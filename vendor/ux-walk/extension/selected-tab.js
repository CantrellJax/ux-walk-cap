// Injected only after the user selects this HTTP(S) tab through the extension action.
(() => {
  if (globalThis.__capUXSelectedTab?.runtime === chrome.runtime) return;
  globalThis.__capUXSelectedTab = { runtime: chrome.runtime };
  let bindingId = null;
  let observeClicks = true;
  let clockEpoch = 0;
  const privateSelector = 'input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[data-uxw-private],[data-private],script,style,noscript,template';
  const privateNode = (el) => !el || !!el.closest(privateSelector);
  const context = () => ({ url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio });
  function visibleText(root, max = 64000) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = []; let length = 0, visited = 0, truncated = false, node;
    while ((node = walker.nextNode())) {
      if (++visited > 10000) { truncated = true; break; }
      const el = node.parentElement;
      if (privateNode(el) || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible' || el.closest('[hidden],[aria-hidden="true"]')) continue;
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const remaining = max - length;
      parts.push(text.slice(0, remaining)); length += text.length + 1;
      if (length >= max) { truncated = true; break; }
    }
    return { text: parts.join('\n').slice(0, max), truncated };
  }
  function snapshot() {
    if (document.visibilityState !== 'visible') throw new Error('Bring the selected tab into view before checkpointing.');
    return { observedAt: Date.now(), context: context(), ...visibleText(document.body) };
  }
  document.addEventListener('click', (event) => {
    if (!bindingId || !observeClicks || !event.isTrusted || document.visibilityState !== 'visible' || privateNode(event.target)) return;
    const el = event.target.closest('button,a,[role="button"],[role="tab"],[data-testid]') || event.target;
    if (privateNode(el)) return;
    const named = el.matches('button,a,[role="button"],[role="tab"]');
    const data = { kind: 'click', observedAt: Date.now(), context: context(), point: { x: event.clientX, y: event.clientY },
      element: { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', testid: el.getAttribute('data-testid') || '',
        name: (el.getAttribute('aria-label') || (named ? visibleText(el, 160).text : '') || '').slice(0, 160) } };
    chrome.runtime.sendMessage({ type: 'tab-observed', bindingId, clockEpoch, data }).then((r) => { if (r && !r.ok) bindingId = null; }).catch(() => { bindingId = null; });
  }, true);
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m.type === 'companion-tab-state') { bindingId = m.recording ? m.binding?.bindingId : null; clockEpoch = m.clockEpoch; observeClicks = m.observeClicks !== false; reply({ ok: true }); return; }
    if (m.type === 'uxw-tab-stop') { bindingId = null; reply({ ok: true }); return; }
    if (m.type !== 'uxw-tab-start' && m.type !== 'uxw-tab-checkpoint' && m.type !== 'companion-tab-checkpoint') return;
    try {
      if (m.type === 'uxw-tab-start') { bindingId = m.bindingId; observeClicks = m.observeClicks !== false; }
      if (!bindingId || bindingId !== m.bindingId) throw new Error('Tab is not selected.');
      reply({ ok: true, data: snapshot() });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });
})();
