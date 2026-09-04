// 턴 추적기 — API 단위 동작. 전투 흐름 자체는 test/scenarios/ 가 본다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createFollower } = require('../src/shared/follower');

const step = (turn, label) => ({ turn, label });
const RUNNING = [step(0, '1R'), step(4, '1R'), step(8, '1R'), step(12, '2R'), step(16, '2R')];
const RESET = [step(0, '1R'), step(4, '1R'), step(0, '2R'), step(4, '2R'), step(0, '3R')];
const strong = (v) => ({ value: v, confidence: 0.95 });
const weak = (v) => ({ value: v, confidence: 0.7 });

test('빌드 종류를 단계에서 스스로 알아낸다', () => {
  assert.strictEqual(createFollower(RUNNING).isReset, false);
  assert.strictEqual(createFollower(RESET).isReset, true);
});

test('앞으로 찾기는 리셋 경계를 넘지 않는다', () => {
  const f = createFollower(RESET);
  assert.strictEqual(f.forwardFrom(0, 4), 1);
  assert.strictEqual(f.forwardFrom(0, 9), 1, '이 라운드에 없으면 라운드 마지막에 머문다');
  assert.strictEqual(f.forwardFrom(2, 1), 3);
  const g = createFollower(RUNNING);
  assert.strictEqual(g.forwardFrom(0, 9), 3, '이어지는 빌드는 다음 라운드로 간다');
  assert.strictEqual(g.forwardFrom(0, 99), 4, '전부 지났으면 마지막');
});

test('흐린 읽기는 두 프레임 같아야 받아들인다', () => {
  const f = createFollower(RUNNING);
  assert.strictEqual(f.push(weak(4), 0).index, 0);
  assert.strictEqual(f.push(weak(4), 100).index, 1);
  const g = createFollower(RUNNING);
  assert.strictEqual(g.push(strong(4), 0).index, 1, '또렷하면 한 프레임');
});

test('손으로 옮기면 거기가 기준이다', () => {
  const f = createFollower(RUNNING);
  f.push(strong(4), 0);
  assert.strictEqual(f.setIndex(3), 3);
  assert.strictEqual(f.turn, null, '읽기 기억은 지운다');
  // 화면은 아직 5턴 — 옮긴 자리(12턴)보다 뒤라 그대로 둔다
  assert.strictEqual(f.push(strong(5), 100).index, 3);
  assert.strictEqual(f.push(strong(13), 200).index, 4, '지나가면 평소처럼 따라간다');
});

test('reset은 위치를 두고 읽기 기억만 지운다', () => {
  const f = createFollower(RUNNING);
  f.push(strong(9), 0);
  f.push(strong(10), 100);
  f.push(strong(11), 200);
  assert.strictEqual(f.index, 3);
  f.reset();
  assert.strictEqual(f.index, 3);
  assert.strictEqual(f.turn, null);
});

test('빈 단계 목록에서도 죽지 않는다', () => {
  const f = createFollower([]);
  assert.strictEqual(f.push(strong(4), 0).index, 0);
  assert.strictEqual(f.push(null, 100).index, 0);
  assert.strictEqual(f.setIndex(5), 0);
});

test('이상한 입력에도 죽지 않는다', () => {
  const f = createFollower(RUNNING);
  for (const bad of [null, undefined, {}, { value: NaN }, { value: 'x' }]) {
    assert.strictEqual(f.push(/** @type {any} */ (bad), 0).index, 0);
  }
});

test('결과에 왜 그렇게 판단했는지가 남는다', () => {
  const f = createFollower(RUNNING);
  assert.strictEqual(f.push(strong(4), 0).why, 'first');
  assert.strictEqual(f.push(strong(5), 100).why, 'forward');
  assert.strictEqual(f.push(strong(3), 200).why, 'pushback');
  assert.strictEqual(f.push(null, 300).why, 'hidden');
});
