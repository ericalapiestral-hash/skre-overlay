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
  GRID_N,
  loadTemplates,
  teachShapes,
  TAUGHT_WEIGHT,
  makeShape,
  similarityOf,
  readTurn,
  resizeGray,
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
 * 표본을 키운다 — **앱과 같은 함수**(turnReader.resizeGray)로.
 *
 * 표본은 게임에서 보이는 크기 그대로(22·32·44px)라서, 그냥 재면 **앱이 실제로
 * 인식기에 넣는 것과 다른 것을 재게 된다.** 앱은 인식 전에 CROP_TARGET_HEIGHT
 * 근처로 맞춘다 — 벤치도 똑같이 키워야 숫자가 실제와 맞는다. 예전엔 여기에 따로
 * 이중선형을 두고 앱은 캔버스로 키워서 둘이 달랐다 (오독 0.3% vs 0.6%).
 *
 * 벤치는 **줄이지는 않는다**(k ≤ 1 이면 그대로). 표본이 전부 작아서 줄일 일이 없다.
 */
function upscale(gray, w, h, k) {
  if (k <= 1.01) return { gray, w, h };
  return resizeGray(gray, w, h, k);
}

/** 이만큼 닮았으면 **같은 폰트**에서 뽑은 대조표로 본다 (다른 폰트끼리는 0.97 을 안 넘었다) */
const SAME_FONT = 0.985;

/** 행 문자열(336자 한 줄 또는 줄 배열) → 격자 */
function gridOf(rows) {
  const flat = Array.isArray(rows) ? rows.join('') : String(rows);
  const grid = new Uint8Array(GRID_N);
  for (let i = 0; i < GRID_N && i < flat.length; i += 1) grid[i] = flat[i] === '1' ? 1 : 0;
  return grid;
}

/** 격자를 dx·dy 칸 민다 (넘치는 칸은 버린다) */
function shiftGrid(g, dx, dy) {
  const out = new Uint8Array(GRID_N);
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx >= 0 && sx < GRID_W && sy >= 0 && sy < GRID_H) out[y * GRID_W + x] = g[sy * GRID_W + sx];
    }
  }
  return out;
}

const fontCache = new Map();

/**
 * **처음 보는 폰트** 조건의 대조표 — 표본을 그린 폰트에서 뽑은 것과 닮은 대조표를 뺀다.
 * (가르친 뒤 조건은 taughtFor)
 *
 * @param {string} font 표본의 폰트 이름 (data.holdout 의 열쇠)
 *
 * ★ 예전엔 대조표 행 문자열이 **한 글자까지 똑같을 때만** 뺐다. 그런데 표본 쪽 대조표는
 * 글자를 왼쪽·글자선에 맞춰 그리고 templates.json 은 가운데에 맞춰 그려서 행이 한 칸씩
 * 어긋난다 — 폰트 6벌 중 5벌에서 0~1개만 빠졌다. "처음 보는 폰트"는 이름뿐이었고,
 * "가르친 뒤"는 아무것도 안 더해서 두 줄의 결과가 늘 똑같았다. 이제 칸을 조금씩 밀어
 * 가며 **닮음**으로 가른다 (같은 폰트 0.99~1.00, 다른 폰트는 0.97 을 안 넘었다).
 */
function templatesFor(font) {
  if (fontCache.has(font)) return fontCache.get(font);
  const data = loadFixtures();
  const own = ((data && data.holdout && data.holdout[font]) || []).map((rows, digit) => ({ digit, grid: gridOf(rows) }));
  // 그 폰트 글자를 ±2칸 밀어 본 모양들 — 그리는 자리가 달라도 같은 폰트면 잡힌다
  const shifted = own.map((o) => {
    const shapes = [];
    for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) shapes.push(makeShape(shiftGrid(o.grid, dx, dy)));
    return { digit: o.digit, shapes };
  });
  const list = loadTemplates(RAW).filter((t) => {
    const mine = shifted.find((o) => o.digit === t.digit);
    return !mine || !mine.shapes.some((sh) => similarityOf(sh, t.shape, 0.5) >= SAME_FONT);
  });
  fontCache.set(font, list);
  return list;
}

/**
 * **가르친 뒤** 조건 — 사용자가 [가르치기]로 하는 일을 그대로 흉내 낸다.
 *
 * 처음 보는 폰트의 대조표에서 시작해, **같은 폰트·같은 크기·같은 명암**의 표본 몇 장
 * (TEACH_VALUES — 0~9 를 다 덮는다)을 앱과 같은 함수(teachShapes)로 가르친다. 예전엔 64px 로 그린 그 폰트 글자를 넣었는데, 사용자는 **게임 화면의 크기
 * 그대로** 가르친다 — 다른 것을 재고 있었다. 가르친 값은 채점에서 뺀다 (본 것을 맞히는
 * 건 아무것도 말해 주지 않는다).
 */
const TEACH_VALUES = [0, 4, 7, 8, 9, 12, 36, 56];
const taughtCache = new Map();
function taughtFor(s, target) {
  const key = `${s.font}|${s.height}|${Boolean(s.invert)}|${target}`;
  if (taughtCache.has(key)) return taughtCache.get(key);
  const base = templatesFor(s.font);
  const data = loadFixtures();
  const lessons = data.samples.filter(
    (x) => x.font === s.font && x.height === s.height && Boolean(x.invert) === Boolean(s.invert) && TEACH_VALUES.includes(x.value),
  );
  const taught = [];
  for (const x of lessons) {
    const raw = new Uint8Array(Buffer.from(x.gray, 'base64'));
    const img = target ? upscale(raw, x.w, x.h, Math.max(1, Math.min(8, target / x.height))) : { gray: raw, w: x.w, h: x.h };
    // 앱과 **같은 함수**로 가르친다 (engine.teachFrom → teachShapes)
    const got = teachShapes(img.gray, img.w, img.h, base, String(x.value));
    if (got.ok) taught.push(...got.templates);
  }
  const list = [...base, ...loadTemplates({ templates: taught }, { weight: TAUGHT_WEIGHT })];
  taughtCache.set(key, list);
  return list;
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
 * @param {{taught?: boolean, withoutTaught?: boolean, read?: object, target?: number, maxTurn?: number,
 *          fonts?: string[], heights?: number[], verbose?: boolean}} [opts]
 *   taught  그 폰트를 **가르친 뒤** 조건 (taughtFor 참고). 기본은 처음 보는 폰트 조건 —
 *           표본을 그린 폰트의 대조표를 빼고 맞춘다 (templatesFor 참고)
 *   withoutTaught 가르친 조건과 같은 표본으로 견주려고, 가르칠 때 쓴 값을 뺀다
 *   target  앱처럼 이 높이 근처로 키워서 읽는다 (0이면 원본 크기 그대로)
 *   maxTurn 최대 턴을 이미 아는 조건에서 잰다 — 그보다 큰 표본은 빼고,
 *           readTurn 에도 같이 넘긴다. `read: { maxTurn: 0 }` 으로 같은 표본에서
 *           모르는 조건과 견줄 수 있다
 * @returns {{total:number, ok:number, unknown:number, wrong:number, misses:string[],
 *            ms:number, msMax:number}|null} ms는 한 장 읽는 데 걸린 시간의 중앙값
 */
function bench(opts = {}) {
  const data = loadFixtures();
  if (!data) return null;

  const taught = Boolean(opts.taught);
  const target = opts.target === undefined ? CROP_TARGET_HEIGHT : opts.target;
  // 가르친 조건과 견줄 때는 **같은 표본**이어야 한다 — 가르친 값은 둘 다에서 뺀다
  const skipTaught = taught || opts.withoutTaught;
  const samples = data.samples.filter(
    (s) =>
      (!opts.heights || opts.heights.includes(s.height)) &&
      (!opts.fonts || opts.fonts.includes(s.font)) &&
      (!opts.maxTurn || s.value <= opts.maxTurn) &&
      !(skipTaught && TEACH_VALUES.includes(s.value)),
  );
  const read = { maxTurn: opts.maxTurn || null, ...(opts.read || {}) };

  const tpl = (s) => (taught ? taughtFor(s, target) : templatesFor(s.font));

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
      readTurn(warm.gray, warm.w, warm.h, tpl(s0), read);
    }
  }

  for (const s of samples) {
    const raw = new Uint8Array(Buffer.from(s.gray, 'base64'));
    const img = target ? upscale(raw, s.w, s.h, Math.max(1, Math.min(8, target / s.height))) : { gray: raw, w: s.w, h: s.h };
    const started = process.hrtime.bigint();
    const got = readTurn(img.gray, img.w, img.h, tpl(s), read);
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

module.exports = { toGrid, byDigit, upscale, bench, loadFixtures, report, templatesFor, taughtFor, TEACH_VALUES, RAW };

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  report('처음 보는 폰트 (실제 앱 조건)', bench({ verbose }), {
    showMisses: verbose,
  });
  console.log();
  // 가르친 조건은 가르칠 때 쓴 값을 빼고 잰다 — 견주는 줄도 같은 표본으로
  report('참고 — 처음 보는 폰트, 가르칠 값 뺀 표본', bench({ withoutTaught: true }));
  report('가르친 뒤 (같은 표본)', bench({ taught: true, verbose }), {
    showMisses: verbose,
  });
  console.log();
  // 앱은 화면에서 최대 턴("16 / 70"의 70)을 스스로 알아낸다. 알고 나면 지금 턴의
  // 자릿수가 정해져서 세 덩어리로 갈린 오독이 아예 물린다 — 여기가 그 차이다.
  report('최대 턴을 아는 조건 (70턴 전투)', bench({ maxTurn: 70, verbose }), {
    showMisses: verbose,
  });
  console.log();
  console.log();
  report('참고 — 최대 턴을 모를 때 (같은 표본)', bench({ maxTurn: 70, read: { maxTurn: 0 } }));
  report('참고 — 화면 확대 없이 (원본 크기 그대로)', bench({ target: 0 }));
}
