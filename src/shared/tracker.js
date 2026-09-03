// 인식한 턴 숫자 → 지금 해야 할 단계.
//
// 도감 표기가 두 가지라 둘 다 따라가야 한다:
//   · 턴이 문서 전체에서 이어지는 빌드   (0 4 8 … 16 | 16 20 …)
//   · 라운드마다 0부터 다시 시작하는 빌드 (0 4 8 | 0 4 8 | 0 4 …)
//
// 순수 함수만 둔다 — 화면도 캡처도 모르게 해서 테스트로 전부 확인할 수 있게 했다.
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

function clampIndex(steps, index) {
  const last = steps.length - 1;
  return Math.max(0, Math.min(index ?? 0, last));
}

/**
 * 인식된 턴으로 다음 단계를 고른다.
 *
 * 라운드 구간을 앞에서부터 훑되:
 *  · 현재 라운드부터 본다 (라운드 안에서는 되돌아갈 수 있다 — 전투 재시작 대응)
 *  · "턴 >= t" 인 단계가 있으면 그중 첫 번째가 다음 행동
 *  · 그 라운드의 최대 턴이 t보다 작으면 이미 지난 라운드 — 통째로 건너뛴다
 *  · 턴이 현재 라운드 시작보다도 작아졌으면 재시작으로 보고 처음부터 다시 찾는다
 */
function nextIndexForTurn(steps, cur, t) {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const last = steps.length - 1;
  const index = clampIndex(steps, cur);

  const ranges = segmentRanges(steps);
  const curSeg = segmentAt(ranges, index);

  const searchFrom = (segIdx) => {
    for (let s = segIdx; s < ranges.length; s += 1) {
      const [a, b] = ranges[s];
      for (let i = a; i <= b; i += 1) {
        if (steps[i].turn >= t) return i;
      }
    }
    return -1;
  };

  // 재시작 — 현재 라운드의 첫 턴보다도 작은 숫자가 나왔다.
  // (라운드마다 0으로 리셋되는 빌드는 첫 턴이 0이라 여기 안 걸리고 아래에서 처리된다)
  if (t < steps[ranges[curSeg][0]].turn) {
    const again = searchFrom(0);
    if (again !== -1) return again;
  }

  const found = searchFrom(curSeg);
  return found === -1 ? last : found;
}

/**
 * 턴 표시가 한동안 사라졌다가 돌아왔을 때의 다음 단계.
 *
 * 게임은 스킬 연출과 라운드 전환 동안 턴 숫자를 감춘다. 라운드마다 턴이 0부터 다시
 * 시작하는 빌드에서는 돌아온 숫자가 직전과 같아(0 → 0) 평소 규칙으로는 제자리에
 * 머물고, 라운드가 넘어간 걸 영영 못 따라간다.
 *
 * 그래서 "사라졌다 돌아왔는데 앞으로 못 갔고, 게다가 지금이 이 라운드의 마지막
 * 단계"면 다음 라운드로 넘긴다. 라운드에 아직 할 게 남아 있으면 연출이 지나간
 * 것뿐이므로 건드리지 않는다 — 이 조건이 없으면 연출 때마다 라운드를 건너뛴다.
 */
function nextIndexAfterGap(steps, cur, t) {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const index = clampIndex(steps, cur);

  const normal = nextIndexForTurn(steps, index, t);
  if (normal !== index) return normal;

  const ranges = segmentRanges(steps);
  const curSeg = segmentAt(ranges, index);
  if (index !== ranges[curSeg][1]) return normal; // 이 라운드에 아직 남은 단계가 있다

  const nextSeg = ranges[curSeg + 1];
  return nextSeg ? nextSeg[0] : normal;
}

/** 처음 켰을 때(현재 위치가 없을 때)의 시작 단계 */
function indexForTurn(steps, t) {
  return nextIndexForTurn(steps, 0, t);
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

/**
 * 지금 위치에서 곧 나올 법한 턴 숫자들.
 *
 * 현재 라운드에 남은 턴 + 다음 라운드의 턴 + (재시작 대비) 첫 라운드의 턴.
 * 인식 결과가 이 안에 있으면 훨씬 믿을 만하고, 애매한 읽기를 여기로 맞춰 준다.
 */
function plausibleTurns(steps, cur) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const index = clampIndex(steps, cur);
  const ranges = segmentRanges(steps);
  const curSeg = segmentAt(ranges, index);

  const set = new Set();
  const add = (a, b) => {
    for (let i = a; i <= b; i += 1) set.add(steps[i].turn);
  };
  add(ranges[curSeg][0], ranges[curSeg][1]);
  if (ranges[curSeg + 1]) add(ranges[curSeg + 1][0], ranges[curSeg + 1][1]);
  add(ranges[0][0], ranges[0][1]);
  return [...set].sort((a, b) => a - b);
}

module.exports = {
  segmentRanges,
  segmentAt,
  indexForTurn,
  nextIndexForTurn,
  nextIndexAfterGap,
  knownTurns,
  plausibleTurns,
};
