// 인식한 턴 → 단계 이동.
//
// 도감이 두 가지 방식으로 적혀 있어서(전체 연속 / 라운드마다 리셋) 둘 다 따라가야 한다.
// 여기 테스트는 실제로 어긋났던 상황들을 못 박아 둔 것이다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  segmentRanges,
  indexForTurn,
  nextIndexForTurn,
  nextIndexAfterGap,
  knownTurns,
  plausibleTurns,
} = require('../src/shared/tracker');

const step = (turn, label) => ({ turn, label, text: `${label} ${turn}턴` });

/** 턴이 문서 전체에서 이어지는 빌드 */
const RUNNING = [
  step(0, '1라운드'), step(4, '1라운드'), step(8, '1라운드'),
  step(12, '2라운드'), step(16, '2라운드'),
  step(20, '3라운드'),
];

/** 라운드마다 0부터 다시 시작하는 빌드 */
const RESET = [
  step(0, '1라운드'), step(4, '1라운드'),
  step(0, '2라운드'), step(4, '2라운드'),
  step(0, '3라운드'),
];

test('라운드 구간을 나눈다', () => {
  assert.deepStrictEqual(segmentRanges(RUNNING), [[0, 2], [3, 4], [5, 5]]);
  assert.deepStrictEqual(segmentRanges(RESET), [[0, 1], [2, 3], [4, 4]]);
  assert.deepStrictEqual(segmentRanges([]), []);
});

test('턴보다 크거나 같은 첫 단계가 지금 할 행동이다', () => {
  assert.strictEqual(indexForTurn(RUNNING, 0), 0);
  assert.strictEqual(indexForTurn(RUNNING, 1), 1);
  assert.strictEqual(indexForTurn(RUNNING, 4), 1);
  assert.strictEqual(indexForTurn(RUNNING, 13), 4);
});

test('전부 지나면 마지막 단계에 머문다', () => {
  assert.strictEqual(indexForTurn(RUNNING, 999), RUNNING.length - 1);
});

test('단계가 없으면 0을 돌려준다', () => {
  assert.strictEqual(nextIndexForTurn([], 0, 5), 0);
  assert.strictEqual(nextIndexAfterGap([], 0, 5), 0);
  assert.strictEqual(nextIndexForTurn(null, 0, 5), 0);
});

test('턴이 크게 줄면 전투 재시작으로 보고 처음부터 다시 따라간다', () => {
  // 3라운드(20턴)를 보던 중에 0턴이 나왔다 = 다시 시작
  assert.strictEqual(nextIndexForTurn(RUNNING, 5, 0), 0);
});

test('라운드 안에서는 되돌아갈 수 있다', () => {
  // 2라운드 두 번째 단계(16턴)를 보다가 12턴이 다시 읽히면 그 라운드 첫 단계로
  assert.strictEqual(nextIndexForTurn(RUNNING, 4, 12), 3);
});

test('지나간 라운드는 통째로 건너뛴다', () => {
  // 1라운드를 보던 중 20턴이 읽히면 2라운드를 지나 3라운드로
  assert.strictEqual(nextIndexForTurn(RUNNING, 0, 20), 5);
});

test('리셋형 빌드 — 라운드가 끝났는데 같은 숫자가 오면 다음 라운드로', () => {
  // 1라운드 마지막(4턴)에서 연출로 숫자가 사라졌다 돌아왔고, 또 0턴이 보인다
  assert.strictEqual(nextIndexForTurn(RESET, 1, 0), 0, '평소 규칙으로는 제자리(혹은 뒤로)');
  assert.strictEqual(nextIndexAfterGap(RESET, 1, 4), 2, '사라졌다 돌아왔으면 다음 라운드');
});

test('라운드에 아직 할 게 남았으면 연출이 지나간 것뿐 — 건너뛰지 않는다', () => {
  // 2라운드 첫 단계(index 2)에 있고 아직 4턴이 남았다
  assert.strictEqual(nextIndexAfterGap(RESET, 2, 0), 2);
});

test('마지막 라운드에서는 더 넘기지 않는다', () => {
  assert.strictEqual(nextIndexAfterGap(RESET, 4, 0), 4);
});

test('현재 위치가 범위를 벗어나도 안전하게 자른다', () => {
  assert.strictEqual(nextIndexForTurn(RUNNING, -5, 0), 0);
  assert.strictEqual(nextIndexForTurn(RUNNING, 999, 999), RUNNING.length - 1);
});

test('빌드에 나오는 턴 목록 — 인식 후보로 쓴다', () => {
  assert.deepStrictEqual(knownTurns(RUNNING), [0, 4, 8, 12, 16, 20]);
  assert.deepStrictEqual(knownTurns(RESET), [0, 4]);
  assert.deepStrictEqual(knownTurns([]), []);
});

test('곧 나올 법한 턴은 현재·다음·첫 라운드에서 모은다', () => {
  const soon = plausibleTurns(RUNNING, 3); // 2라운드
  assert.deepStrictEqual(soon, [0, 4, 8, 12, 16, 20]);
  assert.deepStrictEqual(plausibleTurns([], 0), []);
});
