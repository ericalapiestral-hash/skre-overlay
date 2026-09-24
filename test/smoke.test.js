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
    'diag',
    'engine',
    'keys',
    'region',
    'win',
  ]);
  // 크롭을 키우는 일은 화면이 아니라 메인(fitCrop)이 한다 — 화면에 크롭 높이를 건네면
  // 누군가 다시 캔버스로 키우기 시작한다 (벤치와 다른 그림이 된다)
  assert.deepStrictEqual(
    got.probe.elements,
    ['app', 'steps', 'status', 'build', 'auto', 'rate'],
    '화면이 다 안 그려졌다',
  );

  // 턴 영역 기본 위치가 화면까지 건너갔는지. 설정이 비어 있는 채로 띄웠으므로
  // (userData를 새로 만든다) 앱은 기본 위치로 시작한다고 말해야 한다 —
  // 이게 안 되면 사용자는 켜자마자 "턴 영역을 지정하세요"만 보게 된다.
  assert.deepStrictEqual(got.probe.presets, ['destroyer'], '기본 위치가 화면에 안 갔다');
  assert.match(got.probe.statusText, /기본 위치|파괴신/, `기본 위치로 시작 안 했다: "${got.probe.statusText}"`);

  // 진짜 IPC 왕복 — 채널 이름이나 핸들러가 어긋나면 여기서 걸린다
  assert.strictEqual(got.probe.catalog.ok, true, `도감 IPC가 실패했다: ${JSON.stringify(got.probe.catalog)}`);
  assert.strictEqual(got.probe.catalog.builds, 2, '스킬 순서를 못 읽은 빌드도 목록에 남아야 한다');
  assert.ok(got.probe.config.includes('tickMs'), '설정 IPC가 기본값을 안 돌려준다');
  assert.strictEqual(got.probe.engine.fed, true, '엔진 IPC가 픽셀을 못 받았다');
  // ★ 캡처 소스와 **그 화면의 실제 크기** — 렌더러가 이 크기를 캡처 제약에 못 박는다.
  // 크기가 안 오면 크로미움이 1280×720으로 줄여 캡처한다 (CLAUDE.md "진짜 원인은 캡처였다")
  assert.ok(got.probe.capture, `capture:source 가 답을 안 했다: ${JSON.stringify(got.probe)}`);
  assert.strictEqual(got.probe.capture.id, 'string');
  assert.ok(got.probe.capture.width > 0 && got.probe.capture.height > 0, '화면 크기를 안 돌려준다');
  assert.strictEqual(got.probe.more, undefined, `IPC 왕복이 실패했다: ${JSON.stringify(got.probe.more)}`);
  assert.strictEqual(got.probe.body, '본문만 있고 순서는 없다');
  assert.ok(Array.isArray(got.probe.keys), '단축키 실패 목록을 못 받았다');
  // 빈 화면으로는 못 가르친다 — 그래도 **답은 와야** 한다 (사람 말로)
  assert.deepStrictEqual(got.probe.teach, { ok: false, error: 'string' });
  assert.deepStrictEqual(got.probe.diag, ['frames', 'samples', 'spanMs']);
  // 기본 위치로 시작했어도 설정에는 안 남는다
  assert.strictEqual(got.probe.turnRegion, null, '앱이 짐작한 기본 위치를 설정에 저장했다');

  fs.rmSync(dir, { recursive: true, force: true });
});
