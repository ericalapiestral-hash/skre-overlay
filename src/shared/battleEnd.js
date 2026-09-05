// 전투가 끝났는지 지켜보기 — 결과 화면에서 턴 인식을 쉬게 한다.
//
// **왜 필요한가.** 전투가 끝나면 결과 화면(별·점수·[다시하기])이 뜨는데, 거기엔 턴이
// 없다. 그런데도 오버레이는 100ms마다 화면을 잘라 읽기를 계속한다 — 화면을 통째로
// 받아 오는 일이라 게임과 CPU를 나눠 쓰는 값이 그대로 나간다. 점수 같은 큰 숫자가
// 턴 자리에 걸치기라도 하면 엉뚱한 값을 읽을 여지도 생긴다.
//
// 끝난 걸 알아채는 신호를 **둘** 둔다. 하나로는 부족하기 때문이다.
//
//  1. **그림 (빠름)** — 턴이 안 읽히는데 **크롭이 프레임마다 거의 안 변하면** 전투 화면이
//     아니다. 스킬 연출은 턴을 가리지만 그 자리 픽셀이 프레임마다 요동친다. 결과 화면은
//     멈춰 있다. 이 신호는 1.5초쯤이면 걸린다.
//  2. **시간 (안전줄)** — 그림 신호가 안 걸려도(결과 화면에 반짝이는 연출이 있다든지)
//     12초 동안 못 읽으면 끝난 걸로 본다. 연출이 12초씩 가리는 일은 없다.
//
// **오검출의 대가를 작게 만드는 게 이 설계의 핵심이다.** 쉬는 중에도 1초에 한 번은
// 계속 보고, 턴이 다시 보이는 순간 원래 속도로 돌아간다. 그래서 긴 연출을 결과 화면으로
// 잘못 봐도 잃는 건 1초뿐이다 — 덕분에 신호를 과감하게 잡을 수 있다.
//
// **한 번도 못 읽었으면 쉬지 않는다.** 턴 영역이 잘못 잡혔을 때 "쉬는 중"이라고 하면
// 사람은 잘 돌고 있는 줄 안다. 그때 필요한 말은 "영역을 다시 잡으세요"다.
'use strict';

/** 안 변한 채로 이만큼 지나면 결과 화면으로 본다 (ms) */
const STILL_MS = 1500;
/** 그림 신호가 안 걸려도 이만큼 못 읽으면 끝난 걸로 본다 (ms) */
const BLIND_MS = 12000;
/** 픽셀 밝기가 이만큼 넘게 달라야 "변했다"로 센다 (캡처 잡음을 넘기려고) */
const PIXEL_DIFF = 10;
/** 이 비율보다 적게 변했으면 "멈춰 있다" */
const MOVED_RATIO = 0.02;
/** 픽셀을 몇 개마다 볼지 — 전부 볼 이유가 없다 */
const STEP = 3;

/**
 * @typedef {{over: boolean, why: string, entered: boolean}} Verdict
 *   why: '' | 'still'(그림으로 잡음) | 'blind'(시간 안전줄)
 *   entered: 이 프레임에서 **막 쉬기 시작했다** (엔진이 그때 한 번만 할 일이 있다)
 */

/**
 * @param {{stillMs?: number, blindMs?: number, pixelDiff?: number,
 *          movedRatio?: number}} [options]
 */
function createBattleEndWatch(options = {}) {
  const stillMs = options.stillMs ?? STILL_MS;
  const blindMs = options.blindMs ?? BLIND_MS;
  const pixelDiff = options.pixelDiff ?? PIXEL_DIFF;
  const movedRatio = options.movedRatio ?? MOVED_RATIO;

  /** 직전 프레임 — 크기가 같으면 다시 안 만든다 */
  let prev = null;
  let prevW = 0;
  let prevH = 0;

  let over = false;
  /** 한 번이라도 턴을 읽었나 — 못 읽었으면 쉬지 않는다 (위 설명) */
  let armed = false;
  /** @type {number|null} */
  let blindSince = null;
  /** @type {number|null} */
  let stillSince = null;

  function reset() {
    over = false;
    armed = false;
    blindSince = null;
    stillSince = null;
    prevW = 0;
    prevH = 0;
  }

  /** 직전 프레임과 거의 같은가 — 크기가 다르면(영역·해상도가 바뀌면) 비교하지 않는다 */
  function still(gray, w, h) {
    if (!gray || w !== prevW || h !== prevH || !prev) return false;
    let moved = 0;
    let seen = 0;
    for (let i = 0; i < gray.length; i += STEP) {
      seen += 1;
      const d = gray[i] - prev[i];
      if (d > pixelDiff || d < -pixelDiff) moved += 1;
    }
    return seen > 0 && moved / seen < movedRatio;
  }

  function remember(gray, w, h) {
    if (!gray) return;
    if (!prev || prev.length !== gray.length) prev = new Uint8Array(gray.length);
    prev.set(gray);
    prevW = w;
    prevH = h;
  }

  /**
   * 프레임 하나를 본다.
   *
   * @param {boolean} read 이 프레임에서 턴을 읽었나
   * @param {Uint8Array|null} gray 잘라 온 픽셀 (그림 신호에 쓴다)
   * @returns {Verdict}
   */
  function see(read, gray, w, h, now) {
    const was = over;
    if (read) {
      // 턴이 보이면 전투 중이다 — 다른 신호는 볼 것도 없다
      armed = true;
      over = false;
      blindSince = null;
      stillSince = null;
    } else if (armed) {
      const blindAt = blindSince === null ? now : blindSince;
      blindSince = blindAt;
      if (still(gray, w, h)) {
        if (stillSince === null) stillSince = now;
      } else {
        stillSince = null;
      }
      if (stillSince !== null && now - stillSince >= stillMs) over = true;
      else if (now - blindAt >= blindMs) over = true;
    }
    const why = !over ? '' : stillSince !== null && now - stillSince >= stillMs ? 'still' : 'blind';
    remember(gray, w, h);
    return { over, why, entered: over && !was };
  }

  return {
    see,
    reset,
    get over() {
      return over;
    },
  };
}

module.exports = { createBattleEndWatch, STILL_MS, BLIND_MS, PIXEL_DIFF, MOVED_RATIO };
