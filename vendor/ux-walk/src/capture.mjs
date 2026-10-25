// Video + mic capture backends. Both expose: start(file), rotate(file), pause(), resume(file), stop().
// start/rotate/resume resolve to { startMs } (wall clock of the first frame); pause/stop resolve to
// the finished file { path, durationS }.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT } from './config.mjs';

export const HELPER = path.join(ROOT, 'bin', 'uxw-capture');

// ScreenCaptureKit helper: one window, followed as it moves, cursor included.
export class WindowCapture {
  // callApp: 'auto' or a call app id (uxw-capture --calls): the call track is only that app's sound.
  // display: record the whole display (video mode, so the camera bubble on screen is in the video).
  // bubbleWindow: the app's camera bubble window, drawn over the recorded window (or in the display, which shows it anyway).
  constructor({ pid, app, title, windowId, display, bubbleWindow, mic, fps, noMic, callAudio, callApp, onEvent }) {
    this.target = windowId != null ? ['--window-id', String(windowId)] : display != null ? ['--display', String(display)] : [...(pid ? ['--pid', String(pid)] : app ? ['--app', app, ...(title ? ['--title', title] : [])] : ['--window-id', String(windowId)]),
      ...(bubbleWindow ? ['--bubble-window', String(bubbleWindow)] : [])];
    this.opts = [...(mic ? ['--mic', mic] : []), ...(fps ? ['--fps', String(fps)] : []), ...(noMic ? ['--no-mic'] : []),
      ...(callAudio ? (callApp ? ['--call-app', callApp] : ['--call-audio']) : [])];
    this.waiters = [];
    this.onEvent = onEvent || (() => {});
    this.exited = false;
    this.nextSnapshot = 0;
  }

  wait(match, ms = 20000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      this.waiters.push(w);
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('capture helper timed out')); }, ms);
      w.timer.unref();
    });
  }

  handle(e) {
    this.onEvent(e);
    if (e.ev === 'error') {
      const i = this.waiters.findIndex((w) => e.requestId ? w.match(e) : true);
      const w = i >= 0 ? this.waiters.splice(i, 1)[0] : null;
      if (w) { clearTimeout(w.timer); w.reject(Object.assign(new Error(e.message), { details: e })); }
      return;
    }
    const i = this.waiters.findIndex((w) => w.match(e));
    if (i >= 0) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(e); }
  }

  async start(file) {
    if (!fs.existsSync(HELPER)) throw new Error(`capture helper missing; run: ${path.join(ROOT, 'install.sh')}`);
    this.proc = spawn(HELPER, ['--out', file, ...this.target, ...this.opts], { stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => { try { this.handle(JSON.parse(l)); } catch {} });
    let stderr = '';
    this.proc.stderr.on('data', (d) => { stderr += d; });
    this.done = new Promise((r) => this.proc.on('exit', (code) => {
      this.exited = true;
      this.onEvent({ ev: 'exit', code });
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(`capture helper exited (${code}) ${stderr.trim()}`)); }
      r(code);
    }));
    // "ready" (window found, prints the window line) and "started" (first frame) can come in either order.
    const [s] = await Promise.all([this.wait((e) => e.ev === 'started' && e.path === file), this.wait((e) => e.ev === 'ready')]);
    return { startMs: s.epochMs };
  }

  send(cmd) { if (!this.exited) this.proc.stdin.write(cmd + '\n'); }

  async snapshot(file, { requestId = `snapshot-${++this.nextSnapshot}`, crop, timeoutMs = 10000 } = {}) {
    if (this.exited || !this.proc) throw new Error('capture is not running');
    const result = this.wait((e) => e.requestId === requestId && ['snapshot', 'error'].includes(e.ev), Math.min(30000, Math.max(100, Number(timeoutMs) || 10000)));
    this.send(`snapshot ${JSON.stringify({ requestId, path: file, crop })}`);
    return result;
  }

  async rotate(file) {
    const fin = this.wait((e) => e.ev === 'finished');
    const st = this.wait((e) => e.ev === 'started' && e.path === file);
    this.send(`rotate ${file}`);
    const [f, s] = await Promise.all([fin, st]);
    return { finished: f, startMs: s.epochMs };
  }

  async pause() { const f = this.wait((e) => e.ev === 'finished'); this.send('pause'); return f; }

  async resume(file) {
    const s = this.wait((e) => e.ev === 'started' && e.path === file);
    this.send(`rotate ${file}`);
    return { startMs: (await s).epochMs };
  }

  async stop() {
    if (this.exited) return null;
    const f = this.wait((e) => e.ev === 'finished', 30000).catch(() => null);
    this.send('stop');
    const r = await f;
    await this.done;
    return r;
  }
}

// Whole-screen fallback through ffmpeg (no window following, a short gap at each chapter).
export class ScreenCapture {
  constructor({ screen, mic }) { this.input = `${screen}:${mic || 'default'}`; }

  async start(file) {
    this.file = file;
    this.proc = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'avfoundation', '-capture_cursor', '1', '-capture_mouse_clicks', '1',
      '-framerate', '10', '-pixel_format', 'nv12', '-i', this.input, '-vf', 'scale=trunc(iw/4)*2:-2',
      '-c:v', 'h264_videotoolbox', '-b:v', '2M', '-c:a', 'aac', '-b:a', '96k', '-y', file], { stdio: ['pipe', 'ignore', 'inherit'] });
    this.startMs = Date.now();
    this.done = new Promise((r) => this.proc.on('exit', r));
    return { startMs: this.startMs };
  }

  async finish() {
    if (!this.proc) return null;
    const p = this.proc; this.proc = null;
    p.stdin.write('q');
    await this.done;
    return { ev: 'finished', path: this.file, durationS: (Date.now() - this.startMs) / 1000 };
  }

  async rotate(file) { const finished = await this.finish(); return { finished, ...(await this.start(file)) }; }
  pause() { return this.finish(); }
  resume(file) { return this.start(file); }
  stop() { return this.finish(); }
}

// Call apps with audio right now, the one in a call (using the microphone) first:
// [{ id, name, active, window, title }] (uxw-capture --calls).
export function detectCalls() {
  if (!fs.existsSync(HELPER)) return [];
  const r = spawnSync(HELPER, ['--calls'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.ev === 'callapp');
}

// Persist native recording failures independently of recoverable, request-scoped screenshot errors.
export function createCaptureHealth({ session, write, save, clock = Date.now }) {
  session.capture = { status: 'starting', errors: [] };
  const interrupt = (reason, details = {}) => {
    const t = clock(), error = { t, reason, ...details };
    Object.assign(session.capture, { status: 'interrupted', error: reason, interruptedAt: t, endReason: reason });
    session.capture.errors.push(error);
    session.coverage ||= {};
    session.coverage.window = 'interrupted; recording ended with a capture error';
    write({ ev: 'capture-error', t, source: 'capture-helper', text: reason, ...details });
    save();
    return true;
  };
  const exited = (code) => {
    if (code === 0) return false;
    session.capture.exitCode = code;
    return interrupt(`Native capture exited unexpectedly (${code ?? 'signal'})`, { exitCode: code });
  };
  return {
    event(e) {
      if (e.ev === 'exit') return exited(e.code);
      if (e.ev === 'error' && !e.requestId) return interrupt(e.message || 'Native capture error', { helperEvent: e });
      if (e.ev === 'ready') {
        session.capture.startedAt = clock();
        session.capture.target = { windowId: e.windowId, title: e.title, width: e.width, height: e.height };
        if (session.capture.status !== 'interrupted') session.capture.status = 'recording';
        save();
      }
      return false;
    },
    exit: exited,
    stop(reason) {
      session.capture.endedAt = clock();
      session.capture.stopReason = reason;
      if (session.capture.status !== 'interrupted') Object.assign(session.capture, { status: 'stopped', endReason: reason });
      save();
    },
  };
}
