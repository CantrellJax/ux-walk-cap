// One user-selected tab per live recording. No broad host permission, browser debugger or page hooks.
export function createTabRecorder({ api, callNative, uuid = () => crypto.randomUUID() }) {
  let target = null, lastError = '';
  const init = (async () => {
    const local = await api.storage.local.get('clientId');
    if (!local.clientId) { local.clientId = uuid(); await api.storage.local.set({ clientId: local.clientId }); }
    target = (await api.storage.session.get('target')).target || null;
    return local.clientId;
  })();
  const save = () => api.storage.session.set({ target });
  const message = (type, more = {}) => ({ type, ...target, ...more });
  async function stopLocal() {
    const old = target; target = null; await save();
    if (old) await api.tabs.sendMessage(old.tabId, { type: 'uxw-tab-stop' }).catch(() => {});
  }
  async function stop(reason) {
    try { if (target) await callNative(message('tab-stop', { reason })); }
    finally { await stopLocal(); }
  }
  async function checkpoint() {
    const t = target;
    if (!t) throw new Error('Select a tab first.');
    const [visible] = await api.tabs.query({ active: true, windowId: t.windowId });
    if (visible?.id !== t.tabId) throw new Error('Bring the selected tab into view before checkpointing.');
    const result = await api.tabs.sendMessage(t.tabId, { type: 'uxw-tab-checkpoint', bindingId: t.bindingId });
    if (!result?.ok) throw new Error(result?.error || 'The selected page did not return evidence.');
    if (target !== t) throw new Error('Tab selection changed.');
    result.data.context.zoom = await api.tabs.getZoom(t.tabId);
    return callNative(message('tab-checkpoint', { data: result.data }));
  }
  return {
    async control(m) {
      const clientId = await init;
      try {
        const status = await callNative({ type: 'hello', clientId });
        if (target && (!status.recording || status.recordingId !== target.recordingId)) await stopLocal();
        if (!target && status.target) { target = status.target; await save(); }
        if (m.action === 'status') return { ok: true, target, recording: status.recording, lastError };
        if (m.action === 'stop') { await stop('Stopped by user'); lastError = ''; return { ok: true, target: null }; }
        if (m.action === 'checkpoint') return { ok: true, result: await checkpoint() };
        if (m.action !== 'start') throw new Error('Unknown tab control.');
        if (target) throw new Error('A tab is already selected. Stop its collection first.');
        if (!status.recording) throw new Error('Start a ux-walk recording first.');
        if (!Number.isInteger(m.tabId) || !Number.isInteger(m.windowId)) throw new Error('Open the extension from the intended test tab.');
        const tab = await api.tabs.get(m.tabId);
        if (tab.windowId !== m.windowId) throw new Error('The selected tab moved; select it again.');
        if (!tab?.url || !/^https?:\/\//.test(tab.url)) throw new Error('Select an HTTP/HTTPS test page.');
        target = await callNative({ type: 'tab-start', clientId, tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, recordingId: status.recordingId });
        await save();
        try {
          await api.scripting.executeScript({ target: { tabId: target.tabId }, files: ['selected-tab.js'] });
          const ready = await api.tabs.sendMessage(target.tabId, { type: 'uxw-tab-start', bindingId: target.bindingId });
          if (!ready?.ok) throw new Error(ready?.error || 'Could not observe the selected page.');
          await checkpoint();
        } catch (error) { await stop(`Could not attach: ${error.message}`).catch(() => {}); throw error; }
        lastError = ''; return { ok: true, target };
      } catch (error) { lastError = error.message; return { ok: false, error: error.message, target }; }
    },
    async observed(m, sender) {
      await init;
      try {
        if (!target || sender.tab?.id !== target.tabId || sender.frameId !== 0 || m.bindingId !== target.bindingId || new URL(sender.url).origin !== target.origin) throw new Error('Observation is outside the selected tab.');
        try { await callNative(message('tab-event', { data: m.data })); }
        catch (error) { await stop(error.message).catch(() => {}); throw error; }
        return { ok: true };
      } catch (error) { lastError = error.message; return { ok: false, error: error.message }; }
    },
    async status(status) {
      await init;
      if (target && (!status.recording || status.recordingId !== target.recordingId)) await stopLocal();
    },
    async updated(tabId, change, tab) {
      await init;
      if (!target || target.tabId !== tabId) return;
      if (change.url && new URL(change.url).origin !== target.origin) { lastError = 'Origin changed; select the tab again.'; await stop(lastError).catch(() => {}); return; }
      if (change.status === 'complete') {
        try {
          if (tab.url && new URL(tab.url).origin !== target.origin) throw new Error('Origin changed; select the tab again.');
          await api.scripting.executeScript({ target: { tabId }, files: ['selected-tab.js'] });
          const reply = await api.tabs.sendMessage(tabId, { type: 'uxw-tab-start', bindingId: target.bindingId });
          if (!reply?.ok) throw new Error(reply?.error || 'Could not resume this tab.');
        } catch (error) { lastError = error.message; await stop(lastError).catch(() => {}); }
      }
    },
    async removed(tabId) { await init; if (target?.tabId === tabId) await stop('Selected tab closed').catch(() => {}); },
  };
}
