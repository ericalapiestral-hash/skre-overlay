// 숫자 대조표 만들기 → src/shared/templates.json
//
//   npm run templates            기존 것에 더한다 (없던 모양만 추가)
//   npm run templates -- --reset 처음부터 다시 만든다
//
// 게임 폰트를 직접 가질 수 없으니 굵은 산세리프 여러 벌로 0~9를 그려 템플릿을 만든다.
// 숫자는 폰트가 달라도 뼈대가 비슷해서 이걸로 대개 맞는다.
//
// **다른 컴퓨터에서 돌리면 그 컴퓨터의 폰트가 더해진다** — 윈도우에서 한 번,
// 리눅스에서 한 번 돌리면 두 쪽 폰트를 다 담게 된다. 그래서 기본이 '더하기'다.
// 그래도 안 맞는 게임이 있으면 앱의 [숫자 가르치기]로 실제 화면을 가르치는 게 제일 정확하다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

/** 게임 UI에 흔한 굵은 산세리프들 — 없는 폰트는 브라우저가 알아서 대체한다 */
const FONTS = [
  'bold 64px "Arial Black"',
  'bold 64px Arial',
  'bold 64px "Segoe UI"',
  'bold 64px Tahoma',
  'bold 64px Verdana',
  '64px Impact',
  'bold 64px "Malgun Gothic"',
  'bold 64px "Noto Sans KR"',
  'bold 64px "Liberation Sans"',
  'bold 64px "DejaVu Sans"',
  'bold 64px FreeSans',
  '600 64px sans-serif',
  '64px sans-serif',
  'italic bold 64px sans-serif',
];

const OUT = path.join(__dirname, '..', 'src', 'shared', 'templates.json');

/** 'bold 64px "Segoe UI"' → 'Segoe UI' */
function fontName(font) {
  const m = font.match(/\d+px\s+(.+)$/);
  return (m ? m[1] : font).replace(/["']/g, '').trim();
}
const RESET = process.argv.includes('--reset');

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

function readExisting() {
  if (RESET) return [];
  try {
    const json = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return Array.isArray(json.templates) ? json.templates : [];
  } catch {
    return [];
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL(PAGE);

  const templates = readExisting();
  const seen = new Set(templates.map((t) => `${t.d}:${t.rows.join('')}`));
  const before = templates.length;

  for (const font of FONTS) {
    for (let digit = 0; digit <= 9; digit += 1) {
      const shot = await win.webContents.executeJavaScript(
        `window.draw(${JSON.stringify(font)}, ${JSON.stringify(String(digit))})`,
      );
      const gray = toGray(Uint8Array.from(shot.data), shot.w, shot.h);
      const boxes = digitBoxes(components(binarize(gray, shot.w, shot.h, true), shot.w, shot.h), shot.h, 1);
      if (boxes.length !== 1) {
        console.warn(`  건너뜀: ${font} "${digit}" — 덩어리 ${boxes.length}개`);
        continue;
      }
      const rows = gridToRows(normalize(cropBitmap(boxes[0], shot.w)));
      const key = `${digit}:${rows.join('')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 어느 폰트에서 나왔는지 남긴다 — 성능을 잴 때 "그 폰트만 빼고" 맞춰 보려면 필요하다
      templates.push({ d: digit, f: fontName(font), rows });
    }
  }

  templates.sort((a, b) => a.d - b.d || String(a.f).localeCompare(String(b.f)));
  const json = {
    설명: '턴 숫자 대조용 템플릿. tools/make-templates.js 가 만든다 — 손으로 고치지 말 것.',
    grid: [14, 24],
    templates,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(json, null, 1)}\n`, 'utf8');

  const perDigit = {};
  for (const t of templates) perDigit[t.d] = (perDigit[t.d] || 0) + 1;
  console.log(`템플릿 ${before} → ${templates.length}개 저장 → ${path.relative(process.cwd(), OUT)}`);
  console.log(`숫자별 개수: ${JSON.stringify(perDigit)}`);

  const complete = Object.keys(perDigit).length === 10;
  app.exit(complete ? 0 : 1);
});
