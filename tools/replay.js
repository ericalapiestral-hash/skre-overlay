// 전투 기록 되돌려 보기 — 실제 게임에서 받은 기록 파일을 여기서 그대로 재생한다.
//
//   node tools/replay.js ~/바탕화면/skre-기록-20260904-153012.json
//   node tools/replay.js 기록.json --from 120 --to 180   (프레임 구간만)
//   node tools/replay.js 기록.json --scenario 이름       (시나리오로 뽑아낸다)
//
// 두 가지를 한다.
//  1) **추적기 재생** — 기록된 읽기를 그대로 넣어 프레임마다 단계가 어떻게 움직였는지
//     궤적을 보여준다. "여기서 안 넘어갔어"를 프레임 번호로 찾는 도구다.
//  2) **인식기 다시 재기** — 기록에 담긴 크롭 표본을 지금 인식기에 넣어, **진짜 게임
//     폰트**에서 무엇을 어떻게 읽는지 본다. 표본 792장은 우리가 고른 폰트로 그린 것이라
//     게임 폰트에서 어떤지는 이 표본으로만 알 수 있다.
//
// 되돌려 본 뒤 "이 프레임에서 이 단계였어야 한다"가 정해지면 --scenario 로 뽑아
// test/scenarios/ 에 넣는다. 그때부터는 테스트가 지켜 준다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createFollower } = require('../src/shared/follower');
const { readTurn, loadTemplates, CROP_TARGET_HEIGHT } = require('../src/shared/turnReader');
const { BUILD } = require('../src/shared/buildInfo');

/**
 * 프레임을 기록 모양으로 맞춘다. 손으로 쓴 시나리오(test/scenarios/)는 프레임이 숫자·null 이고
 * 시각(t)이 없다 — 예전엔 그대로 넣었다가 null 에서 `f.set` 을 읽다 죽었고, 숫자는 `f.v` 가
 * 없어 "못 읽음"이 됐다. 시나리오의 궤적을 이 도구로 보려는 사람이 속지 않게 한다.
 */
function normalize(rec) {
  const dt = rec.dt || 100;
  return (rec.frames || []).map((f, i) => {
    if (f === null || f === undefined) return { t: i * dt, v: null };
    if (typeof f === 'number') return { t: i * dt, v: f };
    return typeof f.t === 'number' ? f : { ...f, t: i * dt, ...(f.weak ? { c: 0.75 } : {}) };
  });
}

/** 기록 프레임 → 추적기가 받는 읽기 */
function toReading(f) {
  if (!f || typeof f.set === 'number' || f.why === 'note') return null;
  if (f.v === null || f.v === undefined) return null;
  return { value: f.v, confidence: f.c ?? 0.95 };
}

/** 추적기를 처음부터 다시 돌려 궤적을 만든다 */
function replay(rec, { from = 0, to = Infinity } = {}) {
  const follower = createFollower(rec.steps || [], { index: rec.start || 0 });
  const trace = [];
  normalize(rec).forEach((f, i) => {
    if (typeof f.set === 'number') {
      const index = follower.setIndex(f.set);
      trace.push({ i, t: f.t, frame: f, index, why: 'set', turn: follower.turn });
      return;
    }
    if (f.why === 'note' || (f.reset && (f.v === null || f.v === undefined))) {
      // ★ 자동을 껐다 켜면 엔진이 읽기 기억을 지운다 (engine:reset). 여기서 같이
      // 안 지우면 되돌려 본 궤적이 그때와 갈린다 — rest 와 똑같은 구멍이었다.
      if (f.reset) follower.reset();
      trace.push({ i, t: f.t, frame: f, index: follower.index, why: 'note', turn: follower.turn });
      return;
    }
    // 엔진은 쉬기 시작한 프레임에서 읽기 기억을 지운다 (engine.feed) — 여기서도
    // 같이 지워야 궤적이 그때와 같아진다
    if (f.rest) follower.reset();
    // 길게 쉬고 난 첫 프레임 — 엔진이 추적기에 "전투가 끝났다"를 알렸다 (P6b)
    if (f.ended) follower.battleOver();
    const r = follower.push(toReading(f), f.t);
    trace.push({ i, t: f.t, frame: f, index: r.index, why: r.why, turn: r.turn });
  });
  return trace.filter((x) => x.i >= from && x.i <= to);
}

function show(f) {
  if (typeof f.set === 'number') return `손→${f.set}`;
  if (f.why === 'note') return f.reset ? '※되돌림' : `※${f.note}`;
  if (f.rest) return ' 쉼';
  if (f.ended) return `새${String(f.v ?? '—').padStart(2)}`;
  // 최대 턴과 안 맞아 버린 프레임 — 못 읽은 것과 갈라서 보여준다
  if (f.drop !== undefined) return `✕${String(f.drop).padStart(2)}`;
  if (f.v === null || f.v === undefined) return '  —';
  return `${String(f.v).padStart(3)}${f.c !== undefined && f.c < 0.86 ? 'w' : ''}`;
}

/** 궤적을 한 줄씩. 단계가 바뀐 줄과 기록된 것과 다른 줄에 표시를 단다 */
function dump(trace, steps) {
  let prev = null;
  return trace
    .map((x) => {
      const moved = prev !== null && x.index !== prev;
      prev = x.index;
      const step = steps[x.index];
      const differs = x.frame.i !== undefined && x.frame.i >= 0 && x.frame.i !== x.index;
      return [
        `${String(x.i).padStart(5)}`,
        `${String((x.t / 1000).toFixed(1)).padStart(7)}s`,
        show(x.frame),
        `→ ${String(x.index).padStart(2)}`,
        moved ? '◆' : ' ',
        differs ? `(그때는 ${x.frame.i})` : '',
        `${x.why.padEnd(12)}`,
        step ? `${step.turn}턴 ${step.label}` : '',
      ].join(' ');
    })
    .join('\n');
}

/** 기록 안의 크롭 표본을 지금 인식기에 다시 넣어 본다 */
function recheck(rec) {
  const templates = loadTemplates(require('../src/shared/templates.json'));
  const rows = [];
  for (const s of rec.samples || []) {
    const gray = new Uint8Array(Buffer.from(s.gray, 'base64'));
    const now = readTurn(gray, s.w, s.h, templates);
    rows.push({
      t: s.t,
      kind: s.kind,
      then: s.read,
      thenConf: s.conf,
      now: now ? now.value : null,
      nowConf: now ? Math.round(now.confidence * 100) / 100 : 0,
    });
  }
  return rows;
}

/** 기록 → 시나리오. 사람이 expect만 붙이면 테스트가 된다 */
function toScenario(rec, name, { from = 0, to = Infinity } = {}) {
  const all = normalize(rec);
  const frames = all.filter((_f, i) => i >= from && i <= to);
  const base = frames.length ? frames[0].t : 0;
  // 시작 위치는 **첫 프레임을 넣기 전**의 단계다 — 구간을 잘랐으면 그 앞 프레임 뒤의 단계
  const before = from > 0 ? all[Math.min(from, all.length) - 1] : null;
  const start = before && before.i !== undefined && before.i >= 0 ? before.i : rec.start || 0;
  return {
    name: name || rec.name || '실제 전투 기록',
    why: '실제 게임에서 기록한 것. expect는 사람이 궤적을 보고 붙였다.',
    recorded: true,
    build: (rec.steps || []).some((s, i, a) => i > 0 && s.label !== a[i - 1].label && s.turn <= a[i - 1].turn)
      ? 'reset'
      : 'running',
    steps: rec.steps || [],
    start,
    frames: frames
      // 그냥 메모는 버리지만 **되돌림 표시는 남긴다** — 그게 빠지면 시나리오가
      // 실제와 다른 궤적을 내고, 그걸 자물쇠로 걸면 틀린 것을 잠그게 된다
      .filter((f) => f.why !== 'note' || f.reset)
      .map((f) => {
        if (typeof f.set === 'number') return { set: f.set, t: f.t - base };
        if (f.reset) return { t: f.t - base, v: null, reset: true };
        const out = { t: f.t - base, v: f.v === undefined ? null : f.v };
        if (f.rest) out.rest = true;
        if (f.ended) out.ended = true;
        if (out.v !== null && f.c !== undefined && f.c < 0.86) out.weak = true;
        return out;
      }),
    expect: [],
  };
}

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('쓰는 법: node tools/replay.js <기록.json> [--from N] [--to N] [--scenario 이름]');
    return 1;
  }
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
  };
  const from = Number(flag('from', 0));
  const to = Number(flag('to', Infinity));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));

  const scenario = args.includes('--scenario');
  if (scenario) {
    const name = flag('scenario', '');
    const out = toScenario(rec, name === '--scenario' ? '' : name, { from, to });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  const steps = rec.steps || [];
  console.log(`기록: ${rec.name || path.basename(file)}`);
  if (rec.meta && rec.meta.build) console.log(`빌드: ${rec.meta.build}`);
  // 어느 판에서 기록했는지 — 지금 코드와 다르면 "(그때는 N)" 차이는 버그가 아니라 판 차이일 수 있다
  if (rec.meta && rec.meta.app) console.log(`기록한 판: ${rec.meta.app} (지금 코드: ${BUILD})`);
  console.log(
    `단계 ${steps.length}개 · 프레임 ${(rec.frames || []).length}개 · 표본 ${(rec.samples || []).length}장`,
  );
  console.log(`단계 목록: ${steps.map((s, i) => `${i}:${s.turn}턴(${s.label})`).join(' ')}`);
  if (rec.trimmed) {
    console.log(
      '⚠ 10분이 넘어 앞부분이 잘린 기록이다 — 그 앞의 추적기 기억(믿는 턴·뛰기 기록)이 없는 채로\n' +
        '  재생하므로 처음 몇 초는 그때와 다를 수 있다. 거기서 난 "(그때는 N)"은 믿지 말 것.',
    );
  }
  console.log('\n프레임    시각   읽음  단계        판단        지금 할 것');
  console.log(dump(replay(rec, { from, to }), steps));

  const rows = recheck(rec);
  if (rows.length) {
    const same = rows.filter((r) => r.then === r.now).length;
    console.log(
      `\n표본 ${rows.length}장을 지금 인식기로 다시 읽음 — 그때와 같은 값 ${same}장, 달라진 값 ${rows.length - same}장`,
    );
    console.log(`(크롭 확대 목표 ${CROP_TARGET_HEIGHT}px)`);
    for (const r of rows.filter((x) => x.then !== x.now).slice(0, 20)) {
      console.log(
        `  ${String((r.t / 1000).toFixed(1)).padStart(7)}s [${r.kind}] 그때 ${r.then}(${r.thenConf}) → 지금 ${r.now}(${r.nowConf})`,
      );
    }
    const unread = rows.filter((r) => r.kind === 'unread');
    if (unread.length) {
      const recovered = unread.filter((r) => r.now !== null).length;
      console.log(`  못 읽었던 ${unread.length}장 중 ${recovered}장은 지금 인식기가 읽는다`);
    }
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { replay, dump, recheck, toScenario, toReading };
