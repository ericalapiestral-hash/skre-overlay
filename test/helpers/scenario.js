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
    // {"set": n} — 사용자가 이 프레임에 단계를 손으로 옮겼다 (P9). 읽기는 없다.
    if (frame && typeof frame === 'object' && typeof frame.set === 'number') {
      const index = follower.setIndex(frame.set);
      trace.push({ i, frame, index, why: 'set', turn: follower.turn });
      return;
    }
    // {"rest": true} — 이 프레임에서 전투가 끝났다고 보고 쉬기 시작했다.
    // 엔진이 그때 읽기 기억을 지우므로(engine.feed) 여기서도 지운다.
    if (frame && typeof frame === 'object' && frame.rest) follower.reset();
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
  const at = (i) => (trace[i] ? trace[i].index : trace[trace.length - 1].index);
  for (const e of scenario.expect || []) {
    if (e.by !== undefined) {
      // k번째 프레임까지는(포함) index가 n이어야 한다
      if (at(e.by) !== e.index) problems.push(`#${e.by}까지 단계 ${e.index}여야 하는데 ${at(e.by)}`);
    } else if (e.at !== undefined) {
      if (at(e.at) !== e.index) problems.push(`#${e.at} 뒤 단계 ${e.index}여야 하는데 ${at(e.at)}`);
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
  return problems;
}

module.exports = { run, check, dump };
