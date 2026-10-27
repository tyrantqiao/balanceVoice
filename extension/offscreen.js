import { sanitizeSettings } from './settings.js';

const sessions = new Map();
let context;
let currentSettings = sanitizeSettings();

async function getContext() {
  if (!context || context.state === 'closed') {
    context = new AudioContext({ latencyHint: 'interactive' });
    try {
      await context.audioWorklet.addModule(chrome.runtime.getURL('normalizer-worklet.js'));
    } catch (error) {
      await context.close();
      context = undefined;
      throw error;
    }
  }
  if (context.state === 'suspended') await context.resume();
  if (context.state !== 'running') throw new Error('音频引擎未能启动，请重新启用当前网页。');
  return context;
}

function stop(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  session.node.port.onmessage = null;
  session.node.port.close();
  session.source.disconnect();
  session.node.disconnect();
  for (const track of session.stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
}

function notify() {
  chrome.runtime.sendMessage({ target: 'background', type: 'SESSIONS_CHANGED' }).catch(console.error);
}

async function start(message) {
  if (sessions.has(message.tabId)) return;
  let stream;
  let source;
  let node;
  try {
    const engine = await getContext();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
      video: false,
    });
    currentSettings = sanitizeSettings(message.settings);
    source = engine.createMediaStreamSource(stream);
    node = new AudioWorkletNode(engine, 'balance-normalizer', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit',
      processorOptions: currentSettings,
    });
    const session = { tabId: message.tabId, title: message.title, stream, source, node, settings: currentSettings,
      inputRms: 0, outputRms: 0, outputPeak: 0, gain: 1 };
    node.port.onmessage = ({ data }) => Object.assign(session, data);
    node.onprocessorerror = () => { stop(message.tabId); notify(); };
    // Capturing suppresses the tab's original output. Re-route it immediately.
    source.connect(node).connect(engine.destination);
    sessions.set(message.tabId, session);
    for (const track of stream.getTracks()) {
      track.onended = () => { stop(message.tabId); notify(); };
    }
    if (!stream.active) throw new Error('网页音频已结束，请重试。');
  } catch (error) {
    stop(message.tabId);
    source?.disconnect();
    node?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    throw error;
  }
}

function snapshot() {
  return [...sessions.values()].map(({ tabId, title, inputRms, outputRms, outputPeak, gain }) =>
    ({ tabId, title, inputRms, outputRms, outputPeak, gain }));
}

async function handle(message) {
  switch (message.type) {
    case 'START': await start(message); break;
    case 'STOP': stop(message.tabId); break;
    case 'STOP_ALL': [...sessions.keys()].forEach(stop); break;
    case 'TAB_SETTINGS': {
      const session = sessions.get(message.tabId);
      if (session) {
        session.settings = sanitizeSettings(message.settings);
        session.node.port.postMessage(session.settings);
      }
      break;
    }
    case 'SETTINGS':
      currentSettings = sanitizeSettings(message.settings);
      for (const session of sessions.values()) session.node.port.postMessage(currentSettings);
      break;
    case 'STATE': return snapshot();
    default: throw new Error('未知音频操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id ||
      sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return;
  handle(message).then(data => respond({ ok: true, data }),
    error => respond({ ok: false, error: error.message }));
  return true;
});

window.addEventListener('pagehide', () => [...sessions.keys()].forEach(stop));
