import test from 'node:test';
import assert from 'node:assert/strict';
import { assessOutput, OUTPUT_REFERENCE } from '../extension/level-guide.js';

const at = db => assessOutput({ outputRms: 10 ** (db / 20) });

test('RMS 电平参考范围及偏高提示边界', () => {
  assert.deepEqual(OUTPUT_REFERENCE, { low: -30, high: -18 });
  assert.equal(at(-31).tone, 'quiet');
  assert.equal(at(-30).tone, 'reference');
  assert.equal(at(-23).tone, 'reference');
  assert.equal(at(-18).tone, 'reference');
  assert.equal(at(-17.9).tone, 'elevated');
  assert.equal(at(-6).tone, 'elevated');
  assert.equal(at(-5.9).tone, 'high');
  assert.equal(at(0).tone, 'high');
});

test('无法读取、暂停输出和停止处理不被标成参考范围或听力安全', () => {
  for (const outputRms of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(assessOutput({ outputRms }).tone, 'unknown');
  }
  assert.equal(assessOutput({ outputRms: 0 }).label, '当前无输出');
  assert.equal(assessOutput({ outputRms: 1, muted: true }).label, '已静音');
  assert.equal(assessOutput({ outputRms: .07, stopped: true }).tone, 'unknown');
  assert.equal(/安全/.test(at(-23).label), false);
});
