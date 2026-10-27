import { sanitizeSettings } from './settings.js';
import { sanitizeTabControl, effectiveSettings, aggregateFrames } from './tab-state.js';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
let queue = Promise.resolve();
const reports = new Map();

async function controls() {
  return (await chrome.storage.session.get('tabControls')).tabControls || {};
}

async function pageSettings(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return effectiveSettings(await settings(), sanitizeTabControl((await controls())[tabId]), tab.mutedInfo?.muted);
}

function serialized(task) {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
}

async function hasOffscreen() {
  return (await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL],
  })).length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['USER_MEDIA'],
    justification: '在本机均衡用户启用的标签页声音并播放处理后的音频。',
  });
}

async function audio(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
  if (!response?.ok) throw new Error(response?.error || '音频处理页面没有响应，请重试。');
  return response.data;
}

async function settings() {
  return sanitizeSettings((await chrome.storage.local.get('settings')).settings);
}

async function sendPage(tabId, captured, value) {
  // Restricted pages and tabs opened before installation may have no receiver.
  await chrome.tabs.sendMessage(tabId, {
    target: 'automatic', captured, settings: value || await pageSettings(tabId),
  }).catch(() => {});
}

async function syncPages(sessions) {
  const value = await settings();
  const overrides = await controls();
  const captured = new Set(sessions.map(session => session.tabId));
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    const next = effectiveSettings(value, sanitizeTabControl(overrides[tab.id]), tab.mutedInfo?.muted);
    await sendPage(tab.id, captured.has(tab.id), next);
    if (captured.has(tab.id)) await audio('TAB_SETTINGS', { tabId: tab.id, settings: next });
  }));
}

async function updateBadge(sessions) {
  const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
  const value = await settings();
  const overrides = await controls();
  const ids = new Set(sessions.map(session => session.tabId));
  if (value.autoEnable) {
    for (const [id, frames] of Object.entries(stored)) {
      if (!sanitizeTabControl(overrides[id]).stopped && Object.values(frames).some(frame => frame.count > 0)) ids.add(Number(id));
    }
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#65dec0' });
  await chrome.action.setBadgeText({ text: ids.size ? String(ids.size) : '' });
  await chrome.action.setTitle({ title: ids.size ? `Balance Voice · 正在管理 ${ids.size} 个网页` : 'Balance Voice · 暂无音视频网页正在管理' });
}

async function state() {
  const sessions = await hasOffscreen() ? await audio('STATE') : [];
  // Titles are only available for tabs for which activeTab was granted.
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  // Each frame reports separately; do not trust the single sendMessage response
  // to represent every iframe in a tab. Polling only runs while the popup is open.
  await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { target: 'automatic', type: 'INSPECT' }).catch(() => {})));
  const overrides = await controls();
  const value = await settings();
  const pages = new Map();
  for (const [tabId, frames] of reports) {
    if (!byId.has(tabId)) { reports.delete(tabId); continue; }
    const fresh = [...frames.values()].filter(frame => Date.now() - frame.at < 5000);
    const summary = aggregateFrames(fresh);
    if (summary.mediaCount) pages.set(tabId, {
      ...summary, tabId, mode: 'automatic', title: byId.get(tabId)?.title || fresh.find(frame => frame.title)?.title || '音视频网页',
    });
  }
  for (const session of sessions) pages.set(session.tabId, { ...session, mode: 'capture', estimated: false });
  const rows = [...pages.values()].map(page => {
    const control = sanitizeTabControl(overrides[page.tabId]);
    const muted = Boolean(byId.get(page.tabId)?.mutedInfo?.muted);
    const stopped = control.stopped || (page.mode === 'automatic' && !value.autoEnable);
    return { ...page, title: byId.get(page.tabId)?.title || page.title || '音视频网页',
      muted, stopped, volume: control.volume ?? value.volume, followsGlobal: control.volume === null,
      outputRms: muted ? 0 : page.outputRms };
  });
  await updateBadge(sessions);
  return {
    settings: value,
    pages: rows,
    sessions: sessions.map(session => ({
      ...session, title: byId.get(session.tabId)?.title || session.title || '已启用的标签页',
      muted: Boolean(byId.get(session.tabId)?.mutedInfo?.muted),
    })),
  };
}

async function handle(message, sender) {
  if (message.type === 'PAGE_PRESENCE') {
    if (!Number.isInteger(message.mediaCount) || message.mediaCount < 0 || message.mediaCount > 10000) return;
    const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
    const tabId = sender.tab.id;
    const frameId = sender.frameId || 0;
    const documentId = sender.documentId || sender.url;
    stored[tabId] ||= {};
    const previous = stored[tabId][frameId];
    if (message.mediaCount) stored[tabId][frameId] = { count: message.mediaCount, documentId };
    else if (!previous || previous.documentId === documentId) delete stored[tabId][frameId];
    if (!Object.keys(stored[tabId]).length) delete stored[tabId];
    await chrome.storage.session.set({ managedFrames: stored });
    await updateBadge(await hasOffscreen() ? await audio('STATE') : []);
    return;
  }
  if (message.type === 'PAGE_STATE') {
    const sessions = await hasOffscreen() ? await audio('STATE') : [];
    return { settings: await pageSettings(sender.tab.id), captured: sessions.some(session => session.tabId === sender.tab.id) };
  }
  if (message.type === 'SESSIONS_CHANGED') {
    if (sender.url !== OFFSCREEN_URL) throw new Error('无效的音频来源。');
    const sessions = await audio('STATE');
    await updateBadge(sessions);
    if (!sessions.length) await chrome.offscreen.closeDocument();
    await syncPages(sessions);
    return;
  }
  if (message.type === 'STATE') return state();
  if (message.type === 'TAB_CONTROL') {
    if (!Number.isInteger(message.tabId)) throw new Error('无效的网页。');
    const tab = await chrome.tabs.get(message.tabId);
    const all = await controls();
    const current = sanitizeTabControl(all[tab.id]);
    if (typeof message.muted === 'boolean') await chrome.tabs.update(tab.id, { muted: message.muted });
    if (message.volume === null) current.volume = null;
    else if (Number.isFinite(message.volume)) current.volume = message.volume;
    else if (message.delta === 10 || message.delta === -10) {
      current.volume = (current.volume ?? (await settings()).volume) + message.delta;
    }
    if (typeof message.stopped === 'boolean') current.stopped = message.stopped;
    all[tab.id] = sanitizeTabControl(current);
    await chrome.storage.session.set({ tabControls: all });
    if (current.stopped && await hasOffscreen()) {
      await audio('STOP', { tabId: tab.id });
      if (!(await audio('STATE')).length) await chrome.offscreen.closeDocument();
    }
    await syncPages(await hasOffscreen() ? await audio('STATE') : []);
    return state();
  }
  if (message.type === 'SETTINGS') {
    const next = sanitizeSettings({ ...await settings(), ...message.settings });
    await chrome.storage.local.set({ settings: next });
    await syncPages(await hasOffscreen() ? await audio('STATE') : []);
    await updateBadge(await hasOffscreen() ? await audio('STATE') : []);
    return next;
  }
  if (message.type === 'START') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) {
      throw new Error('请在普通 HTTP / HTTPS 网页中启用，浏览器内部页面不支持。');
    }
    await ensureOffscreen();
    const all = await controls();
    all[tab.id] = { ...sanitizeTabControl(all[tab.id]), stopped: false };
    await chrome.storage.session.set({ tabControls: all });
    const existing = await audio('STATE');
    if (!existing.some(session => session.tabId === tab.id)) {
      try {
        // Let the capture processor own gain; never apply automatic volume twice.
        await sendPage(tab.id, true);
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        await audio('START', { tabId: tab.id, title: tab.title, streamId, settings: await pageSettings(tab.id) });
      } catch (error) {
        await sendPage(tab.id, false);
        if (!(await audio('STATE')).length) await chrome.offscreen.closeDocument();
        throw error;
      }
    }
    await sendPage(tab.id, true);
    return state();
  }
  if (message.type === 'STOP' || message.type === 'STOP_ALL') {
    if (await hasOffscreen()) {
      await audio(message.type, { tabId: message.tabId });
      if (!(await audio('STATE')).length) await chrome.offscreen.closeDocument();
    }
    await syncPages(await hasOffscreen() ? await audio('STATE') : []);
    return state();
  }
  throw new Error('未知操作。');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  const popupUrl = chrome.runtime.getURL('popup.html');
  const trustedPage = sender.url === popupUrl || sender.url === OFFSCREEN_URL;
  if (!trustedPage && sender.tab && message.type === 'PAGE_REPORT') {
    const raw = message.data;
    if (raw && Number.isInteger(raw.mediaCount) && raw.mediaCount >= 0 && raw.mediaCount <= 10000 &&
        Number.isInteger(raw.playingCount) && raw.playingCount >= 0 && raw.playingCount <= raw.mediaCount) {
      const safeLevel = level => Number.isFinite(level) && level >= 0 && level <= 100 ? level : null;
      if (!reports.has(sender.tab.id)) reports.set(sender.tab.id, new Map());
      reports.get(sender.tab.id).set(sender.frameId || 0, {
        mediaCount: raw.mediaCount, playingCount: raw.playingCount,
        inputRms: safeLevel(raw.inputRms), outputRms: safeLevel(raw.outputRms),
        title: sender.frameId ? '' : String(raw.title || '').slice(0, 200), at: Date.now(),
      });
    }
    respond({ ok: true });
    return;
  }
  if (!trustedPage && (!sender.tab || !['PAGE_STATE', 'PAGE_PRESENCE'].includes(message.type))) return;
  serialized(() => handle(message, sender)).then(
    data => respond({ ok: true, data }),
    error => respond({ ok: false, error: error.message }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  reports.delete(tabId);
  serialized(async () => {
    const all = await controls();
    delete all[tabId];
    await chrome.storage.session.set({ tabControls: all });
    const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
    delete stored[tabId];
    await chrome.storage.session.set({ managedFrames: stored });
    if (!(await hasOffscreen())) { await updateBadge([]); return; }
    await audio('STOP', { tabId });
    const sessions = await audio('STATE');
    await updateBadge(sessions);
    if (!sessions.length) await chrome.offscreen.closeDocument();
  }).catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') {
    reports.delete(tabId);
    serialized(async () => {
      const stored = (await chrome.storage.session.get('managedFrames')).managedFrames || {};
      delete stored[tabId];
      await chrome.storage.session.set({ managedFrames: stored });
      await updateBadge(await hasOffscreen() ? await audio('STATE') : []);
    }).catch(console.error);
  }
  if (change.mutedInfo) serialized(async () => {
    await syncPages(await hasOffscreen() ? await audio('STATE') : []);
  }).catch(console.error);
});

chrome.runtime.onInstalled.addListener(() => {
  serialized(async () => {
    await chrome.storage.local.set({ settings: await settings() });
    await updateBadge([]);
  }).catch(console.error);
});
