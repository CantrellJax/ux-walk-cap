// Menu bar mode (ux-walk record --ipc): the ux-walk app drives the recorder over JSON lines.
// stdout carries only JSON for the app; console output becomes { ev: 'log' } events.
// App -> recorder (stdin): { cmd: next|mark|pause|speaker|status|stop|answer, ... }
// Recorder -> app (stdout): ready, state, reply, live, log, ask, done, error (see swift/uxw-menubar.swift).
import fs from 'node:fs';
import readline from 'node:readline';
import { EVIDENCE_COMMANDS } from './evidence.mjs';

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Writes are synchronous: on macOS a pipe write is async, and process.exit would drop the last events.
export function emit(o) {
  try { fs.writeSync(1, JSON.stringify(o) + '\n'); } catch {}
}

// Call first, before anything prints: every console line becomes a log event.
export function routeConsole() {
  const as = (level) => (...a) => emit({ ev: 'log', level, text: plain(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ')) });
  console.log = as('info');
  console.info = as('info');
  console.warn = as('warn');
  console.error = as('error');
}

// A line from the app, as a terminal command for runCommand ("n checkout", "m bug", "+ Clay").
export function commandLine(m) {
  switch (m.cmd) {
    case 'next': return `n ${m.name || ''}`.trim();
    case 'mark': return `m ${m.text || 'marker'}`;
    case 'pause': return 'p';
    case 'speaker': return `+ ${[].concat(m.names || m.name || []).join(', ')}`;
    case 'status': return 's';
    case 'stop': return 'q';
    case 'detach': return 'detach';
    default: return null;
  }
}

// Reads the app's commands. onAnswer gets { id, text }; onClose runs when the app goes away.
export function readCommands({ onCommand, onAnswer, onClose, onEvidence, input = process.stdin, respond = emit }) {
  const rl = readline.createInterface({ input });
  rl.on('line', (l) => {
    let m;
    try { m = JSON.parse(l); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    const result = (run) => Promise.resolve(run).then(
      (value) => respond(value && typeof value === 'object' && typeof value.error === 'string'
        ? { ev: 'result', requestId: m.requestId, cmd: m.cmd, ok: false, error: value.error }
        : { ev: 'result', requestId: m.requestId, cmd: m.cmd, ok: true, result: value }),
      (error) => respond({ ev: 'result', requestId: m.requestId, cmd: m.cmd, ok: false, error: error.message, ...(error.details ? { details: error.details } : {}) }));
    try {
      if (EVIDENCE_COMMANDS.has(m.cmd)) {
        // Invoke synchronously to enqueue in input order; a following stop must not overtake a checkpoint.
        result(onEvidence ? onEvidence(m) : Promise.reject(new Error('evidence commands unavailable')));
      } else if (m.cmd === 'answer') onAnswer(m);
      else {
        const line = commandLine(m);
        if (line) { const run = onCommand(line); if (m.requestId) result(run); }
        else if (m.requestId) result(Promise.reject(new Error(`unknown command: ${m.cmd}`)));
      }
    } catch (error) { result(Promise.reject(error)); }
  });
  rl.on('close', onClose);
  return rl;
}

// The same interface as createAsker (src/ask.mjs): the app shows each question as a dialog. Lines printed
// since the last question ride along as its context (the speaker samples). A question the app does not
// answer within timeoutS (when given, times 8: a dialog waits for someone to come back) resolves to ''.
export function createIpcAsker() {
  let next = 1, context = [], closed = false;
  const open = new Map();
  return {
    interrupted: false,
    ask(text, { timeoutS = 0 } = {}) {
      if (closed) return Promise.resolve('');
      const id = next++;
      emit({ ev: 'ask', id, text: plain(text).trim(), context });
      context = [];
      return new Promise((resolve) => {
        const timer = timeoutS > 0 ? setTimeout(() => { open.delete(id); emit({ ev: 'ask-cancel', id }); resolve(''); }, timeoutS * 8000) : null;
        open.set(id, (answer) => { clearTimeout(timer); open.delete(id); resolve(answer); });
      });
    },
    answer({ id, text }) { open.get(id)?.(String(text || '').trim()); },
    print(msg) { const t = plain(msg); context.push(t); emit({ ev: 'log', level: 'info', text: t }); },
    close() { closed = true; for (const r of open.values()) r(''); },
  };
}
