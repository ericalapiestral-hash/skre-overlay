// 슬래시를 숫자와 가를 수 있는지 재 본다 (한 번 쓰고 마는 계측 도구).
//
//   xvfb-run -a node_modules/.bin/electron tools/measure-slash.js --no-sandbox
//
// 게임의 턴 표시는 그냥 숫자가 아니라 **"16 / 70"** 이다. 왼쪽 숫자만 읽어야 하므로
// 어느 덩어리가 슬래시인지 알아내야 한다. 문턱값은 짐작하지 않고 여기서 재서 고른다
// (CLAUDE.md: "문턱값은 재서 골랐다").
//
// 재는 값 셋:
//  · ratio = w/h            슬래시는 좁고 길다
//  · fill  = 켜진칸/넓이     대각선 획 하나라 성기다
//  · diag  = (위쪽 무게중심 x − 아래쪽 무게중심 x) / w
//    이게 핵심이다. 슬래시는 **위가 오른쪽, 아래가 왼쪽**이라 이 값이 크게 양수다.
//    숫자 중엔 7이 그나마 비슷한데, 7은 위가 가로획이라 무게중심이 가운데에 온다.
'use strict';

const { app, BrowserWindow } = require('electron');
const { toGray, binarize, components, digitBoxes } = require('../src/shared/turnReader');

// 대조표를 만드는 폰트(make-templates)와 표본을 그리는 폰트(make-fixtures)를 **둘 다** 넣는다.
// 처음엔 앞쪽만 재고 문턱을 골랐는데, 표본 쪽에만 있는 Loma의 슬래시가 ratio 0.57로
// 그 문턱(0.56)을 아슬하게 넘어 못 잡혔다. 재는 대상이 좁으면 문턱도 좁게 나온다.
const FAMILIES = [
  '"Arial Black"',
  'Arial',
  '"Segoe UI"',
  'Tahoma',
  'Verdana',
  'Impact',
  '"Malgun Gothic"',
  '"Noto Sans KR"',
  '"Liberation Sans"',
  '"DejaVu Sans"',
  'FreeSans',
  '"Bitstream Charter"',
  'Loma',
  'sans-serif',
];
/** 실제 화면의 글자 크기까지 같이 본다 — 작을수록 획이 뭉개져 값이 흔들린다 */
const SIZES = [22, 32, 44, 64];
const WEIGHTS = ['bold ', '', 'italic bold '];
const FONTS = [];
for (const f of FAMILIES) for (const z of SIZES) for (const wt of WEIGHTS) FONTS.push(`${wt}${z}px ${f}`);

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<canvas id="c" width="140" height="140"></canvas>
<script>
  window.draw = (font, ch) => {
    const c = document.getElementById('c');
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff'; g.font = font;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(ch, c.width / 2, c.height / 2);
    const d = g.getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, data: Array.from(d.data) };
  };
</script>
`)}`;

/** 덩어리의 위/아래 4분의 1에서 켜진 칸의 x 무게중심 차이 */
function measure(box, imgW) {
  const { labels, label, minX, maxX, minY, maxY, w, h, count } = box;
  const band = Math.max(1, Math.round(h * 0.25));
  let topSum = 0;
  let topN = 0;
  let botSum = 0;
  let botN = 0;
  for (let y = minY; y <= maxY; y += 1) {
    const top = y < minY + band;
    const bottom = y > maxY - band;
    if (!top && !bottom) continue;
    for (let x = minX; x <= maxX; x += 1) {
      if (labels[y * imgW + x] !== label) continue;
      if (top) {
        topSum += x - minX;
        topN += 1;
      } else {
        botSum += x - minX;
        botN += 1;
      }
    }
  }
  return {
    ratio: w / h,
    fill: count / (w * h),
    diag: topN && botN ? (topSum / topN - botSum / botN) / w : 0,
  };
}

function stats(rows) {
  const nums = rows.slice().sort((a, b) => a - b);
  return {
    min: nums[0],
    p10: nums[Math.floor(nums.length * 0.1)],
    med: nums[nums.length >> 1],
    p90: nums[Math.floor(nums.length * 0.9)],
    max: nums[nums.length - 1],
  };
}

const f2 = (x) => (x === undefined ? ' —  ' : x.toFixed(2).padStart(5));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL(PAGE);

  /** @type {Record<string, Array<{ratio:number, fill:number, diag:number}>>} */
  const byChar = {};
  for (const font of FONTS) {
    for (const ch of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '/']) {
      const shot = await win.webContents.executeJavaScript(
        `window.draw(${JSON.stringify(font)}, ${JSON.stringify(ch)})`,
      );
      const gray = toGray(Uint8Array.from(shot.data), shot.w, shot.h);
      const boxes = digitBoxes(components(binarize(gray, shot.w, shot.h, true), shot.w, shot.h), shot.h, 1);
      if (boxes.length !== 1) continue;
      (byChar[ch] = byChar[ch] || []).push(measure(boxes[0], shot.w));
    }
  }

  console.log('글자   개수 |        ratio (w/h)        |          fill           |          diag');
  console.log('            |  min  p10  med  p90  max  |  min  med  max          |  min  p10  med  p90  max');
  for (const ch of Object.keys(byChar)) {
    const rows = byChar[ch];
    const r = stats(rows.map((x) => x.ratio));
    const f = stats(rows.map((x) => x.fill));
    const d = stats(rows.map((x) => x.diag));
    console.log(
      `  ${ch}   ${String(rows.length).padStart(3)} | ${f2(r.min)}${f2(r.p10)}${f2(r.med)}${f2(r.p90)}${f2(r.max)} |` +
        ` ${f2(f.min)}${f2(f.med)}${f2(f.max)}         |` +
        ` ${f2(d.min)}${f2(d.p10)}${f2(d.med)}${f2(d.p90)}${f2(d.max)}`,
    );
  }

  const slash = byChar['/'] || [];
  const digits = Object.keys(byChar)
    .filter((c) => c !== '/')
    .flatMap((c) => byChar[c].map((x) => ({ ...x, ch: c })));

  // ── 규칙을 손으로 고르지 않고 격자로 훑어 고른다.
  //
  // **숫자를 슬래시로 잘못 보는 것(거짓 양성)이 훨씬 나쁘다.** 그러면 진짜 숫자가
  // 잘려 나가 턴을 아예 못 읽거나 반쪽만 읽는다. 반대로 슬래시를 못 알아보면
  // 예전과 같은 상태(자릿수 제한이 알아서 처리)로 돌아갈 뿐이다.
  // 그래서 거짓 양성 0을 먼저 만족시키고, 그 안에서 슬래시를 제일 많이 잡는 값을 고른다.
  //
  // 문턱은 경계에 딱 붙이지 않고 **틈의 한가운데**에 둔다. 거짓 양성 0만 보고 고르면
  // 제일 아슬아슬한 숫자에서 0.02밖에 안 떨어진 값이 뽑히는데, 그건 잰 폰트에서만
  // 0이지 처음 보는 게임 폰트에서는 바로 뚫린다.
  let bestRule = null;
  for (let ratio = 0.40; ratio <= 0.85; ratio += 0.01) {
    for (const fill of [1, 0.6, 0.55, 0.5, 0.45, 0.4]) {
      const pass = (x) => x.ratio < ratio && x.fill < fill;
      const d = digits.filter(pass);
      const sl = slash.filter(pass);
      if (sl.length === 0) continue;
      // 이 (ratio, fill) 아래에서 숫자가 도달하는 가장 큰 diag
      const dMax = d.length ? Math.max(...d.map((x) => x.diag)) : -1;
      const above = sl.filter((x) => x.diag > dMax);
      if (above.length === 0) continue;
      const sMin = Math.min(...above.map((x) => x.diag));
      const gap = sMin - dMax;
      const tp = above.length;
      const better =
        !bestRule || tp > bestRule.tp || (tp === bestRule.tp && gap > bestRule.gap);
      if (better) bestRule = { ratio, fill, diag: (dMax + sMin) / 2, gap, dMax, sMin, tp, fp: 0 };
    }
  }
  if (!bestRule) {
    console.log('\n거짓 양성 0인 규칙이 없다 — 다른 값을 재야 한다.');
    app.exit(1);
    return;
  }
  const { ratio, fill, tp, gap, dMax, sMin } = bestRule;
  // 소수 둘째 자리로 반올림해도 틈 안에 남는지 확인하고 쓴다 (코드에 적기 좋게)
  const diag = Math.round(bestRule.diag * 100) / 100;
  console.log(
    `\n틈: 숫자 최대 diag ${dMax.toFixed(3)} ~ 슬래시 최소 diag ${sMin.toFixed(3)} (${gap.toFixed(3)})`,
  );
  if (diag <= dMax || diag >= sMin) console.log('  ⚠ 반올림하면 틈을 벗어난다 — 소수 셋째 자리까지 쓸 것');
  const hit = (x) => x.ratio < ratio && x.diag > diag && x.fill < fill;
  console.log(
    `\n고른 규칙: ratio < ${ratio.toFixed(2)} · diag > ${diag.toFixed(2)}` +
      `${fill < 1 ? ` · fill < ${fill.toFixed(2)}` : ' (fill은 안 봄)'}`,
  );
  console.log(`  슬래시 ${tp}/${slash.length}장 잡음 (${((tp / slash.length) * 100).toFixed(1)}%)`);
  console.log(`  숫자를 슬래시로 잘못 봄: 0/${digits.length}장`);

  // 못 잡은 슬래시가 어떤 것들인지 — 여기가 실제로 못 읽는 화면이 된다
  const missed = slash.filter((x) => !hit(x));
  if (missed.length) {
    const r = stats(missed.map((x) => x.ratio));
    const d = stats(missed.map((x) => x.diag));
    console.log(
      `  못 잡은 ${missed.length}장: ratio ${f2(r.min)}~${f2(r.max)} · diag ${f2(d.min)}~${f2(d.max)}`,
    );
  }
  // 가장 아슬아슬한 숫자 — 여유가 얼마나 되는지
  const near = digits
    .filter((x) => x.ratio < ratio && x.fill < fill)
    .sort((a, b) => b.diag - a.diag)[0];
  if (near) console.log(`  제일 아슬아슬한 숫자: "${near.ch}" diag ${near.diag.toFixed(3)} (문턱 ${diag.toFixed(2)})`);
  app.exit(0);
});
