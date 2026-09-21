// 노션 긁는 기계가 진짜로 도는가 — Electron 을 띄워 시험용 페이지를 긁어 본다.
//
// **진짜 노션은 여기서 못 연다** (개발 환경에서 notion.site 가 통째로 막혀 있다).
// 그래서 노션의 **성질만** 흉내 낸 페이지로 확인한다: 자바스크립트로 그려지고,
// 토글이 접혀 있고, 바닥까지 내려가야 붙는 부분이 있는 페이지.
//
// 여기서 확인하는 건 "노션 화면이 맞나"가 아니라 **기계가 도는가**다. 다른 테스트는
// 전부 순수 로직이라, 숨긴 창에서 JS 가 안 돌거나 executeJavaScript 가 막히거나
// 추출 스크립트에 문법 오류가 있어도 **전부 초록인 채로 [노션에서 받기]만 죽는다.**
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const ELECTRON = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const ROOT = path.join(__dirname, '..');
const PAGE = path.join(__dirname, 'fixtures', 'notion-page.html');

function have(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function launcher() {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.env.DISPLAY) {
    return { cmd: ELECTRON, pre: [] };
  }
  return have('xvfb-run') ? { cmd: 'xvfb-run', pre: ['-a', ELECTRON] } : null;
}

const runner = fs.existsSync(ELECTRON) ? launcher() : null;
// node:test 는 skip 이 **빈 문자열이어도** 건너뛴다 — `why || false` 로 둘 것
const why = !fs.existsSync(ELECTRON)
  ? 'electron이 안 깔려 있다 (npm install)'
  : !runner
    ? '화면도 xvfb도 없다'
    : !fs.existsSync(PAGE)
      ? '시험용 페이지가 없다'
      : '';

test('숨긴 창으로 노션 모양 페이지를 실제로 긁어낸다', { skip: why || false }, () => {
  const run = /** @type {{cmd: string, pre: string[]}} */ (runner);
  const r = spawnSync(
    run.cmd,
    [...run.pre, '.', `--notion-selftest=file://${PAGE}`, '--no-sandbox'],
    { cwd: ROOT, encoding: 'utf8', timeout: 90000 },
  );
  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('SKRE_NOTION '));
  assert.ok(line, `결과를 안 남겼다 (종료 ${r.status})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  const got = JSON.parse(line.slice('SKRE_NOTION '.length));
  assert.strictEqual(got.ok, true, `긁다가 실패했다: ${got.error}`);

  const by = Object.fromEntries(got.candidates.map((c) => [c.how, c.markdown]));

  // ★ 숨긴 창에서 **자바스크립트가 돌았나.** 안 돌면 "불러오는 중…"만 나온다 —
  // 노션 공개 페이지는 HTML 에 글이 없고 전부 JS 가 그리므로 여기가 곧 생사다.
  assert.ok(
    by.notion.includes('세인 속공'),
    `숨긴 창에서 JS 가 안 돌았다 (긁힌 것: ${JSON.stringify(by.notion).slice(0, 200)})`,
  );

  // 블록 종류가 마크다운 기호로 옮겨졌나
  assert.match(by.notion, /^# 세팅$/m);
  assert.match(by.notion, /^## 스킬 순서$/m);
  assert.match(by.notion, /^### 1라운드$/m);
  assert.match(by.notion, /- 세인 속공 33 이상/);

  // ★ PREPARE 가 **접힌 토글을 폈나.** 안 펴면 그 안의 빌드가 통째로 사라진다.
  assert.ok(got.prepared && got.prepared.opened > 0, '접힌 토글을 하나도 안 폈다');
  assert.match(by.notion, /8턴.*세인 위/, '토글 안의 글이 안 긁혔다');

  // ★ PREPARE 가 **끝까지 훑어 내렸나.** 노션은 긴 페이지를 보이는 만큼만 그린다.
  assert.match(by.notion, /16턴.*리나 아래/, '아래로 안 내려가서 늦게 붙는 부분을 놓쳤다');

  // ★ 그리고 **한 번에 안 오는 것까지 기다렸나.** 시험용 페이지는 늦게 붙는 부분을
  // 두 단계로 나누고 각 단계에 뜸을 들인다. 높이가 한 틱(200ms) 안 안 늘었다고
  // 거기서 멈추면 2단계를 영영 못 받는다 — 오류 없이 페이지 절반이 조용히 사라진다.
  // 실제로 그렇게 돼 있었고, CPU를 물려 놓으면 세 번에 한 번씩 재현됐다.
  assert.match(by.notion, /20턴.*스핑크스 위/, '뜸 한 번을 "끝"으로 보고 2단계를 놓쳤다');

  // 하위 페이지 링크
  assert.ok(
    got.links.some((l) => l.href.includes('aaaaaaaabbbbccccddddeeeeffff0000')),
    `하위 페이지 링크를 못 찾았다: ${JSON.stringify(got.links)}`,
  );
  assert.strictEqual(got.title, '파이 세인 4턴');

  // 나머지 두 방법도 무언가는 뽑아야 한다 — 하나가 깨져도 받쳐 주는 게 설계다
  assert.ok(by.plain.includes('세인 속공'), '보이는 글 그대로도 못 뽑았다');
  assert.ok(by.semantic.length >= 0, 'semantic 이 예외로 죽으면 빈 문자열조차 아니다');

  // 그리고 셋 중 제일 나은 것을 골랐나
  assert.strictEqual(got.picked.how, 'notion', `엉뚱한 방법을 골랐다: ${JSON.stringify(got.picked)}`);
  assert.strictEqual(got.picked.strategy, 'section');
  assert.ok(got.picked.stepCount >= 5, `단계를 ${got.picked.stepCount}개만 읽었다`);
  assert.ok(got.picked.groups >= 3, `라운드를 ${got.picked.groups}개로만 나눴다`);
});
