// 턴 표시는 "16 / 70" 이다 — 슬래시 앞까지만 읽는지.
//
// 스크린샷을 받아 보고서야 안 것이다. 게임은 턴을 그냥 숫자로 보여주지 않고
// **"지금 턴 / 최대 턴"** 으로 보여준다. 슬래시를 모르면 "16 / 70"이 "1670"이나
// (자릿수 제한에 걸려) "6/7" 같은 엉뚱한 조각으로 읽힌다. 그걸 믿고 단계를 옮기면
// 순서가 통째로 어긋나므로, 아예 못 읽는 것보다 나쁘다.
//
// 표본은 `npm run fixtures`가 **진짜 폰트로 그린** "N / M" 그림들이다 (data.pairs).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readTurn, loadTemplates, looksLikeSlash, SLASH, CROP_TARGET_HEIGHT, binarize, components } =
  require('../src/shared/turnReader');
const { loadFixtures, upscale, RAW } = require('../tools/bench-reader');

const data = loadFixtures();
const pairs = (data && data.pairs) || [];
const skip = pairs.length === 0 ? '표본이 없다 (npm run fixtures)' : false;

/**
 * 그 폰트에서 뽑은 대조표는 빼고 맞춘다 — bench와 같은 "처음 보는 게임 폰트" 조건이다.
 * 안 빼면 자기 폰트를 자기가 맞히는 셈이라 실제보다 쉬워진다.
 */
const byFont = new Map();
function templatesFor(font) {
  if (!byFont.has(font)) {
    const drop = new Set((data.holdout && data.holdout[font]) || []);
    byFont.set(font, loadTemplates({ templates: RAW.templates.filter((t) => !drop.has(t.rows.join('')))}));
  }
  return byFont.get(font);
}

/**
 * 앱과 같은 조건으로 읽는다 — **글자 높이**(s.height)를 CROP_TARGET_HEIGHT로 키운다.
 * 이미지 높이(s.h)에는 여백이 들어 있어서 그걸로 계산하면 확대가 거의 안 되고,
 * 확대 없이 읽으면 정확도가 눈에 띄게 떨어진다 (bench의 "확대 없이" 줄 참고).
 */
function read(s) {
  const gray = new Uint8Array(Buffer.from(s.gray, 'base64'));
  const big = upscale(gray, s.w, s.h, Math.max(1, Math.min(8, CROP_TARGET_HEIGHT / s.height)));
  return readTurn(big.gray, big.w, big.h, templatesFor(s.font));
}

test('표본이 있다', { skip }, () => {
  assert.ok(pairs.length > 500, `"N / M" 표본이 ${pairs.length}장뿐이다`);
});

test('"N / M"에서 왼쪽 숫자만 읽는다', { skip }, () => {
  const wrong = [];
  const unknown = [];
  for (const s of pairs) {
    const r = read(s);
    if (!r) unknown.push(s);
    else if (r.value !== s.value) wrong.push({ ...s, got: r.value, conf: r.confidence });
  }
  const show = wrong
    .slice(0, 15)
    .map((x) => `  "${x.text}" (${x.font} ${x.height}px) → ${x.got} (${x.conf.toFixed(2)})`)
    .join('\n');
  // 틀림이 제일 중요하다 — 틀린 턴을 믿고 단계를 건너뛰면 순서가 통째로 어긋난다
  assert.strictEqual(
    wrong.length,
    0,
    `${pairs.length}장 중 ${wrong.length}장을 틀리게 읽었다:\n${show}`,
  );
  // 못 읽는 건(모르겠음) 괜찮다 — 추적기가 "가려짐"으로 보고 그대로 있고, 초당 열 장쯤
  // 읽으므로 다음 프레임에 따라잡는다. 지금 못 읽는 것들은 작은 글자에서 슬래시가 옆
  // 숫자에 **붙어 버린** 경우인데, 그때 억지로 읽으면 자신 있게 틀린 턴이 나온다.
  assert.ok(
    unknown.length <= pairs.length * 0.08,
    `못 읽은 것이 ${unknown.length}장 (${((unknown.length / pairs.length) * 100).toFixed(1)}%) — 8%를 넘으면 안 된다`,
  );
});

test('빌드 턴이 아닌 턴도 그대로 읽는다', { skip }, () => {
  // ★ 실제 게임의 턴은 1씩 올라가므로 화면에 뜨는 값 대부분이 빌드 턴이 아니다.
  // 예전에는 빌드 턴을 "후보"로 넘겨 거기에 맞췄고, 그래서 18이 28로 읽혔다.
  const buildTurns = new Set([0, 4, 8, 12, 16]);
  const others = pairs.filter((s) => !buildTurns.has(s.value));
  assert.ok(others.length > 100, '빌드 턴이 아닌 표본이 넉넉해야 한다');
  const wrong = others.filter((s) => {
    const r = read(s);
    return r && r.value !== s.value;
  });
  assert.strictEqual(wrong.length, 0, `빌드 턴이 아닌 ${wrong.length}장이 틀렸다`);
});

test('슬래시를 재는 값은 숫자와 겹치지 않는다', { skip: !data ? '표본이 없다' : false }, () => {
  // `node tools/tune-slash.js` 로 앱 조건에서 잰 값이 자물쇠다.
  // 앱 조건(64px로 확대)에서 diag는 숫자 −0.15~0.23, 슬래시 0.38~0.61로 완전히 갈린다.
  // 문턱은 그 틈 안에 있어야 한다 — 벗어나면 숫자를 자르거나 슬래시를 못 잡는다.
  assert.ok(SLASH.minDiag > 0.23 && SLASH.minDiag < 0.38, 'diag 문턱이 틈을 벗어났다');
  assert.ok(SLASH.maxRatio >= 0.57, 'ratio 울타리가 슬래시(최대 0.57)를 잘라낸다');
  assert.ok(SLASH.maxFill >= 0.49, 'fill 울타리가 슬래시(최대 0.49)를 잘라낸다');

  // 숫자만 그린 표본에서는 슬래시가 하나도 안 나와야 한다 (오검출이 없다는 뜻)
  let falseSlash = 0;
  for (const s of data.samples.slice(0, 200)) {
    const gray = new Uint8Array(Buffer.from(s.gray, 'base64'));
    for (const bright of [true, false]) {
      const comps = components(binarize(gray, s.w, s.h, bright), s.w, s.h);
      for (const c of comps) if (c.h > 5 && c.w > 2 && looksLikeSlash(c, s.w)) falseSlash += 1;
    }
  }
  assert.strictEqual(falseSlash, 0, `숫자 표본에서 슬래시로 잘못 본 덩어리 ${falseSlash}개`);
});

test('슬래시가 없으면 하던 대로 읽는다', { skip }, () => {
  // 사용자가 영역을 숫자에만 딱 맞춰 잡았을 때 — 예전처럼 쓰던 사람에게 달라지는 게 없어야 한다
  const digitsOnly = data.samples.filter((s) => s.height === 32 && !s.invert).slice(0, 60);
  for (const s of digitsOnly) {
    const r = read(s);
    assert.ok(r && r.value === s.value, `숫자만 있는 표본을 못 읽는다: ${s.value} (${s.font})`);
  }
});

test('맨 앞이 슬래시로 보여도 통째로 버리지 않는다', { skip }, () => {
  // 자르고 나면 남는 게 없는 경우다. 오검출일 가능성이 크므로 자르지 않는 편이 낫다 —
  // 아무것도 안 읽히면 추적기는 "가려짐"으로 보고 멈춘다.
  const one = pairs.find((s) => s.value === 1 && s.text.includes('/'));
  assert.ok(one, '표본에 "1/..."이 있어야 한다');
  const r = read(one);
  assert.ok(r && r.value === 1, `"${one.text}"를 ${r ? r.value : 'null'}로 읽었다`);
});

test('최대 턴(슬래시 오른쪽)도 같이 읽는다', { skip }, () => {
  // 오른쪽 숫자는 **전투 내내 안 바뀐다.** 그래서 엔진이 이걸 검증에 쓴다
  // (engine.js의 knownMax): 프레임마다 다른 최대 턴이 나오면 나눈 자리가 수상하다는
  // 뜻이고, 지금 턴이 최대 턴보다 크면 있을 수 없는 값이다.
  //
  // 그러니 여기서 중요한 건 "얼마나 자주 읽히나"가 아니라 **틀리게 읽는 비율**이다.
  // 못 읽는 건(null) 안전하다 — 엔진이 그 프레임을 검증에 안 쓴다.
  let ok = 0;
  const wrong = [];
  let none = 0;
  for (const s of pairs) {
    const truth = Number(String(s.text).split('/')[1]);
    const r = read(s);
    if (!r || r.max === null) {
      none += 1;
      continue;
    }
    if (r.max === truth) ok += 1;
    else wrong.push(`  "${s.text}" (${s.font} ${s.height}px) → 최대 ${r.max} (${r.maxConfidence.toFixed(2)})`);
  }
  assert.ok(ok > pairs.length * 0.95, `최대 턴을 읽은 것이 ${ok}/${pairs.length}장뿐이다`);
  assert.ok(
    wrong.length <= pairs.length * 0.005,
    `최대 턴을 ${wrong.length}장 틀리게 읽었다:\n${wrong.slice(0, 10).join('\n')}`,
  );
  // 틀린 것들은 흐리게 읽힌다 — 엔진이 **또렷한 것만** 믿고 채택하는 근거다
  assert.ok(none < pairs.length * 0.05, `최대 턴을 못 읽은 것이 ${none}장`);
});

test('슬래시가 없으면 최대 턴도 없다', { skip }, () => {
  // 사용자가 영역을 숫자에만 딱 맞춰 잡았을 때 — 엔진의 최대 턴 검증이 통째로 꺼져야 한다
  const digitsOnly = data.samples.filter((s) => s.height === 32 && !s.invert).slice(0, 40);
  for (const s of digitsOnly) {
    const r = read(s);
    assert.ok(r && r.max === null, `숫자만 있는 표본에서 최대 턴이 나왔다: ${r && r.max}`);
  }
});
