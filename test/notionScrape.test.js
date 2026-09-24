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
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const ELECTRON = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const ROOT = path.join(__dirname, '..');
const PAGE = path.join(__dirname, 'fixtures', 'notion-page.html');
const SEMANTIC = path.join(__dirname, 'fixtures', 'semantic-page.html');
/**
 * 같은 페이지를 **창 하나로 몇 번** 긁나. 앱(fetchTree)은 창 하나로 수십 장을 돈다.
 * 숨긴 창은 둘째 장부터 화면 갱신이 더 드물어져 늦게 붙는 부분을 더 자주 놓쳤는데,
 * 예전 시험은 새 프로세스의 첫 장 하나만 긁어서 그걸 못 봤다.
 */
const REPEAT = 3;

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
  // userData 를 따로 준다 (smoke.test.js 와 같은 이유). 개발자의 실제 설정·도감에
  // 안 닿게 하려는 것이다. (예전엔 기본 userData 의 단일 인스턴스 잠금까지 나눠 써서,
  // 앱을 켜 둔 채 시험하면 이 실행이 아무것도 안 뱉고 끝났다 — 지금은 자가 시험이
  // 잠금을 안 잡는다.)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skre-notion-'));
  const pages = [...Array(REPEAT).fill(`file://${PAGE}`), `file://${SEMANTIC}`];
  const r = spawnSync(
    run.cmd,
    [
      ...run.pre,
      '.',
      ...pages.map((u) => `--notion-selftest=${u}`),
      '--no-sandbox',
      `--user-data-dir=${userData}`,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 },
  );
  fs.rmSync(userData, { recursive: true, force: true });
  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('SKRE_NOTION '));
  assert.ok(line, `결과를 안 남겼다 (종료 ${r.status})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  const got = JSON.parse(line.slice('SKRE_NOTION '.length));
  assert.strictEqual(got.ok, true, `긁다가 실패했다: ${got.error}`);
  assert.strictEqual(got.pages.length, pages.length, '긁은 장 수가 모자란다');

  got.pages.slice(0, REPEAT).forEach((page, n) => checkNotionPage(page, `${n + 1}번째 장`));
  checkSemanticPage(got.pages[REPEAT]);
});

/** 노션 모양 페이지 한 장 — 창을 돌려 쓴 둘째·셋째 장도 첫 장과 똑같이 긁혀야 한다 */
function checkNotionPage(page, which) {
  const by = Object.fromEntries(page.candidates.map((c) => [c.how, c.markdown]));
  const say = (msg) => `${which}: ${msg}`;

  // ★ 숨긴 창에서 **자바스크립트가 돌았나.** 안 돌면 "불러오는 중…"만 나온다 —
  // 노션 공개 페이지는 HTML 에 글이 없고 전부 JS 가 그리므로 여기가 곧 생사다.
  assert.ok(
    by.notion.includes('세인 속공'),
    say(`숨긴 창에서 JS 가 안 돌았다 (긁힌 것: ${JSON.stringify(by.notion).slice(0, 200)})`),
  );

  // 블록 종류가 마크다운 기호로 옮겨졌나
  assert.match(by.notion, /^# 세팅$/m);
  assert.match(by.notion, /^## 스킬 순서$/m);
  assert.match(by.notion, /^### 1라운드$/m);
  assert.match(by.notion, /- 세인 속공 33 이상/);

  // ★ 표는 **그 자리에서** 풀려야 한다. 예전엔 문서 맨 끝(# 메모 뒤)으로 밀려
  // 스킬 순서 섹션 밖으로 잘렸다.
  const table = by.notion.indexOf('세인 위 (표)');
  assert.ok(table >= 0, say('표 줄이 안 긁혔다'));
  assert.ok(table < by.notion.indexOf('# 메모'), say('표 줄이 문서 끝으로 밀렸다 — 섹션 밖에서 잘린다'));

  // ★ PREPARE 가 **접힌 토글을 폈나.** 안 펴면 그 안의 빌드가 통째로 사라진다.
  assert.ok(page.prepared && page.prepared.opened > 0, say('접힌 토글을 하나도 안 폈다'));
  assert.match(by.notion, /8턴.*세인 위/, say('토글 안의 글이 안 긁혔다'));

  // ★ PREPARE 가 **끝까지 훑어 내렸나.** 노션은 긴 페이지를 보이는 만큼만 그린다.
  assert.match(by.notion, /16턴.*리나 아래/, say('아래로 안 내려가서 늦게 붙는 부분을 놓쳤다'));

  // ★ 그리고 **한 번에 안 오는 것까지 기다렸나.** 시험용 페이지는 늦게 붙는 부분을
  // 두 단계로 나누고 각 단계에 뜸을 들인다. 높이가 한 틱(200ms) 안 안 늘었다고
  // 거기서 멈추거나, 페이지가 스크롤을 알기도 전에 "조용하다"를 세면 2단계를 못 받는다
  // — 오류 없이 페이지 절반이 조용히 사라진다.
  assert.match(by.notion, /20턴.*스핑크스 위/, say('늦게 붙는 2단계를 놓쳤다'));

  // 하위 페이지 링크
  assert.ok(
    page.links.some((l) => l.href.includes('aaaaaaaabbbbccccddddeeeeffff0000')),
    say(`하위 페이지 링크를 못 찾았다: ${JSON.stringify(page.links)}`),
  );
  assert.strictEqual(page.title, '파이 세인 4턴');

  // 나머지 두 방법도 무언가는 뽑아야 한다 — 하나가 깨져도 받쳐 주는 게 설계다
  assert.ok(by.plain.includes('세인 속공'), say('보이는 글 그대로도 못 뽑았다'));
  assert.ok(typeof by.semantic === 'string', say('semantic 이 예외로 죽었다'));

  // 그리고 셋 중 제일 나은 것을 골랐나
  assert.strictEqual(page.picked.how, 'notion', say(`엉뚱한 방법을 골랐다: ${JSON.stringify(page.picked)}`));
  assert.strictEqual(page.picked.strategy, 'section');
  assert.ok(page.picked.stepCount >= 6, say(`단계를 ${page.picked.stepCount}개만 읽었다`));
  assert.ok(page.picked.groups >= 3, say(`라운드를 ${page.picked.groups}개로만 나눴다`));
}

/** 노션 클래스가 없는 페이지 — 표준 태그로 긁는 길(EXTRACT_SEMANTIC) */
function checkSemanticPage(page) {
  const by = Object.fromEntries(page.candidates.map((c) => [c.how, c.markdown]));
  const md = by.semantic;
  const count = (re) => (md.match(re) || []).length;
  // ★ 글이 같다고 지우지 않는다 — 섹션마다 되풀이되는 라운드 제목, 라운드마다 같은 행동 줄
  assert.strictEqual(count(/^### 1라운드$/gm), 2, `되풀이된 "### 1라운드" 가 지워졌다:\n${md}`);
  assert.strictEqual(count(/비스킷 아래 \/ `4턴`나타 아래/g), 2, `라운드마다 같은 행동 줄이 지워졌다:\n${md}`);
  // 표 줄 안의 p 는 표 줄이 이미 담았다 — 두 번 나오면 단계가 부푼다
  assert.strictEqual(count(/리나 아래 \(표\)/g), 1, `표 칸의 글이 두 번 들어갔다:\n${md}`);
  assert.strictEqual(page.picked.how, 'semantic', `노션 클래스가 없는데 ${page.picked.how} 를 골랐다`);
}
