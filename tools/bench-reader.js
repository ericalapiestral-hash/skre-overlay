// 숫자 인식기 성능 재기 — 게임을 켜지 않고 확인하는 방법.
//
//   npm run bench                요약
//   npm run bench -- --verbose   틀린 것까지
//
// 표본은 진짜 폰트로 그린 그림이다 (test/fixtures/digits.json.gz — npm run fixtures 로 다시 만든다).
// 맞출 때는 **그 폰트에서 뽑은 대조표를 빼고** 맞춘다. 그래야 "처음 보는 게임 폰트"
// 조건이 된다 — 자기 자신과 맞추면 100%가 나오는데 그건 아무것도 말해 주지 않는다.
//
// 재는 값 셋:
//   맞음     제대로 읽은 비율
//   모르겠음 확신이 없어 답하지 않은 비율 (안전한 실패 — 화면은 그대로 대기한다)
//   틀림     다른 숫자로 읽은 비율. **이게 0에 가까워야 한다.** 틀린 턴을 믿고
//            단계를 건너뛰면 순서가 통째로 어긋나서, 아예 못 읽느니만 못하다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  GRID_W,
  GRID_H,
  CROP_TARGET_HEIGHT,
  loadTemplates,
  readTurn,
} = require('../src/shared/turnReader');

const RAW = require('../src/shared/templates.json');
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'digits.json.gz');

let cached;

/** 표본 파일을 읽는다 (없으면 null — npm run fixtures 로 만든다) */
function loadFixtures() {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURES)).toString('utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/** 템플릿 행 문자열 → 0/1 격자 (테스트에서 모양을 직접 다룰 때) */
function toGrid(rows) {
  const grid = new Uint8Array(GRID_W * GRID_H);
  rows.forEach((row, y) => {
    if (y >= GRID_H) return;
    for (let x = 0; x < row.length && x < GRID_W; x += 1) {
      if (row[x] !== '0' && row[x] !== ' ') grid[y * GRID_W + x] = 1;
    }
  });
  return grid;
}

/**
 * 이중선형 확대 — 화면(캔버스)이 크롭을 키우는 방식과 같게.
 *
 * 표본은 게임에서 보이는 크기 그대로(22·32·44px)라서, 그냥 재면 **앱이 실제로
 * 인식기에 넣는 것과 다른 것을 재게 된다.** 앱은 인식 전에 CROP_TARGET_HEIGHT
 * 근처로 키운다 — 벤치도 똑같이 키워야 숫자가 실제와 맞는다.
 */
function upscale(gray, w, h, k) {
  if (k <= 1.01) return { gray, w, h };
  const W = Math.round(w * k);
  const H = Math.round(h * k);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    const sy = Math.min(h - 1.0001, (y + 0.5) / k - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(w - 1.0001, (x + 0.5) / k - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const a = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx;
      const b = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx;
      out[y * W + x] = (a * (1 - fy) + b * fy) | 0;
    }
  }
  return { gray: out, w: W, h: H };
}

/** 숫자별 템플릿 묶음 */
function byDigit() {
  const map = new Map();
  for (const t of RAW.templates) {
    if (!map.has(t.d)) map.set(t.d, []);
    map.get(t.d).push(t);
  }
  return map;
}

/**
 * 성능을 잰다.
 *
 * @param {{holdout?: boolean, read?: object, target?: number,
 *          fonts?: string[], heights?: number[], verbose?: boolean}} [opts]
 *   holdout 표본을 그린 폰트의 대조표를 빼고 맞춘다 (기본 true = 처음 보는 폰트 조건)
 *   target  앱처럼 이 높이 근처로 키워서 읽는다 (0이면 원본 크기 그대로)
 * @returns {{total:number, ok:number, unknown:number, wrong:number, misses:string[],
 *            ms:number, msMax:number}|null} ms는 한 장 읽는 데 걸린 시간의 중앙값
 */
function bench(opts = {}) {
  const data = loadFixtures();
  if (!data) return null;

  const holdout = opts.holdout !== false;
  const target = opts.target === undefined ? CROP_TARGET_HEIGHT : opts.target;
  const samples = data.samples.filter(
    (s) =>
      (!opts.heights || opts.heights.includes(s.height)) &&
      (!opts.fonts || opts.fonts.includes(s.font)),
  );

  // 폰트마다 대조표를 한 번만 만든다 (표본마다 만들면 몇 분씩 걸린다)
  const byFont = new Map();
  const templatesFor = (font) => {
    if (byFont.has(font)) return byFont.get(font);
    const drop = new Set(holdout ? data.holdout[font] || [] : []);
    const list = loadTemplates({
      templates: RAW.templates.filter((t) => !drop.has(t.rows.join(''))),
    });
    byFont.set(font, list);
    return list;
  };

  let ok = 0;
  let unknown = 0;
  let wrong = 0;
  const misses = [];
  // 한 장 읽는 데 걸리는 시간도 같이 잰다 — 이게 곧 프레임 간격의 하한이다
  const times = [];

  // 미리 한 번 돌려 JIT를 예열한다 (안 하면 첫 몇 장이 열 배쯤 느리게 나온다)
  if (samples.length > 0) {
    const s0 = samples[0];
    const warm = upscale(
      new Uint8Array(Buffer.from(s0.gray, 'base64')),
      s0.w,
      s0.h,
      target ? Math.max(1, Math.min(8, target / s0.height)) : 1,
    );
    for (let i = 0; i < 20; i += 1) {
      readTurn(warm.gray, warm.w, warm.h, templatesFor(s0.font), opts.read || {});
    }
  }

  for (const s of samples) {
    const raw = new Uint8Array(Buffer.from(s.gray, 'base64'));
    const img = target ? upscale(raw, s.w, s.h, Math.max(1, Math.min(8, target / s.height))) : { gray: raw, w: s.w, h: s.h };
    const started = process.hrtime.bigint();
    const got = readTurn(img.gray, img.w, img.h, templatesFor(s.font), opts.read || {});
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    const where = `${s.font} ${s.height}px${s.invert ? ' 반전' : ''}`;
    if (!got) {
      unknown += 1;
      if (opts.verbose) misses.push(`모르겠음 ${s.value} (${where})`);
    } else if (got.value === s.value) {
      ok += 1;
    } else {
      wrong += 1;
      misses.push(`틀림 ${s.value} → ${got.value} (${where})`);
    }
  }

  times.sort((a, b) => a - b);
  return {
    total: samples.length,
    ok,
    unknown,
    wrong,
    misses,
    ms: times[times.length >> 1] || 0,
    msMax: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] || 0,
  };
}

function report(title, r, { showMisses = false } = {}) {
  if (!r) {
    console.log(`── ${title} ── 표본이 없어요. npm run fixtures 로 만들어주세요.`);
    return;
  }
  const pct = (n) => `${((n / r.total) * 100).toFixed(1)}%`;
  console.log(`── ${title} (${r.total}장) ──`);
  console.log(`  맞음     ${r.ok} (${pct(r.ok)})`);
  console.log(`  모르겠음 ${r.unknown} (${pct(r.unknown)})  ← 안전한 실패`);
  console.log(`  틀림     ${r.wrong} (${pct(r.wrong)})  ← 0에 가까워야 한다`);
  console.log(`  걸린 시간 중앙값 ${r.ms.toFixed(2)}ms · 상위 5% ${r.msMax.toFixed(2)}ms (한 장 읽는 데)`);
  if (!showMisses) return;
  for (const m of r.misses.slice(0, 30)) console.log(`    · ${m}`);
  if (r.misses.length > 30) console.log(`    … 외 ${r.misses.length - 30}건`);
}

module.exports = { toGrid, byDigit, upscale, bench, loadFixtures, report, RAW };

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  report('처음 보는 폰트 (실제 앱 조건)', bench({ verbose }), {
    showMisses: verbose,
  });
  console.log();
  report('가르친 뒤 (그 폰트를 아는 조건)', bench({ holdout: false }), {
    showMisses: verbose,
  });
  console.log();
  console.log();
  report('참고 — 화면 확대 없이 (원본 크기 그대로)', bench({ target: 0 }));
}
