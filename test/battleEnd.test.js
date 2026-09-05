// 전투가 끝났는지 — 결과 화면에서 쉬고, 다음 전투에 스스로 깨어나는가.
//
// 신호가 둘이라 서로를 삼키지 않는지가 핵심이다: 연출(변하는 화면)은 그림 신호에
// 안 걸려야 하고, 결과 화면(멈춘 화면)은 시간 안전줄을 기다리지 않아야 한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createBattleEndWatch, STILL_MS, BLIND_MS } = require('../src/shared/battleEnd');

const W = 40;
const H = 10;
const N = W * H;

/** 결과 화면처럼 **멈춘** 그림 — 늘 같은 픽셀 */
function frozen() {
  return new Uint8Array(N).fill(60);
}

/** 스킬 연출처럼 **요동치는** 그림 — 프레임마다 절반이 바뀐다 */
function flicker(i) {
  const g = new Uint8Array(N);
  for (let p = 0; p < N; p += 1) g[p] = (p + i * 37) % 2 ? 20 : 230;
  return g;
}

/** 턴을 읽은 프레임 하나 (그림은 아무거나) */
function battle(w, t, i = 0) {
  return w.see(true, flicker(i), W, H, t);
}

test('결과 화면처럼 멈춰 있으면 1.5초쯤에 쉰다', () => {
  const w = createBattleEndWatch();
  battle(w, 0);
  let t = 100;
  let last = null;
  // 멈춘 그림이 들어오기 시작한다
  for (; t <= 2000; t += 100) {
    last = w.see(false, frozen(), W, H, t);
    if (last.over) break;
  }
  assert.ok(last, '한 프레임은 돌았어야 한다');
  assert.strictEqual(last.over, true, '멈춘 화면인데도 안 쉰다');
  assert.strictEqual(last.why, 'still', '그림으로 잡아야 한다 (시간 안전줄이 아니라)');
  // 첫 멈춤 프레임(100ms)부터 STILL_MS 뒤 — 한 프레임 안쪽 오차만 허용한다
  assert.ok(t >= 100 + STILL_MS && t <= 100 + STILL_MS + 200, `너무 이르거나 늦다 (${t}ms)`);
});

test('연출처럼 요동치면 그림 신호에 안 걸린다', () => {
  // ★ 이게 두 신호를 나눈 이유다. 스킬 연출은 턴을 가리지만 그 자리가 프레임마다
  // 요동친다 — 그걸 결과 화면으로 보면 전투 도중에 쉬어 버린다.
  const w = createBattleEndWatch();
  battle(w, 0);
  for (let t = 100, i = 1; t < BLIND_MS; t += 100, i += 1) {
    const r = w.see(false, flicker(i), W, H, t);
    assert.strictEqual(r.over, false, `${t}ms에 쉬어 버렸다`);
  }
});

test('요동쳐도 12초를 넘기면 안전줄이 잡는다', () => {
  // 결과 화면에 반짝이는 연출이 있어도 결국은 쉬어야 한다
  const w = createBattleEndWatch();
  battle(w, 0);
  let last = null;
  for (let t = 100, i = 1; t <= BLIND_MS + 200; t += 100, i += 1) {
    last = w.see(false, flicker(i), W, H, t);
  }
  assert.ok(last);
  assert.strictEqual(last.over, true);
  assert.strictEqual(last.why, 'blind');
});

test('턴이 다시 보이면 그 프레임에 깨어난다', () => {
  const w = createBattleEndWatch();
  battle(w, 0);
  for (let t = 100; t <= 3000; t += 100) w.see(false, frozen(), W, H, t);
  assert.strictEqual(w.over, true);
  const r = battle(w, 3100, 5);
  assert.strictEqual(r.over, false, '한 프레임이면 충분하다 — 기다릴 이유가 없다');
  assert.strictEqual(w.over, false);
});

test('한 번도 못 읽었으면 쉬지 않는다', () => {
  // ★ 턴 영역이 잘못 잡혔을 때 "쉬는 중"이라고 하면 사람은 잘 돌고 있는 줄 안다.
  // 그때 해야 할 말은 "영역을 다시 잡으세요"다 — 그 말이 나오려면 안 쉬어야 한다.
  const w = createBattleEndWatch();
  for (let t = 0; t <= BLIND_MS * 2; t += 100) {
    const r = w.see(false, frozen(), W, H, t);
    assert.strictEqual(r.over, false, `${t}ms에 쉬어 버렸다`);
  }
});

test('쉬기 시작한 프레임만 entered가 참이다', () => {
  // 엔진이 그때 딱 한 번 읽기 기억을 지운다 — 매 프레임 지우면 안 된다
  const w = createBattleEndWatch();
  battle(w, 0);
  const entered = [];
  for (let t = 100; t <= 4000; t += 100) {
    if (w.see(false, frozen(), W, H, t).entered) entered.push(t);
  }
  assert.strictEqual(entered.length, 1, `entered가 ${entered.length}번 나왔다: ${entered}`);
});

test('영역이 바뀌어 크기가 달라지면 멈춘 것으로 보지 않는다', () => {
  // 크기가 다른 그림끼리는 비교할 수 없다. 그때 "같다"고 하면 영역을 다시 잡는
  // 순간마다 쉬어 버린다.
  const w = createBattleEndWatch();
  battle(w, 0);
  let t = 100;
  for (; t <= 2000; t += 100) {
    const g = t % 200 === 0 ? new Uint8Array(N).fill(60) : new Uint8Array(N * 2).fill(60);
    const r = w.see(false, g, t % 200 === 0 ? W : W * 2, H, t);
    assert.strictEqual(r.over, false, `${t}ms에 쉬어 버렸다`);
  }
});

test('작은 잡음은 멈춘 것으로 본다', () => {
  // 캡처는 완전히 똑같은 픽셀을 주지 않는다 (압축·색변환 잡음). 그걸 "변했다"로
  // 세면 그림 신호가 영영 안 걸린다.
  const w = createBattleEndWatch();
  battle(w, 0);
  let last = null;
  for (let t = 100, i = 0; t <= 3000; t += 100, i += 1) {
    const g = frozen();
    g[i % N] = 200; // 픽셀 한 개만 크게 다르다
    last = w.see(false, g, W, H, t);
  }
  assert.ok(last);
  assert.strictEqual(last.over, true);
  assert.strictEqual(last.why, 'still');
});

test('reset하면 처음으로 돌아간다', () => {
  const w = createBattleEndWatch();
  battle(w, 0);
  for (let t = 100; t <= 3000; t += 100) w.see(false, frozen(), W, H, t);
  assert.strictEqual(w.over, true);
  w.reset();
  assert.strictEqual(w.over, false);
  // reset 뒤에는 다시 "한 번도 못 읽음" 상태 — 읽기 전에는 쉬지 않는다
  for (let t = 3100; t <= 3100 + BLIND_MS * 2; t += 100) {
    assert.strictEqual(w.see(false, frozen(), W, H, t).over, false);
  }
});
