// 여러 프레임을 모아 하나의 턴으로 — 한 번 잘못 읽었다고 단계가 튀면 안 된다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createVoter } = require('../src/shared/vote');

const read = (value, confidence = 0.7) => ({ value, confidence });

test('같은 값이 두 번 읽혀야 받아들인다', () => {
  const v = createVoter();
  assert.strictEqual(v.push(read(4)).accepted, null, '한 번으로는 안 받는다');
  const r = v.push(read(4));
  assert.strictEqual(r.accepted, 4);
  assert.strictEqual(r.changed, true);
});

test('한 프레임만 튄 값은 무시된다', () => {
  const v = createVoter();
  v.push(read(4));
  v.push(read(4));
  assert.strictEqual(v.push(read(88)).accepted, 4, '튄 값 하나로는 안 바뀐다');
  assert.strictEqual(v.push(read(8)).accepted, 4);
  assert.strictEqual(v.push(read(8)).accepted, 8, '두 번 이어지면 받아들인다');
});

test('확실하게 읽힌 값은 한 번에 받아들인다', () => {
  const v = createVoter();
  const r = v.push({ value: 12, confidence: 0.95 });
  assert.strictEqual(r.accepted, 12, '점수가 높으면 두 표로 친다');
});

test('후보로 맞춘 값은 확실해도 두 표를 안 준다', () => {
  const v = createVoter();
  const r = v.push({ value: 12, confidence: 0.95, snapped: true });
  assert.strictEqual(r.accepted, null);
});

test('크게 되돌아가는 값은 확인을 한 번 더 요구한다', () => {
  const v = createVoter();
  v.push(read(40));
  v.push(read(40));
  assert.strictEqual(v.push(read(4)).accepted, 40);
  assert.strictEqual(v.push(read(4)).accepted, 40, '두 번으로는 부족하다');
  assert.strictEqual(v.push(read(4)).accepted, 4, '세 번이면 재시작으로 인정');
});

test('연속으로 못 읽으면 연출 중으로 본다', () => {
  const v = createVoter();
  v.push(read(4));
  v.push(read(4));
  assert.strictEqual(v.push(null).gap, false);
  assert.strictEqual(v.push(null).gap, false);
  const r = v.push(null);
  assert.strictEqual(r.gap, true);
  assert.strictEqual(r.misses, 3);
  assert.strictEqual(r.accepted, 4, '연출 중에도 마지막 턴은 유지한다');
});

test('연출에서 돌아오면 같은 값이어도 afterGap으로 알린다', () => {
  const v = createVoter();
  v.push(read(4));
  v.push(read(4));
  for (let i = 0; i < 3; i += 1) v.push(null);
  v.push(read(4));
  const r = v.push(read(4));
  assert.strictEqual(r.afterGap, true, '라운드가 넘어갔을 수 있다고 알려야 한다');
  assert.strictEqual(r.changed, false);
});

test('reset은 모든 것을 되돌린다', () => {
  const v = createVoter();
  v.push(read(4));
  v.push(read(4));
  v.reset();
  assert.strictEqual(v.accepted, null);
  assert.strictEqual(v.everRead, false);
  assert.strictEqual(v.push(read(4)).accepted, null);
});

test('이상한 입력에도 죽지 않는다', () => {
  const v = createVoter();
  const bads = /** @type {any[]} */ ([null, undefined, {}, { value: NaN }, { value: 'x' }]);
  for (const bad of bads) {
    assert.strictEqual(v.push(bad).accepted, null);
  }
});
