// 엔진 — 픽셀 한 장을 넣으면 "지금 몇 번째 단계인지"까지 나오는지.
//
// 화면 없이 여기까지 확인할 수 있게 만든 게 이번 재작성의 핵심이다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createEngine } = require('../src/main/engine');
const { loadTemplates } = require('../src/shared/turnReader');
const { bench, loadFixtures, RAW } = require('../tools/bench-reader');

const TEMPLATES = loadTemplates(RAW);

/** 도감에서 나온 모양의 변형 그룹 */
const GROUPS = [
  {
    round: 1,
    variants: [
      {
        label: '1라운드',
        steps: [
          { turn: 0, text: '나타 아래' },
          { turn: 4, text: '쥬리 위' },
        ],
      },
    ],
  },
  {
    round: 2,
    variants: [
      { label: '2라운드 (8턴)', steps: [{ turn: 8, text: '미호 위' }, { turn: 12, text: '리나 아래' }] },
      { label: '2라운드 (4턴)', steps: [{ turn: 4, text: '미호 위' }] },
    ],
  },
];

/** 표본에서 특정 숫자 그림 하나 */
function frameFor(value) {
  const data = loadFixtures();
  if (!data) return null;
  const s = data.samples.find((x) => x.value === value && x.height === 44 && !x.invert);
  if (!s) return null;
  return { gray: new Uint8Array(Buffer.from(s.gray, 'base64')), w: s.w, h: s.h };
}

function engine() {
  const e = createEngine({ templates: TEMPLATES });
  e.setFlow(GROUPS, {});
  return e;
}

test('변형 선택에 따라 단계 목록이 달라진다', () => {
  const e = createEngine({ templates: TEMPLATES });
  const a = e.setFlow(GROUPS, {});
  assert.deepStrictEqual(a.steps.map((s) => s.turn), [0, 4, 8, 12]);
  const b = e.setFlow(GROUPS, { 1: 1 });
  assert.deepStrictEqual(b.steps.map((s) => s.turn), [0, 4, 4]);
  assert.strictEqual(b.index, 0);
});

test('도감이 갱신돼도 진행 위치를 지킬 수 있다', () => {
  const e = engine();
  e.setIndex(2);
  const r = e.setFlow(GROUPS, {}, { keepIndex: true });
  assert.strictEqual(r.index, 2, '전투 중에 위치가 처음으로 돌아가면 안 된다');
});

test('빈 빌드에서도 안전하다', () => {
  const e = createEngine({ templates: TEMPLATES });
  const r = e.setFlow([], {});
  assert.deepStrictEqual(r.steps, []);
  assert.strictEqual(r.index, 0);
  assert.strictEqual(e.setIndex(5), 0);
  assert.strictEqual(e.feed(new Uint8Array(4), 2, 2).index, 0);
});

test('단계 이동은 범위를 벗어나지 않는다', () => {
  const e = engine();
  assert.strictEqual(e.setIndex(99), 3);
  assert.strictEqual(e.setIndex(-5), 0);
});

test('두 단계 이상 건너뛰는 이동은 몇 프레임 이어져야 한다 (P7)', { skip: !loadFixtures() }, () => {
  // 0턴 단계에서 8턴이 읽히면 두 단계를 건너뛴다 — 오독 한 프레임에 순간이동하면 안 된다
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  e.setFlow(GROUPS, {});
  const frame = frameFor(8);
  assert.ok(frame, '표본에 8이 있어야 한다');

  const first = e.feed(frame.gray, frame.w, frame.h);
  assert.strictEqual(first.turn, null, '아직 믿지 않는다');
  assert.strictEqual(first.index, 0);
  e.feed(frame.gray, frame.w, frame.h);
  const third = e.feed(frame.gray, frame.w, frame.h);
  assert.strictEqual(third.turn, 8);
  assert.ok(third.confidence > 0.86, '표본은 또렷하게 읽혀야 한다');
  assert.strictEqual(third.index, 2, '8턴이면 2라운드 첫 단계');
  assert.strictEqual(third.moved, true);
});

test('같은 턴이 이어지면 더 움직이지 않는다', { skip: !loadFixtures() }, () => {
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  e.setFlow(GROUPS, {});
  const frame = frameFor(8);
  assert.ok(frame);
  for (let i = 0; i < 3; i += 1) e.feed(frame.gray, frame.w, frame.h);
  for (let i = 0; i < 3; i += 1) {
    const r = e.feed(frame.gray, frame.w, frame.h);
    assert.strictEqual(r.moved, false);
    assert.strictEqual(r.index, 2);
  }
});

test('턴이 올라가면 한 단계씩은 바로 따라 올라간다', { skip: !loadFixtures() }, () => {
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  e.setFlow(GROUPS, {});
  const eight = frameFor(8);
  const twelve = frameFor(12);
  assert.ok(eight && twelve);
  for (let i = 0; i < 3; i += 1) e.feed(eight.gray, eight.w, eight.h);
  const r = e.feed(twelve.gray, twelve.w, twelve.h);
  assert.strictEqual(r.turn, 12);
  assert.strictEqual(r.index, 3, '한 단계 이동은 기다리지 않는다');
});

test('아무것도 없는 화면에서는 자리를 지킨다', () => {
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => t });
  e.setFlow(GROUPS, {});
  e.setIndex(1);
  const blank = new Uint8Array(80 * 40).fill(28);
  for (let i = 0; i < 5; i += 1) {
    t += 100;
    const r = e.feed(blank, 80, 40);
    assert.strictEqual(r.index, 1, '못 읽었다고 위치를 잃으면 안 된다');
    assert.strictEqual(r.turn, null);
    assert.strictEqual(r.hidden, true);
  }
  t += 100;
  assert.ok(e.feed(blank, 80, 40).hiddenMs >= 500, '얼마나 가려졌는지 잰다');
});

test('프레임 시각을 직접 넣을 수 있다 (시나리오 시험용)', () => {
  const e = createEngine({ templates: TEMPLATES });
  e.setFlow(GROUPS, {});
  const blank = new Uint8Array(80 * 40).fill(28);
  assert.strictEqual(e.feed(blank, 80, 40, 1000).hiddenMs, 0);
  assert.strictEqual(e.feed(blank, 80, 40, 1700).hiddenMs, 700);
});

test('가르친 대조표를 더하면 개수가 늘어난다', () => {
  const e = createEngine({ templates: TEMPLATES });
  const before = e.templateCount;
  const rows = new Array(24).fill('0'.repeat(14));
  const after = e.setTemplates(TEMPLATES, [{ d: 7, rows }]);
  assert.strictEqual(after, before + 1);
});

test('reset은 투표만 지우고 위치는 지킨다', () => {
  const e = engine();
  e.setIndex(2);
  e.reset();
  assert.strictEqual(e.index, 2);
});
