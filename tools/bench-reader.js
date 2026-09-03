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
const { GRID_W, GRID_H, loadTemplates, readTurn } = require('../src/shared/turnReader');

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
 * @param {{holdout?: boolean, useCandidates?: boolean, read?: object,
 *          fonts?: string[], heights?: number[], verbose?: boolean}} [opts]
 *   holdout 표본을 그린 폰트의 대조표를 빼고 맞춘다 (기본 true = 처음 보는 폰트 조건)
 * @returns {{total:number, ok:number, unknown:number, wrong:number, misses:string[]}|null}
 */
function bench(opts = {}) {
  const data = loadFixtures();
  if (!data) return null;

  const holdout = opts.holdout !== false;
  const samples = data.samples.filter(
    (s) =>
      (!opts.heights || opts.heights.includes(s.height)) &&
      (!opts.fonts || opts.fonts.includes(s.font)),
  );
  // 실제 앱은 빌드에 나오는 턴만 후보로 넘긴다 — 그 조건도 잴 수 있게
  const values = [...new Set(data.samples.map((s) => s.value))].sort((a, b) => a - b);
  const candidates = opts.useCandidates ? values : undefined;

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

  for (const s of samples) {
    const gray = new Uint8Array(Buffer.from(s.gray, 'base64'));
    const got = readTurn(gray, s.w, s.h, templatesFor(s.font), { ...(opts.read || {}), candidates });
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

  return { total: samples.length, ok, unknown, wrong, misses };
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
  if (!showMisses) return;
  for (const m of r.misses.slice(0, 30)) console.log(`    · ${m}`);
  if (r.misses.length > 30) console.log(`    … 외 ${r.misses.length - 30}건`);
}

module.exports = { toGrid, byDigit, bench, loadFixtures, report, RAW };

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  report('처음 보는 폰트 · 후보 없음', bench({ verbose }), { showMisses: verbose });
  console.log();
  report('처음 보는 폰트 · 빌드 턴 후보 사용 (실제 앱 조건)', bench({ verbose, useCandidates: true }), {
    showMisses: verbose,
  });
  console.log();
  report('가르친 뒤 (그 폰트를 아는 조건)', bench({ holdout: false, useCandidates: true }), {
    showMisses: verbose,
  });
}
