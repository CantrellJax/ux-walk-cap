// Metadata only: no bodies, headers, credentials, query values or fragments.
export function safeUrl(value) {
  try { const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return ''; }
}
export function requestMetadata({ requestId, url, method, startedAt, completedAt, status = null, failure = null, source = 'captured' }) {
  let waitMs = null;
  const pagination = {};
  try { const n = new URL(url).searchParams.get('wait_ms'); if (n !== null && /^\d+$/.test(n) && Number.isSafeInteger(Number(n))) waitMs = Number(n);
    const query = new URL(url).searchParams;
    for (const k of ['offset', 'limit', 'since_seq']) { const v = query.get(k); if (v !== null && /^\d+$/.test(v) && Number.isSafeInteger(Number(v))) pagination[k] = Number(v); } } catch {}
  return { ev: 'network', requestId, source, url: safeUrl(url), method, startedAt, completedAt,
    durationMs: Math.max(0, completedAt - startedAt), status, ...(failure ? { failure: String(failure).slice(0, 400) } : {}),
    ...(Object.keys(pagination).length ? { pagination } : {}), intentionalLongPoll: waitMs !== null && waitMs > 0, ...(waitMs !== null ? { waitMs } : {}) };
}
// Listen at completion, including successful GETs and failures after response headers arrived.
let nextRequest = 0;
export function watchNetwork(page, write, clock = Date.now, requestContext = () => ({})) {
  const requests = new WeakMap();
  page.on('request', (r) => requests.set(r, { requestId: `net-${++nextRequest}`, startedAt: clock(), context: requestContext() }));
  const complete = async (r, failed) => {
    const start = requests.get(r); if (!start) return;
    requests.delete(r);
    const completedAt = clock();
    const response = await r.response().catch(() => null);
    write({ ...requestMetadata({ ...start, completedAt, url: r.url(), method: r.method(), status: response?.status() ?? null, failure: failed ? r.failure()?.errorText || 'Request failed' : null }), ...start.context });
  };
  page.on('requestfinished', (r) => { complete(r, false).catch(() => {}); });
  page.on('requestfailed', (r) => { complete(r, true).catch(() => {}); });
}
