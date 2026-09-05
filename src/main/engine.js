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

const { readTurn, loadTemplates, gridToRows } = require('../shared/turnReader');
const { createFollower } = require('../shared/follower');
const { createMaxTurnWatch } = require('../shared/maxTurn');
const { createBattleEndWatch } = require('../shared/battleEnd');
const { flatten } = require('../shared/steps');

/**
 * @typedef {{turn: number, label: string}} FlowStep
 * @typedef {{index: number, moved: boolean, turn: number|null, raw: number|null,
 *            confidence: number, hidden: boolean, hiddenMs: number,
 *            why: string, max: number|null, dropped: number|null,
 *            resting: boolean, restWhy: string}} FeedResult
 *   max     지금 믿고 있는 최대 턴 (`16 / 70` 의 70). 모르면 null
 *   dropped 최대 턴과 안 맞아서 **버린** 값. 상태줄에 왜 멈췄는지 보여주려고 둔다
 *   resting 전투가 끝난 것 같아 **쉬는 중**. 화면은 이때 인식 주기를 늦춘다
 *           (shared/battleEnd.js). 턴이 다시 보이면 스스로 풀린다
 *   restWhy 왜 쉬는지 — 'still'(화면이 멈춰 있다) | 'blind'(오래 못 읽었다)
 */

/**
 * @param {{templates?: any[], follower?: object, maxTurn?: object, battleEnd?: object,
 *          now?: () => number}} [options]
 *   now 시계 — 테스트에서 프레임 시각을 직접 넣으려고 바꿔 끼울 수 있다
 */
function createEngine(options = {}) {
  const { templates = [], follower: followerOptions } = options;
  const clock = options.now || (() => Date.now());

  /** @type {FlowStep[]} */
  let flow = [];
  let follower = createFollower([], followerOptions);
  let active = templates;
  // 최대 턴은 전투 내내 안 바뀐다 — 알아내면 지금 턴의 자릿수와 상한이 정해진다
  const maxTurn = createMaxTurnWatch(options.maxTurn);
  // 전투가 끝나면(결과 화면) 쉰다 — 턴이 다시 보이면 스스로 깨어난다
  const endWatch = createBattleEndWatch(options.battleEnd);

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
    follower = createFollower(flow, { ...followerOptions, index: steps.length ? index : 0 });
    // 빌드를 바꿨으면 다른 전투일 수 있다 — 최대 턴도 처음부터 다시 본다
    maxTurn.reset();
    endWatch.reset();
    return { steps, index: follower.index };
  }

  /**
   * 숫자 가르치기 — 지금 보이는 크롭에서 사람이 말해 준 값의 모양을 뽑아낸다.
   *
   * **인식기와 같은 길로 자른다.** 예전엔 여기서 따로 digitBoxes 를 불렀는데, 그러면
   * 슬래시가 옆 숫자에 붙은 경우("/7")나 두 글자가 한 덩어리로 잡힌 경우를 못 풀어서
   * "숫자를 못 찾았어요"만 나왔다 — **가르치려는 상황이 바로 그 상황인데도.**
   * readTurn 은 그걸 전부 다루고 이긴 명암의 모양까지 돌려준다 (collect).
   *
   * 점수 문턱은 0으로 낮춘다. 못 읽는 폰트를 가르치려는 참인데 "확신이 없다"고
   * 거절하면 앞뒤가 안 맞는다 — 정답은 사람이 말해 주고 있다.
   *
   * @param {Uint8Array} gray
   * @param {string} text 사람이 적은 값 ("16")
   * @returns {{ok: true, templates: Array<{d: number, rows: string[]}>}
   *          |{ok: false, found: number, want: number}}
   */
  function teachFrom(gray, w, h, text) {
    const want = text.length;
    const got = readTurn(gray, w, h, active, {
      collect: true,
      minScore: 0,
      minMargin: 0,
    });
    const shapes = got && got.shapes ? got.shapes : [];
    if (shapes.length !== want) return { ok: false, found: shapes.length, want };
    return {
      ok: true,
      templates: shapes.map((grid, i) => ({ d: Number(text[i]), rows: gridToRows(grid) })),
    };
  }

  /** 손으로 단계를 옮겼을 때 */
  function setIndex(i) {
    return follower.setIndex(i);
  }

  /** 자동을 껐다 켰을 때 — 위치는 두고 읽기 기억만 지운다 */
  function reset() {
    follower.reset();
    maxTurn.reset();
    endWatch.reset();
  }

  /**
   * 한 프레임을 넣는다.
   *
   * @param {Uint8Array} gray 회색조 픽셀
   * @param {number} [now] 프레임 시각(ms). 안 주면 시계에서 읽는다
   * @returns {FeedResult}
   */
  function feed(gray, w, h, now = clock()) {
    // 빌드 턴을 "후보"로 넘기지 않는다 — 턴 카운터는 1씩 올라가서 화면에 뜨는 값
    // 대부분이 빌드 턴이 아니고, 맞추려 들면 18을 28로 바꿔 놓는다 (turnReader의 bestValue).
    //
    // 대신 넘기는 건 **최대 턴**이다. 그건 화면이 스스로 말해 주는 값이라
    // 빌드와 무관하고, 지금 턴의 자릿수와 상한을 정해 준다 (shared/maxTurn.js).
    const got = readTurn(gray, w, h, active, { maxTurn: maxTurn.known });
    const verdict = maxTurn.see(got);
    // 최대 턴이 안 맞는 프레임은 슬래시를 엉뚱한 데서 잘랐다는 뜻이라 왼쪽도 못 믿는다.
    // 추적기에는 "가려짐"으로 들어간다 — 못 읽은 것과 똑같이 그 자리에 머문다.
    const trusted = verdict.trust ? got : null;

    // 전투가 끝났는지. 막 쉬기 시작한 프레임에서 **읽기 기억을 지운다** — 다음 전투는
    // 최대 턴도 다르고 턴도 처음부터다. 단계 위치는 그대로 둔다(지우면 오검출 한 번에
    // 사람이 보던 자리를 잃는다). 새 전투가 0턴으로 시작하면 추적기가 알아서 따라간다.
    const rest = endWatch.see(trusted !== null, gray, w, h, now);
    if (rest.entered) {
      follower.reset();
      maxTurn.reset();
    }

    const r = follower.push(trusted, now);
    return {
      index: r.index,
      moved: r.moved,
      turn: r.turn,
      raw: trusted ? trusted.value : null,
      confidence: trusted ? trusted.confidence : 0,
      hidden: r.hidden,
      hiddenMs: r.hiddenMs,
      why: r.why,
      max: maxTurn.known,
      dropped: !verdict.trust && got ? got.value : null,
      resting: rest.over,
      restWhy: rest.why,
    };
  }

  return {
    setTemplates,
    teachFrom,
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
    /** 지금 믿는 최대 턴 — 진단·시험용 */
    get maxTurn() {
      return maxTurn.known;
    },
    /** 전투가 끝난 것 같아 쉬는 중인가 */
    get resting() {
      return endWatch.over;
    },
  };
}

module.exports = { createEngine };
