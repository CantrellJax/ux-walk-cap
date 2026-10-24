// Deterministic local report: no transcription, model calls, or remote resources.
import fs from 'node:fs';
import path from 'node:path';
const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function writeReport(dir) {
  const session = read(path.join(dir, 'session.json'), {}), ledger = read(path.join(dir, 'ledger.json'), {});
  const actionsFile = path.join(dir, 'actions.jsonl');
  const actions = (fs.existsSync(actionsFile) ? fs.readFileSync(actionsFile, 'utf8') : '').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const checkpoints = new Map(actions.filter((e) => e.ev === 'checkpoint').map((e) => [e.evidenceId, e]));
  const tabObservations = actions.filter((e) => e.ev === 'tab-observation');
  const tabCheckpoints = new Map(tabObservations.filter((e) => e.kind === 'checkpoint').map((e) => [e.evidenceId, e]));
  const link = (file, label) => {
    if (!file) return '<span class="missing">Unavailable</span>';
    const absolute = path.resolve(dir, file), relative = path.relative(dir, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(absolute)) return `<span class="missing">Missing evidence: ${esc(label || file)}</span>`;
    return `<a href="${esc(relative.split(path.sep).map(encodeURIComponent).join('/'))}">${esc(label || relative)}</a>`;
  };
  const evidence = (refs = []) => refs.map((ref) => {
    const e = checkpoints.get(ref) || tabCheckpoints.get(ref);
    return e ? [e.path ? link(e.path, ref) : '', e.cropPath ? link(e.cropPath, 'crop') : '', e.textPath ? link(e.textPath, `${e.textSource || 'selected-tab visible'} text`) : '', link(e.metadataPath, 'metadata')].filter(Boolean).join(' · ') : `<span class="missing">Missing evidence: ${esc(ref)}</span>`;
  }).join('<br>');
  const steps = new Map();
  for (const e of actions.filter((e) => e.ev === 'step')) steps.set(e.stepId, { ...steps.get(e.stepId), ...e });
  const verdictOrder = { fail: 0, 'not-tested': 1, pass: 2 };
  const severity = (f) => Number(/^P([0-4])/i.exec(f.severity || f.priority || '')?.[1] ?? 9);
  const findings = (session.chapters || []).flatMap((c) => read(path.join(dir, c.dir, 'items.json'), {}).items || [])
    .sort((a, b) => (verdictOrder[a.verdict || 'not-tested'] - verdictOrder[b.verdict || 'not-tested']) || severity(a) - severity(b) || String(a.id).localeCompare(String(b.id)));
  const network = actions.filter((e) => e.ev === 'network');
  const captureErrors = actions.filter((e) => e.ev === 'capture-error');
  const captureWarning = session.capture?.status === 'interrupted' || captureErrors.length
    ? `<aside role="alert" class="capture-warning"><strong>Recording interrupted — capture coverage is incomplete.</strong><p>${esc(session.capture?.error || captureErrors.at(-1)?.text || 'Native recording failed')}</p><p>Capture end reason: ${esc(session.capture?.endReason || 'Unavailable')}. Saved checkpoints may still be usable; this report does not establish uninterrupted video capture.</p></aside>` : '';
  const mediaState = read(path.join(dir, 'media', 'cap-session.json'), {});
  const mediaSection = session.cap ? `<h2>Cap recording and logging</h2><p>${session.cap.pendingMedia
    ? 'Log finished; Cap is still recording. Video is pending. Reconcile after its owner finishes the recording.'
    : mediaState.status === 'logging' ? 'Logging is in progress. Cap records continuously, including during logging pauses.'
    : session.cap.mediaError ? `Media is incomplete: ${esc(session.cap.mediaError)}` : 'Logging finished; the continuous source and chapter derivatives are retained locally.'}</p><p>Recording ${esc(session.cap.recordingId)}. ${session.cap.ownsRecording ? 'This logger owned the recording.' : 'Attached recording; ending logging did not stop Cap.'} Source alignment is approximate.</p><p>${link('media/cap-session.json', 'Logging ranges and clock')}${fs.existsSync(path.join(dir, 'media', 'video.mp4')) ? ` · ${link('media/video.mp4', 'Full video')} · ${link('media/media.json', 'Source manifest')}` : ''}</p>` : '';
  const rows = (values) => values.map((v) => `<td>${v}</td>`).join('');
  const tabSection = tabObservations.length || actions.some((e) => e.ev === 'tab-binding') ? `<h2>Selected-tab extension evidence</h2><p>Collection is limited to the explicitly selected tab's visible text and clicks. Form values and marked private regions are excluded by the observer. No complete DOM, console, network or iframe coverage is established. The selected browser tab and native video window have not been automatically mapped to each other.</p><table><tr><th>Observed / tab</th><th>Kind / target</th><th>Context</th><th>Evidence</th></tr>${tabObservations.map((e) => `<tr>${rows([esc(`${new Date(e.observedAt).toISOString()} / ${e.tabId}`), esc(e.kind === 'click' ? `click ${e.element?.name || e.element?.tag || ''}` : `visible text${e.truncated ? ' (truncated)' : ''}`), esc(JSON.stringify(e.context)), e.evidenceId ? evidence([e.evidenceId]) : esc(JSON.stringify(e.point || {}))])}</tr>`).join('')}</table><p>Selection lifecycle: ${actions.filter((e) => e.ev === 'tab-binding').map((e) => esc(`${e.phase} tab ${e.tabId}${e.reason ? `: ${e.reason}` : ''}`)).join(' · ')}</p>` : '';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(session.topic || 'Walk')} — evidence</title>
<style>body{font:14px system-ui;margin:32px;max-width:1400px;color:#18232f}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccd2d8;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f4f7}pre{white-space:pre-wrap;overflow-wrap:anywhere}.capture-warning{border:2px solid #a12727;background:#fff1f1;padding:16px;margin:16px 0}.missing{color:#9f2222}a{color:#1559a5}</style>
<h1>${esc(session.topic || 'Walk')} — evidence report</h1><p>Started ${esc(session.startedAt)}. Rebuilt from saved records; readiness is declared by the driver, never inferred from network idle or Event Timing.</p>
${captureWarning}
${mediaSection}
<h2>Coverage</h2><pre>${esc(JSON.stringify(session.coverage || { coverage: 'Not recorded' }, null, 2))}</pre>
<p>${link('actions.jsonl', 'Actions and request metadata')} · ${link('session.json', 'Session')} · ${link('ledger.json', 'Ledger')}</p>
${tabSection}
<h2>Steps</h2><table><tr><th>Step / persona</th><th>Last state / timing source</th><th>First feedback ms</th><th>Ready ms</th><th>Observation</th></tr>${[...steps.values()].map((s) => `<tr>${rows([esc(`${s.stepId}: ${s.name} / ${s.persona || ''}`), esc(`${s.phase} / ${s.timingSource || 'recorder-clock'}`), esc(s.firstFeedbackMs ?? 'Not recorded'), esc(s.readyMs ?? 'Not recorded'), esc(s.text || '')])}</tr>`).join('')}</table>
<h2>Findings</h2><table><tr><th>Finding</th><th>Verdict / severity / persona</th><th>Expected</th><th>Observed</th><th>Evidence / refs</th></tr>${findings.map((f) => `<tr>${rows([esc(`${f.id}: ${f.title}`), esc(`${f.verdict || 'not-tested'} / ${f.severity || f.priority || ''} / ${f.persona || ''}`), esc(f.expected || ''), esc(f.observed || f.said || ''), evidence(f.evidence) + (ledger[f.id] || []).map((l) => `<p>${esc(l.ref)} ${esc(l.note || '')}</p>`).join('')])}</tr>`).join('')}</table>
<h2>Checkpoints</h2>${[...checkpoints.values()].map((e) => `<p>${esc(e.evidenceId)} · ${esc(new Date(e.capturedAt).toISOString())} · ${esc(e.stepId || '')} · ${esc(e.persona || '')}<br>${evidence([e.evidenceId])}<br>Context: ${esc(JSON.stringify(e.context))}; context ${esc(e.contextSource)}, text ${esc(e.textSource)}${e.textObservedAt != null ? `, observed ${esc(new Date(e.textObservedAt).toISOString())}` : ', observation time unavailable'}. Text and PNG are separate observations, not an atomic snapshot.</p>`).join('')}
<h2>Network completion metadata</h2><p>All captured completion records are listed. Explicit wait_ms requests are labeled intentional long polls. Passive recording does not collect requests automatically.</p><table><tr><th>ID / step / source</th><th>Method / URL path</th><th>Status / failure</th><th>Duration ms</th><th>Long poll</th></tr>${network.map((e) => `<tr>${rows([esc(`${e.requestId} / ${e.stepId || ''} / ${e.source}`), esc(`${e.method} ${e.url}${e.pagination ? ` ${JSON.stringify(e.pagination)}` : ''}`), esc(e.failure || e.status), esc(e.durationMs), esc(e.intentionalLongPoll ? `yes, wait_ms=${e.waitMs}` : 'no')])}</tr>`).join('')}</table>
<h2>Console and observations</h2>${actions.filter((e) => ['console', 'pageerror', 'observation', 'evidence-error', 'capture-error'].includes(e.ev)).map((e) => `<pre>${esc(`${e.t} / ${e.stepId || ''} / ${e.source || 'captured'} / ${e.level || e.ev}: ${e.text}`)}</pre>`).join('')}
</html>`;
  const out = path.join(dir, 'report.html'); fs.writeFileSync(out, html); return out;
}
