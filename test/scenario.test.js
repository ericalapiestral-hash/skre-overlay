// 전투 시나리오 실행기 — test/scenarios/*.json 을 전부 돌려 본다.
//
// 시나리오 형식과 지켜야 할 정책은 test/scenarios/README.md 에 있다.
// 여기서는 프레임을 하나씩 넣고 index의 궤적을 기록한 뒤, expect를 하나씩 확인한다.
// 틀리면 어느 프레임에서 무엇이 나왔는지 궤적을 통째로 보여준다 — 그래야 고칠 수 있다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createFollower } = require('../src/shared/follower');

const DIR = path.join(__dirname, 'scenarios');

/** 시나리오 한 판을 돌려 프레임마다의 index와 판단 이유를 돌려준다 */
function run(scenario) {
  const dt = scenario.dt || 100;
  const follower = createFollower(scenario.steps, { index: scenario.start || 0 });
  const trace = [];
  scenario.frames.forEach((frame, i) => {
    // {"set": n} — 사용자가 이 프레임에 단계를 손으로 옮겼다 (P9). 읽기는 없다.
    if (frame && typeof frame === 'object' && typeof frame.set === 'number') {
      const index = follower.setIndex(frame.set);
      trace.push({ i, frame, index, why: 'set', turn: follower.turn });
      return;
    }
    let reading = null;
    if (typeof frame === 'number') reading = { value: frame, confidence: 0.95 };
    else if (frame && typeof frame === 'object') {
      reading = { value: frame.v, confidence: frame.weak ? 0.75 : 0.95, snapped: Boolean(frame.snapped) };
    }
    const r = follower.push(reading, i * dt);
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

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

test('시나리오 파일이 있다', () => {
  assert.ok(files.length > 0, 'test/scenarios/*.json 이 하나도 없다');
});

for (const file of files) {
  const scenario = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  test(`${file} — ${scenario.name}`, () => {
    assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0, 'steps가 비었다');
    assert.ok(Array.isArray(scenario.frames) && scenario.frames.length > 0, 'frames가 비었다');
    const trace = run(scenario);
    const problems = check(scenario, trace);
    assert.strictEqual(
      problems.length,
      0,
      `${scenario.why || ''}\n${problems.map((p) => `  ✗ ${p}`).join('\n')}\n궤적:\n${dump(trace)}`,
    );
  });
}

module.exports = { run, check, dump };
