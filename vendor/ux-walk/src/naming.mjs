import fs from 'node:fs';
import path from 'node:path';
// Folder names and the hand-off line, shared by the recorder and `ux-walk import` so both make the same layout:
// <outDir>/<YYYY-MM-DD-HHMM>-<topic>/<NN>-<chapter>/.
export const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
export const pad = (n) => String(n).padStart(2, '0');
// Local time, to the minute.
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
export const sessionName = (topic, d = new Date()) => `${stamp(d)}-${slug(topic) || 'walk'}`;
export const chapterName = (n, name) => `${pad(n)}-${slug(name) || 'part'}`;
// The one line Jackson pastes into Claude Code to hand the walk to agents.
export const handoffLine = (dir, ask) => `/ux-walk ${dir}${ask && ask.trim() ? ` ${ask.replace(/\s+/g, ' ').trim()}` : ''}`;

// Reserve atomically; a same-minute restart must never overwrite a previous session/video.
export function createSessionDir(outDir, topic, date = new Date()) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = sessionName(topic, date);
  for (let n = 1; ; n++) {
    const dir = path.join(outDir, n === 1 ? base : `${base}-${n}`);
    try { fs.mkdirSync(dir); return dir; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
