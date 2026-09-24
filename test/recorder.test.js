// 전투 기록 — 실제 게임에서 받은 파일을 여기서 되돌려 볼 수 있어야 한다.
//
// 이 기능이 있는 이유가 "재현할 수 없는 문제를 재현하려고"이므로, 정작 기록이
// 조용히 비거나 형식이 어긋나면 아무 소용이 없다. 그래서 한 바퀴를 통째로 확인한다:
// 엔진에 프레임을 넣고 → 기록하고 → 저장 모양을 뽑고 → 시나리오 러너로 재생해서
// **처음 엔진이 낸 결론과 같은지** 본다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRecorder, SAMPLE_CAPS } = require('../src/main/recorder');
const { createEngine } = require('../src/main/engine');
const { loadTemplates } = require('../src/shared/turnReader');
const { replay, toScenario, recheck } = require('../tools/replay');
const { run } = require('./helpers/scenario');
const { bench, loadFixtures, RAW } = require('../tools/bench-reader');

const TEMPLATES = loadTemplates(RAW);
const GROUPS = [
  {
    round: 1,
    variants: [{ label: '1라운드', steps: [{ turn: 0, text: '나타 아래' }, { turn: 4, text: '쥬리 위' }] }],
  },
  {
    round: 2,
    variants: [{ label: '2라운드', steps: [{ turn: 8, text: '미호 위' }, { turn: 12, text: '리나 아래' }] }],
  },
];

const result = (raw, index, why = 'forward', confidence = 0.95) => ({
  raw,
  confidence: raw === null ? 0 : confidence,
  index,
  why,
});

test('고리 버퍼는 정해진 만큼만 들고 있는다', () => {
  // 몇 시간을 켜 두는 도구다. 기록이 계속 쌓이면 메모리를 잡아먹는다.
  const r = createRecorder({ maxFrames: 10 });
  r.setFlow([{ turn: 0, label: '1R' }]);
  for (let i = 0; i < 50; i += 1) r.frame(result(i, 0), { now: i * 100 });
  assert.strictEqual(r.frameCount, 10);
  const d = r.dump();
  assert.strictEqual(d.frames[0].v, 40, '오래된 것부터 버린다');
  assert.strictEqual(d.frames[9].v, 49);
});

test('표본은 종류별로 상한이 있고, 못 읽은 프레임을 먼저 담는다', () => {
  // 잘 읽힌 프레임만 잔뜩 모으면 정작 알고 싶은 "왜 못 읽었나"가 한 장도 안 남는다
  const r = createRecorder();
  r.setFlow([{ turn: 0, label: '1R' }]);
  const gray = new Uint8Array(64 * 40).fill(30);
  for (let i = 0; i < 200; i += 1) r.frame(result(null, 0, 'hidden'), { gray, w: 64, h: 40, now: i * 100 });
  const unread = r.dump().samples.filter((s) => s.kind === 'unread');
  assert.strictEqual(unread.length, SAMPLE_CAPS.unread, '못 읽은 표본은 상한까지만');

  const r2 = createRecorder();
  r2.setFlow([{ turn: 0, label: '1R' }]);
  for (let i = 0; i < 100; i += 1) {
    r2.frame(result(7, 0, 'same'), { gray, w: 64, h: 40, now: i * 100 });
  }
  assert.strictEqual(
    r2.dump().samples.length,
    SAMPLE_CAPS.perValue,
    '같은 값만 이어지면 값당 상한까지만 — 파일이 무거워지면 주고받기가 번거롭다',
  );
});

test('표본 크기 상한을 넘지 않는다', () => {
  const r = createRecorder({ maxSampleBytes: 5000 });
  r.setFlow([{ turn: 0, label: '1R' }]);
  const gray = new Uint8Array(2000).fill(30);
  for (let i = 0; i < 20; i += 1) r.frame(result(null, 0, 'hidden'), { gray, w: 50, h: 40, now: i * 100 });
  assert.ok(r.sampleCount <= 3, `상한을 넘겼다: ${r.sampleCount}장`);
});

test('빌드를 바꾸면 기록을 새로 시작한다', () => {
  // 다른 빌드의 프레임이 섞이면 되돌려 볼 수 없다
  const r = createRecorder();
  r.setFlow([{ turn: 0, label: '1R' }]);
  r.frame(result(3, 0), { now: 0 });
  r.setFlow([{ turn: 0, label: '1R' }, { turn: 5, label: '1R' }], { build: '다른 빌드' });
  assert.strictEqual(r.frameCount, 0);
  assert.strictEqual(r.dump().meta.build, '다른 빌드');
});

test('손으로 옮긴 것과 표시가 남는다', () => {
  const r = createRecorder();
  r.setFlow([{ turn: 0, label: '1R' }, { turn: 4, label: '1R' }]);
  r.frame(result(1, 0), { now: 0 });
  r.manual(1, 100);
  r.note('자동 껐다 켬', 200);
  r.frame(result(5, 1, 'forward'), { now: 300 });
  const f = r.dump().frames;
  assert.strictEqual(f[1].set, 1, '손으로 옮긴 것이 시나리오의 set으로 남아야 한다');
  assert.strictEqual(f[2].note, '자동 껐다 켬');
  assert.strictEqual(f[0].t, 0, '시각은 첫 프레임 기준 상대값');
  assert.strictEqual(f[3].t, 300);
});

test('기록이 없으면 저장할 것도 없다고 말한다', () => {
  const r = createRecorder();
  r.setFlow([{ turn: 0, label: '1R' }]);
  assert.strictEqual(r.frameCount, 0);
  assert.deepStrictEqual(r.dump().frames, []);
});

test('한 바퀴 — 엔진에 넣은 것을 기록해서 재생하면 같은 결론이 나온다', { skip: !loadFixtures() }, () => {
  // 이게 이 기능의 전부다. 여기가 어긋나면 기록 파일을 받아도 쓸모가 없다.
  const data = loadFixtures();
  const pick = (v) => {
    const s = data.samples.find((x) => x.value === v && x.height === 44 && !x.invert);
    return s ? { gray: new Uint8Array(Buffer.from(s.gray, 'base64')), w: s.w, h: s.h } : null;
  };
  const script = [0, 0, 4, 4, 8, 8, 8, 12, 12];
  const blank = { gray: new Uint8Array(80 * 40).fill(28), w: 80, h: 40 };

  let t = 0;
  const engine = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  engine.setFlow(GROUPS, {});
  const rec = createRecorder({ now: () => t });
  rec.setFlow(engine.flow, { build: '시험' });

  const live = [];
  for (const v of script) {
    const f = pick(v) || blank;
    const r = engine.feed(f.gray, f.w, f.h);
    rec.frame(r, { gray: f.gray, w: f.w, h: f.h, now: t });
    live.push(r.index);
  }

  const dumped = JSON.parse(JSON.stringify(rec.dump()));
  assert.strictEqual(dumped.frames.length, script.length);
  assert.ok(dumped.samples.length > 0, '표본이 하나는 담겨야 한다');

  // 1) replay 도구로 재생 — 엔진이 실제로 낸 index와 같아야 한다
  const trace = replay(dumped).map((x) => x.index);
  assert.deepStrictEqual(trace, live, '기록을 재생한 결과가 실제와 다르다');

  // 2) 시나리오로 뽑아 시나리오 러너에 넣어도 같아야 한다 (그대로 테스트가 된다)
  const scenario = toScenario(dumped, '한 바퀴 시험');
  assert.strictEqual(scenario.build, 'running');
  assert.deepStrictEqual(
    run(scenario).map((x) => x.index),
    live,
    '시나리오로 뽑으면 결과가 달라진다 — 형식이 어긋난 것이다',
  );

  // 3) 표본을 지금 인식기에 다시 넣어 본다 (진짜 게임 폰트 확인용 경로)
  const rows = recheck(dumped);
  assert.strictEqual(rows.length, dumped.samples.length);
  assert.ok(
    rows.every((r) => r.then === r.now),
    '같은 픽셀·같은 인식기인데 값이 달라졌다',
  );
});

test('한 바퀴 — 전투가 끝나 쉬는 구간이 끼어도 같은 결론이 나온다', { skip: !loadFixtures() }, () => {
  // ★ 엔진은 쉬기 시작한 프레임에서 **읽기 기억을 지운다** (engine.feed). 그걸 기록에
  // 안 적으면, 재생할 때만 옛 기억을 들고 가서 궤적이 그때와 달라진다 — 기록을 받아도
  // 못 믿게 된다. 결과 화면 → 다음 전투까지를 한 바퀴 돌려 잠근다.
  const data = loadFixtures();
  const pick = (v) => {
    const s = data.samples.find((x) => x.value === v && x.height === 44 && !x.invert);
    return s ? { gray: new Uint8Array(Buffer.from(s.gray, 'base64')), w: s.w, h: s.h } : null;
  };
  const eight = pick(8);
  assert.ok(eight);
  // 결과 화면은 **멈춰 있다** — 크기를 크롭과 맞춰야 그림 신호가 걸린다
  const still = { gray: new Uint8Array(eight.w * eight.h).fill(28), w: eight.w, h: eight.h };

  let t = 0;
  const engine = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  engine.setFlow(GROUPS, {});
  const rec = createRecorder({ now: () => t });
  rec.setFlow(engine.flow, { build: '시험' });

  const live = [];
  const feed = (f) => {
    const r = engine.feed(f.gray, f.w, f.h);
    rec.frame(r, { gray: f.gray, w: f.w, h: f.h, now: t });
    live.push(r.index);
    return r;
  };
  for (let i = 0; i < 4; i += 1) feed(eight); // 전투 중
  for (let i = 0; i < 30; i += 1) feed(still); // 결과 화면
  assert.strictEqual(engine.resting, true, '결과 화면을 안 알아챘다');
  for (let i = 0; i < 4; i += 1) feed(eight); // 다음 전투

  const dumped = JSON.parse(JSON.stringify(rec.dump()));
  const rests = dumped.frames.filter((f) => f.rest);
  assert.strictEqual(rests.length, 1, `쉬기 시작한 프레임이 ${rests.length}개 적혔다`);

  assert.deepStrictEqual(replay(dumped).map((x) => x.index), live, '재생 결과가 실제와 다르다');
  assert.deepStrictEqual(
    run(toScenario(dumped, '쉬는 구간')).map((x) => x.index),
    live,
    '시나리오로 뽑으면 결과가 달라진다',
  );
});

test('한 바퀴 — 자동을 껐다 켠 구간이 끼어도 같은 결론이 나온다', { skip: !loadFixtures() }, () => {
  // ★ rest 와 **똑같은 구멍**이 note 에도 있었다. 자동을 껐다 켜면 엔진이 읽기 기억을
  // 지우는데(engine:reset), 기록에 그 사실을 안 남기면 되돌려 볼 때만 옛 기억을 들고
  // 가서 궤적이 갈린다. 게임 폰트·추적기 상수·전투끝 문턱을 푸는 길이 전부 이 도구
  // 하나인데, **도구가 실제와 다른 답을 내면 받은 기록이 쓸모없어진다.**
  //
  // 글(note)을 보고 짐작하지 않는다 — 되돌려 보는 코드가 한국어를 해석하게 두면
  // 말을 조금만 고쳐도 조용히 어긋난다. reset 표시를 따로 남긴다.
  const data = loadFixtures();
  const pick = (v) => {
    const s = data.samples.find((x) => x.value === v && x.height === 44 && !x.invert);
    return s ? { gray: new Uint8Array(Buffer.from(s.gray, 'base64')), w: s.w, h: s.h } : null;
  };
  const twelve = pick(12);
  const four = pick(4);
  assert.ok(twelve && four);

  let t = 0;
  const engine = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  engine.setFlow(GROUPS, {});
  const rec = createRecorder({ now: () => t });
  rec.setFlow(engine.flow, { build: '시험' });

  const live = [];
  const feed = (f) => {
    const r = engine.feed(f.gray, f.w, f.h);
    rec.frame(r, { gray: f.gray, w: f.w, h: f.h, now: t });
    live.push(r.index);
  };
  for (let i = 0; i < 4; i += 1) feed(twelve); // 12턴까지 진행
  const moved = engine.index;
  assert.ok(moved > 0, '먼저 단계가 움직여 있어야 이 시험이 뜻이 있다');

  // 자동을 껐다 켰다 — 앱이 하는 그대로
  engine.reset();
  rec.note('자동 껐다 켬', t, { reset: true });

  for (let i = 0; i < 8; i += 1) feed(four); // 다시 4턴부터

  const dumped = JSON.parse(JSON.stringify(rec.dump()));
  const resets = dumped.frames.filter((f) => f.reset);
  assert.strictEqual(resets.length, 1, `되돌림 표시가 ${resets.length}개 적혔다`);

  // 재생 궤적은 note 프레임 한 줄이 더 끼므로, 실제로 읽은 프레임만 견준다
  const trace = replay(dumped)
    .filter((x) => x.why !== 'note')
    .map((x) => x.index);
  assert.deepStrictEqual(trace, live, '기록을 재생한 결과가 실제와 다르다');

  const scenario = toScenario(dumped, '껐다 켠 구간');
  assert.ok(
    scenario.frames.some((f) => f.reset),
    '시나리오로 뽑을 때 되돌림이 사라지면 안 된다 — 틀린 것을 자물쇠로 걸게 된다',
  );
  assert.deepStrictEqual(
    run(scenario).filter((x) => !(x.frame && x.frame.reset)).map((x) => x.index),
    live,
    '시나리오로 뽑으면 결과가 달라진다',
  );
});

test('기록 프레임의 시각이 고르지 않아도 재생된다', () => {
  // 실제 캡처는 100ms에 딱 맞춰 오지 않는다. 시나리오 러너가 t를 봐야 하는 이유다.
  //
  // 시각을 무시하면 **결과가 달라지는** 배치로 확인한다: 0턴에서 9가 읽히면 세 단계를
  // 건너뛰므로 P7이 2프레임 **그리고** 200ms를 요구한다. 프레임이 0·500·1000ms에 오면
  // 두 번째 프레임에서 이미 500ms가 지나 건너뛰지만, 100ms 간격으로 치면 아직 100ms라
  // 안 건너뛴다. 아래가 통과한다는 건 러너가 t를 실제로 본다는 뜻이다.
  const uneven = {
    steps: [
      { turn: 0, label: '1R' },
      { turn: 4, label: '1R' },
      { turn: 8, label: '1R' },
      { turn: 12, label: '1R' },
    ],
    start: 0,
    frames: [
      { t: 0, v: 0 },
      { t: 500, v: 9 },
      { t: 1000, v: 9 },
    ],
  };
  assert.deepStrictEqual(run(uneven).map((x) => x.index), [0, 0, 3], 'P7이 시각을 보고 판단해야 한다');

  // 같은 프레임을 100ms 간격으로 치면 아직 못 건너뛴다 — 그래야 위가 t 덕분임이 확실하다
  const asIfEven = { ...uneven, frames: uneven.frames.map((f) => ({ v: f.v })) };
  assert.deepStrictEqual(run(asIfEven).map((x) => x.index), [0, 0, 0]);
});

test('못 읽은 표본은 **최근 것**이 남는다 — 로비에서 켜 둬도 전투 장면이 남는다', () => {
  // ★ 예전엔 먼저 온 순서대로 상한까지 담고 안 뺐다. [자동]을 로딩·로비에서 켜 두면
  // 40장이 로딩 화면 4초에 다 차서, 정작 전투 중에 못 읽은 장면은 한 장도 안 남았다.
  const r = createRecorder();
  r.setFlow([{ turn: 0, label: '1R' }]);
  const lobby = new Uint8Array(64 * 40).fill(10);
  const battle = new Uint8Array(64 * 40).fill(200);
  let t = 0;
  for (let i = 0; i < 300; i += 1, t += 100) r.frame(result(null, 0, 'hidden'), { gray: lobby, w: 64, h: 40, now: t });
  const battleFrom = t;
  for (let i = 0; i < 300; i += 1, t += 100) r.frame(result(null, 0, 'hidden'), { gray: battle, w: 64, h: 40, now: t });
  const unread = r.dump().samples.filter((s) => s.kind === 'unread');
  assert.strictEqual(unread.length, SAMPLE_CAPS.unread);
  assert.ok(
    unread.every((s) => s.t >= battleFrom - r.dump().frames[0].t),
    '로비 그림이 남아 있다 — 최근 장면이 밀려났다',
  );
  // 띄엄띄엄 담는다 — 같은 연출의 거의 같은 그림만 남지 않게
  const gaps = unread.slice(1).map((s, i) => s.t - unread[i].t);
  assert.ok(gaps.every((g) => g >= 500), `표본 간격이 너무 좁다: ${gaps.slice(0, 5).join(', ')}ms`);
});

test('쉬는 중(결과 화면)의 그림은 표본으로 안 담는다', () => {
  const r = createRecorder();
  r.setFlow([{ turn: 0, label: '1R' }]);
  const gray = new Uint8Array(64 * 40).fill(30);
  for (let i = 0; i < 50; i += 1) {
    r.frame({ ...result(null, 0, 'hidden'), resting: true }, { gray, w: 64, h: 40, now: i * 1000 });
  }
  assert.strictEqual(r.sampleCount, 0);
});

test('되돌려 보는 시작 위치는 첫 프레임을 넣기 **전**의 단계다', () => {
  // ★ 예전엔 첫 프레임의 i 를 썼다 — 넣은 **뒤**의 단계이고, [자동]을 켠 메모로 시작하면 -1
  // 이라 0단계에서 재생해 실제 위치(예: 3)를 잃었다.
  const r = createRecorder();
  const steps = [0, 4, 8, 12, 16].map((turn) => ({ turn, label: '1R' }));
  r.setFlow(steps, {}, 3);
  r.note('자동 껐다 켬', 0, { reset: true, index: 3 });
  r.frame(result(13, 4), { now: 100 });
  const d = r.dump();
  assert.strictEqual(d.start, 3);
  assert.strictEqual(d.frames[0].i, 3, '메모에도 그때의 단계를 적는다');
});

test('고리 버퍼가 앞을 버리면 시작 위치를 옮기고 잘렸다고 적는다', () => {
  const r = createRecorder({ maxFrames: 5 });
  r.setFlow([0, 4, 8, 12, 16, 20].map((turn) => ({ turn, label: '1R' })), {}, 0);
  for (let i = 0; i < 9; i += 1) r.frame(result(i * 2, Math.floor(i / 2)), { now: i * 100 });
  const d = r.dump();
  assert.strictEqual(d.trimmed, true);
  assert.strictEqual(d.start, 1, '버린 마지막 프레임(#3) 뒤의 단계에서 시작해야 한다');
  assert.strictEqual(d.frames[0].t, 0, '시각도 남은 첫 프레임 기준');
});

test('신뢰도는 반올림하지 않는다 — 흐림과 또렷함의 경계가 재생에서 바뀌지 않게', () => {
  // 0.8595~0.86 사이 값이 엔진에서는 흐림(0.86 미만)이었는데 셋째 자리로 반올림하면 0.86 이
  // 되어 재생에서만 또렷함이 됐다
  const r = createRecorder();
  r.setFlow([{ turn: 0, label: '1R' }]);
  r.frame(result(5, 0, 'weak', 0.8597), { now: 0 });
  const f = r.dump().frames[0];
  assert.ok(f.c !== undefined && f.c < 0.86, `저장된 신뢰도 ${f.c}`);
});

test('되돌림 뒤 간격이 길어도 시나리오 러너와 재생 도구가 같은 궤적을 낸다', () => {
  // ★ 러너만 되돌림 칸에 "가려짐" 한 프레임을 넣고 있었다. 그러면 되돌림부터 다음 읽기까지가
  // 가려진 시간으로 잡혀, 리셋 빌드의 라운드 중간 전환(P5 — 앞에 500ms 가려짐)이 러너에서만
  // 걸렸다. 받은 기록을 시나리오로 잠그면 실제와 다른 궤적을 자물쇠로 걸게 된다.
  const rec = {
    steps: [
      { turn: 0, label: '1라운드' },
      { turn: 4, label: '1라운드' },
      { turn: 8, label: '1라운드' },
      { turn: 0, label: '2라운드' },
      { turn: 4, label: '2라운드' },
    ],
    start: 1,
    frames: [
      { t: 0, v: 3, c: 0.95, i: 1, why: 'same' },
      { t: 100, v: null, i: 1, why: 'note', note: '자동 껐다 켬', reset: true },
      { t: 800, v: 0, c: 0.95, i: 1, why: 'hold' },
      { t: 900, v: 0, c: 0.95, i: 1, why: 'hold' },
      { t: 1000, v: 0, c: 0.95, i: 1, why: 'hold' },
    ],
  };
  const played = replay(rec).filter((x) => x.why !== 'note').map((x) => x.index);
  const ran = run(toScenario(rec, '되돌림 뒤 간격'))
    .filter((x) => !(x.frame && x.frame.reset))
    .map((x) => x.index);
  assert.deepStrictEqual(ran, played);
  assert.deepStrictEqual(played, [1, 1, 1, 1], '되돌림은 가려짐이 아니다 — 라운드가 넘어가면 안 된다');
});

test('재생 도구에 손으로 쓴 시나리오를 넣어도 돈다', () => {
  // 예전엔 프레임이 숫자·null 이면 `f.set` 을 읽다 죽었다
  const scenario = require('./scenarios/misread-05.json');
  const trace = replay(scenario).map((x) => x.index);
  assert.deepStrictEqual(trace, run(scenario).map((x) => x.index));
});

test('한 바퀴 — 길게 쉬고 다음 전투가 시작되면 처음으로, 기록·재생도 같다', { skip: !loadFixtures() }, () => {
  // P6b. 리셋 빌드 1라운드 도중에 전투가 끝나고(결과 화면) 6초 쉰 뒤 다음 전투의 0턴이 나온다.
  const data = loadFixtures();
  const pick = (v) => {
    const s = data.samples.find((x) => x.value === v && x.height === 44 && !x.invert);
    return s ? { gray: new Uint8Array(Buffer.from(s.gray, 'base64')), w: s.w, h: s.h } : null;
  };
  const four = pick(4);
  const zero = pick(0);
  assert.ok(four && zero);
  const still = { gray: new Uint8Array(four.w * four.h).fill(28), w: four.w, h: four.h };
  const RESET_GROUPS = [
    { round: 1, variants: [{ label: '1라운드', steps: [{ turn: 0, text: '가' }, { turn: 4, text: '나' }, { turn: 8, text: '다' }] }] },
    { round: 2, variants: [{ label: '2라운드', steps: [{ turn: 0, text: '라' }, { turn: 4, text: '마' }] }] },
  ];

  let t = 0;
  const engine = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  engine.setFlow(RESET_GROUPS, {});
  const rec = createRecorder({ now: () => t });
  rec.setFlow(engine.flow, { build: '시험' }, engine.index);
  const live = [];
  const feed = (f) => {
    const r = engine.feed(f.gray, f.w, f.h);
    rec.frame(r, { gray: f.gray, w: f.w, h: f.h, now: t });
    live.push(r.index);
    return r;
  };
  for (let i = 0; i < 4; i += 1) feed(four); // 1라운드 4턴
  const before = engine.index;
  assert.strictEqual(before, 1);
  for (let i = 0; i < 80; i += 1) feed(still); // 결과 화면 8초 (1.5초 뒤부터 쉼)
  assert.strictEqual(engine.resting, true);
  const first = feed(zero);
  assert.strictEqual(first.ended, true, '길게 쉬고 난 첫 읽기를 "전투 끝"으로 알려야 한다');
  for (let i = 0; i < 8; i += 1) feed(zero);
  assert.strictEqual(engine.index, 0, `다음 전투는 처음부터다 — ${engine.index}단계(다음 라운드)로 갔다`);

  const dumped = JSON.parse(JSON.stringify(rec.dump()));
  assert.ok(dumped.frames.some((f) => f.ended), '기록에 "전투 끝"이 남아야 한다');
  assert.deepStrictEqual(replay(dumped).map((x) => x.index), live, '재생 결과가 실제와 다르다');
  assert.deepStrictEqual(run(toScenario(dumped, '전투 끝')).map((x) => x.index), live);
});

test('짧게 쉰 것은 전투 끝이 아니다 — 라운드 전환으로 따라간다', { skip: !loadFixtures() }, () => {
  const data = loadFixtures();
  const pick = (v) => {
    const s = data.samples.find((x) => x.value === v && x.height === 44 && !x.invert);
    return s ? { gray: new Uint8Array(Buffer.from(s.gray, 'base64')), w: s.w, h: s.h } : null;
  };
  const eight = /** @type {NonNullable<ReturnType<typeof pick>>} */ (pick(8));
  const zero = /** @type {NonNullable<ReturnType<typeof pick>>} */ (pick(0));
  assert.ok(eight && zero);
  const still = { gray: new Uint8Array(eight.w * eight.h).fill(28), w: eight.w, h: eight.h };
  const RESET_GROUPS = [
    { round: 1, variants: [{ label: '1라운드', steps: [{ turn: 0, text: '가' }, { turn: 4, text: '나' }, { turn: 8, text: '다' }] }] },
    { round: 2, variants: [{ label: '2라운드', steps: [{ turn: 0, text: '라' }, { turn: 4, text: '마' }] }] },
  ];
  let t = 0;
  const engine = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  engine.setFlow(RESET_GROUPS, {});
  for (let i = 0; i < 4; i += 1) engine.feed(eight.gray, eight.w, eight.h);
  for (let i = 0; i < 25; i += 1) engine.feed(still.gray, still.w, still.h); // 2.5초 — 쉬긴 했지만 짧다
  assert.strictEqual(engine.resting, true);
  const r = engine.feed(zero.gray, zero.w, zero.h);
  assert.strictEqual(r.ended, false);
  for (let i = 0; i < 3; i += 1) engine.feed(zero.gray, zero.w, zero.h);
  assert.strictEqual(engine.index, 3, '라운드 전환이면 다음 라운드 첫 단계로 가야 한다');
});

test('도감 파일만 다시 읽히면(단계 그대로) 아무것도 안 지운다', { skip: !loadFixtures() }, () => {
  // ★ 예전엔 도감이 갱신될 때마다 추적기·최대 턴·전투끝을 새로 만들어서, 결과 화면에서 쉬던
  // 인식이 깨어나고 (index.js 가) 전투 기록을 통째로 지웠다.
  const data = loadFixtures();
  const s = data.samples.find((x) => x.value === 8 && x.height === 44 && !x.invert);
  const eight = { gray: new Uint8Array(Buffer.from(s.gray, 'base64')), w: s.w, h: s.h };
  const still = { gray: new Uint8Array(eight.w * eight.h).fill(28), w: eight.w, h: eight.h };
  let t = 0;
  const engine = createEngine({ templates: TEMPLATES, now: () => (t += 100) });
  engine.setFlow(GROUPS, {});
  for (let i = 0; i < 4; i += 1) engine.feed(eight.gray, eight.w, eight.h);
  for (let i = 0; i < 30; i += 1) engine.feed(still.gray, still.w, still.h);
  assert.strictEqual(engine.resting, true);
  const again = engine.setFlow(GROUPS, {}, { keepIndex: true });
  assert.strictEqual(again.same, true);
  assert.strictEqual(engine.resting, true, '도감이 다시 읽혔다고 쉬던 인식이 깨어났다');
  // 단계가 바뀌면(분기 선택) 새로 시작한다 — 설계대로
  const changed = engine.setFlow([GROUPS[0]], {}, { keepIndex: true });
  assert.strictEqual(changed.same, false);
});

test('판 표시 — CI 가 심은 값이 있으면 그것, 없으면 dev', () => {
  const { buildStamp } = require('../src/shared/buildInfo');
  assert.strictEqual(buildStamp({ version: '0.9.0', skreBuild: 'v0.9.0-test.7+abc1234' }), 'v0.9.0-test.7+abc1234');
  assert.strictEqual(buildStamp({ version: '0.9.0' }), '0.9.0-dev');
  assert.strictEqual(buildStamp({ version: '0.9.0', skreBuild: '  ' }), '0.9.0-dev');
});
