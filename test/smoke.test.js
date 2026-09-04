// 앱이 진짜로 뜨는가 — Electron을 실제로 띄워 보는 유일한 테스트.
//
// 나머지 테스트는 전부 순수 로직(인식기·추적기·파서)만 본다. 그래서 **단위 테스트가
// 전부 초록인 채로 앱이 아예 안 뜨는 일**이 얼마든지 생긴다: 프리로드 경로 오타,
// IPC 채널 이름 불일치, contextBridge에서 못 넘기는 값, 렌더러의 문법 오류,
// Electron 판올림으로 사라진 옵션. 이 층은 여기서만 걸린다.
//
// 화면이 없는 곳(CI·컨테이너)에서는 xvfb가 있어야 돌아가고, 없으면 건너뛴다 —
// 검사를 못 했으면 못 했다고 하지, 통과했다고 하지 않는다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');
const { CROP_TARGET_HEIGHT } = require('../src/shared/turnReader');

const ELECTRON = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const ROOT = path.join(__dirname, '..');

/** 도감이 있는지 없는지에 따라 결과가 달라지면 안 되니 시험용 도감을 직접 쥐여 준다 */
const CATALOG = {
  builds: [
    {
      id: 'smoke-1',
      name: '스모크 파괴신',
      mode: '파괴신',
      body: '## 스킬 순서\n### 1라운드\n- `0턴` 나타 아래\n- `4턴` 쥬리 위\n',
    },
    { id: 'smoke-2', name: '스모크 공성전', mode: '공성전', body: '본문만 있고 순서는 없다' },
  ],
};

function have(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 화면이 있으면 그냥 띄우고, 없으면 xvfb를 빌린다 */
function launcher() {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.env.DISPLAY) {
    return { cmd: ELECTRON, pre: [] };
  }
  return have('xvfb-run') ? { cmd: 'xvfb-run', pre: ['-a', ELECTRON] } : null;
}

const runner = fs.existsSync(ELECTRON) ? launcher() : null;
const why = !fs.existsSync(ELECTRON)
  ? 'electron이 안 깔려 있다 (npm install)'
  : !runner
    ? '화면도 xvfb도 없다'
    : '';

// node:test는 skip이 **빈 문자열이어도** 건너뛴다(문자열은 문자열이다). `skip: why`로
// 두면 조건이 다 맞는 곳에서도 조용히 안 돌아, 안 돈 걸 통과로 착각하게 된다.
test('앱이 실제로 뜨고 화면·프리로드·IPC가 이어진다', { skip: why || false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skre-smoke-'));
  const builds = path.join(dir, 'builds.json');
  fs.writeFileSync(builds, JSON.stringify(CATALOG));
  // userData를 따로 줘야 이 컴퓨터에 이미 있는 설정이 결과를 바꾸지 않는다
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ buildsPath: builds }));

  const run = /** @type {{cmd: string, pre: string[]}} */ (runner);
  const r = spawnSync(
    run.cmd,
    [
      ...run.pre,
      '.',
      '--smoke',
      // 컨테이너에서는 root로 도는 일이 많다 — 게임 PC에서는 해당 없다
      '--no-sandbox',
      `--user-data-dir=${userData}`,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 90000 },
  );

  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('SKRE_SMOKE '));
  assert.ok(line, `앱이 결과를 안 남겼다 (종료 ${r.status})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  const got = JSON.parse(line.slice('SKRE_SMOKE '.length));

  assert.deepStrictEqual(got.errors, [], '렌더러 콘솔에 에러가 있으면 안 된다');
  assert.strictEqual(got.window.created, true, '창이 안 생겼다');
  assert.strictEqual(got.window.alwaysOnTop, true, '항상 위가 아니면 게임에 가린다');

  // 프리로드 다리 — 하나라도 빠지면 화면이 통째로 죽는다
  assert.deepStrictEqual(got.probe.bridge, [
    'capture',
    'catalog',
    'config',
    'engine',
    'keys',
    'region',
    'tune',
    'win',
  ]);
  // 크롭 높이는 인식기에 한 값만 두고 preload로 건네야 한다 (CLAUDE.md). 실제로 그런지 본다.
  assert.strictEqual(got.probe.cropHeight, CROP_TARGET_HEIGHT, '화면이 크롭 높이를 따로 정하고 있다');
  assert.deepStrictEqual(
    got.probe.elements,
    ['app', 'steps', 'status', 'build', 'auto', 'rate'],
    '화면이 다 안 그려졌다',
  );

  // 진짜 IPC 왕복 — 채널 이름이나 핸들러가 어긋나면 여기서 걸린다
  assert.strictEqual(got.probe.catalog.ok, true, `도감 IPC가 실패했다: ${JSON.stringify(got.probe.catalog)}`);
  assert.strictEqual(got.probe.catalog.builds, 2, '스킬 순서를 못 읽은 빌드도 목록에 남아야 한다');
  assert.ok(got.probe.config.includes('tickMs'), '설정 IPC가 기본값을 안 돌려준다');
  assert.strictEqual(got.probe.engine.fed, true, '엔진 IPC가 픽셀을 못 받았다');

  fs.rmSync(dir, { recursive: true, force: true });
});
