// Glossaries: plain-text lists of names a transcriber gets wrong, one per line ("Right: wrong, wrong").
// Building blocks, not one hard-coded list: ~/.config/ux-walk/glossary.txt is always used, and named
// glossaries in ~/.config/ux-walk/glossaries/<name>.txt are added per recording (--glossary acme,clinic).
// Today the timeline uses them to fix spellings; transcribers with name hints get the right-hand names.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, expand } from './config.mjs';

export const GLOSSARY_DIR = path.join(CONFIG_DIR, 'glossaries');
export const DEFAULT_GLOSSARY = path.join(CONFIG_DIR, 'glossary.txt');

export function glossaryPath(ref) {
  if (/[/~]|\.txt$/.test(ref)) return path.resolve(expand(ref));
  return path.join(GLOSSARY_DIR, `${ref}.txt`);
}

// The files a recording uses: the default one plus every named one (missing names are an error).
export function resolveGlossaries(...refs) {
  const names = refs.flatMap((r) => (Array.isArray(r) ? r : String(r || '').split(','))).map((s) => s.trim()).filter(Boolean);
  const files = [DEFAULT_GLOSSARY, ...names.map(glossaryPath)];
  for (const f of files.slice(1)) if (!fs.existsSync(f)) throw new Error(`no glossary ${f}; create it with: ux-walk glossary new ${path.basename(f, '.txt')}`);
  return [...new Set(files)].filter((f) => fs.existsSync(f));
}

export function listGlossaries() {
  const named = fs.existsSync(GLOSSARY_DIR) ? fs.readdirSync(GLOSSARY_DIR).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)) : [];
  return { default: fs.existsSync(DEFAULT_GLOSSARY) ? DEFAULT_GLOSSARY : null, named };
}

// [{ right, wrongs: [] }] from all files.
export function readGlossaries(files) {
  const out = [];
  for (const file of files.filter((f) => fs.existsSync(f))) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([^#:][^:]*):(.*)$/) || line.match(/^\s*([^#\s][^#]*?)\s*$/);
      if (!m) continue;
      out.push({ right: m[1].trim(), wrongs: (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean) });
    }
  }
  return out;
}

// For transcribers that take a vocabulary list.
export const glossaryTerms = (files) => [...new Set(readGlossaries(files).map((g) => g.right))];

// Names from the screen: a transcriber hears "Bergum" where the page says "Bergam" 1,677 times.
// Proper nouns are capitalised words of 4+ letters in the page text (snapshots/*.yml) that are not
// dictionary words; a name counts once it is on screen 3 or more times.
let DICT = null;
export function dictionary(file = '/usr/share/dict/words') {
  if (!DICT) { try { DICT = new Set(fs.readFileSync(file, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean)); } catch { DICT = new Set(); } }
  return DICT;
}
// The dictionary file has no plurals or verb forms: "residents" is a word because "resident" is.
export function isWord(w, dict = dictionary()) {
  const x = w.toLowerCase();
  if (dict.has(x)) return true;
  for (const [suf, add] of [['s', ''], ['es', ''], ['ies', 'y'], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e'], ['er', ''], ['ers', ''], ['ly', ''], ['d', '']]) {
    if (x.endsWith(suf) && x.length - suf.length >= 3 && dict.has(x.slice(0, -suf.length) + add)) return true;
  }
  // Doubled consonant: "dropped", "planning".
  const m = x.match(/^(.*([b-df-hj-np-tv-z]))\2(ed|ing|er)$/);
  return !!(m && dict.has(m[1]));
}

export function screenNames(files, dict = dictionary()) {
  const count = new Map();
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // Quoted accessible names and plain text nodes; skip /url lines and attributes.
    for (const line of text.split('\n')) {
      if (/^\s*-\s*\/url:/.test(line)) continue;
      const parts = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      const plain = line.match(/^\s*-\s*(?:text|paragraph|heading|cell|rowheader|option|row|listitem|generic)[^:"]*:\s+([^"].*)$/);
      if (plain) parts.push(plain[1]);
      for (const p of parts) {
        for (const w of p.match(/[A-Za-z][A-Za-z'’-]*[A-Za-z]/g) || []) {
          const word = w.replace(/['’]s$/, '');
          if (word.length < 4 || !/^[A-Z]/.test(word) || /-/.test(word) || isWord(word, dict)) continue;
          count.set(word, (count.get(word) || 0) + 1);
        }
      }
    }
  }
  return [...count].filter(([, n]) => n >= 3).map(([name, n]) => ({ name, n }));
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// A replacer for transcript text: a word of 4+ letters that is not a dictionary word and not on
// screen, within edit distance 2 of an on-screen name with the same first letter (1 for words under
// 6 letters, where 2 changes is half the word). The closest name wins, then the most seen; a tie
// between two names changes nothing. fix(text) returns the new text; fix.log lists what changed.
export function nameFixer(names, dict = dictionary()) {
  const exact = new Set(names.map((x) => x.name.toLowerCase()));
  const memo = new Map();
  const log = new Map();
  const pick = (w) => {
    const lw = w.toLowerCase();
    if (memo.has(w)) return memo.get(w);
    let best = null;
    // Transcribers capitalise names; a lowercase word is an ordinary word ("workspaces").
    if (lw.length >= 4 && /^[A-Z]/.test(w) && !exact.has(lw) && !exact.has(lw.replace(/e?s$/, '')) && !isWord(w, dict)) {
      const max = lw.length < 6 ? 1 : 2;
      const hits = names.filter((x) => x.name[0].toLowerCase() === lw[0]).map((x) => ({ ...x, d: distance(lw, x.name.toLowerCase()) })).filter((x) => x.d <= max)
        .sort((a, b) => a.d - b.d || b.n - a.n);
      if (hits.length && !(hits[1] && hits[1].d === hits[0].d && hits[1].n * 2 > hits[0].n)) best = hits[0].name;
    }
    memo.set(w, best);
    return best;
  };
  const fix = (text) => text.replace(/[A-Za-z][A-Za-z'’]*[A-Za-z]/g, (w) => {
    const base = w.replace(/['’]s$/, '');
    const to = pick(base);
    if (!to) return w;
    const k = `${base} -> ${to}`;
    log.set(k, (log.get(k) || 0) + 1);
    return to + w.slice(base.length);
  });
  fix.log = log;
  return fix;
}
