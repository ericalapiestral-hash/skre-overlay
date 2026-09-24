// 시나리오 실행기 — 프레임 열을 추적기에 넣고 궤적과 기대 확인을 돌려준다.
//
// test/scenario.test.js(시나리오 파일 전부 돌리기)와 test/recorder.test.js(실제 기록을
// 시나리오로 뽑아 같은 결론이 나오는지)가 같이 쓴다. 테스트 파일에서 직접 require하면
// 그쪽 테스트가 통째로 한 번 더 돌아 버리므로 여기로 뺐다.
'use strict';

const { createFollower } = require('../../src/shared/follower');

/** 시나리오 한 판을 돌려 프레임마다의 index와 판단 이유를 돌려준다 */
function run(scenario) {
  const dt = scenario.dt || 100;
  const follower = createFollower(scenario.steps, { index: scenario.start || 0 });
  const trace = [];
  scenario.frames.forEach((frame, i) => {
    // 실제 게임에서 기록한 시나리오는 프레임 간격이 고르지 않다 — 프레임마다 t를
    // 들고 온다. 손으로 쓴 시나리오는 없으므로 100ms 간격으로 친다.
    const at = frame && typeof frame === 'object' && typeof frame.t === 'number' ? frame.t : i * dt;
    // {"skip": true} — 아무 일도 없는 칸 (doubled 가 쓴다)
    if (frame && typeof frame === 'object' && frame.skip) {
      trace.push({ i, frame, index: follower.index, why: 'skip', turn: follower.turn });
      return;
    }
    // {"set": n} — 사용자가 이 프레임에 단계를 손으로 옮겼다 (P9). 읽기는 없다.
    if (frame && typeof frame === 'object' && typeof frame.set === 'number') {
      const index = follower.setIndex(frame.set);
      trace.push({ i, frame, index, why: 'set', turn: follower.turn });
      return;
    }
    // {"rest": true} — 이 프레임에서 전투가 끝났다고 보고 쉬기 시작했다.
    // 엔진이 그때 읽기 기억을 지우므로(engine.feed) 여기서도 지운다.
    if (frame && typeof frame === 'object' && frame.rest) follower.reset();
    // {"reset": true} — 이 프레임에서 자동을 껐다 켰다 (engine:reset). 엔진이 읽기
    // 기억을 지우므로 여기서도 지운다.
    if (frame && typeof frame === 'object' && frame.reset) {
      follower.reset();
      // ★ 읽기가 없으면 **프레임을 넣지 않는다.** 엔진도 되돌림 때는 프레임을 안 넣는다
      // (engine:reset 은 reset 만 한다 · tools/replay.js 도 같다). 예전엔 여기서 가려짐 한
      // 프레임을 넣어서, 그 뒤 첫 프레임까지가 "가려진 시간"으로 잡혀 리셋 빌드의 라운드
      // 전환(P5, 500ms 가려짐)이 러너에서만 걸렸다 — 실제와 다른 궤적을 자물쇠로 걸게 된다.
      if (frame.v === null || frame.v === undefined) {
        trace.push({ i, frame, index: follower.index, why: 'reset', turn: follower.turn });
        return;
      }
    }
    // {"ended": true} — 길게 쉬고 난 뒤 처음 읽힌 프레임이다 (P6b). 엔진이 이 프레임을
    // 넣기 전에 "전투가 끝났다"를 알린다 (engine.feed).
    if (frame && typeof frame === 'object' && frame.ended) follower.battleOver();
    let reading = null;
    if (typeof frame === 'number') reading = { value: frame, confidence: 0.95 };
    else if (frame && typeof frame === 'object' && frame.v !== null && frame.v !== undefined) {
      reading = { value: frame.v, confidence: frame.weak ? 0.75 : 0.95 };
    }
    const r = follower.push(reading, at);
    trace.push({ i, frame, index: r.index, why: r.why, turn: r.turn });
  });
  return trace;
}

/**
 * 시나리오를 **프레임마다 두 장씩**(간격 절반) 으로 늘린다 — 인식 주기를 50ms 로 낮춘 경우.
 *
 * 추적기의 "몇 프레임 이어져야"는 전부 ms 로도 같이 재야 한다. 프레임 수만 세면 주기를
 * 반으로 줄였을 때 100ms 짜리 오독 한 번이 두 번 찍혀 조건을 채운다 — 실제로 P5·P9b·흐린
 * 읽기가 그랬고, 50ms 에서 시나리오 76개 중 23개가 깨졌다. 기대의 프레임 번호도 따라
 * 옮긴다 (k번째 → 둘째 장 2k+1).
 * 사건(set·rest·reset·ended)은 첫 장에만 싣고, 둘째 장은 같은 읽기만 한 번 더 보여준다.
 */
function doubled(scenario) {
  const dt = (scenario.dt || 100) / 2;
  const frames = [];
  scenario.frames.forEach((f, i) => {
    const t0 = f && typeof f === 'object' && typeof f.t === 'number' ? f.t : i * dt * 2;
    const first = f && typeof f === 'object' ? { ...f, t: t0 } : { v: f, t: t0 };
    let again;
    if (f && typeof f === 'object') {
      const { set, rest, reset, ended, ...plain } = f;
      // 읽기 없는 사건(손으로 옮김·읽기 없는 되돌림)은 둘째 장에 아무것도 안 넣는다 —
      // 원래도 그 칸에는 추적기에 들어간 게 없다. 손으로 옮김을 두 번 하면 P9b 가 깨진다.
      const eventOnly = typeof set === 'number' || (reset && (f.v === null || f.v === undefined));
      again = eventOnly ? { skip: true, t: t0 + dt } : { ...plain, t: t0 + dt };
    } else {
      again = { v: f, t: t0 + dt };
    }
    frames.push(first);
    frames.push(again);
  });
  const map = (k) => 2 * k + 1;
  const expect = (scenario.expect || []).map((e) => {
    const x = { ...e };
    if (x.by !== undefined) x.by = map(x.by);
    if (x.at !== undefined) x.at = map(x.at);
    if (x.from !== undefined) x.from = 2 * x.from;
    if (x.to !== undefined) x.to = map(x.to);
    return x;
  });
  return { ...scenario, dt, frames, expect };
}

/** 궤적을 한 줄씩 — 실패 메시지용 */
function dump(trace) {
  return trace
    .map((t) => {
      const f =
        t.frame === null
          ? '  —'
          : typeof t.frame === 'number'
            ? String(t.frame).padStart(3)
            : typeof t.frame.set === 'number'
              ? `손→${t.frame.set}`
              : t.frame.v === null || t.frame.v === undefined
                ? '  —'
                : `${String(t.frame.v).padStart(3)}${t.frame.weak ? 'w' : ''}`;
      return `  #${String(t.i).padStart(3)} 읽음 ${f} → 단계 ${t.index} (${t.why}${t.turn !== null ? `, 믿는 턴 ${t.turn}` : ''})`;
    })
    .join('\n');
}

function check(scenario, trace) {
  const problems = [];
  // ★ 범위를 넘는 프레임 번호를 **조용히 넘기지 않는다.**
  //
  // 예전엔 없는 프레임을 물어보면 마지막 프레임의 index 를 돌려줬다. 그래서 expect 에
  // 프레임 번호를 잘못 적어도 그냥 통과했고, 실제로 reset-06·resetb-06 이 프레임 28개
  // (0~27)짜리에서 `to: 28` 을 검사하고 있었다. 시나리오는 이 프로젝트가 추적기 규칙을
  // 정하는 방식이라, 여기가 헐거우면 **틀린 것을 자물쇠로 걸게 된다.**
  const out = [];
  const at = (i) => {
    if (!trace[i]) {
      out.push(i);
      return -1;
    }
    return trace[i].index;
  };
  for (const e of scenario.expect || []) {
    if (e.by !== undefined) {
      // k번째 프레임까지는(포함) index가 n이어야 한다
      if (at(e.by) !== e.index) problems.push(`#${e.by}까지 단계 ${e.index}여야 하는데 ${at(e.by)}`);
    } else if (e.at !== undefined) {
      if (e.index !== undefined && at(e.at) !== e.index) {
        problems.push(`#${e.at} 뒤 단계 ${e.index}여야 하는데 ${at(e.at)}`);
      }
      // 믿는 턴 — 상태줄·턴 표시가 이 값을 보여준다
      if (e.turn !== undefined) {
        const got = trace[e.at] ? trace[e.at].turn : undefined;
        if (got !== e.turn) problems.push(`#${e.at} 뒤 믿는 턴이 ${e.turn}이어야 하는데 ${got}`);
        at(e.at);
      }
    } else if (e.from !== undefined) {
      for (let i = e.from; i <= e.to; i += 1) {
        const got = at(i);
        if (e.hold !== undefined && got !== e.hold) {
          problems.push(`#${e.from}~#${e.to} 내내 단계 ${e.hold}여야 하는데 #${i}에서 ${got}`);
          break;
        }
        if (e.min !== undefined && got < e.min) {
          problems.push(`#${e.from}~#${e.to}에서 단계 ${e.min} 아래로 가면 안 되는데 #${i}에서 ${got}`);
          break;
        }
        if (e.max !== undefined && got > e.max) {
          problems.push(`#${e.from}~#${e.to}에서 단계 ${e.max}를 넘으면 안 되는데 #${i}에서 ${got}`);
          break;
        }
      }
    }
  }
  if (out.length > 0) {
    problems.push(
      `expect 가 없는 프레임을 가리킨다: #${[...new Set(out)].join(', #')} (프레임은 0~${trace.length - 1})`,
    );
  }
  return problems;
}

module.exports = { run, check, dump, doubled };
