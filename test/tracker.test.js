// 라운드 나누기 도우미.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { segmentRanges, segmentAt, knownTurns } = require('../src/shared/tracker');

const step = (turn, label) => ({ turn, label, text: `${label} ${turn}턴` });

const RUNNING = [
  step(0, '1라운드'), step(4, '1라운드'), step(8, '1라운드'),
  step(12, '2라운드'), step(16, '2라운드'),
  step(20, '3라운드'),
];

const RESET = [
  step(0, '1라운드'), step(4, '1라운드'),
  step(0, '2라운드'), step(4, '2라운드'),
  step(0, '3라운드'),
];

test('라운드 구간을 나눈다', () => {
  assert.deepStrictEqual(segmentRanges(RUNNING), [[0, 2], [3, 4], [5, 5]]);
  assert.deepStrictEqual(segmentRanges(RESET), [[0, 1], [2, 3], [4, 4]]);
  assert.deepStrictEqual(segmentRanges([]), []);
  assert.deepStrictEqual(segmentRanges(/** @type {any} */ (null)), []);
});

test('단계가 어느 라운드인지', () => {
  const r = segmentRanges(RUNNING);
  assert.strictEqual(segmentAt(r, 0), 0);
  assert.strictEqual(segmentAt(r, 4), 1);
  assert.strictEqual(segmentAt(r, 5), 2);
  assert.strictEqual(segmentAt(r, 99), 0, '범위 밖이면 0');
});

test('빌드에 나오는 턴 목록 — 인식 후보로 쓴다', () => {
  assert.deepStrictEqual(knownTurns(RUNNING), [0, 4, 8, 12, 16, 20]);
  assert.deepStrictEqual(knownTurns(RESET), [0, 4]);
  assert.deepStrictEqual(knownTurns([]), []);
});
