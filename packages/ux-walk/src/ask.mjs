// End-of-walk questions in the terminal: one readline for all of them, so the terminal stays in one
// mode until the process exits. Closing a readline puts a TTY back in cooked mode, and the tty then
// echoes every key typed while the recorder works on (the stray blank lines and ", Jackson 2" from
// the first drive). Here the interface stays open: between questions its output is muted and lines
// typed then are dropped, so nothing echoes and nothing leaks into the next answer or the shell.
import readline from 'node:readline';
import { Writable } from 'node:stream';

// ask(text, { timeoutS }) resolves to the answer, or '' on Enter, timeout or Ctrl+C. While a question
// waits, its prompt counts down ("(skips in 15 s)"); a key press restarts the countdown, so a question
// always skips itself after timeoutS with no typing (a stray key never leaves it waiting forever).
// print(msg) writes a line above an open question. After Ctrl+C every later ask resolves to ''.
export function createAsker({ input = process.stdin, output = process.stdout, terminal } = {}) {
  const tty = terminal ?? !!(input.isTTY && output.isTTY);
  let active = null; // { text, resolve, timer, left }
  const queued = []; // piped input (not a TTY): answers typed ahead are taken in order
  let interrupted = false, closed = false;
  const sink = new Writable({ write(chunk, enc, cb) { if (active) output.write(chunk); cb(); } });
  Object.defineProperty(sink, 'columns', { get: () => output.columns || 80 });
  const rl = readline.createInterface({ input, output: sink, terminal: tty, historySize: 0, prompt: '' });
  const show = (t) => { rl.setPrompt(t); rl.prompt(true); };
  const label = (a) => `${a.text}${a.timeoutS > 0 ? `(skips in ${a.left} s) ` : ''}`;
  const end = (answer) => {
    const a = active;
    if (!a) return;
    clearInterval(a.timer);
    active = null;
    a.resolve(answer);
  };
  rl.on('line', (line) => {
    if (active) end(line.trim());
    else if (!tty) queued.push(line.trim());
    // A TTY line typed with no question open is dropped.
  });
  rl.on('SIGINT', () => {
    interrupted = true;
    if (active) { output.write('\n'); end(''); }
  });
  rl.on('close', () => { closed = true; if (active) { output.write('\n'); end(''); } });
  if (tty) {
    // Typing restarts the countdown: a question skips only after timeoutS with no key pressed.
    input.on('keypress', (_s, key) => {
      if (!active || !active.timeoutS || (key && key.ctrl && key.name === 'c')) return;
      active.since = Date.now();
      if (active.left !== active.timeoutS) { active.left = active.timeoutS; show(label(active)); }
    });
  }
  const clearTyped = () => {
    if (!tty) return;
    // Throw away anything typed while no question was open (output is muted, so this draws nothing).
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
  };
  return {
    get interrupted() { return interrupted; },
    ask(text, { timeoutS = 0 } = {}) {
      if (interrupted || closed) return Promise.resolve('');
      if (!tty && queued.length) { output.write(`${text}${queued[0]}\n`); return Promise.resolve(queued.shift()); }
      clearTyped();
      return new Promise((resolve) => {
        const a = active = { text, resolve, timeoutS, left: timeoutS, since: Date.now(), timer: 0 };
        if (tty) show(label(a)); else output.write(text);
        if (timeoutS > 0) {
          a.timer = setInterval(() => {
            if (active !== a) return;
            const left = Math.ceil(timeoutS - (Date.now() - a.since) / 1000);
            if (left <= 0) { output.write(tty ? '\n' : '(skipped)\n'); end(''); return; }
            if (tty && left !== a.left) { a.left = left; show(label(a)); }
          }, 250);
        }
      });
    },
    // A line from background work, drawn above the open question (if any).
    print(msg) {
      if (active && tty) {
        readline.clearLine(output, 0); readline.cursorTo(output, 0);
        output.write(`${msg}\n`);
        rl.prompt(true);
      } else output.write(active ? `\n${msg}\n${active.text}` : `${msg}\n`);
    },
    close() { if (!closed) { closed = true; if (active) end(''); rl.close(); } },
  };
}
