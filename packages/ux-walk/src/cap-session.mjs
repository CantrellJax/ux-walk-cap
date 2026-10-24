// Logical chapters and logging attach to one Cap recording. Never rotate the encoder for a note.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CapCapture, CapClient, capManifest, copyCapProject } from './cap.mjs';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file);
};
function within(dir, relative) {
  const file = path.resolve(dir, relative);
  if (typeof relative !== 'string' || path.isAbsolute(relative) || !file.startsWith(path.resolve(dir) + path.sep)) throw new Error('Chapter media must stay inside the walk');
  return file;
}
async function duration(client, file) {
  const { stdout } = await client.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
  const p = JSON.parse(stdout), seconds = Number(p.format?.duration);
  if (!(seconds > 0) || !p.streams?.some((s) => s.codec_type === 'video')) throw new Error('Media has no playable video');
  await client.run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { timeout: 30000 });
  return seconds;
}

export async function reconcileCapSession(dir, { client = new CapClient() } = {}) {
  const mediaDir = path.join(dir, 'media'), stateFile = path.join(mediaDir, 'cap-session.json');
  const state = read(stateFile);
  if (state.schemaVersion !== 1 || state.status !== 'closed') throw new Error('End logging before reconciling media');
  await client.localOnly();
  const rows = await client.json(['record', 'status']);
  const row = rows.find((r) => r.recordingId === state.recordingId);
  if (row?.status === 'recording' && row.alive) return { pending: true, reason: 'Cap is still recording; media is not copied or exported', recordingId: state.recordingId };
  if (row?.status === 'error' || (row?.status === 'recording' && !row.alive)) throw new Error(row.error || 'Cap recording ended without finalizing');
  const project = path.join(mediaDir, 'source.cap'), video = path.join(mediaDir, 'video.mp4');
  // validate before copying; the external recording is never edited, stopped or exported in place.
  if (!fs.existsSync(project)) {
    await client.inspect(state.project);
    const tmp = path.join(mediaDir, `${randomUUID()}.cap`);
    try { copyCapProject(state.project, tmp); await client.inspect(tmp); fs.renameSync(tmp, project); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  await client.inspect(project);
  let durationS;
  if (fs.existsSync(video)) durationS = await duration(client, video);
  else {
    const tmp = path.join(mediaDir, `${randomUUID()}.mp4`);
    try { ({ durationS } = await client.export(project, tmp)); fs.renameSync(tmp, video); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  await capManifest(project, video, { durationS }, state.timing);
  for (const span of state.spans) {
    const file = within(dir, span.file), chapterDir = path.dirname(file);
    const startS = Math.max(0, (span.startMs - state.timing.sourceEpochMs) / 1000);
    const requestedEndS = Math.max(startS, (span.endMs - state.timing.sourceEpochMs) / 1000);
    const clockSlackS = (state.timing.resolutionMs || Math.max(0, (state.timing.acknowledgedAt || 0) - (state.timing.requestedAt || 0))) / 1000 + 0.15;
    if (requestedEndS > durationS + clockSlackS && span.endMs - span.startMs >= 1500) throw new Error('Cap video ends before the logged interval; media coverage is incomplete. The source and log are retained.');
    const endS = Math.min(durationS, requestedEndS);
    if (endS - startS < 0.04) {
      if (span.endMs - span.startMs >= 1500) throw new Error('Logged interval is outside the playable Cap media; check the source clock before reconciling');
      span.empty = true; continue;
    }
    if (fs.existsSync(file) && !span.materialized) throw new Error(`Refusing to overwrite existing chapter media: ${file}`);
    if (!span.materialized) {
      const tmp = path.join(chapterDir, `${randomUUID()}.mp4`);
      try {
        await client.run('ffmpeg', ['-v', 'error', '-nostdin', '-ss', String(startS), '-i', video, '-t', String(endS - startS),
          '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', tmp], { timeout: 15 * 60 * 1000 });
        span.durationS = await duration(client, tmp); fs.renameSync(tmp, file); span.materialized = true;
        save(stateFile, state);
      } finally { fs.rmSync(tmp, { force: true }); }
    } else await duration(client, file);
    save(path.join(chapterDir, 'media.json'), { schemaVersion: 1, backend: 'cap', project: path.relative(chapterDir, project),
      sourceManifest: path.relative(chapterDir, path.join(mediaDir, 'media.json')), derivative: { path: 'video.mp4', durationS: span.durationS },
      sourceRange: { startS, endS, exact: false, ...(requestedEndS > endS ? { requestedEndS, clippedWithinClockUncertainty: true } : {}) }, timing: state.timing, sharing: 'local; no upload requested' });
  }
  state.materialized = true; save(stateFile, state);
  return { pending: false, recordingId: state.recordingId, project, video, durationS, spans: state.spans };
}

export class CapSessionCapture {
  constructor({ dir, client = new CapClient(), clock = Date.now, ...options }) {
    this.dir = dir; this.client = client; this.clock = clock; this.raw = new CapCapture({ ...options, client });
    this.continuous = true; this.ownsRecording = this.raw.ownsRecording;
    this.done = this.raw.done;
  }
  persist() { save(path.join(this.dir, 'media', 'cap-session.json'), this.state); }
  begin(file, at) {
    this.active = { file: path.relative(this.dir, file), startMs: at };
    within(this.dir, this.active.file); this.state.spans.push(this.active); this.persist();
    return { startMs: at };
  }
  end(at = this.clock()) {
    if (!this.active) return null;
    this.active.endMs = at; this.active = null; this.persist();
    return { endMs: at, deferred: true };
  }
  async start(file) {
    fs.mkdirSync(path.join(this.dir, 'media'), { recursive: true });
    const started = await this.raw.start(path.join(this.dir, 'media', 'video.mp4'));
    this.state = { schemaVersion: 1, status: 'logging', ownsRecording: this.ownsRecording, recordingId: this.raw.recordingId,
      project: this.raw.project, timing: this.raw.timing, spans: [] };
    return this.begin(file, started.startMs);
  }
  async rotate(file) { const at = this.clock(), finished = this.end(at); return { finished, ...this.begin(file, at) }; }
  async pause() { return this.end(); }
  async resume(file) { return this.begin(file, this.clock()); }
  releaseOwnership() { this.ownsRecording = false; this.raw.ownsRecording = false; this.state.ownsRecording = false; this.persist(); }
  async snapshot(file, options) { if (!this.active) throw new Error('Logging is paused; Cap is still recording'); return this.raw.snapshot(file, options); }
  async stop() {
    const finished = this.end(); this.state.status = 'closed'; this.persist();
    try {
      await this.raw.stop();
      const media = await reconcileCapSession(this.dir, { client: this.client });
      return { ...finished, deferred: true, mediaReady: !media.pending, pending: media.pending };
    } catch (error) {
      // Reconciliation checkpoints each finished chapter. Preserve that progress for a safe retry.
      this.state = read(path.join(this.dir, 'media', 'cap-session.json'));
      this.state.error = error.message; this.persist(); throw error;
    }
  }
}
