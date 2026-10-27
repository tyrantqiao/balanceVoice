import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

// Optional Chromium integration test. Uses an isolated profile, never a user's profile.
const executable = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(path.join(os.tmpdir(), 'balance-voice-smoke-'));
const extension = path.resolve('extension');
const browser = spawn(executable, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding',
  `--user-data-dir=${profile}`, '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let logs = '';
browser.stderr.on('data', chunk => { logs += chunk; });
let failure;
let server;
const timeout = setTimeout(() => { browser.kill(); }, 55000);
try {
  let id = 0;
  const pending = new Map();
  const dispatch = message => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  let received = '';
  browser.stdio[4].on('data', chunk => {
    received += chunk.toString();
    let index;
    while ((index = received.indexOf('\0')) !== -1) {
      const raw = received.slice(0, index);
      received = received.slice(index + 1);
      if (raw) dispatch(JSON.parse(raw));
    }
  });
  browser.on('error', error => { for (const item of pending.values()) item.reject(error); });
  browser.on('exit', code => {
    for (const item of pending.values()) item.reject(new Error(`浏览器退出：${code} ${logs.slice(-2000)}`));
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const requestTimeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`CDP 超时：${method} ${logs.slice(-1000)}`));
      }, 5000);
      pending.set(requestId, {
        resolve: value => { clearTimeout(requestTimeout); resolve(value); },
        reject: error => { clearTimeout(requestTimeout); reject(error); },
      });
      browser.stdio[3].write(JSON.stringify({ id: requestId, method, params, sessionId }) + '\0');
    });
  }
  const { id: extensionId } = await cdp('Extensions.loadUnpacked', { path: extension });
  let worker;
  for (let attempt = 0; attempt < 40; attempt++) {
    worker = (await cdp('Target.getTargets')).targetInfos.find(target =>
      target.type === 'service_worker' && target.url.endsWith('/background.js'));
    if (worker) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!worker) throw new Error('浏览器未启动扩展 service worker。');
  // URL.origin is "null" for chrome-extension: in Node; preserve the scheme explicitly.
  const popupUrl = worker.url.replace('background.js', 'popup.html');
  const { targetId } = await cdp('Target.createTarget', { url: popupUrl });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId);
  for (let n = 0; n < 30; n++) {
    if (await evaluate("document.getElementById('current-title')?.textContent !== '正在读取网页…' && !!document.getElementById('status')")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const initial = await evaluate("({error:document.getElementById('error').textContent,volume:document.getElementById('volume').value,title:document.getElementById('current-title').textContent})");
  if (initial.error || initial.volume !== '70' || initial.title === '正在读取网页…') throw new Error(`初始化失败：${JSON.stringify(initial)}`);
  await evaluate("document.querySelector('[data-volume=\"30\"]').click()");
  let stored;
  for (let n = 0; n < 20; n++) {
    stored = await evaluate("chrome.storage.local.get('settings')");
    if (stored.settings?.volume === 30) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (stored.settings?.volume !== 30) throw new Error('快捷音量没有持久化');
  await evaluate("document.getElementById('normalize').click()");
  for (let n = 0; n < 20; n++) {
    stored = await evaluate("chrome.storage.local.get('settings')");
    if (stored.settings?.normalize === false) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (stored.settings?.normalize !== false) throw new Error('均衡开关没有持久化');
  await evaluate("document.getElementById('max-dbfs').value=-24;document.getElementById('max-dbfs').dispatchEvent(new Event('change'))");
  await new Promise(resolve => setTimeout(resolve, 200));
  const cappedSettings = await evaluate("chrome.storage.local.get('settings')");
  if (cappedSettings.settings.maxDbfs !== -24) throw new Error('分贝数字输入未保存');
  await evaluate("document.getElementById('max-dbfs-range').value=-1;document.getElementById('max-dbfs-range').dispatchEvent(new Event('input'))");
  await evaluate("document.querySelector('[data-volume=\"70\"]').click();document.getElementById('normalize').click()");
  await new Promise(resolve => setTimeout(resolve, 300));
  const layout = await evaluate("({height:document.body.scrollHeight,width:document.body.scrollWidth,error:document.getElementById('error').textContent})");
  if (layout.width > 390 || layout.error) throw new Error(`布局/消息错误：${JSON.stringify(layout)}`);
  const screenshot = await cdp('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 390, height: layout.height, scale: 1 },
  }, sessionId);
  await mkdir('dist', { recursive: true });
  await writeFile('dist/popup-preview.png', Buffer.from(screenshot.data, 'base64'));
  console.log('真实 Chrome 扩展加载、后台消息、中文弹窗、设置持久化和布局检查通过。');
  console.log('截图：dist/popup-preview.png');
  if (process.argv.includes('--audio') || process.argv.includes('--auto')) {
    server = createServer((request, response) => {
      if (request.url.startsWith('/tone.wav')) {
        const amplitude = 0.4;
        const count = 48000;
        const wav = Buffer.alloc(44 + count * 2);
        wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
        wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
        for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(32767 * amplitude * Math.sin(i * 2 * Math.PI * 440 / 48000)), 44 + i * 2);
        response.setHeader('Content-Type', 'audio/wav');
        response.end(wav);
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>本地合成音测试</title><h1>Balance Voice 音频测试</h1>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  if (process.argv.includes('--auto')) {
    // Stop popup polling: the badge must update independently of STATE/metering.
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    const autoUrl = `http://127.0.0.1:${server.address().port}/auto`;
    const { targetId: autoTarget } = await cdp('Target.createTarget', { url: autoUrl });
    const { sessionId: autoSession } = await cdp('Target.attachToTarget', { targetId: autoTarget, flatten: true });
    const page = async expression => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, autoSession);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await new Promise(resolve => setTimeout(resolve, 300));
    await page("window.player=document.createElement('audio');player.volume=.42;player.src='/tone.wav';player.loop=true;document.body.append(player)");
    await new Promise(resolve => setTimeout(resolve, 400));
    const defaultVolume = await page('player.volume');
    if (Math.abs(defaultVolume - 0.7) > 0.001) throw new Error(`未点击扩展时默认音量错误：${defaultVolume}`);
    if (await evaluate('chrome.action.getBadgeText({})') !== '1') throw new Error('默认模式徽标在弹窗不轮询时未显示');
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{volume:31,normalize:false}})");
    await new Promise(resolve => setTimeout(resolve, 200));
    if (Math.abs(await page('player.volume') - 0.31) > 0.001) throw new Error('自动网页未同步统一音量');
    await page("window.dynamic=document.createElement('video');dynamic.volume=.6;document.body.append(dynamic)");
    await new Promise(resolve => setTimeout(resolve, 200));
    if (Math.abs(await page('dynamic.volume') - 0.31) > 0.001) throw new Error('动态播放器未自动启用');
    await page("window.frame=document.createElement('iframe');frame.src='/frame';document.body.append(frame)");
    await new Promise(resolve => setTimeout(resolve, 400));
    await page("window.framePlayer=frame.contentDocument.createElement('audio');frame.contentDocument.body.append(framePlayer)");
    await new Promise(resolve => setTimeout(resolve, 200));
    if (Math.abs(await page('framePlayer.volume') - 0.31) > 0.001) throw new Error('子框架播放器未自动启用');
    if (await evaluate('chrome.action.getBadgeText({})') !== '1') throw new Error('子框架重复计入徽标');
    await cdp('Page.reload', {}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 500));
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{autoEnable:false}})");
    await new Promise(resolve => setTimeout(resolve, 200));
    const restored = await page('[player.volume,dynamic.volume,framePlayer.volume]');
    if (restored.some((value, index) => Math.abs(value - [.42,.6,1][index]) > .001)) throw new Error(`关闭后未恢复：${restored}`);
    if (await evaluate('chrome.action.getBadgeText({})') !== '') throw new Error('关闭默认模式后徽标未清空');
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{autoEnable:true,normalize:true,volume:70}})");
    await page('player.play()');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const normalized = await page('player.volume');
    if (normalized < .18 || normalized > .35) throw new Error(`自动响度均衡未工作：${normalized}`);
    await new Promise(resolve => setTimeout(resolve, 700));
    const autoState = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    const autoRow = autoState.data.pages.find(row => row.mode === 'automatic');
    if (!autoRow || autoRow.mediaCount !== 3 || !(autoRow.inputRms > .1) || !(autoRow.outputRms > .01)) {
      throw new Error(`默认模式或子框架数据未显示：${JSON.stringify(autoState)}`);
    }
    const rowId = autoRow.tabId;
    const clickRow = async name => {
      await evaluate(`document.querySelector('[data-id="${rowId}"] .${name}').click()`);
      await new Promise(resolve => setTimeout(resolve, 500));
    };
    const controlsPresent = await evaluate(`!!document.querySelector('[data-id="${rowId}"] .mute') && !!document.querySelector('[data-id="${rowId}"] .higher')`);
    if (!controlsPresent) throw new Error('网页列表未显示单页控制按钮');
    const referenceHint = await evaluate(`document.querySelector('[data-id="${rowId}"] .output-assessment').textContent`);
    if (referenceHint !== '在数字参考范围内') throw new Error(`输出参考提示错误：${referenceHint}`);
    const hearingGuide = await evaluate("document.querySelector('.listening-guide').textContent");
    if (!hearingGuide.includes('80 dB(A)') || !hearingGuide.includes('40 小时') || !hearingGuide.includes('无法测量')) {
      throw new Error('听音安全参考缺少实际声级、时间或读数局限说明');
    }
    const activeLayout = await evaluate('document.body.scrollHeight');
    const activeScreenshot = await cdp('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 390, height: activeLayout, scale: 1 },
    }, sessionId);
    await writeFile('dist/popup-preview.png', Buffer.from(activeScreenshot.data, 'base64'));
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{normalize:false}})");
    await clickRow('lower');
    if (Math.abs(await page('player.volume') - .6) > .001) throw new Error('网页调低按钮未生效');
    await new Promise(resolve => setTimeout(resolve, 600));
    let highHint;
    for (let n = 0; n < 25; n++) {
      highHint = await evaluate(`document.querySelector('[data-id="${rowId}"] .output-assessment').textContent`);
      if (highHint === '高于参考 · 建议调低') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (highHint !== '高于参考 · 建议调低') {
      const debugState = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
      throw new Error(`偏高电平未提示：${highHint} ${JSON.stringify(debugState)}`);
    }
    await clickRow('mute');
    if (await page('player.volume') !== 0) throw new Error('网页静音按钮未生效');
    const muteHint = await evaluate(`document.querySelector('[data-id="${rowId}"] .output-assessment').textContent`);
    if (muteHint !== '已静音') throw new Error(`静音时参考提示错误：${muteHint}`);
    await clickRow('mute');
    if (Math.abs(await page('player.volume') - .6) > .001) throw new Error('取消静音未恢复此前的单页音量');
    await clickRow('higher');
    if (Math.abs(await page('player.volume') - .7) > .001) throw new Error('网页调高按钮未生效');
    await clickRow('stop-toggle');
    if (Math.abs(await page('player.volume') - .42) > .001) throw new Error('停止默认控制后未恢复网页原音量');
    await clickRow('stop-toggle');
    await clickRow('follow-global');
    const follow = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    if (!follow.data.pages.find(row => row.tabId === rowId).followsGlobal) throw new Error('跟随统一音量按钮未生效');
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{normalize:true}})");
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{normalize:false,maxDbfs:-30}})");
    await new Promise(resolve => setTimeout(resolve, 600));
    const softLimited = await page('player.volume');
    if (softLimited * .4 > 10 ** (-30 / 20) + .001) throw new Error(`默认模式分贝限幅未生效：${softLimited}`);
    // Independent tab gain must still obey the shared ceiling.
    await evaluate(`chrome.runtime.sendMessage({target:'background',type:'TAB_CONTROL',tabId:${rowId},volume:100})`);
    await new Promise(resolve => setTimeout(resolve, 300));
    if (await page('player.volume') * .4 > 10 ** (-30 / 20) + .001) throw new Error('单页音量越过全局分贝上限');
    await evaluate(`chrome.runtime.sendMessage({target:'background',type:'TAB_CONTROL',tabId:${rowId},volume:null})`);
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{normalize:true,maxDbfs:-1}})");
    // Taking over the tab restores the player's gain before worklet processing.
    await cdp('Page.bringToFront', {}, autoSession);
    const autoTab = (await cdp('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find(target => target.url === autoUrl);
    await cdp('Extensions.triggerAction', { id: extensionId, targetId: autoTab.targetId });
    const captureAuto = await evaluate("chrome.runtime.sendMessage({target:'background',type:'START'})");
    if (!captureAuto.ok) throw new Error(`自动模式切换接管失败：${captureAuto.error}`);
    if (await evaluate('chrome.action.getBadgeText({})') !== '1') throw new Error('自动与整页接管重复计数');
    if (Math.abs(await page('player.volume') - .42) > .001) throw new Error('接管模式未取消网页增益，可能重复衰减');
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'STOP_ALL'})");
    await new Promise(resolve => setTimeout(resolve, 700));
    if (Math.abs(await page('dynamic.volume') - .7) > .001) throw new Error('停止接管后自动模式未恢复');
    await page('player.pause()');
    await page('player.remove();dynamic.remove()');
    await new Promise(resolve => setTimeout(resolve, 250));
    if (await evaluate('chrome.action.getBadgeText({})') !== '1') throw new Error('只有 iframe 播放器时徽标未统计');
    await page('frame.remove()');
    await new Promise(resolve => setTimeout(resolve, 400));
    if (await evaluate('chrome.action.getBadgeText({})') !== '') throw new Error('移除最后一个 iframe 后徽标残留');
    console.log('默认模式电平/子框架汇总、列表静音/恢复、调高/调低、停止/恢复及跟随统一音量检查通过。');
    await cdp('Target.closeTarget', { targetId: autoTarget });
    await new Promise(resolve => setTimeout(resolve, 400));
    if (await evaluate('chrome.action.getBadgeText({})') !== '') throw new Error('关闭网页后徽标未清空');
    console.log('默认管理的无弹窗徽标、子框架/接管去重、全局关闭与标签页关闭清理、默认模式分贝上限通过。');
  }
  if (process.argv.includes('--audio')) {
    const testUrl = `http://127.0.0.1:${server.address().port}/`;
    const { targetId: audioTarget } = await cdp('Target.createTarget', { url: testUrl });
    const { sessionId: audioSession } = await cdp('Target.attachToTarget', { targetId: audioTarget, flatten: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    const sourceStarted = await cdp('Runtime.evaluate', { expression: `
      window.engine = new AudioContext();
      window.oscillator = engine.createOscillator();
      window.level = engine.createGain();
      level.gain.value = 0.08;
      oscillator.connect(level).connect(engine.destination);
      oscillator.start(); engine.resume();
    `, awaitPromise: true }, audioSession);
    if (sourceStarted.exceptionDetails) throw new Error(JSON.stringify(sourceStarted.exceptionDetails));
    await cdp('Page.bringToFront', {}, audioSession);
    const tabTargets = (await cdp('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
    const tabTarget = tabTargets.find(target => target.url === testUrl);
    if (!tabTarget) throw new Error(`没有找到本地声音标签页：${JSON.stringify(tabTargets)}`);
    await cdp('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
    const started = await evaluate("chrome.runtime.sendMessage({target:'background',type:'START'})");
    if (!started.ok) throw new Error(`音频接管失败：${started.error}`);
    await new Promise(resolve => setTimeout(resolve, 3500));
    const quiet = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    const quietAudio = quiet.data.sessions[0];
    if (!quietAudio || quietAudio.inputRms < 0.01 || quietAudio.outputRms < 0.01) {
      const sourceState = await cdp('Runtime.evaluate', { expression: 'engine.state', returnByValue: true }, audioSession);
      throw new Error(`捕获后没有有效音频：${JSON.stringify({quiet,sourceState})}`);
    }
    await evaluate(`chrome.runtime.sendMessage({target:'background',type:'TAB_CONTROL',tabId:${quietAudio.tabId},muted:true})`);
    await new Promise(resolve => setTimeout(resolve, 600));
    const mutedCapture = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    if (mutedCapture.data.sessions[0].outputRms > 0.00001) throw new Error('整页接管静音未实际作用于音频线程');
    await evaluate(`chrome.runtime.sendMessage({target:'background',type:'TAB_CONTROL',tabId:${quietAudio.tabId},muted:false,delta:-10})`);
    await new Promise(resolve => setTimeout(resolve, 600));
    const trimmed = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    if (Math.abs(trimmed.data.sessions[0].outputRms - .06) > .009) throw new Error('整页接管单页音量未生效');
    await evaluate(`chrome.runtime.sendMessage({target:'background',type:'TAB_CONTROL',tabId:${quietAudio.tabId},volume:null})`);
    await cdp('Runtime.evaluate', { expression: 'level.gain.value = 0.8' }, audioSession);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const loud = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    const loudAudio = loud.data.sessions[0];
    if (Math.abs(20 * Math.log10(loudAudio.outputRms / quietAudio.outputRms)) > 2) {
      throw new Error(`浏览器音频响度未收敛：${JSON.stringify({quietAudio,loudAudio})}`);
    }
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{maxDbfs:-40}})");
    await new Promise(resolve => setTimeout(resolve, 400));
    const hardLimited = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    if (hardLimited.data.sessions[0].outputPeak > .010001 || hardLimited.data.sessions[0].outputPeak < .005) {
      throw new Error(`真实音频线程分贝上限未生效：${JSON.stringify(hardLimited)}`);
    }
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{maxDbfs:-1}})");
    const secondUrl = `${testUrl}?second`;
    const { targetId: secondTarget } = await cdp('Target.createTarget', { url: secondUrl });
    const { sessionId: secondSession } = await cdp('Target.attachToTarget', { targetId: secondTarget, flatten: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    const secondSource = await cdp('Runtime.evaluate', { expression: `
      window.engine = new AudioContext();
      window.oscillator = engine.createOscillator();
      window.level = engine.createGain(); level.gain.value = 0.4;
      oscillator.connect(level).connect(engine.destination); oscillator.start(); engine.resume();
    `, awaitPromise: true }, secondSession);
    if (secondSource.exceptionDetails) throw new Error(JSON.stringify(secondSource.exceptionDetails));
    await cdp('Page.bringToFront', {}, secondSession);
    const secondTab = (await cdp('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos
      .find(target => target.url === secondUrl);
    await cdp('Extensions.triggerAction', { id: extensionId, targetId: secondTab.targetId });
    const secondStart = await evaluate("chrome.runtime.sendMessage({target:'background',type:'START'})");
    if (!secondStart.ok || secondStart.data.sessions.length !== 2) throw new Error(`双标签页接管失败：${JSON.stringify(secondStart)}`);
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'SETTINGS',settings:{volume:30}})");
    await new Promise(resolve => setTimeout(resolve, 2000));
    const shared = await evaluate("chrome.runtime.sendMessage({target:'background',type:'STATE'})");
    if (shared.data.sessions.some(session => Math.abs(session.outputRms - 0.03) > 0.006)) {
      throw new Error(`两页统一音量失败：${JSON.stringify(shared)}`);
    }
    const firstTabId = quietAudio.tabId;
    const singleStop = await evaluate(`chrome.runtime.sendMessage({target:'background',type:'STOP',tabId:${firstTabId}})`);
    if (singleStop.data.sessions.length !== 1 || singleStop.data.sessions[0].tabId === firstTabId) {
      throw new Error(`停止单页影响其他会话：${JSON.stringify(singleStop)}`);
    }
    await evaluate("chrome.runtime.sendMessage({target:'background',type:'STOP_ALL'})");
    const stopped = await evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})");
    if (stopped.length) throw new Error('停止后 offscreen 资源未释放');
    console.log(`真实 Chrome 音频接管、10 倍输入强弱均衡和停止释放通过；输出 RMS ${quietAudio.outputRms.toFixed(4)} → ${loudAudio.outputRms.toFixed(4)}。`);
    console.log('双标签页同时接管、统一音量同步、停止单页不影响另一页检查通过。');
  }
} catch (error) {
  failure = error;
} finally {
  clearTimeout(timeout);
  if (server) {
    // Close speculative/keep-alive browser connections before awaiting shutdown.
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const exited = new Promise(resolve => browser.once('exit', resolve));
  if (browser.exitCode === null) { browser.kill(); await exited; }
  // Some Windows Chromium children release profile locks a moment later.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}
if (failure) throw failure;
