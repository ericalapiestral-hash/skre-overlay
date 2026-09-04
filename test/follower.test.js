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
  assert.strictEqual(f.push(strong(4), 0).why, 'forward');
  assert.strictEqual(f.push(strong(5), 100).why, 'forward');
  assert.strictEqual(f.push(strong(3), 200).why, 'pushback');
  assert.strictEqual(f.push(null, 300).why, 'hidden');
});

test('첫 읽기도 두 단계 이상이면 P7을 거친다', () => {
  // 손으로 옮긴 직후·앱 시작 직후의 오독 한 프레임에 순간이동하면 안 된다
  const f = createFollower(RUNNING);
  assert.strictEqual(f.push(strong(9), 0).index, 0, '두 단계 건너뛰기는 기다린다');
  assert.strictEqual(f.push(strong(9), 100).index, 0);
  assert.strictEqual(f.push(strong(9), 200).index, 3);

  const g = createFollower(RUNNING);
  assert.strictEqual(g.push(strong(4), 0).index, 1, '한 단계는 바로');
});

test('P7이 기다리는 동안 오독 값이 기준이 되지 않는다', () => {
  // 기준이 오독으로 잡히면 그 뒤 진짜 턴이 전부 "큰 뒤로"가 되어 영영 갇힌다
  const f = createFollower(RUNNING);
  assert.strictEqual(f.push(strong(40), 0).index, 0);
  assert.strictEqual(f.turn, null, '아직 아무것도 안 믿는다');
  // 40을 기준으로 삼았다면 3은 "37턴 뒤로"라 갇힌다. 안 삼았으니 평소처럼 한 단계 간다.
  assert.strictEqual(f.push(strong(3), 100).index, 1);
  assert.strictEqual(f.turn, 3);
});

test('밀림은 정당하게 뛴 것을 되돌리지 않는다 (P8)', () => {
  // 4·6·8턴이 촘촘한 빌드에서 4→7로 두 단계 뛴 직후의 2턴 밀림(7→5)은
  // "뛰기 전 턴 4 근처"라 되돌리기 조건에도 들어맞는다. 밀림은 되돌릴 일이 아니다.
  const dense = [step(0, '1R'), step(4, '1R'), step(6, '1R'), step(8, '1R')];
  const f = createFollower(dense, { index: 1 });
  let t = 0;
  const feed = (v) => f.push(strong(v), (t += 100)).index;
  feed(7);
  feed(7);
  assert.strictEqual(feed(7), 3, '세 프레임 이어지면 두 단계 뛴다');
  for (let i = 0; i < 6; i += 1) assert.strictEqual(feed(5), 3, '밀림에는 단계를 안 움직인다');
});

test('잘못 뛴 것은 여전히 되돌린다 (P8)', () => {
  // 위 규칙이 P8 자체를 막으면 안 된다 — 오독으로 크게 뛴 뒤 진짜 턴이 돌아오는 경우
  const f = createFollower(RUNNING, { index: 1 });
  let t = 0;
  const feed = (v) => f.push(strong(v), (t += 100)).index;
  feed(5);
  feed(40);
  feed(40);
  assert.strictEqual(feed(40), 4, '오독이 이어져 끝까지 뛴다');
  feed(6);
  feed(6);
  // 뛰기 전 자리(index 1)로 돌아가 거기서부터 다시 따라간다 — 6턴이면 8턴 단계다
  assert.strictEqual(feed(6), 2, '진짜 턴이 돌아오면 뛰기 전 자리에서 다시 따라간다');
});

test('손으로 미리 고른 라운드의 첫 0은 이 라운드가 시작한 것이다 (P9b)', () => {
  // 1라운드가 5·6턴까지 갔는데 사용자가 2라운드 첫 단계로 미리 옮긴 경우.
  // 뒤이어 오는 0을 P5(다음 라운드로)로 읽으면 한 라운드를 통째로 건너뛴다.
  const f = createFollower(RESET, { index: 1 });
  let t = 0;
  const feed = (v) => f.push(v === null ? null : strong(v), (t += 100)).index;
  feed(5);
  assert.strictEqual(f.setIndex(2), 2);
  feed(6); // 아직 1라운드 눈금 — 2라운드 안에서 앞으로 간다
  feed(7);
  for (let i = 0; i < 6; i += 1) feed(null);
  assert.strictEqual(feed(0), 3, '한 프레임으로는 안 움직인다');
  assert.strictEqual(feed(0), 2, '2라운드 첫 단계로 다시 맞춘다 — 3라운드가 아니다');
  assert.strictEqual(feed(4), 3, '그 뒤로는 평소처럼');
});

test('같은 라운드 안에서 손으로 옮긴 것은 미리 고름이 아니다 (P9b)', () => {
  const f = createFollower(RESET, { index: 0 });
  let t = 0;
  const feed = (v) => f.push(strong(v), (t += 100)).index;
  feed(4);
  f.setIndex(1); // 1라운드 안에서 손질 — "곧 넘어간다"가 아니다
  feed(5);
  feed(0);
  assert.strictEqual(feed(0), 2, '평소대로 2라운드로 넘어간다');
});

test('받아들이지 않은 흐린 읽기는 이어짐을 끊는다', () => {
  // 또렷한 오독 2프레임 + 흐린 1프레임으로 P7의 3프레임을 채워 순간이동하면 안 된다
  const f = createFollower(RUNNING);
  let t = 0;
  assert.strictEqual(f.push(strong(16), (t += 100)).index, 0);
  assert.strictEqual(f.push(weak(9), (t += 100)).index, 0, '흐린 한 프레임은 읽기가 아니다');
  assert.strictEqual(f.push(strong(16), (t += 100)).index, 0);
  assert.strictEqual(f.push(strong(16), (t += 100)).index, 0, '끊겼으니 아직 두 프레임째');
  assert.strictEqual(f.push(strong(16), (t += 100)).index, 4);
});
