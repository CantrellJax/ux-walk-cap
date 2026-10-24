// Carrying chapter 1's roll call into later chapters. A transcriber numbers voices per file, so a chapter
// with no introductions cannot be named. Chapter 1's roll-call audio is kept (rollcall.m4a), put in front of
// each later chapter's audio before transcription, and cut back out of the transcript afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { parseSrt, rollCallSpan } from './timeline.mjs';

const CLIP = 'rollcall.m4a', INFO = 'rollcall.json', CALLED = 'rollcall-map.json';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (s) => { const ms = Math.max(0, Math.round(s * 1000)); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`; };
const secs = (t) => { const [h, m, x] = t.trim().split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(x.replace(',', '.')); };

export const clipPath = (walkDir) => path.join(walkDir, CLIP);
export const readClip = (walkDir) => {
  try { const info = JSON.parse(fs.readFileSync(path.join(walkDir, INFO), 'utf8')); return fs.existsSync(clipPath(walkDir)) ? info : null; } catch { return null; }
};
export const writeClipInfo = (walkDir, info) => fs.writeFileSync(path.join(walkDir, INFO), JSON.stringify(info, null, 2));

// Who the roll call named in an SRT, by raw label, and when the last name line ends.
export function callSpan(srtText, names) {
  const { map, end } = rollCallSpan(parseSrt(srtText, [], {}), names);
  return { called: map, end };
}

// The roll call a later chapter's transcript heard in the prepended clip: { "Speaker 2": "Clay" }.
export const saveCalled = (chapterDir, called) => fs.writeFileSync(path.join(chapterDir, CALLED), JSON.stringify(called));
export function readCalled(chapterDir) {
  try { return JSON.parse(fs.readFileSync(path.join(chapterDir, CALLED), 'utf8')); } catch { return null; }
}

// An SRT whose first `dur` seconds were the prepended clip -> the chapter's own SRT: those cues dropped, a cue
// straddling the join trimmed, every time moved back by `dur`, cues renumbered. Descript labels only the first cue
// of a paragraph, so when the cut falls inside one the voice it was in is written on the first kept cue.
export function stripPrefix(srtText, dur) {
  const out = [];
  let last = '';
  for (const block of srtText.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map(secs);
    const body = lines.slice(ti + 1).join('\n');
    if (b <= dur) { const l = [...body.matchAll(/\b(Speaker(?: \d+)?):\s/g)].pop(); if (l) last = l[1]; continue; }
    const text = last && !/^\s*Speaker(?: \d+)?:\s/.test(body) ? `${last}: ${body}` : body;
    last = '';
    out.push(`${out.length + 1}\n${stamp(Math.max(a, dur) - dur)} --> ${stamp(b - dur)}\n${text}\n`);
  }
  return out.join('\n');
}
