import { assessOutput, OUTPUT_REFERENCE } from './level-guide.js';

const $ = id => document.getElementById(id);
let currentTab;
let currentState;
let busy = false;
let editingUntil = 0;
let pollInProgress = false;
let settingsQueue = Promise.resolve();
const histories = new Map();

function db(level) {
  if (level === null || level === undefined) return '不可读取';
  return level > 0.00001 ? `${(20 * Math.log10(level)).toFixed(1)} dBFS` : '−∞ dBFS';
}

async function request(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!response?.ok) throw new Error(response?.error || '扩展暂时没有响应，请重新打开面板。');
  return response.data;
}

function showError(error) {
  $('error').textContent = error.message;
  $('error').hidden = false;
}

function paintVolume(value) {
  $('volume').value = value;
  $('volume-value').value = value;
  $('volume').style.background = `linear-gradient(to right, #81e5bc ${value}%, #3a5046 ${value}%)`;
  document.querySelectorAll('[data-volume]').forEach(button =>
    button.classList.toggle('selected', Number(button.dataset.volume) === Number(value)));
}

function paintCeiling(value) {
  $('max-dbfs').value = value;
  $('max-dbfs-range').value = value;
  const percent = (value + 60) / 60 * 100;
  $('max-dbfs-range').style.background = `linear-gradient(to right, #81e5bc ${percent}%, #3a5046 ${percent}%)`;
}

function saveSettings(patch) {
  editingUntil = Date.now() + 1500;
  settingsQueue = settingsQueue.then(() => request('SETTINGS', { settings: patch })).catch(showError);
}

function render(state) {
  currentState = state;
  if (Date.now() > editingUntil) {
    paintVolume(state.settings.volume);
    if (document.activeElement !== $('max-dbfs')) paintCeiling(state.settings.maxDbfs);
    $('normalize').checked = state.settings.normalize;
    $('auto-enable').checked = state.settings.autoEnable;
  }
  const enabled = state.sessions.some(session => session.tabId === currentTab?.id);
  const supported = /^https?:\/\//i.test(currentTab?.url || '');
  $('status').textContent = state.settings.autoEnable ? '全网页自动开启'
    : state.sessions.length ? `${state.sessions.length} 个网页已接管` : '自动模式已关闭';
  document.querySelector('.live').classList.toggle('active', state.settings.autoEnable || state.sessions.length > 0);
  $('current-title').textContent = currentTab?.title || '当前标签页';
  $('current-hint').textContent = enabled
    ? '整页音频均衡中，停止后回到默认模式。'
    : supported ? state.settings.autoEnable ? '音视频默认自动控制；整页接管可处理 Web Audio。'
      : '默认模式已关闭，可开启或单独接管当前网页。' : '浏览器内部页面不支持；普通网页按默认设置运行。';
  $('toggle-current').textContent = enabled ? '停止整页接管' : '增强均衡：接管当前网页';
  $('toggle-current').classList.toggle('enabled', enabled);
  $('toggle-current').disabled = busy || (!supported && !enabled);
  const pages = state.pages || state.sessions;
  $('session-count').textContent = pages.length;
  $('stop-all').hidden = state.sessions.length === 0;
  // Keep rows stable during metering so keyboard focus is not lost.
  const container = $('sessions');
  const activeIds = new Set(pages.map(session => String(session.tabId)));
  for (const id of histories.keys()) if (!activeIds.has(String(id))) histories.delete(id);
  for (const row of container.querySelectorAll('.session')) {
    if (!activeIds.has(row.dataset.id)) row.remove();
  }
  container.querySelector('.empty')?.remove();
  if (!pages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '打开含有音视频的网页，即可查看音量和实时电平。';
    container.append(empty);
  }
  for (const session of pages) {
    let row = container.querySelector(`[data-id="${session.tabId}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'session';
      row.dataset.id = session.tabId;
      const info = document.createElement('div');
      info.className = 'session-info';
      const title = document.createElement('span');
      title.className = 'session-title';
      const detail = document.createElement('span');
      detail.className = 'session-detail';
      const meter = document.createElement('div');
      meter.className = 'meter';
      meter.setAttribute('aria-hidden', 'true');
      meter.append(document.createElement('i'));
      const level = document.createElement('span');
      level.className = 'session-level';
      const cap = document.createElement('span');
      cap.className = 'session-cap';
      const guidance = document.createElement('div');
      guidance.className = 'output-guide';
      const reference = document.createElement('span');
      reference.className = 'output-reference';
      reference.textContent = `输出起始参考 ${OUTPUT_REFERENCE.low}～${OUTPUT_REFERENCE.high} dBFS`;
      const assessment = document.createElement('span');
      assessment.className = 'output-assessment';
      guidance.append(reference, assessment);
      guidance.title = '仅用于比较数字音频的 RMS 电平；该范围由产品设定，不是听力安全阈值。实际听感和风险还取决于系统音量、耳机及聆听时间。';
      const trend = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      trend.classList.add('trend');
      trend.setAttribute('viewBox', '0 0 300 22');
      trend.setAttribute('preserveAspectRatio', 'none');
      trend.setAttribute('aria-hidden', 'true');
      trend.append(document.createElementNS('http://www.w3.org/2000/svg', 'polyline'));
      info.append(title, detail, level, cap, guidance, meter, trend);
      const actions = document.createElement('div');
      actions.className = 'session-actions';
      const button = (name, text, handler) => {
        const element = document.createElement('button');
        element.className = `stop ${name}`;
        element.textContent = text;
        element.addEventListener('click', handler);
        return element;
      };
      // Read the latest snapshot on each click, not the state captured on row creation.
      const latest = () => currentState.pages.find(page => page.tabId === session.tabId);
      const mute = button('mute', '静音', () => act('TAB_CONTROL', { tabId: session.tabId, muted: !latest().muted }));
      const lower = button('lower', '−', () => act('TAB_CONTROL', { tabId: session.tabId, delta: -10 }));
      const value = document.createElement('span');
      value.className = 'tab-volume';
      const higher = button('higher', '+', () => act('TAB_CONTROL', { tabId: session.tabId, delta: 10 }));
      const follow = button('follow-global', '跟随统一', () => act('TAB_CONTROL', { tabId: session.tabId, volume: null }));
      const stop = button('stop-toggle', '停止', () => act('TAB_CONTROL', { tabId: session.tabId, stopped: !latest().stopped }));
      actions.append(mute, lower, value, higher, follow, stop);
      row.append(info, actions);
      container.append(row);
    }
    row.querySelector('.session-title').textContent = session.title;
    row.querySelector('.session-title').title = session.title;
    const mode = session.mode === 'capture' ? '整页接管' : '自动模式';
    row.querySelector('.session-detail').textContent = `${mode} · ${session.stopped ? '已停止' : session.muted ? '已静音'
      : session.volume === 0 ? '音量为零' : session.playingCount === 0 || session.inputRms === 0 ? '等待播放' : '正在播放'}${session.followsGlobal ? ' · 跟随统一' : ' · 独立音量'}`;
    row.querySelector('.session-level').textContent = `输入 ${db(session.inputRms)} → 输出 ${db(session.outputRms)}${session.estimated ? '（估算）' : ''}`;
    row.querySelector('.session-cap').textContent = session.stopped ? '未管理 · 峰值上限未生效'
      : `峰值上限 ${state.settings.maxDbfs} dBFS · ${session.mode === 'capture' ? '音频线程限幅' : session.inputRms === null ? '无法分析，仅音量衰减' : '采样调整，可能短暂超限'}`;
    const assessment = assessOutput(session);
    row.dataset.level = assessment.tone;
    row.querySelector('.output-assessment').textContent = assessment.label;
    const level = session.stopped || session.outputRms === null ? 0 : Math.min(100, Math.max(0, (20 * Math.log10(Math.max(session.outputRms, 0.00001)) + 60) / 60 * 100));
    row.querySelector('.meter i').style.width = `${level}%`;
    const history = histories.get(session.tabId) || [];
    if (!busy) history.push(level);
    if (history.length > 30) history.shift();
    histories.set(session.tabId, history);
    row.querySelector('polyline').setAttribute('points', history.map((value, index) => `${index * 300 / 29},${21 - value / 5}`).join(' '));
    row.querySelector('.mute').textContent = session.muted ? '取消静音' : '静音';
    row.querySelector('.mute').setAttribute('aria-pressed', String(session.muted));
    row.querySelector('.mute').setAttribute('aria-label', `${session.muted ? '取消静音' : '静音'}：${session.title}`);
    row.querySelector('.tab-volume').textContent = `${session.volume}%`;
    row.querySelector('.lower').setAttribute('aria-label', `调低 10%：${session.title}`);
    row.querySelector('.higher').setAttribute('aria-label', `调高 10%：${session.title}`);
    row.querySelector('.stop-toggle').textContent = session.stopped ? '恢复' : '停止';
    row.querySelector('.stop-toggle').setAttribute('aria-label', `${session.stopped ? '恢复' : '停止'}：${session.title}`);
    row.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    row.querySelector('.lower').disabled = busy || session.volume <= 0 || session.stopped;
    row.querySelector('.higher').disabled = busy || session.volume >= 100 || session.stopped;
    row.querySelector('.follow-global').disabled = busy || session.followsGlobal;
    if (session.mode === 'automatic' && !state.settings.autoEnable) {
      row.querySelector('.stop-toggle').textContent = '全局关闭';
      row.querySelector('.stop-toggle').disabled = true;
    }
  }
  $('stop-all').disabled = busy;
}

async function act(type, data) {
  if (busy) return;
  busy = true;
  $('error').hidden = true;
  render(currentState);
  try {
    await settingsQueue;
    currentState = await request(type, data);
  } catch (error) { showError(error); }
  finally { busy = false; render(currentState); }
}

$('volume').addEventListener('input', event => {
  paintVolume(event.target.value);
  saveSettings({ volume: Number(event.target.value) });
});
document.querySelectorAll('[data-volume]').forEach(button => button.addEventListener('click', () => {
  const volume = Number(button.dataset.volume);
  paintVolume(volume);
  saveSettings({ volume });
}));
$('normalize').addEventListener('change', event => saveSettings({ normalize: event.target.checked }));
$('auto-enable').addEventListener('change', event => saveSettings({ autoEnable: event.target.checked }));
$('max-dbfs-range').addEventListener('input', event => {
  const maxDbfs = Number(event.target.value);
  paintCeiling(maxDbfs);
  saveSettings({ maxDbfs });
});
$('max-dbfs').addEventListener('focus', () => { editingUntil = Infinity; });
$('max-dbfs').addEventListener('change', event => {
  const raw = event.target.value;
  if (raw === '' || !Number.isFinite(Number(raw))) return;
  const maxDbfs = Math.round(Math.max(-60, Math.min(0, Number(raw))));
  paintCeiling(maxDbfs);
  saveSettings({ maxDbfs });
});
$('max-dbfs').addEventListener('blur', () => {
  if ($('max-dbfs').value === '') paintCeiling(currentState.settings.maxDbfs);
  if (editingUntil === Infinity) editingUntil = Date.now();
});
$('toggle-current').addEventListener('click', () => {
  const enabled = currentState.sessions.some(session => session.tabId === currentTab?.id);
  act(enabled ? 'STOP' : 'START', { tabId: currentTab?.id });
});
$('stop-all').addEventListener('click', () => act('STOP_ALL'));

async function refresh() {
  if (pollInProgress || busy) return;
  pollInProgress = true;
  try {
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const state = await request('STATE');
    if (!busy) render(state);
  } catch (error) { showError(error); }
  finally { pollInProgress = false; }
}

await refresh();
const timer = setInterval(refresh, 600);
window.addEventListener('pagehide', () => clearInterval(timer));
