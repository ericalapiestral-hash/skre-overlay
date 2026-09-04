// 단계 목록을 라운드로 나누는 도우미 — 추적기(follower.js)와 엔진이 같이 쓴다.
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

/**
 * 이 빌드에 나오는 턴 숫자 전부 (작은 것부터, 중복 없이).
 *
 * 숫자 인식이 애매할 때 후보를 좁히는 데 쓴다. 게임이 어떤 숫자를 보여줄 수 있는지
 * 우리가 이미 알고 있는데 그걸 안 쓰는 건 아까운 일이다.
 */
function knownTurns(steps) {
  const set = new Set();
  for (const s of steps || []) if (Number.isFinite(s.turn)) set.add(s.turn);
  return [...set].sort((a, b) => a - b);
}

module.exports = { segmentRanges, segmentAt, knownTurns };
