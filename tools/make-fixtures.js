// 인식기 성능을 잴 표본 만들기 → test/fixtures/digits.json.gz
//
//   npm run fixtures
//
// 예전에는 대조표(14×24 격자)를 확대해서 시험 그림을 만들었다. 그런데 그렇게 하면
// 6의 뚫린 곳이 확대 과정에서 막혀 8처럼 보이는 등, **실제 게임 글자에는 없는**
// 손상이 생겨 인식기가 억울하게 틀린 것으로 나왔다.
//
// 그래서 여기서는 진짜 폰트를 캔버스에 그려 표본으로 삼는다. 안티에일리어싱까지
// 게임 화면과 같은 방식으로 생긴다. 표본에는 "이 폰트에서 뽑은 대조표"도 같이 담아,
// 성능을 잴 때 그 폰트만 빼고 맞춰 볼 수 있게 한다 (처음 보는 폰트 조건).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { app, BrowserWindow } = require('electron');
const {
  toGray,
  binarize,
  components,
  digitBoxes,
  cropBitmap,
  normalize,
  gridToRows,
} = require('../src/shared/turnReader');

/** 시험에 쓸 폰트 — 이 컴퓨터에 실제로 있는 것들 */
const FONTS = [
  'bold {S}px "DejaVu Sans"',
  'bold {S}px "Liberation Sans"',
  'bold {S}px FreeSans',
  '{S}px "DejaVu Sans"',
  'bold {S}px "Bitstream Charter"',
  'bold {S}px Loma',
];

/** 게임에서 실제로 보게 되는 턴 숫자들 + 자릿수 시험용 */
const VALUES = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 7, 9, 100, 128];
/** 화면에서 턴 숫자가 차지하는 높이 (픽셀) */
const HEIGHTS = [22, 32, 44];

const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'digits.json.gz');

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<canvas id="c" width="600" height="220"></canvas>
<script>
  // 글자 높이를 정확히 맞추려고 한 번 재고 다시 그린다
  window.draw = (font, text, bg, fg) => {
    const c = document.getElementById('c');
    const g = c.getContext('2d', { willReadFrequently: true });
    g.font = font;
    const m = g.measureText(text);
    const pad = 10;
    const w = Math.ceil(m.width) + pad * 2;
    const h = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + pad * 2;
    c.width = w; c.height = h;
    const g2 = c.getContext('2d', { willReadFrequently: true });
    g2.fillStyle = bg; g2.fillRect(0, 0, w, h);
    g2.fillStyle = fg; g2.font = font;
    g2.textAlign = 'left'; g2.textBaseline = 'alphabetic';
    g2.fillText(text, pad, pad + m.actualBoundingBoxAscent);
    const d = g2.getImageData(0, 0, w, h);
    return { w, h, data: Array.from(d.data) };
  };
</script>
`)}`;

/** 폰트 하나에서 0~9 대조표를 뽑는다 (성능 잴 때 이 폰트를 빼려고) */
async function templatesOf(win, fontAt64) {
  const rows = [];
  for (let digit = 0; digit <= 9; digit += 1) {
    const shot = await win.webContents.executeJavaScript(
      `window.draw(${JSON.stringify(fontAt64)}, ${JSON.stringify(String(digit))}, '#000', '#fff')`,
    );
    const gray = toGray(Uint8Array.from(shot.data), shot.w, shot.h);
    const boxes = digitBoxes(
      components(binarize(gray, shot.w, shot.h, true), shot.w, shot.h),
      shot.h,
      1,
    );
    if (boxes.length !== 1) continue;
    rows.push(gridToRows(normalize(cropBitmap(boxes[0], shot.w))).join(''));
  }
  return rows;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 700, height: 300 });
  await win.loadURL(PAGE);

  const samples = [];
  const holdout = {};

  for (const template of FONTS) {
    const name = template.replace('{S}px ', '').replace(/["']/g, '');
    holdout[name] = await templatesOf(win, template.replace('{S}', '64'));

    for (const height of HEIGHTS) {
      const font = template.replace('{S}', String(height));
      for (const invert of [false, true]) {
        const bg = invert ? '#f0f0ee' : '#14161c';
        const fg = invert ? '#191b22' : '#f2f4f8';
        for (const value of VALUES) {
          const shot = await win.webContents.executeJavaScript(
            `window.draw(${JSON.stringify(font)}, ${JSON.stringify(String(value))}, '${bg}', '${fg}')`,
          );
          const gray = toGray(Uint8Array.from(shot.data), shot.w, shot.h);
          samples.push({
            font: name,
            height,
            invert,
            value,
            w: shot.w,
            h: shot.h,
            gray: Buffer.from(gray).toString('base64'),
          });
        }
      }
    }
    console.log(`  ${name} — ${samples.length}장`);
  }

  const json = JSON.stringify({
    설명: '인식기 성능 표본. tools/make-fixtures.js 가 만든다.',
    holdout,
    samples,
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));
  console.log(
    `표본 ${samples.length}장 저장 → ${path.relative(process.cwd(), OUT)} ` +
      `(${(fs.statSync(OUT).size / 1024).toFixed(0)}KB)`,
  );
  app.exit(samples.length > 0 ? 0 : 1);
});
