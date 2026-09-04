// 인식 엔진 — 잘라 온 픽셀 한 장을 받아 "지금 몇 번째 단계인지"까지 정한다.
//
// 화면(렌더러)에는 캡처와 그리기만 남기고 판단은 전부 여기로 모았다.
// 이유는 하나다: **여기 있는 건 전부 Node 테스트로 확인할 수 있다.** 예전에는
// 인식·투표·단계 이동이 렌더러 안에 섞여 있어서 눈으로 게임을 돌려보는 것 말고는
// 확인할 방법이 없었고, 그래서 조용히 틀린 채로 오래 남았다.
//
// 읽기(turnReader) → 따라가기(follower). 따라가기가 지켜야 하는 규칙과 실제 전투
// 시나리오는 test/scenarios/ 에 있다.
'use strict';

const { readTurn, loadTemplates } = require('../shared/turnReader');
const { createFollower } = require('../shared/follower');
const { flatten } = require('../shared/steps');
const { knownTurns } = require('../shared/tracker');

/**
 * @typedef {{turn: number, label: string}} FlowStep
 * @typedef {{index: number, moved: boolean, turn: number|null, raw: number|null,
 *            confidence: number, snapped: boolean, hidden: boolean, hiddenMs: number,
 *            why: string}} FeedResult
 */

/**
 * @param {{templates?: any[], follower?: object, now?: () => number}} [options]
 *   now 시계 — 테스트에서 프레임 시각을 직접 넣으려고 바꿔 끼울 수 있다
 */
function createEngine(options = {}) {
  const { templates = [], follower: followerOptions } = options;
  const clock = options.now || (() => Date.now());

  /** @type {FlowStep[]} */
  let flow = [];
  /** flow에 나오는 턴 숫자 — 프레임마다 다시 만들지 않으려고 캐시한다 */
  let turns = [];
  let follower = createFollower([], followerOptions);
  let active = templates;

  /** 기본 대조표 + 사용자가 가르친 대조표 */
  function setTemplates(builtin, userJson) {
    const extra = userJson && userJson.length
      ? loadTemplates({ templates: userJson }, { weight: 1.12 })
      : [];
    active = [...builtin, ...extra];
    return active.length;
  }

  /**
   * 빌드나 변형이 바뀌었을 때 — 단계 목록을 갈아끼운다.
   *
   * 펼치기(변형 선택 → 한 줄)를 화면이 아니라 여기서 한다. 같은 계산을 양쪽에
   * 두면 언젠가 어긋나고, 그러면 화면에 보이는 순서와 자동 추적이 따로 논다.
   *
   * @param {any[]} groups 도감에서 읽은 변형 그룹
   * @param {Record<number, number>} picks 그룹별 선택
   * @returns {{steps: Array<{turn:number,text:string,label:string}>, index: number}}
   */
  function setFlow(groups, picks = {}, { keepIndex = false } = {}) {
    const steps = flatten(Array.isArray(groups) ? groups : [], picks || {});
    const index = keepIndex ? Math.max(0, Math.min(follower.index, steps.length - 1)) : 0;
    flow = steps;
    turns = knownTurns(flow);
    follower = createFollower(flow, { ...followerOptions, index: steps.length ? index : 0 });
    return { steps, index: follower.index };
  }

  /** 손으로 단계를 옮겼을 때 */
  function setIndex(i) {
    return follower.setIndex(i);
  }

  /** 자동을 껐다 켰을 때 — 위치는 두고 읽기 기억만 지운다 */
  function reset() {
    follower.reset();
  }

  /**
   * 한 프레임을 넣는다.
   *
   * @param {Uint8Array} gray 회색조 픽셀
   * @param {number} [now] 프레임 시각(ms). 안 주면 시계에서 읽는다
   * @returns {FeedResult}
   */
  function feed(gray, w, h, now = clock()) {
    // 이 빌드에 나오는 턴 숫자 — 게임이 보여줄 수 있는 숫자를 이미 아는데 안 쓰면 아깝다.
    // 애매하게 읽힌 자리를 여기에 맞추고, 여기 없는 숫자를 확신하면 한 번 더 의심한다.
    const got = readTurn(gray, w, h, active, { candidates: turns });
    const r = follower.push(got, now);
    return {
      index: r.index,
      moved: r.moved,
      turn: r.turn,
      raw: got ? got.value : null,
      confidence: got ? got.confidence : 0,
      snapped: Boolean(got && got.snapped),
      hidden: r.hidden,
      hiddenMs: r.hiddenMs,
      why: r.why,
    };
  }

  return {
    setTemplates,
    setFlow,
    setIndex,
    reset,
    feed,
    get index() {
      return follower.index;
    },
    get flow() {
      return flow;
    },
    get templateCount() {
      return active.length;
    },
  };
}

module.exports = { createEngine };
