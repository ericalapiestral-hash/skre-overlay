// 인식기 문턱값 재기 — 문턱값을 감으로 정하지 않으려고 둔 도구.
//
//   node tools/tune-reader.js
//
// "맞음"이 제일 높은 값이 아니라, **틀림이 가장 적은 것 중** 맞음이 가장 높은 값을
// 고른다. 틀린 턴을 믿고 단계를 건너뛰면 순서가 통째로 어긋나서, 못 읽고 가만히
// 있는 것보다 훨씬 나쁘기 때문이다.
//
// ★ **앱이 실제로 겪는 조건을 다 같이 본다.** 예전엔 "처음 보는 폰트" 한 줄만 봤다.
// 그 사이 인식기가 슬래시("N / M")·최대 턴·가르치기를 얻었는데 이 도구는 그걸 몰라서,
// 코드에 든 값도 재현하지 못했다 (코드 0.7/0.04, 도구는 0.05 를 골랐다). 이제 두 단계로 잰다:
//  1. 처음 보는 폰트 한 줄로 값 묶음 전부를 훑는다 (빠르다).
//  2. 그중 앞의 몇 개를 **앱 조건 줄 전부**로 다시 잰다 — 최대 턴을 알 때·모를 때,
//     가르친 뒤, "N / M" 표본. 틀림 합으로 고른다.
'use strict';

const { bench, loadFixtures, templatesFor, upscale } = require('./bench-reader');
const { MATCH, CROP_TARGET_HEIGHT, readTurn } = require('../src/shared/turnReader');

/** 2단계로 넘길 개수 */
const FINALISTS = Number(process.env.FINALISTS || 12);

/** "N / M" 표본 — 앱이 슬래시까지 보는 조건 */
function pairsBench(read) {
  const data = loadFixtures();
  let ok = 0;
  let unknown = 0;
  let wrong = 0;
  for (const s of data.pairs || []) {
    const f = upscale(new Uint8Array(Buffer.from(s.gray, 'base64')), s.w, s.h,
      Math.max(1, Math.min(8, CROP_TARGET_HEIGHT / s.height)));
    const r = readTurn(f.gray, f.w, f.h, templatesFor(s.font), read);
    if (!r) unknown += 1;
    else if (r.value === s.value) ok += 1;
    else wrong += 1;
  }
  return { ok, unknown, wrong, total: ok + unknown + wrong };
}

/** 표본이 있는 걸 위에서 확인했으니 bench 는 null 이 아니다 */
const must = (r) => /** @type {NonNullable<ReturnType<typeof bench>>} */ (r);

function allConditions(read) {
  const rows = {
    처음보는폰트: must(bench({ read })),
    최대턴앎: must(bench({ read, maxTurn: 70 })),
    최대턴모름: must(bench({ read: { ...read, maxTurn: 0 }, maxTurn: 70 })),
    가르친뒤: must(bench({ read, taught: true })),
    NM: pairsBench(read),
  };
  let wrong = 0;
  let unknown = 0;
  let ok = 0;
  for (const r of Object.values(rows)) {
    wrong += r.wrong;
    unknown += r.unknown;
    ok += r.ok;
  }
  return { rows, wrong, unknown, ok };
}

if (!loadFixtures()) {
  console.log('표본이 없어요. npm run fixtures 로 만들어주세요.');
  process.exit(1);
}

const current = { minScore: 0.7, minMargin: 0.05, match: MATCH };
const combos = [];
for (const minScore of [0.6, 0.65, 0.7, 0.75]) {
  for (const minMargin of [0.03, 0.04, 0.05, 0.06, 0.07]) {
    for (const holeY of [0.4, 0.55, 0.7]) {
      for (const splitCost of [0.02, 0.04]) {
        combos.push({ minScore, minMargin, match: { ...MATCH, holeY, splitCost } });
      }
    }
  }
}

const first = combos.map((read) => {
  const r = must(bench({ read }));
  process.stdout.write('.');
  return { read, r };
});
console.log('\n');
first.sort((a, b) => a.r.wrong - b.r.wrong || b.r.ok - a.r.ok);

const show = (read) =>
  `minScore=${read.minScore} minMargin=${read.minMargin} holeY=${read.match.holeY} splitCost=${read.match.splitCost}`;
const line = (x) =>
  `틀림 합 ${x.wrong} · 모르겠음 합 ${x.unknown} · 맞음 합 ${x.ok}  | ` +
  Object.entries(x.rows).map(([k, r]) => `${k} ${r.ok}/${r.unknown}/${r.wrong}`).join(' · ');

const finalists = first.slice(0, FINALISTS).map(({ read }) => ({ read, ...allConditions(read) }));
finalists.sort((a, b) => a.wrong - b.wrong || a.unknown - b.unknown || b.ok - a.ok);
console.log(`── 앱 조건 전부로 다시 잰 상위 ${FINALISTS}개 (틀림 합 → 모르겠음 합 → 맞음 합 순) ──`);
for (const f of finalists) console.log(`  ${show(f.read)}\n    ${line(f)}`);

console.log('\n── 지금 코드의 값 ──');
console.log(`  ${show(current)}\n    ${line(allConditions(current))}`);
