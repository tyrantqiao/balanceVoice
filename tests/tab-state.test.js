import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFrames, effectiveSettings, sanitizeTabControl } from '../extension/tab-state.js';

test('多框架电平合并，未知音频不能伪装成静音', () => {
  const result = aggregateFrames([
    { mediaCount: 2, playingCount: 1, inputRms: .3, outputRms: .1 },
    { mediaCount: 1, playingCount: 1, inputRms: .4, outputRms: .2 },
  ]);
  assert.equal(result.mediaCount, 3);
  assert.equal(result.playingCount, 2);
  assert.equal(result.inputRms, .5);
  assert.ok(Math.abs(result.outputRms - Math.sqrt(.05)) < 1e-12);
  assert.equal(aggregateFrames([{ mediaCount: 1, playingCount: 1, inputRms: null, outputRms: null }]).inputRms, null);
  assert.equal(aggregateFrames([{ mediaCount: 1, playingCount: 0, inputRms: null, outputRms: null }]).inputRms, 0);
});

test('单页音量、静音、停止相互独立，并支持恢复跟随统一音量', () => {
  const settings = { volume: 70, normalize: true, autoEnable: true };
  const control = sanitizeTabControl({ volume: 0, stopped: true });
  assert.equal(effectiveSettings(settings, control).volume, 0);
  assert.equal(effectiveSettings(settings, control).autoEnable, false);
  assert.equal(effectiveSettings(settings, { volume: 40, stopped: false }, true).volume, 0);
  assert.equal(effectiveSettings(settings, { volume: null, stopped: false }).volume, 70);
  assert.equal(sanitizeTabControl({ volume: 1000 }).volume, 100);
  assert.equal(sanitizeTabControl({ volume: -10 }).volume, 0);
});
