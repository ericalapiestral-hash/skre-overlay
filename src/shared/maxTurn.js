// 최대 턴 지켜보기 — `16 / 70` 의 오른쪽 숫자를 믿을 만해지면 붙잡아 둔다.
//
// **왜 이게 있나.** 최대 턴은 전투 내내 안 바뀐다. 인식기가 공짜로 얻을 수 있는
// 유일한 검증 수단이고, 알고 나면 두 가지가 따라온다:
//
//  1) **지금 턴의 자릿수가 정해진다.** "70턴 중"이면 지금 턴은 두 자리를 넘을 수 없다.
//     readTurn 에 maxTurn 으로 건네주면 세 덩어리로 갈린 명암을 아예 물린다 —
//     44px "8"이 구멍까지 세 덩어리로 잡혀 "551"로 읽히던 마지막 오독이 이걸로 사라졌다
//     (표본 720장 · 1008장 모두 오독 0).
//  2) **최대 턴이 프레임마다 달라지면 그 프레임은 수상하다.** 슬래시를 엉뚱한 데서
//     잘랐다는 뜻이라 왼쪽도 믿을 게 못 된다.
//
// **잘못 믿으면 영영 못 읽는다는 게 이 구조의 유일한 위험이다.** 70을 7로 잘못 믿으면
// 한 자리 값만 통과시키니 읽히는 게 없어지고, 읽히는 게 없으면 최대 턴도 다시 못 보므로
// 스스로 못 빠져나온다. 그래서 세 겹으로 막는다.
//  · **또렷한 것만 센다** — 표본에서 틀린 최대 턴은 전부 흐리게(0.73) 읽혔다.
//  · **다른 값이 계속 이어지면 갈아탄다** (채택보다 더 많은 증거를 요구한다).
//  · **한동안 아무것도 못 읽으면 잊는다** — 위의 막다른 골목에서 빠져나오는 길이다.
'use strict';

/** 또렷한 같은 값이 이만큼 이어지면 믿는다 */
const ADOPT = 3;
/** 이미 믿는 값이 있을 때, 다른 값이 이만큼 이어져야 갈아탄다 */
const RELEARN = 8;
/** 이만큼 못 읽으면 믿던 값을 잊는다 (100ms 주기로 2초) */
const FORGET = 20;
/** 이 점수 아래로 읽힌 최대 턴은 세지도, 물리지도 않는다 */
const STRONG = 0.86;

/**
 * @typedef {{max: number|null, maxConfidence: number}} MaxRead
 * @typedef {{trust: boolean, why: string}} Verdict
 *   trust=false 면 이 프레임은 통째로 안 믿는다 (추적기에는 "가려짐"으로 들어간다)
 */

/**
 * @param {{adopt?: number, relearn?: number, forget?: number, strongScore?: number}} [options]
 */
function createMaxTurnWatch(options = {}) {
  const adopt = options.adopt ?? ADOPT;
  const relearn = options.relearn ?? RELEARN;
  const forget = options.forget ?? FORGET;
  const strongScore = options.strongScore ?? STRONG;

  /** @type {number|null} 지금 믿고 있는 최대 턴 */
  let known = null;
  /** 같은 값이 몇 번 이어졌는지 */
  let run = { value: 0, n: 0 };
  /** 연속으로 못 읽은 프레임 수 */
  let blind = 0;

  function reset() {
    known = null;
    run = { value: 0, n: 0 };
    blind = 0;
  }

  /**
   * 프레임 하나를 본다.
   *
   * @param {MaxRead|null} reading 인식 결과 (못 읽었으면 null)
   * @returns {Verdict}
   */
  function see(reading) {
    if (!reading) {
      blind += 1;
      // 믿던 값이 틀려서 아무것도 안 읽히는 것일 수 있다 — 잊고 처음부터 다시 본다
      if (known !== null && blind >= forget) reset();
      return { trust: true, why: '' };
    }
    blind = 0;

    const m = reading.max;
    // 슬래시가 안 보였거나 흐리게 읽혔으면 아무 판단도 안 한다.
    // (사용자가 영역을 숫자에만 딱 맞춰 잡았으면 여기서 늘 끝난다 — 검증이 통째로 꺼진다)
    if (m === null || m <= 0 || (reading.maxConfidence ?? 0) < strongScore) {
      return { trust: true, why: '' };
    }

    if (m === run.value) run.n += 1;
    else run = { value: m, n: 1 };

    if (known === null) {
      if (run.n >= adopt) known = m;
      return { trust: true, why: '' };
    }
    if (m === known) return { trust: true, why: '' };
    // 이어서 다른 값만 나오면 우리가 틀린 것이다
    if (run.n >= relearn) {
      known = m;
      return { trust: true, why: '' };
    }
    return { trust: false, why: 'maxMismatch' };
  }

  return {
    see,
    reset,
    /** 지금 믿는 최대 턴 (모르면 null) — readTurn 에 그대로 건넨다 */
    get known() {
      return known;
    },
  };
}

module.exports = { createMaxTurnWatch, ADOPT, RELEARN, FORGET, STRONG };
