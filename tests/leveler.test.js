import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/leveler.js';

test('两种模式共用的整体响度控制：跨页收敛、强音快压、恢复慢放', () => {
  for (const seconds of [128 / 48000, 0.025]) {
    const controller = new globalThis.BalanceLeveler();
    for (let t = 0; t < 8; t += seconds) controller.update(0.03 ** 2, seconds);
    assert.ok(Math.abs(controller.gain * 0.03 - 0.1) < 0.003);
    for (let t = 0; t < 0.2; t += seconds) controller.update(0.5 ** 2, seconds);
    assert.ok(controller.gain * 0.5 < 0.16);
    const reduced = controller.gain;
    for (let t = 0; t < 0.5; t += seconds) controller.update(0.03 ** 2, seconds);
    assert.ok(controller.gain <= reduced + 1e-6);
    const beforeSilence = controller.gain;
    for (let t = 0; t < 30; t += seconds) controller.update(0, seconds);
    assert.equal(controller.gain, beforeSilence);
    for (let t = 0; t < 30; t += seconds) controller.update(0.03 ** 2, seconds);
    assert.ok(Math.abs(controller.gain * 0.03 - 0.1) < 0.004);
    assert.equal(controller.update(0.5 ** 2, seconds, false), 1);
  }
});
