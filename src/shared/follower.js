// 턴 추적기 — 프레임마다 읽힌 숫자(또는 가려짐)를 받아 "지금 할 단계"를 정한다.
//
// 게임에서 실제로 벌어지는 일이 이 모듈의 존재 이유다:
//  · 스킬 연출이 턴 숫자를 가린다 (0.3~3초). 그동안 전투는 계속 간다.
//  · 반쯤 가려지면 엉뚱한 숫자로 읽힌다 ("16"의 1이 가려져 "6").
//  · 게임 효과로 턴이 1~2턴 **뒤로 밀린다.** 오독이 아니라 실제다.
//  · 전투를 다시 시작하면 처음으로 돌아간다.
//  · 리셋 빌드는 라운드마다 턴이 0부터 다시 시작한다.
//
// 지켜야 하는 정책은 test/scenarios/README.md 에 P1~P9로 적혀 있고, 그 폴더의
// 시나리오들이 전부 이 모듈을 통과해야 한다. 규칙을 고치면 README부터 고칠 것.
//
// 원칙 하나로 요약하면: **앞으로는 가볍게, 뒤로는 무겁게.**
// 턴은 원래 오르기만 한다. 뒤로 가는 읽기는 밀림(그대로 둔다)·오독(그대로 둔다)·
// 재시작(한참 이어져야 믿는다)·리셋 라운드 전환(둘 이상 이어져야 믿는다) 넷 중
// 하나이고, 넷 중 셋은 "그대로 둔다"가 답이다. 반대로 앞으로 가는 읽기는 대개 진짜다 —
// 단, 두 단계 이상을 한꺼번에 건너뛰는 것만은 잠깐 의심한다.
//
// "이어진다"는 **같은 값**이 아니라 **같은 조건**이 이어지는 것이다. 전투 중엔 턴이
// 프레임마다 바뀌므로(9, 10, 11 …) 같은 값을 기다리면 영영 못 넘어간다. 그래서
// "건너뛸 곳이 같은 단계인가", "첫 턴 근처인가" 같은 조건이 몇 프레임·몇 ms 이어졌는지 센다.
'use strict';

const { segmentRanges, segmentAt } = require('./tracker');

const DEFAULTS = {
  /** 또렷한 읽기의 기준 점수 — 이 이상이면 한 프레임에 받아들인다 */
  strongScore: 0.86,
  /** 이만큼(턴)까지 뒤로 가는 건 밀림으로 보고 그대로 둔다 (P3) */
  pushback: 3,
  /** 두 단계 이상 건너뛰는 이동이 믿을 만해지려면 (P7) — 100ms 프레임이면 3프레임 */
  jumpMs: 200,
  jumpFrames: 2,
  /**
   * 재시작으로 믿으려면 (P6) — 100ms 프레임이면 7프레임.
   * 진짜 재시작은 0이 몇 초씩 가만히 있으니 오래 기다려도 손해가 없다. 반대로
   * "16"의 6이 가려져 "1"로 읽히는 건 연출 동안만이라, 길게 요구할수록 안전하다.
   */
  restartMs: 600,
  restartFrames: 3,
  /** 재시작으로 볼 숫자: 첫 턴 + 이 값 이하 */
  restartSlack: 1,
  /** 리셋 라운드 전환에 필요한 프레임 (P5) */
  resetFrames: 2,
  /** 라운드 중간에 리셋 전환을 믿으려면 그 앞에 이만큼 가려져 있어야 한다 (P5) */
  resetGapMs: 500,
  /** 건너뛴 뒤 되돌릴 수 있는 시간 (P8) */
  undoWindowMs: 3000,
  /** 되돌리려면 (P8) — 100ms 프레임이면 3프레임 */
  undoMs: 200,
  undoFrames: 2,
  /** 되돌리기 판단에서 "건너뛰기 전 위치에 맞는 숫자"의 범위 (P8) */
  undoBelow: 3,
  undoAbove: 6,
};

/**
 * @typedef {{turn: number, label: string}} Step
 * @typedef {{value: number, confidence?: number, snapped?: boolean}} Reading
 * @typedef {{index: number, moved: boolean, turn: number|null, raw: number|null,
 *            hidden: boolean, hiddenMs: number, why: string}} FollowResult
 */

/** 조건이 이어진 프레임 수와 시간을 센다 */
function createStreak() {
  let since = 0;
  let frames = 0;
  let key = null;
  let gapBefore = 0;
  return {
    /** 조건이 맞으면 잇고, 아니면 끊는다. key가 달라져도 끊는다 */
    tick(ok, now, k = true, gap = 0) {
      if (!ok || key !== k) {
        if (!ok) {
          frames = 0;
          key = null;
          return;
        }
        since = now;
        frames = 0;
        key = k;
        gapBefore = gap;
      }
      frames += 1;
    },
    clear() {
      frames = 0;
      key = null;
    },
    held(minFrames, minMs, now) {
      return frames >= minFrames && now - since >= minMs;
    },
    get frames() {
      return frames;
    },
    get gapBefore() {
      return gapBefore;
    },
  };
}

/**
 * @param {Step[]} steps 펼쳐진 단계 (같은 label이 이어지는 구간이 한 라운드)
 * @param {Partial<typeof DEFAULTS> & {index?: number}} [options]
 */
function createFollower(steps, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const flow = Array.isArray(steps) ? steps : [];
  const ranges = segmentRanges(flow);
  const last = flow.length - 1;

  /**
   * 라운드 경계가 "리셋"인지 — 다음 라운드 첫 턴이 이 라운드 마지막 턴 이하면
   * 턴이 새로 시작하는 것이다. 그 경계 너머로는 숫자를 비교할 수 없다.
   */
  const resetAfter = ranges.map(([, b], s) => {
    const next = ranges[s + 1];
    return next ? flow[next[0]].turn <= flow[b].turn : false;
  });

  let index = clamp(options.index ?? 0);
  /** 마지막으로 믿은 턴 */
  let believed = null;
  /** 같은 값이 이어지는 구간 — 흐린 읽기를 받아들일 때만 쓴다 */
  let run = null;
  /** 가려짐을 재려고 */
  let hiddenSince = null;
  /** 직전 읽기 앞에 가려져 있던 시간 */
  let gapBefore = 0;
  /** 크게 건너뛴 기록 — 되돌리기용 (P8) */
  let jump = null;

  const streaks = {
    jump: createStreak(),
    reset: createStreak(),
    restart: createStreak(),
    undo: createStreak(),
  };

  function clamp(i) {
    if (flow.length === 0) return 0;
    return Math.max(0, Math.min(Number(i) || 0, last));
  }

  /**
   * P1 — from부터 앞으로 훑어 "턴 ≥ t"인 첫 단계.
   * 리셋 경계는 넘지 않는다: 그 너머의 숫자는 다른 눈금이다. 이 라운드에 더 할 게
   * 없으면 라운드 마지막 단계에 머문다 — 라운드가 아직 안 끝난 것뿐이다.
   */
  function forwardFrom(from, t) {
    let s = segmentAt(ranges, from);
    let i = from;
    for (;;) {
      const [, b] = ranges[s];
      for (; i <= b; i += 1) if (flow[i].turn >= t) return i;
      if (resetAfter[s]) return b;
      if (s + 1 >= ranges.length) return last;
      s += 1;
      i = ranges[s][0];
    }
  }

  /**
   * 한 프레임을 넣는다.
   * @param {Reading|null} reading 못 읽었으면 null
   * @param {number} now ms 단위 시각 (단조 증가면 무엇이든)
   * @returns {FollowResult}
   */
  function push(reading, now) {
    const out = (moved, why, raw) => ({
      index,
      moved,
      turn: believed,
      raw,
      hidden: hiddenSince !== null,
      hiddenMs: hiddenSince !== null ? now - hiddenSince : gapBefore,
      why,
    });

    // P2 — 가려짐은 아무것도 움직이지 않는다. 얼마나 가려졌는지만 잰다.
    // 이어지던 조건도 여기서 끊는다: 진짜 재시작·전환은 숫자가 가만히 있고,
    // 연출 중 오독은 깜빡인다. 깜빡이는 쪽을 못 믿게 하려는 것이다.
    if (!reading || !Number.isFinite(reading.value)) {
      if (hiddenSince === null) hiddenSince = now;
      run = null;
      streaks.jump.clear();
      clearBackward();
      return out(false, 'hidden', null);
    }

    const v = reading.value;
    gapBefore = hiddenSince !== null ? now - hiddenSince : 0;
    hiddenSince = null;
    if (run && run.value === v) run.frames += 1;
    else run = { value: v, frames: 1 };

    const strong = (reading.confidence ?? 0) >= cfg.strongScore && !reading.snapped;
    if (!strong && run.frames < 2) return out(false, 'weak', v);
    if (flow.length === 0) return out(false, 'empty', v);

    // 처음 읽는 값 (또는 손으로 옮긴 뒤) — 앞이면 따라가고 뒤면 그대로
    if (believed === null) {
      if (v >= flow[index].turn) return move(forwardFrom(index, v), v, 'first', out);
      believed = v;
      return out(false, 'first-behind', v);
    }

    return v >= believed ? forward(v, now, out) : backward(v, now, out);
  }

  function move(target, v, why, out) {
    const moved = target !== index;
    index = target;
    believed = v;
    return out(moved, why, v);
  }

  function clearBackward() {
    streaks.reset.clear();
    streaks.restart.clear();
    streaks.undo.clear();
  }

  /** 크게 뛴 게 오독이었는지 — 뛰기 전 위치에 맞는 숫자가 돌아왔는가 (P8) */
  function undoable(v, now) {
    return (
      jump !== null &&
      now - jump.at <= cfg.undoWindowMs &&
      v >= jump.fromTurn - cfg.undoBelow &&
      v <= jump.fromTurn + cfg.undoAbove
    );
  }

  function tryUndo(v, now, out) {
    const ok = undoable(v, now);
    streaks.undo.tick(ok, now);
    if (!ok || !streaks.undo.held(cfg.undoFrames, cfg.undoMs, now)) return null;
    const from = jump.fromIndex;
    jump = null;
    streaks.jump.clear();
    clearBackward();
    return move(forwardFrom(from, v), v, 'undo', out);
  }

  /** 앞으로 — 가볍게. 단, 두 단계 이상 건너뛰는 건 잠깐 의심한다 (P7). */
  function forward(v, now, out) {
    // 재시작으로 잘못 내려간 뒤 진짜 턴이 돌아오면 여기로 들어온다 (0 → 17)
    const undone = tryUndo(v, now, out);
    if (undone) return undone;
    streaks.reset.clear();
    streaks.restart.clear();
    const target = forwardFrom(index, v);
    if (target - index < 2) {
      streaks.jump.clear();
      return move(target, v, target === index ? 'same' : 'forward', out);
    }
    // 건너뛸 곳이 같은 단계로 이어지는지 센다 — 값은 프레임마다 달라도 된다
    streaks.jump.tick(true, now, target);
    if (!streaks.jump.held(cfg.jumpFrames, cfg.jumpMs, now)) return out(false, 'jump-wait', v);
    streaks.jump.clear();
    // 되돌릴 수 있게 어디서 뛰었는지 남긴다 (P8)
    jump = { fromIndex: index, fromTurn: believed, at: now };
    return move(target, v, 'jump', out);
  }

  /** 뒤로 — 무겁게. 밀림·오독은 그대로 두고, 전환·재시작·되돌리기만 이어질 때 믿는다. */
  function backward(v, now, out) {
    streaks.jump.clear();
    const back = believed - v;

    // P3 — 밀림. 이미 한 단계를 다시 보여주지 않는다. 기준만 낮춘다.
    if (back <= cfg.pushback) {
      clearBackward();
      believed = v;
      return out(false, 'pushback', v);
    }

    // P8 — 조금 전 크게 건너뛴 게 오독이었다: 건너뛰기 전 위치에 맞는 숫자가 돌아왔다
    const undone = tryUndo(v, now, out);
    if (undone) return undone;

    const s = segmentAt(ranges, index);
    const [, b] = ranges[s];
    const next = ranges[s + 1];

    // P5 — 리셋 빌드의 라운드 전환: 다음 라운드 첫 턴 이하의 숫자가 이어진다.
    // 라운드 마지막 단계에 있었으면 그것으로 충분하고, 중간이면(보스가 일찍 죽음)
    // 그 앞에 연출로 가려진 시간이 있어야 한다 — 아니면 오독일 가능성이 더 크다.
    const resetting = Boolean(next) && resetAfter[s] && v <= flow[next[0]].turn;
    streaks.reset.tick(resetting, now, s, gapBefore);
    if (resetting) {
      const atEnd = index === b;
      if (streaks.reset.frames >= cfg.resetFrames && (atEnd || streaks.reset.gapBefore >= cfg.resetGapMs)) {
        jump = null;
        clearBackward();
        return move(forwardFrom(next[0], v), v, 'next-round', out);
      }
      return out(false, 'reset-wait', v);
    }

    // P6 — 재시작: 첫 턴 근처의 숫자가 한참 이어진다 (리셋 빌드는 마지막 라운드에서만 온다).
    // 재시작도 "크게 뛴 것"으로 기억해 둔다 — 오독이었으면 P8로 되돌린다.
    const restarting = v <= flow[0].turn + cfg.restartSlack;
    streaks.restart.tick(restarting, now);
    if (restarting && streaks.restart.held(cfg.restartFrames, cfg.restartMs, now)) {
      jump = { fromIndex: index, fromTurn: believed, at: now };
      clearBackward();
      return move(forwardFrom(0, v), v, 'restart', out);
    }
    if (restarting) return out(false, 'restart-wait', v);

    // P4 — 그 밖의 뒤로는 그대로 둔다 (아마 오독이다)
    return out(false, 'hold', v);
  }

  /** P9 — 손으로 옮기면 거기가 기준이다 */
  function setIndex(i) {
    index = clamp(i);
    believed = null;
    run = null;
    jump = null;
    streaks.jump.clear();
    clearBackward();
    return index;
  }

  /** 자동을 껐다 켰을 때 — 위치는 두고 읽기 기억만 지운다 */
  function reset() {
    believed = null;
    run = null;
    hiddenSince = null;
    gapBefore = 0;
    jump = null;
    streaks.jump.clear();
    clearBackward();
  }

  return {
    push,
    setIndex,
    reset,
    forwardFrom,
    get index() {
      return index;
    },
    get turn() {
      return believed;
    },
    get isReset() {
      return resetAfter.some(Boolean);
    },
  };
}

module.exports = { createFollower, DEFAULTS };
