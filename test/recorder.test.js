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
