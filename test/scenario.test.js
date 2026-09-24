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
const { run, check, dump, doubled } = require('./helpers/scenario');

const DIR = path.join(__dirname, 'scenarios');

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

test('시나리오 파일이 있다', () => {
  assert.ok(files.length > 0, 'test/scenarios/*.json 이 하나도 없다');
});

for (const file of files) {
  const scenario = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  test(`${file} — ${scenario.name}`, () => {
    assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0, 'steps가 비었다');
    assert.ok(Array.isArray(scenario.frames) && scenario.frames.length > 0, 'frames가 비었다');
    // ★ expect 가 비면 **아무것도 검사하지 않고 초록**이 된다. tools/replay.js 는 실제
    // 기록을 `expect: []` 인 초안으로 뽑으므로(사람이 궤적을 보고 채우라고), 그걸 그대로
    // 넣으면 개수만 늘고 잠기는 건 없다. 여기 들어온 파일은 채워져 있어야 한다.
    assert.ok(
      Array.isArray(scenario.expect) && scenario.expect.length > 0,
      'expect 가 비었다 — 아무것도 검사하지 않는 시나리오다 (기록에서 뽑았으면 궤적을 보고 채울 것)',
    );
    const trace = run(scenario);
    const problems = check(scenario, trace);
    assert.strictEqual(
      problems.length,
      0,
      `${scenario.why || ''}\n${problems.map((p) => `  ✗ ${p}`).join('\n')}\n궤적:\n${dump(trace)}`,
    );
  });
}

// ★ 인식 주기를 **50ms 로 낮춘** 경우 — 같은 시나리오를 프레임마다 두 장씩으로 늘려 돌린다.
//
// 추적기의 "몇 프레임 이어져야"는 ms 로도 같이 재야 뜻이 유지된다 (주기 슬라이더는 50ms 까지
// 내려간다). 예전엔 P5·P9b·흐린 읽기가 프레임 수만 세서, 50ms 에서는 100ms 짜리 오독 한
// 번이 두 번 찍혀 조건을 채웠다 — 이 방식으로 돌리면 76개 중 23개가 깨졌다.
for (const file of files) {
  const scenario = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  // 실제 기록(프레임마다 t 가 있는 것)은 이미 그때의 간격이다 — 늘리지 않는다
  if (scenario.frames.some((f) => f && typeof f === 'object' && typeof f.t === 'number')) continue;
  test(`${file} — 50ms 주기에서도 같다`, () => {
    const half = doubled(scenario);
    const trace = run(half);
    const problems = check(half, trace);
    assert.strictEqual(
      problems.length,
      0,
      `${scenario.why || ''}\n${problems.map((p) => `  ✗ ${p}`).join('\n')}\n궤적(50ms):\n${dump(trace)}`,
    );
  });
}
