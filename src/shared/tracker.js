// 단계 목록을 라운드로 나누는 도우미 — 추적기(follower.js)가 쓴다.
//
// 턴 숫자 → 단계 이동의 규칙 자체는 여기 없다. 그건 follower.js에 있고,
// 실제 전투 시나리오(test/scenarios/)로 확인한다.
'use strict';

/** 같은 라벨(라운드)이 이어지는 구간들의 [시작, 끝] 목록 */
function segmentRanges(steps) {
  const ranges = [];
  if (!Array.isArray(steps) || steps.length === 0) return ranges;
  let start = 0;
  for (let i = 1; i <= steps.length; i += 1) {
    if (i === steps.length || steps[i].label !== steps[start].label) {
      ranges.push([start, i - 1]);
      start = i;
    }
  }
  return ranges;
}

/** 현재 단계가 속한 구간 번호 */
function segmentAt(ranges, index) {
  const i = ranges.findIndex(([a, b]) => index >= a && index <= b);
  return i < 0 ? 0 : i;
}

// (예전엔 "빌드에 나오는 턴 목록 — 인식 후보로 쓴다"는 knownTurns 가 여기 있었다. 아무도 안
// 쓰는데 주석이 후보 기능을 되살리라고 권하고 있었다 — CLAUDE.md "후보 — 걷어냈다" 참고. 지웠다.)
module.exports = { segmentRanges, segmentAt };
