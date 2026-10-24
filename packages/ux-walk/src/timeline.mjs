// Merge the transcript and the action log into two readable timelines:
//   timeline.md        everything (speech, page changes, clicks, keys, writes, errors), times from chapter start
//   timeline-short.md  speech + page changes + writes + risky clicks + markers + errors only
// Each line can point at the screenshot that was on screen at that moment (shots/NNNN.jpg).
import fs from 'node:fs';
import path from 'node:path';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const RISKY = /\b(delete|remove|discard|destroy|archive|unassign|revoke|reset|clear all|withdraw|unpublish|deactivate)\b/i;
const pad = (n) => String(n).padStart(2, '0');
export const clock = (sec) => { const x = Math.max(0, sec); return `${pad(Math.floor(x / 60))}:${pad(Math.floor(x % 60))}`; };
// Supabase sends every RPC as POST, reads included. An RPC counts as a write when a word in its name
// is a write verb (or it failed); the rest are READ lines, kept out of the short timeline.
const WRITE_VERBS = new Set(('set create insert update upsert delete remove add apply save replace promote publish unpublish ' +
  'assign unassign reassign swap record request approve decide confirm cancel undo redo correct move pin unpin mark clear ' +
  'reset withdraw submit generate import release retire restore revoke grant invite send upload edit toggle enable disable ' +
  'archive commit claim accept reject decline merge split rename reorder drop').split(' '));
const READ_FIRST = new Set('get list fetch search count is has can check explain preview find describe current load read resolve lookup validate my'.split(' '));
// rpc: { readRpcs, writeRpcs } regex strings from config, for names the verb guess gets wrong.
const rx = (x) => (x instanceof RegExp ? x : x ? new RegExp(x, 'i') : null);
export const isWriteRpc = (name, rpc = {}) => {
  if (rx(rpc.readRpcs)?.test(name)) return false;
  if (rx(rpc.writeRpcs)?.test(name)) return true;
  const words = name.toLowerCase().split('_');
  return !READ_FIRST.has(words[0]) && words.some((w) => WRITE_VERBS.has(w));
};

// "a1b2c3d4-...." -> "a1b2c3d4"; drop the origin when it is the app under test.
export function cleanUrl(u, appOrigin) {
  let s = String(u || '');
  try {
    const x = new URL(s, appOrigin || 'http://x');
    s = (appOrigin && x.origin === new URL(appOrigin).origin ? '' : x.origin) + x.pathname + x.search;
  } catch {}
  return s.replace(UUID, (m) => m.slice(0, 8));
}

// A read cancelled by navigating away (ERR_ABORTED) is no failure; anything else at 0 or >= 400 is.
export const isFailed = (e) => e.status >= 400 || (e.status === 0 && !/ABORTED/.test(e.failure || ''));
// The server down or unreachable (5xx, CORS-less error, network), not the app saying no (4xx).
const isOutageFail = (e) => e.status >= 500 || (e.status === 0 && !/ABORTED/.test(e.failure || ''));

// READ, WRITE, or FAIL (a read that failed). GET/HEAD failures come in as 'http' events.
export function writeKind(e, ignore, rpcRules) {
  if (ignore && ignore.test(String(e.url))) return null;
  const rpc = String(e.url).match(/\/rest\/v1\/rpc\/([^/?]+)/);
  const read = e.ev === 'http' || ['GET', 'HEAD', 'OPTIONS'].includes(e.method) || (rpc && !isWriteRpc(rpc[1], rpcRules));
  if (!read) return 'WRITE';
  return isFailed(e) ? 'FAIL' : 'READ';
}

// What a failed response says (PostgREST: message, code, details, hint), short.
export function bodySummary(body) {
  const s = String(body || '').trim();
  if (!s) return '';
  try {
    const j = JSON.parse(s);
    const o = (Array.isArray(j) ? j[0] : j) || {};
    const err = o.error && typeof o.error === 'object' ? o.error : {};
    const msg = o.message || err.message || o.error_description || (typeof o.error === 'string' ? o.error : '') || o.msg || '';
    const code = o.code || err.code || '';
    const more = [o.details, o.hint].filter((x) => x && typeof x === 'string').join('; ');
    if (msg || code) return `"${String(msg).slice(0, 200)}"${code ? ` (${code})` : ''}${more ? ` ${more.slice(0, 160)}` : ''}`.replace(UUID, (m) => m.slice(0, 8));
  } catch {}
  if (/<html|<!doctype/i.test(s)) { const t = s.match(/<title>([^<]*)<\/title>/i); return t ? `HTML page "${t[1].trim().slice(0, 100)}"` : 'HTML page'; }
  return `"${s.replace(/\s+/g, ' ').slice(0, 200).replace(UUID, (m) => m.slice(0, 8))}"`;
}

export const isRisky = (el = {}) => RISKY.test(`${el.testid || ''} ${el.aria || ''} ${el.text || ''} ${el.title || ''}`) || /^[x×✕]$/i.test((el.text || '').trim());

export function label(el = {}) {
  const short = (x) => (x ? x.replace(UUID, (m) => m.slice(0, 8)).slice(0, 60) : '');
  const tid = short(el.testid), region = short(el.region);
  // An empty part of a container: say which container, not all of its text.
  if (el.area) return `empty area in ${el.aria || el.ctx || tid || region || el.tag || 'page'}`.slice(0, 120);
  // Text with no letters or digits ("·", "+") names nothing; the title or a labelled ancestor does.
  const weak = (x) => !x || !/[\p{L}\p{N}]/u.test(x);
  const text = weak(el.text) ? el.title || (el.text && el.ctx ? `${el.text} in ${el.ctx}` : el.text) : el.text;
  // On a control the aria label names it best; elsewhere the text under the pointer does.
  let seen = (el.control === false ? text || el.aria : el.aria || text) || el.label || el.title || el.name || '';
  if (el.row && seen && !seen.includes(el.row)) seen = `${seen.slice(0, 70)} · row ${el.row}`;
  // No test id (or only a generic wrapper's): the labelled ancestor ("Requests") says where.
  const where = [tid, region && region !== tid ? `in ${region}` : ''].filter(Boolean).join(' ') || (el.ctx && seen && !seen.includes(el.ctx) ? `in ${el.ctx}` : '');
  if (seen && where) return `${seen.slice(0, 100)} (${where})`;
  return (seen || where || el.tag || '?').slice(0, 120);
}

// The roll call: in the first two minutes each person says their name ("This is Jackson", "I'm Clay",
// "Jackson here", or just "Clay."). A voice that says a known name is that person for the whole chapter.
// Only names the roll call proves are returned; nobody is guessed.
export function rollCall(cues, names) { return rollCallSpan(cues, names).map; }

// The roll call's names, and when the last name line ends (seconds), so its audio can be reused.
export function rollCallSpan(cues, names) {
  const map = {};
  let end = 0;
  const want = new Map(names.map((n) => [n.toLowerCase(), n]));
  const give = (c, word) => {
    const name = want.get(String(word || '').toLowerCase());
    if (name && c.speaker && !map[c.speaker] && !Object.values(map).includes(name)) { map[c.speaker] = name; end = Math.max(end, c.end ?? c.start); }
  };
  for (const c of cues) {
    if (c.start > 120) break;
    for (const m of c.text.matchAll(/\b(?:this is|it's|it is|i'm|i am|my name is|name's|name is)\s+([A-Za-z][\w'-]+)/gi)) give(c, m[1]);
    // "Jackson here", "Clay speaking", or the name alone.
    const bare = c.text.match(/^\W*([A-Za-z][\w'-]+)\W*(?:here|speaking|is here)?\W*$/i);
    if (bare) give(c, bare[1]);
  }
  return { map, end };
}

// Names for the raw voice labels, in order of first speech: roll-call names only. A voice the roll call did
// not name keeps its neutral label ("Speaker 2"), except the last voice standing when exactly one name is
// left unclaimed (or the only voice when there is one name).
export function voiceNames(order, called, names) {
  const left = names.filter((n) => !Object.values(called).includes(n));
  const open = order.filter((s) => !called[s]);
  const alone = open.length === 1 && left.length === 1 ? left[0] : null;
  return Object.fromEntries(order.map((s) => [s, called[s] || (alone && open[0] === s ? alone : s === 'Speaker' ? 'Speaker 1' : s)]));
}

export function writeLabel(e, appOrigin) {
  const u = cleanUrl(e.url, appOrigin);
  const rpc = u.match(/\/rest\/v1\/rpc\/([^/?]+)/);
  const table = u.match(/\/rest\/v1\/([^/?]+)/);
  const what = rpc ? `rpc ${rpc[1]}` : table ? `${e.method} ${table[1]}` : e.serverAction ? `server action on ${u.split('?')[0]}` : `${e.method} ${u.split('?')[0]}`;
  const status = e.status === 0 ? `failed${e.failure ? ` (${e.failure})` : ''}` : e.status;
  return `${what} -> ${status}`;
}

// Find-and-replace rules from glossary entries ({ right, wrongs }).
export function glossaryRules(entries) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
  return entries.flatMap(({ right, wrongs }) => wrongs.map((w) => [new RegExp(`\\b${esc(w)}\\b`, 'gi'), right]));
}

// The raw speaker labels in an SRT, in order of first speech, with when each first spoke and a sample line.
export function speakerSamples(text) {
  const out = new Map();
  for (const c of parseSrt(text, [], {})) {
    if (!out.has(c.speaker)) out.set(c.speaker, { at: c.start, lines: [] });
    const l = out.get(c.speaker).lines;
    if (l.join(' ').length < 160) l.push(c.text);
  }
  return [...out].map(([label, v]) => ({ label, at: v.at, sample: v.lines.join(' ').slice(0, 160) }));
}

// SRT with Descript speaker labels ("Speaker 2: ...") on the first cue of each paragraph.
// `speakers`: a map { "Speaker 2": "Clay" }, or a list of names given in order of first speech.
export function parseSrt(text, glossary = [], speakers = []) {
  const cues = [];
  const order = [];
  // With one voice Descript writes no "Speaker:" label at all: that voice is still the first speaker.
  let speaker = /\bSpeaker(?: \d+)?:\s/.test(text) ? '' : 'Speaker';
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map((s) => {
      const [h, m, x] = s.trim().split(':');
      return Number(h) * 3600 + Number(m) * 60 + Number(x.replace(',', '.'));
    });
    const words = lines.slice(ti + 1).join(' ').replace(/\s+/g, ' ').trim();
    // A speaker change can fall mid-cue ("... Speaker 2: next words"): split it, sharing the time by length.
    const parts = words.split(/\s*\b(Speaker(?: \d+)?):\s+/);
    const segs = [{ speaker, text: parts[0] }];
    for (let i = 1; i < parts.length; i += 2) segs.push({ speaker: parts[i], text: parts[i + 1] || '' });
    const total = segs.reduce((n, x) => n + x.text.length, 0) || 1;
    let at = a;
    for (const seg of segs) {
      const len = (b - a) * seg.text.length / total;
      speaker = seg.speaker;
      if (speaker && !order.includes(speaker)) order.push(speaker);
      let text = seg.text.trim();
      for (const [re, right] of glossary) text = text.replace(re, right);
      if (text) cues.push({ start: at, end: at + len, speaker, text });
      at += len;
    }
  }
  // Descript calls the first voice "Speaker" and the next ones "Speaker 2", "Speaker 3".
  const raw = (s) => (s === 'Speaker' ? 'Speaker 1' : s);
  let names;
  if (Array.isArray(speakers)) {
    // A list of names: only the roll call names a voice; the rest keep neutral labels.
    names = voiceNames(order, rollCall(cues, speakers), speakers);
  } else names = Object.fromEntries(order.map((s) => [s, speakers[raw(s)] || speakers[s] || raw(s)]));
  for (const c of cues) c.speaker = c.speaker ? names[c.speaker] : '';
  return cues;
}

export const POINTING = /^(this|that|these|those|here|there|it)$/i;

// Same speaker, gap under 1.5 s, never across a page change, write or marker (checked between cues):
// one quotable line that still sits next to what was on screen. A line ends at a sentence end once
// it is 4 s long, at a clause end once it is `maxS` long, anywhere at `hardS`, so a line's time is
// never far from its words. Word times are shared out by length inside each cue; `points` holds the
// time of each pointing word ("this", "here").
export function mergeCues(cues, breaks = [], { maxS = 8, hardS = 12 } = {}) {
  const out = [];
  let cur = null;
  const close = () => { if (cur) out.push(cur); cur = null; };
  for (const c of cues) {
    if (cur && (cur.speaker !== c.speaker || c.start - cur.end >= 1.5 || breaks.some((t) => t > cur.start && t <= c.start))) close();
    const words = c.text.split(/\s+/).filter(Boolean);
    const total = words.reduce((n, w) => n + w.length + 1, 0) || 1;
    let at = c.start;
    for (const w of words) {
      const len = (c.end - c.start) * (w.length + 1) / total;
      if (!cur) cur = { start: at, end: at + len, speaker: c.speaker, text: w, points: [] };
      else { cur.text += ' ' + w; cur.end = at + len; }
      if (POINTING.test(w.replace(/[^\w]/g, ''))) cur.points.push(at);
      at += len;
      const dur = cur.end - cur.start;
      if ((/[.?!]["')]*$/.test(w) && dur >= 4) || (/[,;:]$/.test(w) && dur >= maxS) || dur >= hardS) close();
    }
  }
  close();
  return out;
}

// "Step 2 of 6" and "Step 3 of 6" are one message updating; "X sent to review" and "X moved back to
// draft" are two messages that share a subject.
const sameMessage = (a, b) => a === b || (/\d/.test(a) && a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#'));

// Text the app showed on its own (not within 1.5 s of a click or key), or in a live region.
export const isNotice = (e) => e.live || e.sinceInput >= 1500;

// Times (seconds from chapter start) worth a screenshot: after each page change, click, marker and write.
export function shotTimes(actions, startMs, durationS) {
  const want = [];
  for (const e of actions) {
    const t = (e.t - startMs) / 1000;
    if (e.ev === 'nav') want.push(t + 1.2);
    else if (['click', 'rightclick', 'drop'].includes(e.ev)) want.push(t + 0.6);
    else if (e.ev === 'mark' || (e.ev === 'note' && !e.edit)) want.push(t);
    else if (e.ev === 'write') want.push(t + 0.4);
    else if (['deadclick', 'select'].includes(e.ev)) want.push(t);
    else if (e.ev === 'slow' && e.ms >= 500) want.push(t);
    else if (e.ev === 'text' && isNotice(e)) want.push(t + 0.3);
    else if (e.ev === 'dialog' && e.open) want.push(t + 0.3);
    else if (e.ev === 'view') want.push(t + 0.5);
  }
  // A still every 20 s when nothing else happened, so every SAY has a nearby picture.
  for (let t = 1; t < durationS; t += 20) if (!want.some((w) => Math.abs(w - t) < 10)) want.push(t);
  const kept = [];
  for (const t of want.map((t) => Math.min(Math.max(0, t), Math.max(0, durationS - 0.6))).sort((a, b) => a - b)) {
    if (!kept.length || t - kept[kept.length - 1] >= 2.5) kept.push(t);
  }
  return kept;
}

const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' | ');
const ctxText = (items) => Object.entries(items || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(' · ');
// Console errors that are a failed fetch, not the app's own bug: they belong to an OUTAGE.
const NETWORK_ERROR = /CORS policy|Failed to fetch|NetworkError|Load failed|net::ERR_|schema cache|\b50[234]\b/i;

// Failing requests (5xx or no answer) 3 or more within 10 s of each other: the backend, not the
// last click. Returns [{ start, end, events }] in ms.
export function outages(actions, ignore) {
  const fails = actions.filter((e) => (e.ev === 'write' || e.ev === 'http') && !(ignore && ignore.test(String(e.url))) && isOutageFail(e));
  const groups = [];
  for (const e of fails) {
    const g = groups.at(-1);
    if (g && e.t - g.end <= 10000) { g.events.push(e); g.end = e.t; } else groups.push({ start: e.t, end: e.t, events: [e] });
  }
  return groups.filter((g) => g.events.length >= 3);
}

// findSource(testid) -> "path:line" or null (process.mjs builds it from the app's repo).
// Older recordings logged generic wrapper ids (config genericTestids) as the element's id: drop them,
// so the name falls back to text, row and context and no src line points at the wrapper.
export function dropGenericIds(actions, generic = ['async-boundary']) {
  const g = new Set((Array.isArray(generic) ? generic : String(generic || '').split(',')).map((x) => String(x).trim()).filter(Boolean));
  if (!g.size) return actions;
  const fix = (el) => {
    if (!el || !(g.has(el.testid) || g.has(el.region))) return el;
    const out = { ...el };
    if (g.has(out.region)) delete out.region;
    if (g.has(out.testid)) { out.testid = out.region || null; delete out.region; }
    return out;
  };
  return actions.map((e) => (e.el || e.inside ? { ...e, el: fix(e.el), ...(e.inside ? { inside: e.inside.filter((x) => !g.has(x.testid)) } : {}) } : e));
}

export function buildTimeline({ actions, startMs, cues, shots = [], appOrigin, ignoreWrites, ignoreConsole, chapterDir, readRpcs, writeRpcs, findSource, genericTestids }) {
  actions = dropGenericIds(actions, genericTestids);
  const ignore = ignoreWrites ? new RegExp(ignoreWrites, 'i') : null;
  const noise = ignoreConsole ? new RegExp(ignoreConsole, 'i') : null;
  const rpcRules = { readRpcs, writeRpcs };
  const sec = (ms) => (ms - startMs) / 1000;
  const rows = [];
  const breaks = actions.filter((e) => ['nav', 'mark', 'write'].includes(e.ev)).map((e) => sec(e.t));
  for (const c of mergeCues(cues, breaks)) rows.push({ t: c.start, end: c.end, kind: 'SAY', points: c.points, text: `${c.speaker ? c.speaker + ': ' : ''}${c.text}` });
  // Outages first: their requests and network console errors fold into one line each.
  const outs = outages(actions, ignore);
  const inOutage = new Set(outs.flatMap((o) => o.events));
  const outageAt = (t) => outs.find((o) => t >= o.start - 1000 && t <= o.end + 3000);
  for (const o of outs) {
    const by = new Map();
    for (const e of o.events) { const k = writeLabel(e, appOrigin); by.set(k, (by.get(k) || 0) + 1); }
    const said = o.events.map((e) => bodySummary(e.resBody)).find(Boolean);
    const lasts = Math.round((o.end - o.start) / 1000);
    rows.push({ t: sec(o.start), kind: 'OUTAGE', outage: o, errors: 0, errorText: '', base: `${o.events.length} requests failed${lasts ? ` over ${lasts} s` : ' at once'}: ` +
      [...by].map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`).join(', ') + (said ? `; server said ${said}` : '') });
  }
  let lastNav = null, lastClick = null, ctx = null;
  const snaps = [], tips = [];
  for (const e of actions) {
    const t = sec(e.t);
    const el = e.el || {};
    switch (e.ev) {
      case 'nav': {
        const u = cleanUrl(e.url, appOrigin);
        if (u === lastNav) break;
        lastNav = u;
        rows.push({ t, kind: 'NAV', base: u, text: u, ctx });
        break;
      }
      case 'context': {
        // Sent after each page load and when a value changes: the NAV it followed carries it;
        // a change with no page change is its own line.
        const was = ctx;
        ctx = e.items || {};
        const nav = rows.findLast((r) => r.kind === 'NAV');
        if (nav && t - nav.t < 5 && !nav.ctxSeen) { nav.ctx = ctx; nav.ctxSeen = true; break; }
        if (ctxText(ctx) === ctxText(was)) break;
        const changed = Object.keys(ctx).filter((k) => ctx[k] !== was?.[k]);
        rows.push({ t, kind: 'CONTEXT', text: changed.map((k) => `${k}: ${ctx[k] || '(none)'}${was?.[k] ? ` (was ${was[k]})` : ''}`).join(' · ') });
        break;
      }
      case 'click': case 'rightclick': case 'dragstart': case 'drop': {
        const lab = label(el);
        const risky = isRisky(el);
        const key = `${e.ev}|${lab}|${e.url}`;
        if (lastClick && lastClick.key === key && t - lastClick.t < 1.5) {
          lastClick.row.count++; lastClick.t = t; break;
        }
        const row = { t, kind: risky ? 'RISK' : 'CLICK', ev: e.ev, lab, testid: el.testid, url: cleanUrl(e.url, appOrigin), count: 1 };
        rows.push(row);
        lastClick = { key, t, row };
        break;
      }
      case 'note': {
        if (e.edit) {
          const n = rows.findLast((r) => r.kind === 'NOTE' && r.id === e.id);
          if (n && e.moved) { n.lab = label(el); n.testid = el.testid || e.inside?.find((x) => x.testid)?.testid; if (e.inside) n.inside = e.inside.slice(0, 15).map((x) => `${String(x.testid || '').replace(UUID, (m) => m.slice(0, 8))}${x.text ? ` "${oneLine(x.text).slice(0, 40)}"` : ''}`).join(', '); }
          else if (n) n.said = e.text;
          break;
        }
        // Crops live in the session folder, one up from the chapter's timeline.
        const rel = (p) => (!p ? '' : chapterDir && fs.existsSync(path.join(chapterDir, p)) ? p : path.join('..', p));
        rows.push({ t, kind: 'NOTE', id: e.id, mode: e.mode || 'pin', lab: label(el), testid: el.testid || e.inside?.find((x) => x.testid)?.testid, said: e.text,
          files: [rel(e.shot), e.full ? `full ${rel(e.full)}` : ''].filter(Boolean).join('; '),
          inside: (e.inside || []).slice(0, 15).map((x) => `${String(x.testid || '').replace(UUID, (m) => m.slice(0, 8))}${x.text ? ` "${oneLine(x.text).slice(0, 40)}"` : ''}`).join(', ') });
        break;
      }
      case 'hover': rows.push({ t, kind: 'HOVER', text: `[${label(el)}]${e.ms ? ` ${(e.ms / 1000).toFixed(1)} s` : ''}` }); break;
      case 'tooltip': {
        const text = oneLine(e.text).slice(0, 200);
        tips.push({ t, text });
        rows.push({ t, kind: 'TIP', text: `"${text}"${e.el ? ` on [${label(el)}]` : ''}` });
        break;
      }
      // A plain key outside a field is an app shortcut ("P" to pin); with a modifier or a named key
      // (arrows, Escape) it is navigation, full view only.
      case 'key': rows.push({ t, kind: 'KEY', single: !!e.single || /^[^+]$/.test(String(e.key)), text: `${e.key} [${label(el)}]` }); break;
      case 'change': {
        const shown = e.option != null && e.option !== '' ? `"${String(e.option).slice(0, 80)}"` : String(e.value ?? '').replace(UUID, (m) => m.slice(0, 8)).slice(0, 80);
        rows.push({ t, kind: 'CHANGE', text: `[${label(el)}] = ${shown}` });
        break;
      }
      case 'write': case 'http': {
        if (inOutage.has(e)) break;
        if (e.ev === 'http' && noise && noise.test(e.url)) break;
        const kind = writeKind(e, ignore, rpcRules);
        if (!kind) break;
        const said = isFailed(e) ? bodySummary(e.resBody) : '';
        const text = writeLabel(e, appOrigin) + (e.ms >= 1000 ? ` (${(e.ms / 1000).toFixed(1)} s)` : '') + (said ? `: ${said}` : '');
        const prev = rows.findLast((r) => r.kind === kind && r.base === text);
        if (prev && t - prev.last < 1.5) { prev.count++; prev.last = t; prev.text = `${text} x${prev.count}`; break; }
        rows.push({ t, kind, text, base: text, count: 1, last: t, failed: isFailed(e), req: isFailed(e) && e.reqBody ? oneLine(e.reqBody).replace(UUID, (m) => m.slice(0, 8)) : '' });
        break;
      }
      case 'console': case 'pageerror': {
        // The browser's "Failed to load resource" repeats a WRITE or FAIL line that names the request.
        if (e.ev === 'console' && (/^Failed to load resource/.test(e.text) || (noise && noise.test(e.text)))) break;
        const kind = e.ev === 'pageerror' || e.level === 'error' ? 'ERROR' : 'WARN';
        const o = kind === 'ERROR' && outageAt(e.t);
        if (o && NETWORK_ERROR.test(e.text)) {
          const r = rows.find((x) => x.kind === 'OUTAGE' && x.outage === o);
          r.errors++; r.errorText ||= oneLine(e.text).slice(0, 120);
          break;
        }
        // The same message again within 2 minutes is one line: (x68), first time kept.
        const text = oneLine(e.text).replace(UUID, (m) => m.slice(0, 8));
        const prev = rows.findLast((r) => r.kind === kind && r.base === text);
        if (prev && t - prev.last < 120) { prev.count++; prev.last = t; break; }
        rows.push({ t, kind, base: text, text, count: 1, last: t, outage: o || null });
        break;
      }
      case 'mark': rows.push({ t, kind: 'MARK', text: e.text }); break;
      case 'deadclick': {
        const lab = label(el), prev = rows.findLast((r) => r.kind === 'DEAD' && r.lab === lab);
        if (prev && t - prev.last < 2) { prev.count++; prev.last = t; prev.text = `[${lab}] x${prev.count} changed nothing for 1 s on ${cleanUrl(e.url, appOrigin)}`; break; }
        // A button or link that does nothing is worth reading; a cell or label clicked once is usually pointing.
        const real = ['button', 'a'].includes(el.tag) || ['button', 'link', 'menuitem', 'tab'].includes(el.role);
        rows.push({ t, kind: 'DEAD', lab, testid: el.testid, count: 1, last: t, real, text: `[${lab}] changed nothing for 1 s on ${cleanUrl(e.url, appOrigin)}` });
        break;
      }
      case 'select': rows.push({ t, kind: 'SELECT', text: `"${e.text}"${el.testid ? ` in ${el.testid.replace(UUID, (m) => m.slice(0, 8))}` : ''}` }); break;
      case 'slow': {
        // One row per interaction (pointerdown, pointerup and click share an id); keep the click's name.
        const prev = e.id && rows.findLast((r) => r.kind === 'SLOW' && r.id === e.id);
        const text = `${e.name} on [${label(el)}] took ${(e.ms / 1000).toFixed(1)} s of interaction latency (Event Timing; async readiness not measured)${e.busy ? `; busy: ${e.busy}` : ''}`;
        if (prev) { if (e.name === 'click' || e.ms > prev.ms) Object.assign(prev, { ms: Math.max(prev.ms, e.ms), short: Math.max(prev.ms, e.ms) >= 500, text }); break; }
        rows.push({ t, kind: 'SLOW', id: e.id, ms: e.ms, short: e.ms >= 500, text });
        break;
      }
      case 'load': rows.push({ t, kind: 'LOAD', short: e.load > 3000, text: `${cleanUrl(e.url, appOrigin)} first byte ${(e.ttfb / 1000).toFixed(1)} s, ready ${(e.dcl / 1000).toFixed(1)} s, loaded ${(e.load / 1000).toFixed(1)} s` }); break;
      case 'away': rows.push({ t, kind: 'AWAY', text: `left the browser for ${e.s} s${e.app ? ` (in ${e.app})` : ''}` }); break;
      case 'text': {
        // A tooltip is the pointer's doing, not the app speaking up: the TIP line says it.
        if (e.lines.every((x) => tips.some((p) => Math.abs(p.t - t) < 2 && (p.text.includes(x) || x.includes(p.text))))) break;
        const text = e.lines.map((x) => `"${x.replace(UUID, (m) => m.slice(0, 8))}"`).join(' ') + (e.srOnly ? ' (screen-reader text, not visible)' : '');
        // Text in the first 2.5 s after a page change is the page loading (recordings made before
        // the page itself knew that).
        const loading = rows.findLast((r) => r.kind === 'NAV' && t - r.t < 2.5);
        if (e.lines.length === 1 && /^(loading|saving|working)\W*$/i.test(e.lines[0])) break;
        if (!isNotice(e) || (loading && !e.live)) { rows.push({ t, kind: 'SHOWS', text }); break; }
        // The same message again (a live region repeating it), or a progress message that keeps
        // changing ("Step 2 of 6", "Step 3 of 6"): one line, first time kept, latest text.
        const key = e.lines.join('\n');
        const prev = rows.findLast((r) => r.kind === 'NOTICE');
        if (prev && sameMessage(prev.key, key) && t - prev.last < 20) {
          prev.count++; prev.last = t;
          if (prev.key !== key) prev.text = `${text} (updated x${prev.count}, last at ${clock(t)})`;
          prev.key = key;
          break;
        }
        rows.push({ t, kind: 'NOTICE', key, last: t, count: 1, text });
        break;
      }
      case 'dialog': {
        // An untitled dialog (a popover, a picker) is named by the click that opened it.
        const opener = !e.title && lastClick && t - lastClick.t < 2 ? ` from [${lastClick.row.lab}]` : '';
        rows.push({ t, kind: 'DIALOG', short: !!e.open, text: `${e.open ? 'opened' : 'closed'}${e.title ? `: "${e.title}"` : `${opener} (no title)`}` });
        break;
      }
      case 'view': {
        // The heading that a page change brought: one NAV line says both.
        const nav = rows.findLast((r) => r.kind === 'NAV');
        if (nav && t - nav.t < 3 && !nav.view) { nav.view = e.text; break; }
        rows.push({ t, kind: 'VIEW', text: `"${e.text}"` });
        break;
      }
      case 'paste': rows.push({ t, kind: 'PASTE', text: `${e.len} characters into [${label(el)}]` }); break;
      // The log holds an absolute path; the session's snapshots/ folder holds the file, wherever the
      // folder has been moved or copied since.
      case 'snapshot': snaps.push({ t, file: chapterDir ? path.join('..', 'snapshots', path.basename(e.file)) : e.file, why: e.why }); break;
      default: break;
    }
  }
  for (const r of rows) {
    if (r.kind === 'CLICK' || r.kind === 'RISK') r.text = `${r.ev === 'click' ? '' : r.ev + ' '}[${r.lab}]${r.count > 1 ? ` x${r.count}` : ''} on ${r.url}`;
    else if (r.kind === 'NAV') r.text = `${r.base}${r.view ? `  "${r.view}"` : ''}${ctxText(r.ctx) ? ` [${ctxText(r.ctx)}]` : ''}`;
    else if (r.kind === 'NOTE') r.text = `#${r.id} ${r.mode} on ${r.lab} — ${r.said ? `"${oneLine(r.said)}"` : '(voice note: see SAY lines around it)'}${r.files ? `  (${r.files})` : ''}`;
    else if (r.kind === 'OUTAGE') r.text = r.base + (r.errors ? `; ${r.errors} console error${r.errors > 1 ? 's' : ''} like "${r.errorText}"` : '');
    else if ((r.kind === 'ERROR' || r.kind === 'WARN') && r.count > 1) r.text = `${r.base} (x${r.count}${r.last - r.t >= 1 ? `, last at ${clock(r.last)}` : ''})`;
    if (findSource && r.testid && ['NOTE', 'CLICK', 'RISK', 'DEAD'].includes(r.kind)) r.src = findSource(r.testid);
  }
  // Rage clicks (PostHog's rule): 3 or more clicks, each within 30 px and 1 s of the one before.
  const clicks = actions.filter((e) => e.ev === 'click' && e.x != null);
  for (let i = 0; i < clicks.length; i++) {
    let j = i;
    while (j + 1 < clicks.length && clicks[j + 1].t - clicks[j].t < 1000 && Math.abs(clicks[j + 1].x - clicks[j].x) + Math.abs(clicks[j + 1].y - clicks[j].y) < 30) j++;
    if (j - i >= 2) {
      const el0 = clicks[i].el || {};
      rows.push({ t: sec(clicks[i].t), kind: 'RAGE', n: j - i + 1, editable: !!el0.editable, lab: label(el0), text: `${j - i + 1} fast clicks on [${label(el0)}] on ${cleanUrl(clicks[i].url, appOrigin)}` });
      i = j;
    }
  }
  // Double- and triple-clicks to edit or select are not frustration. A burst counts when nothing
  // changed after it, or when it runs to five clicks.
  for (const r of rows.filter((x) => x.kind === 'RAGE')) {
    const dead = rows.find((d) => d.kind === 'DEAD' && d.t >= r.t - 0.1 && d.t - r.t < 3 && d.lab === r.lab);
    if (dead) { r.text += ', nothing changed'; rows.splice(rows.indexOf(dead), 1); }
    else if (r.editable || r.n < 5) rows.splice(rows.indexOf(r), 1);
  }
  for (const r of rows) if (r.kind === 'DEAD') r.short = r.real || r.count > 1;
  // What the pointer rested on, a tooltip, a one-key shortcut, within 4 s of a SAY line with a
  // pointing word ("this", "here"): the short view keeps every shortcut key and the hover or tooltip
  // nearest each pointing word.
  for (const s of rows.filter((r) => r.kind === 'SAY' && r.points?.length)) {
    const near = rows.filter((r) => ['HOVER', 'TIP', 'KEY'].includes(r.kind) && r.t >= s.t - 4 && r.t <= s.end + 4);
    for (const r of near) if (r.kind === 'KEY' && r.single) r.short = true;
    const look = near.filter((r) => r.kind !== 'KEY');
    for (const p of s.points) { const h = look.sort((a, b) => Math.abs(a.t - p) - Math.abs(b.t - p))[0]; if (h) h.short = true; }
  }
  rows.sort((a, b) => a.t - b.t);
  // "Blocked by CORS policy", "Failed to fetch": the console repeating a failed request, said once on it.
  for (const r of rows.filter((x) => x.kind === 'ERROR' && !x.outage && NETWORK_ERROR.test(x.base))) {
    const req = rows.find((x) => (x.kind === 'FAIL' || (x.kind === 'WRITE' && x.failed)) && Math.abs(x.t - r.t) <= 1.5);
    if (!req) continue;
    req.errors = (req.errors || 0) + r.count;
    req.errorText ||= r.base.slice(0, 120);
    rows.splice(rows.indexOf(r), 1);
  }
  for (const r of rows) if (r.errors && r.kind !== 'OUTAGE') r.text += `; ${r.errors} console error${r.errors > 1 ? 's' : ''} like "${r.errorText}"`;
  // Error clicks: an error or failed request within 2 s of a click names that click (never during
  // an outage: that is the backend, not the click).
  const userActs = rows.filter((r) => ['CLICK', 'RISK', 'KEY', 'CHANGE'].includes(r.kind));
  for (const r of rows) {
    const bad = r.kind === 'ERROR' || r.kind === 'FAIL' || (r.kind === 'WRITE' && r.failed);
    if (!bad || r.outage) continue;
    const act = userActs.filter((a) => a.t <= r.t && r.t - a.t <= 2).at(-1);
    if (act) r.text += `  [after ${act.kind === 'KEY' || act.kind === 'CHANGE' ? act.text.slice(0, 60) : act.lab} at ${clock(act.t)}]`;
  }
  // Page-text snapshots hang off the page change (or marker) they were taken after.
  for (const sn of snaps) {
    const host = rows.filter((r) => (sn.why === 'mark' ? r.kind === 'MARK' : r.kind === 'NAV') && r.t <= sn.t).at(-1);
    if (host && !host.snap) host.snap = sn.file;
  }
  // Attach the latest screenshot at or before each line (a NOTE names its own crop).
  let si = -1;
  for (const r of rows) {
    while (si + 1 < shots.length && shots[si + 1].t <= r.t + 1.3) si++;
    r.shot = r.kind === 'NOTE' ? null : si >= 0 ? shots[si].file : null;
  }
  return rows;
}

const SHORT = new Set(['SAY', 'NAV', 'VIEW', 'NOTICE', 'WRITE', 'FAIL', 'OUTAGE', 'RISK', 'MARK', 'ERROR', 'RAGE', 'SELECT', 'AWAY', 'NOTE', 'CONTEXT', 'CHANGE']);
// Lines that get an indented "src:" (where the test id is defined), per view.
const SRC_FULL = new Set(['NOTE', 'CLICK', 'RISK', 'DEAD']);
const SRC_SHORT = new Set(['NOTE', 'RISK', 'DEAD']);

// Sections from what the screen says changed: page changes, a new main heading, markers. Sections
// shorter than a minute fold into the next one. Returns [{ t, title }], the first at 0.
export function screenSections(rows, durationS) {
  // A page is named by its heading when it has one, else by its path.
  const cuts = rows.filter((r) => r.kind === 'NAV' || r.kind === 'VIEW' || r.kind === 'MARK')
    .map((r) => ({ t: r.t, title: r.kind === 'NAV' ? r.view || r.text.split(/\s|\?/)[0] : r.text.replace(/^"|"$/g, ''), mark: r.kind === 'MARK' }));
  const end = durationS || (rows.at(-1)?.t ?? 0) + 1;
  cuts.forEach((c, i) => { c.stay = (cuts[i + 1]?.t ?? end) - c.t; });
  // Changes less than a minute apart are one section, named after the screen it stayed on longest
  // (a marker's words win); a section starts at its first change.
  const groups = [];
  for (const c of cuts) {
    const g = groups.at(-1);
    if (g && c.t - g[0].t < 60 && !c.mark) g.push(c); else groups.push([c]);
  }
  const out = groups.map((g) => ({ t: g[0].t, title: (g.find((c) => c.mark) || g.reduce((a, b) => (b.stay > a.stay ? b : a))).title }));
  // Neighbours with the same name are one section.
  const merged = out.filter((s, i) => i === 0 || s.title !== out[i - 1].title);
  if (!merged.length || merged[0].t > 5) merged.unshift({ t: 0, title: 'Start' });
  else merged[0].t = 0;
  return durationS ? merged.filter((s) => s.t < durationS - 30 || s.t === 0) : merged;
}

export function renderTimeline(rows, { title, startMs, short, replays = [], sections = [], version }) {
  const list = short ? rows.filter((r) => SHORT.has(r.kind) || r.short) : rows;
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const started = new Date(startMs);
  const head = [
    `# ${title}${short ? ' (short)' : ''}`,
    '',
    `Started ${started.toLocaleString()} (times below are from this point)${version ? `; built by ux-walk ${version}` : ''}. ` +
      Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') + '.',
    short ? 'Speech, notes (NOTE), page changes with their context, new headings (VIEW), messages the app showed on its own (NOTICE), dialogs opening, choices (CHANGE), writes, failed reads (FAIL), outages, risky clicks, buttons that did nothing, rage clicks, selected text, slow moments, markers and errors; HOVER, TIP and KEY only next to a pointing word ("this", "here"). timeline.md has every click, key, hover, read RPC and the text each click brought up (SHOWS).' : 'Short view: timeline-short.md. READ = a read-only RPC (Supabase sends those as POST); FAIL = a read that failed; OUTAGE = 3+ requests failing (5xx or no answer) within 10 s. SHOWS = new text within 1.5 s of a click or key (its answer); NOTICE = new text later, or in a live region (the app speaking up); TIP = a tooltip; HOVER = the pointer resting on something. "src:" = where that test id is defined in the app\'s code.',
    'A path in parentheses at the end of a line is the screenshot on screen at that moment; "text:" points at the page text (accessibility tree) after a page change.',
    ...replays.map((r) => (r.tool === 'Environment' ? `Environment: ${r.link}` : `${r.tool} replay of this session: ${r.link}`)),
    '',
    '',
  ];
  if (sections.length > 1) head.splice(head.length - 2, 0, `Sections: ${sections.map((x) => `${clock(x.t)} ${x.title}`).join(' · ')}`);
  let lastShot = null, lastSrc = null, si = 0;
  const body = [];
  for (const r of list) {
    while (sections.length > 1 && si < sections.length && sections[si].t <= r.t) { body.push('', `## ${clock(sections[si].t)} ${sections[si].title}`, ''); si++; }
    const shot = r.shot && r.shot !== lastShot ? `  (${r.shot})` : '';
    if (r.shot) lastShot = r.shot;
    body.push(`${clock(r.t)}  ${r.kind.padEnd(6)} ${r.text}${shot}${r.snap ? `  (text: ${r.snap})` : ''}`);
    const pad = ' '.repeat(7);
    // The same file:line twice in a row is said once (ten clicks on one kind of chip).
    if (r.src && (short ? SRC_SHORT : SRC_FULL).has(r.kind) && (r.kind === 'NOTE' || r.src !== lastSrc)) { body.push(`${pad}src: ${r.src}`); lastSrc = r.src; }
    if (r.kind === 'NOTE' && r.inside) body.push(`${pad}inside: ${r.inside}`);
    if (!short && r.req) body.push(`${pad}request: ${r.req.slice(0, 600)}`);
  }
  return { text: head.join('\n') + body.join('\n') + '\n', counts, lines: list.length };
}

export function readActions(file, fromMs, toMs) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.t >= fromMs - 500 && (toMs == null || e.t <= toMs + 500));
}

export function listShots(dir) {
  const d = path.join(dir, 'shots');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.jpg')).sort().map((f) => {
    const m = f.match(/-(\d+)m(\d+(?:\.\d+)?)s\.jpg$/);
    return { t: m ? Number(m[1]) * 60 + Number(m[2]) : 0, file: `shots/${f}` };
  }).sort((a, b) => a.t - b.t); // frames saved later by "ux-walk frame" sort in by time
}
