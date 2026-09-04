// 인식기 문턱값 재기 — 문턱값을 감으로 정하지 않으려고 둔 도구.
//
//   node tools/tune-reader.js
//
// "맞음"이 제일 높은 값이 아니라, **틀림이 목표치 아래인 것 중** 맞음이 가장
// 높은 값을 고른다. 틀린 턴을 믿고 단계를 건너뛰면 순서가 통째로 어긋나서,
// 못 읽고 가만히 있는 것보다 훨씬 나쁘기 때문이다.
'use strict';

const { bench } = require('./bench-reader');
const { MATCH } = require('../src/shared/turnReader');

/** 오독 허용치 — 이 아래에서만 고른다 */
const MAX_WRONG = Number(process.env.MAX_WRONG || 0.015);

const rows = [];
for (const minScore of [0.6, 0.65, 0.7, 0.75]) {
  for (const minMargin of [0.03, 0.04, 0.05, 0.07]) {
    for (const holeY of [0.4, 0.55, 0.7]) {
      for (const splitCost of [0.02, 0.04]) {
        const read = { minScore, minMargin, match: { ...MATCH, holeY, splitCost } };
        const r = bench({ read });
        if (!r) {
          console.log('표본이 없어요. npm run fixtures 로 만들어주세요.');
          process.exit(1);
        }
        rows.push({
          read,
          ok: r.ok / r.total,
          wrong: r.wrong / r.total,
          unknown: r.unknown / r.total,
        });
        process.stdout.write('.');
      }
    }
  }
}
console.log('\n');

const show = (r) =>
  `맞음 ${(r.ok * 100).toFixed(1)}%  모르겠음 ${(r.unknown * 100).toFixed(1)}%  ` +
  `틀림 ${(r.wrong * 100).toFixed(1)}%  |  minScore=${r.read.minScore} ` +
  `minMargin=${r.read.minMargin} holeY=${r.read.match.holeY} splitCost=${r.read.match.splitCost}`;

const safe = rows.filter((r) => r.wrong <= MAX_WRONG).sort((a, b) => b.ok - a.ok);
console.log(`── 틀림 ${(MAX_WRONG * 100).toFixed(1)}% 이하 중 맞음이 높은 순 ──`);
for (const r of (safe.length ? safe : rows.sort((a, b) => a.wrong - b.wrong)).slice(0, 12)) {
  console.log('  ' + show(r));
}
