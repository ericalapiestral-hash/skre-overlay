// 턴 영역 기본 위치 — 화면 어디를 잡는지.
//
// 이 값은 게임 스크린샷을 눈으로 재서 넣은 것이라, 누가 무심코 고치면 앱이 조용히
// 엉뚱한 자리를 읽는다. 어디를 피해야 하는지(위의 `턴` 글자·아래 막대)를 여기 적어 둔다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DESTROYER, PRESETS } = require('../src/shared/regions');

/** 1920×1080 화면에서 실제로 몇 픽셀 자리인지 */
const px = (r) => ({
  x0: Math.round(r.fx * 1920),
  x1: Math.round((r.fx + r.fw) * 1920),
  y0: Math.round(r.fy * 1080),
  y1: Math.round((r.fy + r.fh) * 1080),
});

test('비율이라 해상도와 무관하다', () => {
  for (const k of ['fx', 'fy', 'fw', 'fh']) {
    assert.ok(DESTROYER[k] > 0 && DESTROYER[k] < 1, `${k}가 0~1 밖이다`);
  }
  assert.ok(DESTROYER.fx + DESTROYER.fw < 1, '오른쪽으로 화면을 넘는다');
  assert.ok(DESTROYER.fy + DESTROYER.fh < 1, '아래로 화면을 넘는다');
});

test('파괴신 턴 표시를 담되 위쪽 한글은 피한다', () => {
  // 아래 숫자들은 스크린샷을 **눈으로 잰 것**이라 몇 픽셀 오차가 있다. 그래서 딱 맞는지가
  // 아니라 "담아야 할 것을 담고, 피해야 할 것을 피하는지"만 본다.
  const b = px(DESTROYER);
  assert.ok(b.x0 <= 28 && b.x1 >= 110, `가로가 "70 / 70"을 못 담는다 (${b.x0}~${b.x1})`);
  assert.ok(b.y0 <= 216 && b.y1 >= 248, `세로가 숫자 줄(y≈216~248)을 못 담는다 (${b.y0}~${b.y1})`);

  // 위쪽 `턴` 글자(y≈165~190)는 반드시 피한다 — 한글은 높이가 숫자와 비슷해서
  // 글자 줄 고르기에서 안 걸러지고, 그대로 숫자로 읽으려 든다.
  assert.ok(b.y0 > 195, `위의 "턴" 글자가 들어온다 (y0=${b.y0})`);
  // 아래는 조금 넘겨도 된다(얇은 막대는 걸러진다). 다만 아래 초상화 줄까지 가면 안 된다.
  assert.ok(b.y1 < 280, `아래로 너무 내려간다 (y1=${b.y1})`);
});

test('화면에 내보내는 목록이 비어 있지 않다', () => {
  assert.ok(PRESETS.length > 0);
  assert.deepStrictEqual(PRESETS[0].region, DESTROYER, '첫 항목이 파괴신이어야 한다');
  assert.ok(PRESETS[0].label.length > 0);
});
