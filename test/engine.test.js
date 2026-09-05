// 엔진 — 픽셀 한 장을 넣으면 "지금 몇 번째 단계인지"까지 나오는지.
//
// 화면 없이 여기까지 확인할 수 있게 만든 게 이번 재작성의 핵심이다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createEngine } = require('../src/main/engine');
const { loadTemplates } = require('../src/shared/turnReader');
const { bench, loadFixtures, RAW, upscale } = require('../tools/bench-reader');
const { CROP_TARGET_HEIGHT } = require('../src/shared/turnReader');

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

/**
 * "N / M" 표본 하나 — 앱과 같은 조건으로 키워서 준다.
 * (렌더러가 크롭을 CROP_TARGET_HEIGHT 로 키워 보내므로 엔진은 이미 커진 그림을 받는다)
 */
function pairFrame(text) {
  const data = loadFixtures();
  if (!data) return null;
  const s = (data.pairs || []).find((x) => x.text === text && x.font === 'bold DejaVu Sans' && x.height === 32);
  if (!s) return null;
  const gray = new Uint8Array(Buffer.from(s.gray, 'base64'));
  return upscale(gray, s.w, s.h, Math.max(1, Math.min(8, CROP_TARGET_HEIGHT / s.height)));
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


test('최대 턴을 몇 프레임 보고 나면 믿는다', { skip: !pairFrame('16/70') && '표본이 없다' }, () => {
  // 최대 턴은 전투 내내 안 바뀐다 — 알아내면 지금 턴의 자릿수와 상한이 정해진다
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  e.setFlow(GROUPS, {});
  const f = pairFrame('16/70');
  assert.ok(f);
  assert.strictEqual(e.maxTurn, null, '처음에는 모른다');
  const first = e.feed(f.gray, f.w, f.h);
  assert.strictEqual(first.raw, 16, '슬래시 왼쪽만 읽는다');
  assert.strictEqual(first.max, null);
  e.feed(f.gray, f.w, f.h);
  e.feed(f.gray, f.w, f.h);
  assert.strictEqual(e.maxTurn, 70);
  assert.strictEqual(e.feed(f.gray, f.w, f.h).max, 70, '화면에도 알려 준다');
});

test('최대 턴이 다른 프레임은 통째로 버린다', { skip: !pairFrame('16/70') && '표본이 없다' }, () => {
  // 최대 턴이 달라졌다는 건 슬래시를 엉뚱한 데서 잘랐다는 뜻이라 왼쪽도 못 믿는다.
  // 추적기에는 "가려짐"으로 들어가므로 단계는 그 자리에 머문다.
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  e.setFlow(GROUPS, {});
  const seventy = pairFrame('16/70');
  const fifty = pairFrame('16/50');
  assert.ok(seventy && fifty);
  for (let i = 0; i < 3; i += 1) e.feed(seventy.gray, seventy.w, seventy.h);
  const r = e.feed(fifty.gray, fifty.w, fifty.h);
  assert.strictEqual(r.raw, null, '버린 프레임은 못 읽은 것과 같이 다룬다');
  assert.strictEqual(r.dropped, 16, '무엇을 버렸는지는 남긴다 (상태줄에 쓴다)');
  assert.strictEqual(r.hidden, true);
});

test('빌드를 바꾸거나 자동을 껐다 켜면 최대 턴도 다시 본다', { skip: !pairFrame('16/70') && '표본이 없다' }, () => {
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  e.setFlow(GROUPS, {});
  const f = pairFrame('16/70');
  assert.ok(f);
  for (let i = 0; i < 3; i += 1) e.feed(f.gray, f.w, f.h);
  assert.strictEqual(e.maxTurn, 70);
  e.reset();
  assert.strictEqual(e.maxTurn, null, '다음 전투는 최대 턴이 다를 수 있다');
  for (let i = 0; i < 3; i += 1) e.feed(f.gray, f.w, f.h);
  e.setFlow(GROUPS, { 1: 1 });
  assert.strictEqual(e.maxTurn, null);
});

test('슬래시 없이 숫자만 잡아도 예전처럼 읽는다', { skip: !loadFixtures() && '표본이 없다' }, () => {
  // 사용자가 영역을 숫자에만 딱 맞춰 잡았을 때 — 최대 턴 검증이 통째로 꺼져야 한다
  let t = 0;
  const e = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  e.setFlow(GROUPS, {});
  const f = frameFor(8);
  assert.ok(f);
  for (let i = 0; i < 5; i += 1) {
    const r = e.feed(f.gray, f.w, f.h);
    assert.strictEqual(r.max, null);
    assert.strictEqual(r.dropped, null);
    assert.strictEqual(r.raw, 8);
  }
  assert.strictEqual(e.index, 2);
});
