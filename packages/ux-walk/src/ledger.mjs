// What happened to each brief item: `ux-walk link` records a bead / PR / "dropped" ref against an
// item id in <session>/ledger.json; `ux-walk status` lists the items nobody has linked yet, and the
// open questions; `ux-walk search` finds brief items and speech across every recording.
import fs from 'node:fs';
import path from 'node:path';
import { mergeBriefs, parseBrief } from './brief.mjs';

const readJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const isSession = (d) => fs.existsSync(path.join(d, 'session.json'));

// Session folders in outDir, newest first (folder names start with the date and time).
export function sessions(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir).map((n) => path.join(outDir, n)).filter(isSession).sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

// A full path, a folder name in outDir, or a unique suffix of one. A chapter folder means its session.
export function resolveSession(arg, outDir) {
  if (!arg) {
    const latest = sessions(outDir)[0];
    if (!latest) throw new Error(`no recordings in ${outDir}`);
    return latest;
  }
  for (const p of [path.resolve(arg), path.join(outDir, arg)]) {
    if (isSession(p)) return p;
    if (fs.existsSync(path.join(p, 'chapter.json')) && isSession(path.dirname(p))) return path.dirname(p);
  }
  const all = sessions(outDir);
  const hits = all.filter((d) => path.basename(d).endsWith(arg));
  const loose = hits.length ? hits : all.filter((d) => path.basename(d).includes(arg));
  if (loose.length === 1) return loose[0];
  if (!loose.length) throw new Error(`no recording matches "${arg}" in ${outDir}`);
  throw new Error(`"${arg}" matches ${loose.length} recordings: ${loose.map((d) => path.basename(d)).join(', ')}`);
}

export function chapters(sessionDir) {
  const s = readJson(path.join(sessionDir, 'session.json'));
  return (s.chapters || []).map((c) => ({ n: c.n, name: c.name, dir: path.join(sessionDir, c.dir) })).filter((c) => fs.existsSync(c.dir));
}

// items.json, or (older chapters) the same thing derived from brief.md. null when there is no brief.
export function loadItems(chDir, first = 'the speaker') {
  const j = readJson(path.join(chDir, 'items.json'), null);
  if (j) return j;
  const f = path.join(chDir, 'brief.md');
  if (!fs.existsSync(f)) return null;
  const meta = readJson(path.join(chDir, 'chapter.json'));
  const b = parseBrief(fs.readFileSync(f, 'utf8'));
  const m = mergeBriefs([b], { n: meta.n || 1, title: b.title, first });
  return { chapter: meta.n || 1, items: m.items, decisions: m.decisions, questions: m.questions, derived: true };
}

const ledgerFile = (s) => path.join(s, 'ledger.json');
export const readLedger = (s) => readJson(ledgerFile(s));

// Replaces the item's refs (a corrected link leaves no stale ref behind); add: true appends instead.
export function link(sessionDir, id, ref, note = '', { add = false } = {}) {
  const known = chapters(sessionDir).flatMap((c) => { const j = loadItems(c.dir); return j ? [...j.items.map((i) => i.id), ...(j.questions || []).map((q) => q.id)] : []; });
  if (!known.includes(id)) throw new Error(`no item ${id} in ${path.basename(sessionDir)}${known.length ? ` (items: ${known[0]}..${known.at(-1)})` : ' (no brief yet: ux-walk brief <folder>)'}`);
  const l = readLedger(sessionDir);
  const entry = { ref, ...(note ? { note } : {}), at: new Date().toISOString() };
  l[id] = add ? [...(l[id] || []), entry] : [entry];
  const tmp = `${ledgerFile(sessionDir)}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n');
  fs.renameSync(tmp, ledgerFile(sessionDir));
  return l[id];
}

// Items with no ref, by chapter, then the open questions. Returns lines to print.
export function status(sessionDir) {
  const s = readJson(path.join(sessionDir, 'session.json'));
  const first = (s.speakers || [])[0] || 'the speaker';
  const l = readLedger(sessionDir);
  const out = [];
  let open = 0, total = 0, linked = 0, qs = [];
  const body = [];
  for (const c of chapters(sessionDir)) {
    const j = loadItems(c.dir, first);
    if (!j) { body.push(`  Chapter ${c.n} "${c.name}": no brief yet (ux-walk brief ${c.dir})`); continue; }
    const todo = j.items.filter((i) => !l[i.id]?.length);
    total += j.items.length; open += todo.length; linked += j.items.length - todo.length;
    if (todo.length) {
      body.push(`  Chapter ${c.n} "${c.name}"`);
      for (const i of todo) body.push(`    ${i.id.padEnd(7)} ${String(i.type).padEnd(8)} ${(i.when || '').padEnd(6)} ${i.note ? `(note #${i.note}) ` : ''}${i.title}${i.priority ? `  [${i.priority.replace(/\s*\(.*$/, '').slice(0, 40)}]` : ''}`);
    }
    qs.push(...(j.questions || []).filter((q) => !l[q.id]?.length));
  }
  out.push(`${path.basename(sessionDir)}: ${open} of ${total} items with no ref (${linked} linked), ${qs.length} open question(s)`);
  out.push(...body);
  if (qs.length) {
    out.push(`  Questions for ${first}`);
    for (const q of qs) out.push(`    ${q.id.padEnd(7)} ${q.when ? `(${q.when}) ` : ''}${q.text}`);
  }
  return { lines: out, open, questions: qs.length };
}

// Sessions started in the last `days` days.
export function recentSessions(outDir, days = 14) {
  const since = Date.now() - days * 864e5;
  return sessions(outDir).filter((d) => {
    const t = Date.parse(readJson(path.join(d, 'session.json')).startedAt || '') || fs.statSync(d).mtimeMs;
    return t >= since;
  });
}

// Every term (case-insensitive) in brief items and SAY lines, newest recording first.
export function search(outDir, terms, limit = 40) {
  const want = terms.map((t) => t.toLowerCase());
  const hit = (s) => { const x = s.toLowerCase(); return want.every((t) => x.includes(t)); };
  const out = [];
  for (const s of sessions(outDir)) {
    const name = path.basename(s);
    for (const c of chapters(s)) {
      const j = loadItems(c.dir);
      for (const i of j?.items || []) {
        if (!hit([i.title, i.said, i.route, i.org, i.source].filter(Boolean).join(' '))) continue;
        const who = (/^"?([A-Z][\w'-]*(?: [A-Z][\w'-]*)?):/.exec(i.said || '') || /\(([A-Z][\w'-]+)(?:,[^)]*)?\)/.exec(i.said || '') || [])[1] || '';
        out.push(`${name}  ch${c.n}  ${(i.when || '--:--').padEnd(5)}  ${who.padEnd(8)} [${i.id} ${i.type}] ${i.title}`);
        if (out.length >= limit) return out;
      }
      const tl = ['timeline-short.md', 'timeline.md'].map((f) => path.join(c.dir, f)).find((f) => fs.existsSync(f));
      if (!tl) continue;
      for (const l of fs.readFileSync(tl, 'utf8').split('\n')) {
        const m = /^(\d+:\d\d)  SAY    ([^:]+): (.*?)(?:  \((?:shots|text)[^)]*\))?$/.exec(l);
        if (!m || !hit(m[3])) continue;
        out.push(`${name}  ch${c.n}  ${m[1].padEnd(5)}  ${m[2].padEnd(8)} ${m[3]}`);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
