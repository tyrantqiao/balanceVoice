import test from 'node:test';
import assert from 'node:assert/strict';
import { BalanceDSP } from '../extension/dsp.js';
import { sanitizeSettings } from '../extension/settings.js';

function signal(dsp, amplitude, seconds = 8, channels = 2) {
  const output = Array.from({ length: channels }, () => new Float32Array(128));
  const input = Array.from({ length: channels }, () => new Float32Array(128));
  let phase = 0;
  let peak = 0;
  for (let block = 0; block < seconds * 48000 / 128; block++) {
    for (let i = 0; i < 128; i++) {
      const sample = amplitude * Math.sin(phase++ * 2 * Math.PI * 440 / 48000);
      for (let c = 0; c < channels; c++) input[c][i] = sample * (c === 0 ? 1 : -1);
    }
    dsp.process(input, output);
    for (const channel of output) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  return { ...dsp.metrics, peak, output };
}

test('不同网页的稳定响度趋近同一个目标', () => {
  const quiet = signal(new BalanceDSP(48000, { volume: 70 }), 0.05);
  const loud = signal(new BalanceDSP(48000, { volume: 70 }), 0.8);
  assert.ok(Math.abs(quiet.outputRms - 0.07) < 0.004);
  assert.ok(Math.abs(loud.outputRms - 0.07) < 0.004);
  assert.ok(Math.abs(20 * Math.log10(quiet.outputRms / loud.outputRms)) < 1);
});

test('突然高音量与过载输入受到峰值保护', () => {
  const dsp = new BalanceDSP(48000, { volume: 100 });
  signal(dsp, 0.04);
  const result = signal(dsp, 4, 0.1);
  assert.ok(result.peak <= 0.950001, `peak=${result.peak}`);
});

test('静音期间不继续提升增益，最大增益不超过四倍', () => {
  const dsp = new BalanceDSP(48000, { volume: 100 });
  signal(dsp, 0.01);
  const gain = dsp.gain;
  const silence = signal(dsp, 0, 3);
  assert.equal(silence.peak, 0);
  assert.equal(dsp.gain, gain);
  assert.ok(dsp.gain <= 4);
});

test('关闭均衡保留原始比例，统一音量独立生效', () => {
  const result = signal(new BalanceDSP(48000, { volume: 50, normalize: false }), 0.2);
  assert.ok(Math.abs(result.outputRms - 0.2 * Math.SQRT1_2 * 0.5) < 0.002);
});

test('音量变化平滑，调至零后保持静音', () => {
  const dsp = new BalanceDSP(48000, { volume: 70 });
  signal(dsp, 0.4, 1);
  dsp.configure({ volume: 0 });
  const result = signal(dsp, 0.4, 1);
  assert.ok(result.outputRms < 1e-10);
});

test('立体声反相通道不会抵消响度检测', () => {
  const result = signal(new BalanceDSP(48000, { volume: 100 }), 0.5);
  assert.ok(result.inputRms > 0.3);
  assert.ok(Math.abs(result.outputRms - 0.1) < 0.004);
  for (let i = 0; i < 128; i++) assert.equal(result.output[0][i], -result.output[1][i]);
});

test('没有输入以及非法采样值不会生成 NaN 或残留声音', () => {
  const dsp = new BalanceDSP(48000);
  const output = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
  dsp.process([], output);
  assert.ok(output.every(channel => channel.every(sample => sample === 0)));
  dsp.process([new Float32Array(128).fill(NaN)], output);
  assert.ok(output.every(channel => channel.every(sample => sample === 0)));
});

test('设置校验保留零值并拒绝非法输入', () => {
  assert.deepEqual(sanitizeSettings({ volume: 0, normalize: false }), { volume: 0, normalize: false, autoEnable: true, maxDbfs: -1 });
  assert.equal(sanitizeSettings({ autoEnable: false }).autoEnable, false);
  assert.equal(sanitizeSettings({ volume: 999 }).volume, 100);
  assert.equal(sanitizeSettings({ volume: -2 }).volume, 0);
  assert.equal(sanitizeSettings({ volume: '20' }).volume, 70);
  assert.equal(sanitizeSettings({ volume: NaN }).volume, 70);
  assert.equal(sanitizeSettings({ maxDbfs: -99 }).maxDbfs, -60);
  assert.equal(sanitizeSettings({ maxDbfs: 10 }).maxDbfs, 0);
  assert.equal(sanitizeSettings({ maxDbfs: NaN }).maxDbfs, -1);
});

test('分贝峰值上限独立于音量和均衡开关，突发过载也不超过设置值', () => {
  for (const normalize of [true, false]) {
    for (const maxDbfs of [-40, -20, -6]) {
      const dsp = new BalanceDSP(48000, { volume: 100, normalize, maxDbfs });
      const result = signal(dsp, 4, 1);
      assert.ok(result.peak <= 10 ** (maxDbfs / 20) + 1e-7, `${normalize} / ${maxDbfs}: ${result.peak}`);
    }
  }
});

test('播放中降低分贝上限，从下一处理块开始生效', () => {
  const dsp = new BalanceDSP(48000, { volume: 100, normalize: false });
  signal(dsp, .8, .1);
  dsp.configure({ volume: 100, normalize: false, maxDbfs: -50 });
  const result = signal(dsp, .8, .1);
  assert.ok(result.peak <= 10 ** (-50 / 20) + 1e-7);
  assert.ok(result.outputPeak <= 10 ** (-50 / 20) + 1e-7);
});
