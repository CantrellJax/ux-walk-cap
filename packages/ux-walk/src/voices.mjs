// Who spoke, from the audio itself. With --call-audio the video has two audio tracks: the microphone
// (the people at this Mac) and what the Mac played (the people on a FaceTime or Zoom call). The
// call track is near silent unless someone on the call is talking, so its loudness during a
// transcript line says whether that line came from the call. Diarization ("Speaker 2") guesses
// from voice alone and merges voices on one mic; this does not.
import { spawn } from 'node:child_process';

const STEP = 0.1; // seconds per loudness sample
const ACTIVE_DB = -45; // louder than this on the call track = someone on the call is talking

// Loudness of the second audio track in dBFS, one value per 100 ms; null when there is no call track.
export function callLoudness(video) {
  return new Promise((resolve) => {
    const rate = 8000, per = rate * STEP;
    const p = spawn('ffmpeg', ['-v', 'error', '-i', video, '-map', '0:a:1', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = [];
    let sum = 0, n = 0, carry = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      const b = carry.length ? Buffer.concat([carry, d]) : d;
      const whole = b.length - (b.length % 2);
      for (let i = 0; i < whole; i += 2) {
        const v = b.readInt16LE(i) / 32768;
        sum += v * v;
        if (++n === per) { out.push(10 * Math.log10(sum / n + 1e-12)); sum = 0; n = 0; }
      }
      carry = b.subarray(whole);
    });
    p.on('error', () => resolve(null));
    p.on('exit', (code) => resolve(code === 0 && out.length ? out : null));
  });
}

// Share of a time span during which the call track was active.
export function callShare(db, start, end) {
  const a = Math.max(0, Math.floor(start / STEP)), b = Math.min(db.length, Math.ceil(end / STEP));
  if (b <= a) return 0;
  let on = 0;
  for (let i = a; i < b; i++) if (db[i] > ACTIVE_DB) on++;
  return on / (b - a);
}

// Renames cues in place. names: you first, then the people on the call. A line mostly heard on the
// call is a caller (their diarized name when it is one of the callers, else the first caller); a
// line with the call silent is you. Lines in between keep the diarized name. Returns whether the
// call track carried any speech at all (else nothing changes: everyone was in the room).
export function nameByCall(cues, db, names) {
  if (!db || names.length < 2) return false;
  const active = db.filter((x) => x > ACTIVE_DB).length / db.length;
  if (active < 0.01) return false;
  const [me, ...callers] = names;
  for (const c of cues) {
    const share = callShare(db, c.start, c.end);
    if (share >= 0.6) c.speaker = callers.includes(c.speaker) ? c.speaker : callers[0];
    else if (share <= 0.15) c.speaker = me;
  }
  return true;
}
