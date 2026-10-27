import test from 'node:test';
import assert from 'node:assert/strict';

test('后台捕获生命周期、设置同步、worker 重启恢复和失败清理', async () => {
  const listeners = {};
  let offscreen = false;
  let stored;
  let failCapture = false;
  let badge = '';
  let creates = 0;
  let captures = 0;
  const sessions = new Map();
  const tab = { id: 7, url: 'https://example.com/video', title: '示例视频' };
  let applied;
  let sessionData = {};
  globalThis.chrome = {
    runtime: {
      id: 'test', getURL: file => `chrome-extension://test/${file}`,
      getContexts: async () => offscreen ? [{}] : [],
      onMessage: { addListener: fn => { listeners.message = fn; } },
      onInstalled: { addListener: fn => { listeners.installed = fn; } },
      sendMessage: async message => {
        assert.equal(message.target, 'offscreen');
        if (!offscreen) throw new Error('no offscreen');
        if (message.type === 'STATE') return { ok: true, data: [...sessions.values()] };
        if (message.type === 'START') sessions.set(message.tabId, { tabId: message.tabId, title: message.title });
        if (message.type === 'STOP') sessions.delete(message.tabId);
        if (message.type === 'STOP_ALL') sessions.clear();
        if (message.type === 'TAB_SETTINGS') applied = message.settings;
        return { ok: true };
      },
    },
    offscreen: {
      createDocument: async () => { assert.equal(offscreen, false); offscreen = true; creates++; },
      closeDocument: async () => { offscreen = false; },
    },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      update: async (id, value) => { tab.mutedInfo = { muted: value.muted }; return tab; },
      sendMessage: async () => ({ ok: true }),
      onRemoved: { addListener: fn => { listeners.removed = fn; } },
      onUpdated: { addListener: fn => { listeners.updated = fn; } },
    },
    storage: { local: {
      get: async () => ({ settings: stored }),
      set: async value => { stored = value.settings; },
    }, session: {
      get: async () => sessionData,
      set: async value => { sessionData = { ...sessionData, ...structuredClone(value) }; },
    } },
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async value => { badge = value.text; },
      setTitle: async () => {},
    },
    tabCapture: { getMediaStreamId: async () => {
      if (failCapture) throw new Error('capture denied');
      captures++;
      return 'stream';
    } },
  };
  const sender = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const send = (type, data = {}, from = sender) => new Promise(resolve => {
    listeners.message({ target: 'background', type, ...data }, from, resolve);
  });
  await import('../extension/background.js?initial');
  assert.equal((await send('STATE')).data.settings.volume, 70);
  const both = await Promise.all([send('START'), send('START')]);
  assert.ok(both.every(response => response.ok));
  assert.equal(creates, 1);
  assert.equal(captures, 1);
  assert.equal(sessions.size, 1);
  assert.equal(badge, '1');
  await send('SETTINGS', { settings: { volume: 31, normalize: false } });
  assert.deepEqual(applied, { volume: 31, normalize: false, autoEnable: true, maxDbfs: -1 });
  const pageState = await send('PAGE_STATE', {}, { id: 'test', tab: { id: 7 }, url: tab.url });
  assert.equal(pageState.data.captured, true);
  assert.equal(pageState.data.settings.autoEnable, true);

  await send('TAB_CONTROL', { tabId: 7, delta: -10 });
  assert.equal(applied.volume, 21);
  await send('SETTINGS', { settings: { volume: 90 } });
  assert.equal(applied.volume, 21); // Independent volume survives master changes.
  await send('TAB_CONTROL', { tabId: 7, muted: true });
  assert.equal(applied.volume, 0);
  assert.equal((await send('STATE')).data.pages[0].volume, 21);
  await send('TAB_CONTROL', { tabId: 7, muted: false });
  assert.equal(applied.volume, 21);
  await send('TAB_CONTROL', { tabId: 7, volume: null });
  assert.equal(applied.volume, 90);
  await send('SETTINGS', { settings: { volume: 31 } });

  // New module instance simulates service worker eviction; offscreen survives.
  await import('../extension/background.js?restarted');
  assert.equal((await send('STATE')).data.sessions.length, 1);
  assert.equal((await send('STATE')).data.settings.volume, 31);
  await send('STOP', { tabId: 7 });
  assert.equal(offscreen, false);
  assert.equal(badge, '');
  const fromFrame = { id: 'test', tab: { id: 7 }, frameId: 2, url: 'https://example.com/frame' };
  await send('PAGE_PRESENCE', { mediaCount: 1 }, fromFrame);
  assert.equal(badge, '1'); // No popup STATE request is needed.
  await send('PAGE_PRESENCE', { mediaCount: 2 }, { ...fromFrame, frameId: 0 });
  assert.equal(badge, '1'); // Frames in one tab count once.
  await import('../extension/background.js?presence-restarted');
  await send('STATE');
  assert.equal(badge, '1'); // Auto registration survives service worker eviction.
  await send('PAGE_REPORT', { data: { mediaCount: 1, playingCount: 1, inputRms: .3, outputRms: .1 } }, fromFrame);
  const autoRow = (await send('STATE')).data.pages[0];
  assert.equal(autoRow.mode, 'automatic');
  assert.equal(autoRow.inputRms, .3);
  assert.equal(autoRow.outputRms, .1);
  await send('TAB_CONTROL', { tabId: 7, stopped: true });
  assert.equal(badge, '');
  assert.equal((await send('PAGE_STATE', {}, fromFrame)).data.settings.autoEnable, false);
  await send('TAB_CONTROL', { tabId: 7, stopped: false });
  assert.equal(badge, '1');
  assert.equal((await send('PAGE_STATE', {}, fromFrame)).data.settings.autoEnable, true);
  await send('SETTINGS', { settings: { autoEnable: false } });
  assert.equal(badge, '');
  await send('SETTINGS', { settings: { autoEnable: true } });
  assert.equal(badge, '1');
  await send('PAGE_PRESENCE', { mediaCount: 0 }, fromFrame);
  await send('PAGE_PRESENCE', { mediaCount: 0 }, { ...fromFrame, frameId: 0 });
  assert.equal(badge, '');
  failCapture = true;
  assert.equal((await send('START')).ok, false);
  assert.equal(offscreen, false);
  failCapture = false;
  tab.url = 'chrome://settings';
  assert.equal((await send('START')).ok, false);
  assert.equal(offscreen, false);
  tab.url = 'https://example.com';
  await send('START');
  await send('STOP_ALL');
  assert.equal(sessions.size, 0);
  assert.equal(offscreen, false);
  await send('START');
  sessions.clear(); // Chrome has ended the captured stream.
  await send('SESSIONS_CHANGED', {}, { id: 'test', url: 'chrome-extension://test/offscreen.html' });
  assert.equal(offscreen, false);
  assert.equal(badge, '');
  delete globalThis.chrome;
});
