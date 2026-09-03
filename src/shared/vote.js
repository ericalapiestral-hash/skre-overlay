// 프레임마다 읽은 숫자 → 믿을 만한 턴 하나.
//
// 화면을 700ms마다 읽으면 스킬 연출·이펙트 때문에 한두 프레임은 엉뚱하게 읽힌다.
// 한 프레임만 보고 단계를 넘기면 그 한 번에 순서가 통째로 어긋난다. 그래서
// 최근 몇 프레임을 모아 **두 번 이상 같게 읽힌 값만** 받아들인다.
//
// 되돌아가는 숫자(40 → 4)는 전투 재시작일 수도, 오독일 수도 있다. 손해가 큰 쪽이
// 오독이라 확인 횟수를 한 번 더 요구한다. 확실하게 읽힌 값(점수가 높고 후보로
// 맞춘 게 아닌 값)은 한 번에 두 표로 친다 — 잘 보이는 화면에서 느려지지 않게.
'use strict';

const DEFAULTS = {
  /** 표를 세는 창 크기 (프레임) */
  window: 5,
  /** 받아들이는 데 필요한 표 */
  needed: 2,
  /** 이만큼 연속으로 못 읽으면 "연출 중"으로 본다 (약 2초) */
  gapTicks: 3,
  /** 이 점수 이상이면 확실하게 읽힌 것으로 보고 두 표를 준다 */
  strongScore: 0.86,
  /** 이만큼 넘게 되돌아가는 값은 확인을 한 번 더 요구한다 */
  backJump: 8,
};

/**
 * @typedef {{value: number, confidence?: number, snapped?: boolean}} Reading
 * @typedef {{accepted: number|null, changed: boolean, afterGap: boolean,
 *            gap: boolean, misses: number, everRead: boolean}} VoteResult
 */

function createVoter(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  /** @type {Reading[]} */
  let recent = [];
  /** @type {number|null} */
  let accepted = null;
  let misses = 0;
  let gap = false;
  let everRead = false;

  /**
   * 한 프레임의 결과를 넣는다.
   * @param {Reading|null} reading 못 읽었으면 null
   * @returns {VoteResult}
   */
  function push(reading) {
    if (!reading || !Number.isFinite(reading.value)) {
      misses += 1;
      recent = [];
      if (misses >= cfg.gapTicks) gap = true;
      return { accepted, changed: false, afterGap: false, gap, misses, everRead };
    }

    misses = 0;
    everRead = true;
    recent.push(reading);
    if (recent.length > cfg.window) recent.shift();

    const votes = recent
      .filter((r) => r.value === reading.value)
      .reduce(
        (n, r) => n + ((r.confidence ?? 0) >= cfg.strongScore && !r.snapped ? 2 : 1),
        0,
      );

    let needed = cfg.needed;
    if (accepted !== null && accepted - reading.value > cfg.backJump) needed += 1;
    if (votes < needed) {
      return { accepted, changed: false, afterGap: false, gap, misses, everRead };
    }

    const afterGap = gap;
    const changed = accepted !== reading.value;
    accepted = reading.value;
    gap = false;
    // 확정한 값은 창을 비워 다음 값이 처음부터 표를 모으게 한다
    recent = [];
    return { accepted, changed, afterGap, gap: false, misses: 0, everRead };
  }

  /** 자동을 껐다 켜거나 빌드를 바꿨을 때 */
  function reset() {
    recent = [];
    accepted = null;
    misses = 0;
    gap = false;
    everRead = false;
  }

  return {
    push,
    reset,
    get accepted() {
      return accepted;
    },
    get misses() {
      return misses;
    },
    get everRead() {
      return everRead;
    },
  };
}

module.exports = { createVoter, DEFAULTS };
