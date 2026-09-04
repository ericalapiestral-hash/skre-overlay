// 슬래시를 가리는 문턱을 **앱과 같은 조건에서** 재서 고른다.
//
//   node tools/tune-slash.js
//
// 게임의 턴 표시는 "16 / 70"이라 슬래시를 찾아 왼쪽만 읽어야 한다. 어느 덩어리가
// 슬래시인지 가리는 값(ratio·fill·diag)의 문턱을 여기서 정한다.
//
// **앱이 실제로 넣는 것과 같은 조건으로 잰다** — 크롭을 CROP_TARGET_HEIGHT로 키운 뒤에
// 잰다. 처음에는 원본 크기의 낱글자로 쟀는데, 그렇게 고른 문턱을 넣으니 오히려 오독이
// 일곱 배로 늘었다. 확대하면 획이 번져 ratio도 fill도 달라지기 때문이다. 이건
// bench가 예전에 저지른 것과 **똑같은 실수**다 (CLAUDE.md "벤치는 앱이 실제로 넣는
// 것과 같은 조건으로 잰다"). 원본 크기로 재는 쪽으로 되돌리지 말 것.
'use strict';

const { CROP_TARGET_HEIGHT, binarize, components, diagOf, looksLikeDigit } = require('../src/shared/turnReader');
const { loadFixtures, upscale } = require('./bench-reader');

/**
 * 표본 한 장에서 글자로 볼 만한 덩어리들의 값을 잰다 (앱과 같이 확대한 뒤).
 *
 * @param {object} s 표본
 * @param {boolean} [onlyRight] 글자가 앞으로 잡히는 명암만 볼지.
 *   **숫자는 양쪽 명암을 다 본다** — 앱이 둘 다 시도하므로, 뒤집힌 쪽에서 잡힌 배경
 *   조각이 슬래시로 오인될 위험까지 세야 한다. 반대로 **슬래시는 올바른 명암만** 본다.
 *   뒤집힌 쪽에서 잡히는 건 슬래시가 아니라 배경이라, 그걸 "못 잡은 슬래시"로 세면
 *   잡는 비율이 헛되이 낮게 나온다.
 */
function measureSample(s, onlyRight = false) {
  const gray = new Uint8Array(Buffer.from(s.gray, 'base64'));
  const big = upscale(gray, s.w, s.h, Math.max(1, Math.min(8, CROP_TARGET_HEIGHT / s.height)));
  const rows = [];
  const polarities = onlyRight ? [!s.invert] : [true, false];
  for (const bright of polarities) {
    const comps = components(binarize(big.gray, big.w, big.h, bright), big.w, big.h);
    for (const c of comps) {
      if (!looksLikeDigit(c, big.h, 3)) continue;
      rows.push({
        ratio: c.w / c.h,
        fill: c.count / (c.w * c.h),
        diag: diagOf(c, big.w),
        where: `${s.font} ${s.height}px${s.invert ? ' 반전' : ''}`,
      });
    }
  }
  return rows;
}

function stats(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  return { min: a[0], med: a[a.length >> 1], max: a[a.length - 1] };
}
const f2 = (x) => (x === undefined ? '  — ' : x.toFixed(2).padStart(5));

function main() {
  const data = loadFixtures();
  if (!data || !data.slashes) {
    console.error('표본에 슬래시가 없다 — npm run fixtures 를 먼저 돌릴 것');
    return 1;
  }
  const digits = data.samples.flatMap(measureSample);
  const slash = data.slashes.flatMap((x) => measureSample(x, true));
  console.log(`숫자 덩어리 ${digits.length}개 · 슬래시 덩어리 ${slash.length}개 (앱과 같이 ${CROP_TARGET_HEIGHT}px로 확대해서 잼)\n`);

  for (const [name, rows] of [['숫자', digits], ['슬래시', slash]]) {
    const r = stats(rows.map((x) => x.ratio));
    const f = stats(rows.map((x) => x.fill));
    const d = stats(rows.map((x) => x.diag));
    console.log(
      `${name.padEnd(4)} ratio ${f2(r.min)}~${f2(r.max)} (중앙 ${f2(r.med)}) ·` +
        ` fill ${f2(f.min)}~${f2(f.max)} (${f2(f.med)}) ·` +
        ` diag ${f2(d.min)}~${f2(d.max)} (${f2(d.med)})`,
    );
  }

  // 거짓 양성 0을 먼저 만족시키고, 그 안에서 틈이 가장 넓은 값을 고른다.
  // 숫자를 슬래시로 잘못 보면 진짜 숫자가 잘려 나가 턴을 반쪽만 읽는다 — 제일 나쁘다.
  //
  // 세 값을 다 훑는다. 문턱 하나가 남아돌면(그 값이 아무것도 안 걸러도 거짓 양성이 0이면)
  // 그건 여유가 아니라 **재 보지 않은 것**이므로, 여유를 따로 재서 같이 본다.
  let best = null;
  for (let ratio = 0.35; ratio <= 0.95; ratio += 0.01) {
    for (let fill = 0.25; fill <= 1.0; fill += 0.05) {
      for (let diag = 0.05; diag <= 0.6; diag += 0.01) {
        const hit = (x) => x.ratio < ratio && x.fill < fill && x.diag > diag;
        if (digits.some(hit)) continue;
        const tp = slash.filter(hit).length / slash.length;
        // 잡힌 슬래시가 문턱에서 얼마나 떨어져 있나 (셋 중 제일 아슬아슬한 쪽)
        const caught = slash.filter(hit);
        const slack = caught.length
          ? Math.min(
              ...caught.map((x) => Math.min(ratio - x.ratio, fill - x.fill, x.diag - diag)),
            )
          : 0;
        // 숫자가 문턱 상자 밖으로 얼마나 떨어져 있나 (제일 가까운 숫자 기준)
        const near = Math.min(
          ...digits.map((x) => Math.max(x.ratio - ratio, x.fill - fill, diag - x.diag)),
        );
        // 슬래시를 다 잡는 것부터 만족시키고, 그 안에서 **양쪽 여유의 작은 쪽**을 키운다.
        // 한쪽만 넉넉한 값은 처음 보는 게임 폰트에서 반대쪽으로 뚫린다.
        const score = (tp >= 1 ? 1000 : tp) + Math.min(near, slack);
        if (!best || score > best.score) best = { ratio, fill, diag, tp, slack, near, score };
      }
    }
  }
  if (!best) {
    console.log('\n거짓 양성 0인 규칙이 없다.');
    return 1;
  }
  console.log(
    `\n고른 값:  maxRatio ${best.ratio.toFixed(2)} · maxFill ${best.fill.toFixed(2)} · minDiag ${best.diag.toFixed(2)}`,
  );
  console.log(`  슬래시 ${(best.tp * 100).toFixed(1)}% 잡음 · 숫자를 슬래시로 잘못 봄 0/${digits.length}`);
  console.log(`  제일 가까운 숫자가 문턱 밖으로 ${best.near.toFixed(3)} 떨어져 있다 (클수록 안전)`);
  console.log(`  제일 아슬아슬하게 잡힌 슬래시의 여유 ${best.slack.toFixed(3)}`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { measureSample };
