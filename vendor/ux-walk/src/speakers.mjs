// Who is talking: asked before recording, confirmed per chapter once transcripts exist.
// Transcribers number voices per file, so "Speaker 2" can be a different person in each chapter.
import fs from 'node:fs';
import path from 'node:path';
import { parseSrt, rollCall, speakerSamples, voiceNames } from './timeline.mjs';
import { readCalled } from './rollcall.mjs';

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);

// Before recording: names, you first. Returns a list.
export async function askSpeakers(rl, me) {
  const a = await rl.question(`Who's talking? Names, you first, comma-separated [${me}]: `);
  return list(a).length ? list(a) : [me];
}

// What the timeline calls each voice when nobody confirmed names: the roll call ("This is Clay") in the
// first two minutes names a voice; a voice it did not name keeps its neutral label. The same rule as
// parseSrt, keyed by the raw labels ("Speaker 1") that speakerMap uses.
// `called`: the roll call a carried-forward clip already heard (rollcall-map.json), used instead of searching the cues.
export function guessVoices(srtText, names, split = null, sources = null, called = null) {
  if (split?.split) return splitNames(srtText, names, split, sources);
  const cues = parseSrt(srtText, [], {});
  const order = [...new Set(cues.map((c) => c.speaker).filter(Boolean))];
  return voiceNames(order, called || rollCall(cues, names), names);
}

// A call transcribed per track (transcript.json). With the speakers screen's names per source, mic voices (busiest
// first) take the mic names and call voices the call names. Without them, the mic's main voice is you and the other
// names go to the busiest remaining voices. A stray voice (under 2% of the words: leftover echo, a cough) keeps its label.
export function splitNames(srtText, names, split, sources = null) {
  const map = {};
  const counts = split.words || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const real = (l) => !split.words || counts[l] / total >= 0.02;
  // Names given per source on the speakers screen: mic voices take the mic names, call voices the call names.
  if (sources && (sources.mic?.length || sources.call?.length)) {
    const give = (labels, people) => { const left = [...(people || [])]; for (const l of labels || []) if (real(l) && left.length) map[l] = left.shift(); };
    give(split.mic, sources.mic.length ? sources.mic : names.slice(0, 1));
    give(split.call, sources.call);
    return map;
  }
  const [me, ...rest] = names;
  if (split.mic?.[0] && me) map[split.mic[0]] = me;
  const others = [...(split.mic || []).slice(1), ...(split.call || [])]
    .filter(real)
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  if (!split.words) {
    // Older transcript.json without counts: order of first speech.
    const order = [...new Set(parseSrt(srtText, [], {}).map((c) => (c.speaker === 'Speaker' ? 'Speaker 1' : c.speaker)).filter(Boolean))];
    others.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  for (const l of others) if (rest.length) map[l] = rest.shift();
  return map;
}
export function readSplit(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')); } catch { return null; }
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// After transcription: show each voice with when it first spoke, its first words and the guessed name.
// Enter (or the timeout) keeps the guesses and changes nothing, so nothing is rebuilt. Typed names are
// written as speakerMap into chapter.json. Returns the chapters whose names changed.
// asker: { ask(text, { timeoutS }), print(msg) } (src/ask.mjs). always: ask even when the guess is sure
// (ux-walk speakers); otherwise a chapter with one voice and a known first name, or named by the call
// track, is not asked about.
export async function confirmSpeakers(asker, chapterDirs, names, { timeoutS = 0, always = false } = {}) {
  const print = asker.print ? (m) => asker.print(m) : (m) => console.log(m);
  const changed = [];
  let hinted = false;
  for (const dir of chapterDirs) {
    const srt = path.join(dir, 'transcript.srt'), cj = path.join(dir, 'chapter.json');
    if (!fs.existsSync(srt) || !fs.existsSync(cj)) continue;
    const meta = JSON.parse(fs.readFileSync(cj, 'utf8'));
    // Names given now first, then anyone this chapter added mid-walk ("+ Clay").
    const own = [...new Set([...list(names), ...list(meta.speakers)])];
    const text = fs.readFileSync(srt, 'utf8');
    const voices = speakerSamples(text).filter((v) => v.label);
    if (!voices.length) continue;
    // Named from the call track (you vs one caller): nothing to ask.
    let sum = {};
    try { sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch {}
    if (!always && sum.voices === 'call' && own.length <= 2 && voices.length <= own.length) continue;
    // Named from Meet's captions: Meet knew who was talking.
    if (!always && sum.voices === 'meet') continue;
    // Transcribed per track: you are the mic; nothing to ask unless there are more voices than names.
    const split = readSplit(dir);
    if (!always && split?.split && split.mic.length <= 1 && voices.length <= own.length) continue;
    // One voice and we know who you are: it is you (or the roll call said who).
    if (!always && voices.length === 1 && own[0]) continue;
    const guess = { ...guessVoices(text, own, split, meta.sources, readCalled(dir)), ...(meta.speakerMap || {}) };
    print(`\nChapter ${meta.n} "${meta.name}": who is each voice? (guess in brackets)`);
    // More voices than names usually means someone joined and nobody typed "+ Name".
    if (voices.length > own.length) print(`  The transcript has ${voices.length} voices but ${own.length} name(s) (${own.join(', ')}); type every name in voice order.`);
    for (const v of voices) print(`  ${v.label.padEnd(10)} first at ${mmss(v.at || 0)}  [${guess[v.label] || v.label}]  "${v.sample.slice(0, 90)}${v.sample.length > 90 ? '…' : ''}"`);
    if (!hinted) { print(`  Not sure? Enter keeps the guesses; fix them any time with: ux-walk speakers ${path.dirname(dir)}`); hinted = true; }
    const a = list(await asker.ask(`  Names in voice order (${voices.map((v) => v.label).join(', ')}), or Enter: `, { timeoutS }));
    if (!a.length) continue;
    const map = Object.fromEntries(voices.map((v, i) => [v.label, a[i] || guess[v.label] || v.label]));
    if (voices.every((v) => map[v.label] === guess[v.label])) continue; // same as the timeline already says
    meta.speakerMap = map;
    fs.writeFileSync(cj, JSON.stringify(meta, null, 2));
    changed.push(dir);
  }
  return changed;
}
