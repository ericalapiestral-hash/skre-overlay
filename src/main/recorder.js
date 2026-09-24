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

/** 표본 전체 크기 상한 (바이트). 넘으면 가장 오래된 표본부터 버린다 */
const MAX_SAMPLE_BYTES = 6 * 1024 * 1024;

/**
 * 못 읽음·흐림 표본은 **이만큼 띄엄띄엄** 담는다 (ms). 100ms 마다 담으면 40장이 4초 만에
 * 찬다 — 같은 연출의 거의 같은 그림만 남는다. 500ms 간격이면 못 읽은 순간 20초 남짓이 남는다.
 */
const SAMPLE_GAP_MS = 500;

/**
 * @typedef {{t: number, v: number|null, c?: number, drop?: number, rest?: boolean,
 *            ended?: boolean, reset?: boolean, i: number, why: string, set?: number,
 *            note?: string}} Frame
 *   c    신뢰도 — **반올림하지 않는다.** 예전엔 소수 셋째 자리로 잘라서 0.8595~0.86 사이
 *        값이 엔진에서는 흐림이었는데 재생에서는 또렷함이 됐다
 *   drop 최대 턴과 안 맞아 **버린** 값. v 는 null 이지만(추적기가 본 그대로)
 *        되돌려 볼 때는 "못 읽은 것"과 "버린 것"을 갈라 봐야 한다
 *   rest 이 프레임에서 **전투가 끝났다고 보고 쉬기 시작했다.** 엔진은 그때 읽기
 *        기억을 지운다 — 되돌려 볼 때 같이 지우지 않으면 궤적이 어긋난다
 *   ended 길게 쉬고 난 뒤 처음 읽힌 프레임 — 엔진이 추적기에 "전투가 끝났다"를 알렸다
 *   i    이 프레임을 넣은 **뒤**의 단계. 메모(note)는 그때의 단계
 * @typedef {{t: number, w: number, h: number, gray: string, kind: string,
 *            read: number|null, conf: number, bytes: number}} Sample
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
  /** @type {Map<string, number>} 종류별로 마지막으로 담은 시각 — 띄엄띄엄 담으려고 */
  const lastAt = new Map();
  /** 직전 프레임이 쉬는 중이었나 — 쉬기 **시작한** 프레임만 적는다 */
  let wasResting = false;
  /** 기록 첫 프레임을 넣기 **전**의 단계 — 되돌려 볼 때 여기서 시작한다 */
  let startIndex = 0;
  /** 고리 버퍼가 앞을 버렸나 */
  let trimmed = false;
  /** @type {Array<{turn: number, label: string}>} */
  let steps = [];
  /** @type {Record<string, any>} */
  let meta = {};
  let startedAt = null;

  /** 고리 버퍼 — 오래된 것부터 버린다. 사람은 "방금 이상했던 것"을 저장한다 */
  function pushFrame(f) {
    if (startedAt === null) startedAt = f.t;
    frames.push(f);
    if (frames.length > maxFrames) {
      const cut = frames.splice(0, frames.length - maxFrames);
      // 앞을 버리면 **시작 위치도 옮긴다** — 버린 마지막 프레임 뒤의 단계에서 시작해야
      // 되돌려 볼 때 같은 자리에서 출발한다
      startIndex = cut[cut.length - 1].i;
      startedAt = frames[0].t;
      trimmed = true;
    }
  }

  /** 이 프레임의 크롭은 어떤 종류의 표본인가 */
  function sampleKind(raw, conf, strongScore) {
    if (raw === null) return 'unread';
    if (conf < strongScore) return 'weak';
    return `v${raw}`;
  }

  /** 종류별 상한 */
  function capOf(kind) {
    if (kind === 'unread') return SAMPLE_CAPS.unread;
    if (kind === 'weak') return SAMPLE_CAPS.weak;
    return SAMPLE_CAPS.perValue;
  }

  function dropSample(s) {
    const at = samples.indexOf(s);
    if (at < 0) return;
    samples.splice(at, 1);
    sampleBytes -= s.bytes;
  }

  /**
   * 프레임 하나. gray를 같이 주면 표본으로 담길 수도 있다.
   *
   * @param {{raw: number|null, confidence: number, index: number, why: string,
   *          dropped?: number|null, resting?: boolean, ended?: boolean}} r 엔진이 돌려준 결과
   * @param {{gray?: Uint8Array, w?: number, h?: number, strongScore?: number,
   *          now?: number}} [frameData]
   */
  function frame(r, frameData = {}) {
    const t = frameData.now ?? clock();
    /** @type {Frame} */
    const f = { t, v: r.raw, i: r.index, why: r.why };
    if (r.raw !== null) f.c = r.confidence;
    // 최대 턴과 안 맞아 버린 프레임은 그렇다고 적어 둔다 — 못 읽은 것과 원인이 다르다
    if (r.dropped !== null && r.dropped !== undefined) f.drop = r.dropped;
    // 쉬기 시작한 프레임 — 엔진이 여기서 읽기 기억을 지웠다
    const resting = r.resting === true;
    if (resting && !wasResting) f.rest = true;
    wasResting = resting;
    // 길게 쉬고 난 첫 프레임 — 엔진이 추적기에 "전투가 끝났다"를 알렸다 (P6b)
    if (r.ended) f.ended = true;
    pushFrame(f);

    const { gray, w, h, strongScore = 0.86 } = frameData;
    if (!gray || !w || !h) return;
    // 쉬는 중(결과 화면·로비)의 그림은 담지 않는다 — "왜 못 읽었나"를 알고 싶은 건 전투 중이다
    if (resting) return;
    if (gray.length > maxSampleBytes) return;
    const kind = sampleKind(r.raw, r.confidence, strongScore);
    const same = samples.filter((x) => x.kind === kind);

    if (kind === 'unread' || kind === 'weak') {
      // ★ 못 읽음·흐림은 **최근 것을 남긴다.** 예전엔 먼저 온 순서대로 상한까지 담고 안
      // 뺐다 — [자동]을 로비·로딩에서 켜 두면 40장이 로딩 화면 4초에 다 차서, 정작 전투
      // 중에 못 읽은 장면은 한 장도 안 남았다. 이상한 걸 본 사람은 **그 뒤에** 저장한다.
      if (t - (lastAt.get(kind) ?? -Infinity) < SAMPLE_GAP_MS) return;
      if (same.length >= capOf(kind)) dropSample(same[0]);
    } else if (same.length >= capOf(kind)) {
      // 값마다 몇 장은 **먼저 온 것**을 둔다 — 0~9 모양을 확보하려는 것이라 새 것일 필요가 없다
      return;
    }
    // 크기 상한을 넘으면 가장 오래된 표본부터 버린다
    while (samples.length > 0 && sampleBytes + gray.length > maxSampleBytes) dropSample(samples[0]);

    // 넘겨받은 버퍼는 다음 프레임에 재사용될 수 있으니 여기서 값을 굳힌다
    samples.push({
      t,
      w,
      h,
      gray: Buffer.from(gray).toString('base64'),
      kind,
      read: r.raw,
      conf: r.confidence,
      bytes: gray.length,
    });
    sampleBytes += gray.length;
    lastAt.set(kind, t);
  }

  /** 사용자가 손으로 단계를 옮겼다 (시나리오의 {"set": n}) */
  function manual(index, now) {
    pushFrame({ t: now ?? clock(), v: null, i: index, why: 'set', set: index });
  }

  /**
   * 자유 표시 — 자동 켬/끔, 빌드 바꿈 같은 것.
   *
   * @param {{reset?: boolean, index?: number}} [what] reset=true 면 **이때 엔진의 읽기 기억을
   *   지웠다**는 뜻이다. 되돌려 볼 때 같이 지워야 궤적이 그때와 같아진다 (rest 와 같은 이유).
   *   index 는 그때의 단계 — 기록이 메모로 시작해도 시작 위치를 안 잃는다
   */
  function note(text, now, what = {}) {
    /** @type {Frame} */
    const f = { t: now ?? clock(), v: null, i: what.index ?? -1, why: 'note', note: String(text) };
    if (what.reset) f.reset = true;
    pushFrame(f);
  }

  /**
   * 보던 단계 목록이 바뀌었다. 기록은 **단계마다 다시 시작한다** —
   * 다른 빌드의 프레임이 섞이면 되돌려 볼 수 없기 때문이다.
   */
  function setFlow(flow, info = {}, index = 0) {
    steps = (Array.isArray(flow) ? flow : []).map((s) => ({ turn: s.turn, label: s.label }));
    meta = { ...info };
    startIndex = index;
    trimmed = false;
    frames = [];
    samples = [];
    sampleBytes = 0;
    lastAt.clear();
    wasResting = false;
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
      // ★ 첫 프레임을 넣기 **전**의 단계. 예전엔 첫 프레임의 i(넣은 **뒤**의 단계, 메모면 -1)를
      // 썼다 — 기록이 [자동]을 켠 메모로 시작하면 0단계에서 재생해 실제 위치를 잃었다.
      start: startIndex,
      // 고리 버퍼가 앞을 버렸으면 알린다 — 그 앞의 추적기 기억(믿는 턴·뛰기 기록)이 없는 채로
      // 재생되므로 처음 몇 초는 그때와 다를 수 있다
      ...(trimmed ? { trimmed: true } : {}),
      frames: frames.map((f) => ({ ...f, t: f.t - base })),
      // bytes 는 상한 계산용이라 파일에는 안 쓴다
      samples: samples.map(({ bytes, ...s }) => ({ ...s, t: s.t - base })),
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

module.exports = { createRecorder, MAX_FRAMES, SAMPLE_CAPS, SAMPLE_GAP_MS };
