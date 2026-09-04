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
const { run, check, dump } = require('./helpers/scenario');

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
    const trace = run(scenario);
    const problems = check(scenario, trace);
    assert.strictEqual(
      problems.length,
      0,
      `${scenario.why || ''}\n${problems.map((p) => `  ✗ ${p}`).join('\n')}\n궤적:\n${dump(trace)}`,
    );
  });
}
