// 전투 기록 — 실제 게임에서 벌어진 일을 나중에 되돌려 볼 수 있게 모아 둔다.
//
// **왜 필요한가.** 추적기 규칙은 test/scenarios/ 의 시나리오로 정하는데, 그 시나리오는
// 전부 "이런 일이 벌어질 것이다"라고 **상상해서 적은 것**이다. 진짜 전투에서 실제로
// 무슨 숫자가 읽혔는지는 아무도 모른다. 그래서 "여기서 안 넘어갔어"라는 얘기를 들어도
// 재현할 방법이 없었다.
//
// 자동 인식이 도는 동안 프레임을 통째로 모아 두었다가 [전투 기록 저장]을 누르면
// **시나리오와 같은 형식의 JSON 한 장**이 나온다. 그 파일은
//  · test/scenarios/ 에 그대로 넣어 테스트로 만들 수 있고 (tools/replay.js 로 궤적을 본다)
//  · 안에 들어 있는 크롭 표본으로 **진짜 게임 폰트에서의 인식 정확도**를 잴 수 있다.
// 기본 대조표는 흔한 폰트로 만든 것이라, 이 표본이 없으면 게임 폰트에서 어떤지 모른다.
//
// 기록은 "일이 벌어진 뒤에" 저장한다. 뭔가 이상한 걸 본 사람이 그제서야 누르기 때문에,
// 시작 버튼을 따로 두지 않고 자동이 켜져 있는 동안 늘 고리 버퍼에 담아 둔다.
'use strict';

/** 몇 프레임까지 들고 있을지 — 100ms 주기면 10분치 */
const MAX_FRAMES = 6000;

/**
 * 크롭 표본을 종류별로 몇 장까지 — 파일이 무거워지면 주고받기가 번거로워진다.
 * 종류를 나누는 이유: 잘 읽힌 프레임만 잔뜩 모으면 정작 알고 싶은
 * "왜 못 읽었나"가 한 장도 안 남는다.
 */
const SAMPLE_CAPS = {
  /** 아예 못 읽은 프레임 — 제일 알고 싶은 것 */
  unread: 40,
  /** 흐리게 읽힌 프레임 — 문턱 근처라 오독으로 넘어갈 수 있는 것 */
  weak: 40,
  /** 값마다 몇 장씩 — 0~9 모양을 진짜 폰트로 확보하려고 */
  perValue: 4,
};

/** 표본 전체 크기 상한 (바이트). 넘으면 더 안 담는다 */
const MAX_SAMPLE_BYTES = 6 * 1024 * 1024;

/**
 * @typedef {{t: number, v: number|null, c?: number, drop?: number,
 *            i: number, why: string, set?: number, note?: string}} Frame
 *   drop 최대 턴과 안 맞아 **버린** 값. v 는 null 이지만(추적기가 본 그대로)
 *        되돌려 볼 때는 "못 읽은 것"과 "버린 것"을 갈라 봐야 한다
 * @typedef {{t: number, w: number, h: number, gray: string, kind: string,
 *            read: number|null, conf: number}} Sample
 */

/**
 * @param {{maxFrames?: number, maxSampleBytes?: number, now?: () => number}} [options]
 */
function createRecorder(options = {}) {
  const maxFrames = options.maxFrames || MAX_FRAMES;
  const maxSampleBytes = options.maxSampleBytes || MAX_SAMPLE_BYTES;
  const clock = options.now || (() => Date.now());

  /** @type {Frame[]} */
  let frames = [];
  /** @type {Sample[]} */
  let samples = [];
  let sampleBytes = 0;
  /** 종류별로 몇 장 담았는지 */
  const counts = { unread: 0, weak: 0 };
  /** @type {Map<number, number>} 값마다 몇 장 */
  const perValue = new Map();
  /** @type {Array<{turn: number, label: string}>} */
  let steps = [];
  /** @type {Record<string, any>} */
  let meta = {};
  let startedAt = null;

  /** 고리 버퍼 — 오래된 것부터 버린다. 사람은 "방금 이상했던 것"을 저장한다 */
  function pushFrame(f) {
    if (startedAt === null) startedAt = f.t;
    frames.push(f);
    if (frames.length > maxFrames) frames.splice(0, frames.length - maxFrames);
  }

  /**
   * 이 프레임의 크롭을 표본으로 담을지 — 담는다면 어떤 종류로.
   * 못 읽음 > 흐림 > 그 값이 아직 부족함 순으로 본다.
   */
  function sampleKind(raw, conf, strongScore) {
    if (raw === null) return counts.unread < SAMPLE_CAPS.unread ? 'unread' : null;
    if (conf < strongScore) return counts.weak < SAMPLE_CAPS.weak ? 'weak' : null;
    if ((perValue.get(raw) || 0) < SAMPLE_CAPS.perValue) return `v${raw}`;
    return null;
  }

  /**
   * 프레임 하나. gray를 같이 주면 표본으로 담길 수도 있다.
   *
   * @param {{raw: number|null, confidence: number, index: number, why: string,
   *          dropped?: number|null}} r 엔진이 돌려준 결과
   * @param {{gray?: Uint8Array, w?: number, h?: number, strongScore?: number,
   *          now?: number}} [frameData]
   */
  function frame(r, frameData = {}) {
    const t = frameData.now ?? clock();
    /** @type {Frame} */
    const f = { t, v: r.raw, i: r.index, why: r.why };
    if (r.raw !== null) f.c = Math.round(r.confidence * 1000) / 1000;
    // 최대 턴과 안 맞아 버린 프레임은 그렇다고 적어 둔다 — 못 읽은 것과 원인이 다르다
    if (r.dropped !== null && r.dropped !== undefined) f.drop = r.dropped;
    pushFrame(f);

    const { gray, w, h, strongScore = 0.86 } = frameData;
    if (!gray || !w || !h) return;
    const kind = sampleKind(r.raw, r.confidence, strongScore);
    if (!kind) return;
    if (sampleBytes + gray.length > maxSampleBytes) return;

    // 넘겨받은 버퍼는 다음 프레임에 재사용될 수 있으니 여기서 값을 굳힌다
    samples.push({
      t,
      w,
      h,
      gray: Buffer.from(gray).toString('base64'),
      kind,
      read: r.raw,
      conf: Math.round(r.confidence * 1000) / 1000,
    });
    sampleBytes += gray.length;
    if (kind === 'unread' || kind === 'weak') counts[kind] += 1;
    else if (r.raw !== null) perValue.set(r.raw, (perValue.get(r.raw) || 0) + 1);
  }

  /** 사용자가 손으로 단계를 옮겼다 (시나리오의 {"set": n}) */
  function manual(index, now) {
    pushFrame({ t: now ?? clock(), v: null, i: index, why: 'set', set: index });
  }

  /** 자유 표시 — 자동 켬/끔, 빌드 바꿈 같은 것 */
  function note(text, now) {
    pushFrame({ t: now ?? clock(), v: null, i: -1, why: 'note', note: String(text) });
  }

  /**
   * 보던 단계 목록이 바뀌었다. 기록은 **단계마다 다시 시작한다** —
   * 다른 빌드의 프레임이 섞이면 되돌려 볼 수 없기 때문이다.
   */
  function setFlow(flow, info = {}) {
    steps = (Array.isArray(flow) ? flow : []).map((s) => ({ turn: s.turn, label: s.label }));
    meta = { ...info };
    frames = [];
    samples = [];
    sampleBytes = 0;
    counts.unread = 0;
    counts.weak = 0;
    perValue.clear();
    startedAt = null;
  }

  /**
   * 저장할 모양 — test/scenarios/*.json 과 같은 형식이라 그대로 시나리오가 된다.
   * 시각은 첫 프레임 기준 상대값으로 바꾼다 (그래야 사람이 읽을 수 있다).
   */
  function dump(info = {}) {
    const base = startedAt ?? 0;
    return {
      name: info.name || '전투 기록',
      why: info.why || '실제 게임에서 기록한 것. expect는 사람이 보고 붙인다.',
      recorded: true,
      recordedAt: new Date().toISOString(),
      meta: { ...meta, ...info.meta },
      steps,
      start: frames.length ? frames[0].i : 0,
      frames: frames.map((f) => ({ ...f, t: f.t - base })),
      samples: samples.map((s) => ({ ...s, t: s.t - base })),
    };
  }

  return {
    frame,
    manual,
    note,
    setFlow,
    dump,
    get frameCount() {
      return frames.length;
    },
    get sampleCount() {
      return samples.length;
    },
    /** 기록된 구간의 길이(ms) — "몇 분치 있는지" 보여주려고 */
    get spanMs() {
      return frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
    },
  };
}

module.exports = { createRecorder, MAX_FRAMES, SAMPLE_CAPS };
