// Agent checkpoints extend the same actions log, notes directory and chapter items used by human walks.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeUrl, requestMetadata } from './network.mjs';
import { writeReport } from './report.mjs';
export const EVIDENCE_COMMANDS = new Set(['checkpoint', 'step', 'observe', 'network', 'finding', 'report']);
const json = (f, value) => fs.writeFileSync(f, JSON.stringify(value, null, 2) + '\n');
const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const required = (v, label) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required`); return v.trim(); };
export function createEvidence({ dir, session, chapter, capture, write, browser = null, clock = Date.now }) {
  const steps = new Map(), requests = new Set();
  const coverage = { window: session.capture?.status === 'interrupted' ? 'interrupted; recording ended with a capture error' : 'captured', dom: browser ? 'captured on checkpoint' : 'not captured; agent supplied only', network: browser ? 'captured request completion metadata' : 'not captured; agent supplied only', console: browser ? 'captured warnings/errors' : 'not captured; agent supplied only' };
  session.coverage = coverage;
  return { coverage, activeStep: () => [...steps.values()].findLast((s) => s.state === 'running'), async run(m) {
    const requestId = required(m.requestId, 'requestId');
    if (m.evidence != null && (!Array.isArray(m.evidence) || !m.evidence.every((e) => typeof e === 'string'))) throw new Error('evidence must be an array of evidence IDs');
    if (m.context != null && (typeof m.context !== 'object' || Array.isArray(m.context))) throw new Error('context must be a metadata object');
    if (requests.has(requestId)) throw new Error(`duplicate requestId: ${requestId}`);
    requests.add(requestId);
    const at = clock(), c = chapter();
    const step = m.stepId ? steps.get(m.stepId) : null;
    if (m.stepId && !step && !(m.cmd === 'step' && m.phase === 'begin')) throw new Error(`unknown step: ${m.stepId}`);
    const base = { requestId, t: at, ...(m.stepId ? { stepId: m.stepId } : {}), ...(m.persona || step?.persona ? { persona: m.persona || step.persona } : {}) };
    if (m.cmd === 'step') {
      required(m.stepId, 'stepId');
      const phase = m.phase;
      const observedAt = m.observedAt ?? at;
      if (!Number.isFinite(observedAt) || observedAt > at || observedAt < 0) throw new Error('observedAt must be an epoch millisecond timestamp at or before receipt');
      const timing = { t: observedAt, receivedAt: at, timingSource: m.observedAt == null ? 'recorder-clock' : 'supplied' };
      if (phase === 'begin') {
        if (step) throw new Error('step already exists');
        const record = { ...base, ...timing, ev: 'step', phase, name: required(m.name, 'name'), startedAt: observedAt, lastObservedAt: observedAt, state: 'running' };
        steps.set(m.stepId, record); write(record); return record;
      }
      if (!step || step.state !== 'running') throw new Error('step is not running');
      if (!['first-feedback', 'ready', 'blocked', 'failed', 'not-tested'].includes(phase)) throw new Error('invalid step phase');
      if (observedAt < step.lastObservedAt) throw new Error('observedAt must not precede the previous phase');
      if (phase === 'first-feedback' && step.firstFeedbackAt != null) throw new Error('first feedback already recorded');
      step.lastObservedAt = observedAt;
      if (phase === 'first-feedback') step.firstFeedbackAt = observedAt;
      else { step.state = phase; step.completedAt = observedAt; }
      const record = { ...base, ...timing, ev: 'step', phase, name: step.name, startedAt: step.startedAt, elapsedMs: observedAt - step.startedAt,
        firstFeedbackMs: step.firstFeedbackAt == null ? null : step.firstFeedbackAt - step.startedAt,
        readyMs: phase === 'ready' ? observedAt - step.startedAt : null, ...(m.text ? { text: String(m.text) } : {}) };
      write(record); return record;
    }
    if (m.cmd === 'checkpoint') {
      if (!c) throw new Error('checkpoint needs an active chapter');
      if (m.textObservedAt != null && (!Number.isFinite(m.textObservedAt) || m.textObservedAt < 0 || m.textObservedAt > at)) throw new Error('textObservedAt must be at or before receipt');
      if (!browser && !capture.snapshot) throw new Error('checkpoints require the window capture backend');
      const notes = path.join(dir, 'notes'); fs.mkdirSync(notes, { recursive: true });
      const stem = `agent-${randomUUID()}`, file = path.join(notes, `${stem}.png`);
      let crop;
      if (m.crop) {
        if (!['x', 'y', 'width', 'height'].every((k) => Number.isFinite(m.crop[k])) || m.crop.x < 0 || m.crop.y < 0 || m.crop.width <= 0 || m.crop.height <= 0) throw new Error('crop must have nonnegative x/y and positive width/height, in screenshot pixels');
        crop = { ...m.crop, path: path.join(notes, `${stem}-crop.png`) };
      }
      const image = browser ? await browser.checkpoint(file, crop) : await capture.snapshot(file, { requestId, crop, timeoutMs: m.timeoutMs });
      if (!Number.isFinite(image.captureStartedAt) || image.captureStartedAt < at || (!Number.isFinite(image.capturedAt) || image.capturedAt < image.captureStartedAt)) throw new Error('capture did not produce a fresh screenshot');
      for (const f of [file, crop?.path].filter(Boolean)) {
        const bytes = fs.readFileSync(f); if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('capture returned a missing or invalid PNG');
        const fd = fs.openSync(f, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      const supplied = m.context || {};
      const context = browser ? image.context : { ...supplied, ...(supplied.url ? { url: safeUrl(supplied.url) } : {}) };
      const text = browser ? image.text : m.text;
      let textPath = null;
      if (typeof text === 'string') { textPath = path.join(notes, `${stem}.txt`); fs.writeFileSync(textPath, text); }
      const record = { ...base, ev: 'checkpoint', evidenceId: stem, path: file, cropPath: crop?.path || null, textPath,
        captureStartedAt: image.captureStartedAt, capturedAt: image.capturedAt, ...(image.bounds ? { bounds: image.bounds } : {}), width: fs.readFileSync(file).readUInt32BE(16), height: fs.readFileSync(file).readUInt32BE(20),
        textObservedAt: browser ? image.textObservedAt : (m.textObservedAt ?? null),
        context, contextSource: browser ? 'captured' : 'supplied', textSource: typeof text === 'string' ? (browser ? 'captured' : 'supplied') : 'unavailable', coverage };
      const metadataPath = path.join(notes, `${stem}.json`); json(metadataPath, record);
      write({ ...record, metadataPath }); return { ...record, metadataPath };
    }
    if (m.cmd === 'observe') {
      const record = { ...base, ev: 'observation', source: 'supplied', text: required(m.text, 'text'), ...(m.level ? { level: m.level } : {}), evidence: m.evidence || [] }; write(record); return record;
    }
    if (m.cmd === 'network') {
      if (![m.startedAt, m.completedAt].every(Number.isFinite) || m.completedAt < m.startedAt) throw new Error('valid startedAt/completedAt required');
      const record = { ...requestMetadata({ requestId, url: required(m.url, 'url'), method: m.method || 'GET', startedAt: m.startedAt, completedAt: m.completedAt, status: m.status ?? null, failure: m.failure, source: 'supplied' }), ...base };
      write(record); return record;
    }
    if (m.cmd === 'finding') {
      if (!c) throw new Error('finding needs an active chapter');
      if (!['pass', 'fail', 'not-tested'].includes(m.verdict)) throw new Error('verdict must be pass, fail, or not-tested');
      required(m.expected, 'expected'); required(m.observed, 'observed');
      if (m.verdict === 'pass' && (!step || step.state !== 'ready')) throw new Error('pass requires a ready stepId; unexercised checks are not-tested');
      const file = path.join(c.dir, 'items.json'), items = read(file, { chapter: c.n, items: [], decisions: [], questions: [] });
      const id = `C${c.n}-A${String(items.items.filter((i) => i.source === 'agent').length + 1).padStart(2, '0')}`;
      const item = { id, type: m.verdict === 'fail' ? 'bug' : 'check', title: required(m.title, 'title'), source: 'agent', ...base,
        expected: m.expected, observed: m.observed, severity: m.severity || 'info', verdict: m.verdict, evidence: m.evidence || [] };
      items.items.push(item); json(file, items); write({ ev: 'finding', ...item }); return item;
    }
    if (m.cmd === 'report') return { path: writeReport(dir), ...base };
    throw new Error(`unknown evidence command: ${m.cmd}`);
  } };
}
