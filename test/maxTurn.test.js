// 최대 턴 지켜보기 — `16 / 70` 의 오른쪽을 언제 믿고 언제 안 믿는가.
//
// 이 값을 잘못 믿으면 **영영 못 읽는다** (한 자리 값만 통과시키게 되고, 안 읽히면
// 최대 턴도 다시 못 본다). 그래서 여기서 재는 건 "얼마나 빨리 믿나"가 아니라
// **잘못 믿었을 때 빠져나오는가**다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMaxTurnWatch } = require('../src/shared/maxTurn');

/** 또렷하게 읽힌 최대 턴 하나 */
const strong = (max) => ({ max, maxConfidence: 0.95 });
/** 문턱 아래로 흐리게 읽힌 것 — 표본에서 틀린 최대 턴은 전부 이랬다 (0.73) */
const weak = (max) => ({ max, maxConfidence: 0.73 });

function feed(watch, reads) {
  return reads.map((r) => watch.see(r));
}

test('또렷한 같은 값이 이어지면 믿는다', () => {
  const w = createMaxTurnWatch();
  assert.strictEqual(w.known, null, '처음에는 아무것도 안 믿는다');
  w.see(strong(70));
  assert.strictEqual(w.known, null, '한 프레임으로는 안 믿는다');
  w.see(strong(70));
  w.see(strong(70));
  assert.strictEqual(w.known, 70);
});

test('흐리게 읽힌 최대 턴은 세지 않는다', () => {
  // 표본 1008장에서 틀린 최대 턴 2장("70"을 570으로)이 전부 0.73이었다.
  // 또렷한 것만 세는 것이 잘못 믿는 걸 막는 첫 번째 겹이다.
  const w = createMaxTurnWatch();
  feed(w, [weak(570), weak(570), weak(570), weak(570)]);
  assert.strictEqual(w.known, null);
});

test('흐린 최대 턴은 프레임을 물리지도 않는다', () => {
  const w = createMaxTurnWatch();
  feed(w, [strong(70), strong(70), strong(70)]);
  assert.strictEqual(w.see(weak(570)).trust, true, '흐린 값 하나로 프레임을 버리면 손해다');
});

test('믿는 값과 다른 또렷한 값이 나오면 그 프레임을 안 믿는다', () => {
  // 슬래시를 엉뚱한 데서 잘랐다는 뜻이라 왼쪽(지금 턴)도 못 믿는다
  const w = createMaxTurnWatch();
  feed(w, [strong(70), strong(70), strong(70)]);
  const v = w.see(strong(50));
  assert.strictEqual(v.trust, false);
  assert.strictEqual(v.why, 'maxMismatch');
  assert.strictEqual(w.known, 70, '한 번 어긋났다고 갈아타지는 않는다');
});

test('다른 값만 계속 나오면 갈아탄다', () => {
  // 우리가 틀렸을 수도 있다. 채택(3)보다 더 많은 증거(8)를 요구하되, 되돌아올 길은 둔다
  const w = createMaxTurnWatch();
  feed(w, [strong(70), strong(70), strong(70)]);
  for (let i = 0; i < 7; i += 1) assert.strictEqual(w.see(strong(50)).trust, false);
  assert.strictEqual(w.see(strong(50)).trust, true, '여덟 번째에는 받아들인다');
  assert.strictEqual(w.known, 50);
});

test('사이사이 맞는 값이 끼면 갈아타지 않는다', () => {
  const w = createMaxTurnWatch();
  feed(w, [strong(70), strong(70), strong(70)]);
  for (let i = 0; i < 20; i += 1) {
    w.see(strong(50));
    w.see(strong(70));
  }
  assert.strictEqual(w.known, 70, '번갈아 나오는 건 갈아탈 증거가 아니다');
});

test('한동안 아무것도 못 읽으면 믿던 값을 잊는다', () => {
  // ★ 막다른 골목에서 빠져나오는 유일한 길이다. 70을 7로 잘못 믿으면 한 자리만
  // 통과시키니 읽히는 게 없어지고, 안 읽히면 최대 턴도 다시 못 봐서 스스로 못 나온다.
  const w = createMaxTurnWatch();
  feed(w, [strong(7), strong(7), strong(7)]);
  assert.strictEqual(w.known, 7);
  for (let i = 0; i < 19; i += 1) w.see(null);
  assert.strictEqual(w.known, 7, '잠깐 가려진 것만으로 잊으면 안 된다');
  w.see(null);
  assert.strictEqual(w.known, null, '2초쯤 아무것도 못 읽었으면 우리가 틀린 것이다');
});

test('한 번 읽히면 못 읽은 셈이 다시 시작된다', () => {
  const w = createMaxTurnWatch();
  feed(w, [strong(70), strong(70), strong(70)]);
  for (let i = 0; i < 15; i += 1) w.see(null);
  w.see(strong(70));
  for (let i = 0; i < 15; i += 1) w.see(null);
  assert.strictEqual(w.known, 70, '연출로 띄엄띄엄 가려지는 것과 막다른 골목은 다르다');
});

test('슬래시가 없으면 검증이 통째로 꺼진다', () => {
  // 사용자가 영역을 숫자에만 딱 맞춰 잡았을 때 — 예전처럼 쓰던 사람에게 달라지는 게 없어야 한다
  const w = createMaxTurnWatch();
  for (let i = 0; i < 30; i += 1) {
    assert.strictEqual(w.see({ max: null, maxConfidence: 0 }).trust, true);
  }
  assert.strictEqual(w.known, null);
});

test('reset하면 처음으로 돌아간다', () => {
  const w = createMaxTurnWatch();
  feed(w, [strong(70), strong(70), strong(70)]);
  w.reset();
  assert.strictEqual(w.known, null);
  assert.strictEqual(w.see(strong(50)).trust, true, '믿는 게 없으면 아무것도 안 물린다');
});
