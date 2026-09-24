// 화면까지 통째로 — 진짜 앱을 띄워 가짜 게임 화면을 캡처해 읽게 한다.
//
// 나머지 시험은 판단(인식기·추적기·파서)을 Node 에서 본다. 그 사이의 층 — 화면을 잡아
// 자르고, 결과를 그리고, 단추를 누르는 것 — 은 여기서만 걸린다. 실제로 여기서 잡힌 것들:
// 기억한 빌드로 켜면 드롭다운이 비어 있었다, [가르치기]를 연 채 턴이 넘어가면 엉뚱한
// 모양을 배웠다, [자동]을 빠르게 켬·끔·켬 하면 화면 캡처 스트림이 새어 나갔다,
// 인식 주기 슬라이더가 [자동]을 다시 켜기 전까지 안 먹었다.
//
// 이 컨테이너의 xvfb 에서는 화면 캡처가 실제로 돈다. 화면도 xvfb 도 없으면 건너뛴다 —
// 검사를 못 했으면 못 했다고 하지, 통과라고 하지 않는다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const ELECTRON = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const MAIN = path.join(__dirname, 'helpers', 'e2e-main.js');

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

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
  // 화면 크기를 못 박는다 — 가짜 게임 글자 크기와 턴 영역이 화면 비율로 잡혀 있다
  return have('xvfb-run') ? { cmd: 'xvfb-run', pre: ['-a', '-s', '-screen 0 1280x1024x24', ELECTRON] } : null;
}

const runner = fs.existsSync(ELECTRON) ? launcher() : null;
// node:test 는 skip 이 **빈 문자열이어도** 건너뛴다 — `why || false` 로 둘 것
const why = !fs.existsSync(ELECTRON) ? 'electron이 안 깔려 있다 (npm install)' : !runner ? '화면도 xvfb도 없다' : '';

/**
 * 시험용 도감. 공성전 둘은 **어제 요일**과 **오늘 요일** 빌드다 — 어제 것을 기억한 채로
 * 켜면 오늘 것이 떠야 한다 (공성전은 보스가 요일마다 바뀐다).
 */
function catalog(today, yesterday) {
  const long = ['0', '2', '4', '6', '8', '10', '12', '14', '16', '18', '20'].map((t) => `- \`${t}턴\` ${t}번`);
  return {
    builds: [
      {
        id: 'd-reset',
        name: '리셋 파괴신',
        category: '파괴신',
        group: '강림',
        body: [
          '## 스킬 순서',
          '### 1라운드',
          '- `0턴` 나타 아래',
          '- `2턴` 쥬리 위',
          '- `4턴` 미호 위',
          '- `6턴` 파멸',
          '### 2라운드',
          '- `0턴` 아칸 아래',
          '- `3턴` 세인 위',
          '- `5턴` 스파이크',
        ].join('\n'),
      },
      { id: 'd-cont', name: '긴 파괴신', category: '파괴신', group: '강림', body: ['## 스킬 순서', ...long].join('\n') },
      { id: 'd-none', name: '순서 없는 파괴신', category: '파괴신', group: '강림', body: '그냥 설명만 있다.' },
      { id: 's-yesterday', name: '어제 보스', category: '공성전', group: '공성전', weekdays: [yesterday], body: ['## 스킬 순서', ...long].join('\n') },
      { id: 's-today', name: '오늘 보스', category: '공성전', group: '공성전', weekdays: [today], body: ['## 스킬 순서', ...long].join('\n') },
    ],
  };
}

test('화면을 캡처해 읽고, 그리고, 단추가 제대로 돈다', { skip: why || false }, () => {
  const run = /** @type {{cmd: string, pre: string[]}} */ (runner);
  const day = new Date().getDay();
  const today = WEEKDAYS[day];
  const yesterday = WEEKDAYS[(day + 6) % 7];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skre-e2e-'));
  const builds = path.join(dir, 'builds.json');
  fs.writeFileSync(builds, JSON.stringify(catalog(today, yesterday)));
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData);
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      buildsPath: builds,
      lastBuildId: 's-yesterday',
      // 가짜 게임 글자를 넉넉히 담는 자리 (기본 위치는 실제 게임 화면을 재서 잡은 것이다)
      turnRegion: { fx: 0.005, fy: 0.18, fw: 0.1, fh: 0.07 },
      tickMs: 100,
    }),
  );

  const r = spawnSync(run.cmd, [...run.pre, MAIN, '--no-sandbox', `--user-data-dir=${userData}`], {
    encoding: 'utf8',
    timeout: 120000,
  });
  const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });

  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('SKRE_E2E '));
  assert.ok(line, `결과를 안 남겼다 (종료 ${r.status})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  const got = JSON.parse(line.slice('SKRE_E2E '.length));
  const dump = (x) => JSON.stringify(x, null, 1);
  for (const [k, v] of Object.entries(got)) {
    assert.ok(!(v && v.error), `${k} 단계가 죽었다:\n${v && v.error}`);
  }
  assert.deepStrictEqual(got.errors, [], '렌더러 콘솔에 에러가 있다');

  // ── 켜자마자: 어제 요일 빌드를 기억했어도 오늘 것으로, 드롭다운도 채워져 있다
  assert.strictEqual(got.start.buildId, 's-today', `어제 요일 빌드가 그대로 떴다\n${dump(got.start)}`);
  assert.strictEqual(got.start.tab, '공성전');
  assert.ok(got.start.options.includes(`>[${today}] 오늘 보스`), `드롭다운이 비었거나 안 골라졌다\n${dump(got.start)}`);

  // ── 단계 목록: 라운드 제목은 한 번씩, 번호는 단계 줄로만 센다
  const steps = got.steps;
  assert.deepStrictEqual(steps.heads, ['1라운드', '2라운드'], `라운드 제목이 바뀌는 자리에만 있어야 한다\n${dump(steps)}`);
  assert.strictEqual(steps.stepRows, steps.steps, 'stepRows 에 단계 줄이 아닌 것이 섞였다');
  assert.strictEqual(steps.now, 5, `5번 단계가 아닌 줄이 "지금"이다\n${dump(steps)}`);
  assert.strictEqual(steps.next, 6);

  // ── 검색어 때문에 다른 탭에 보이는 빌드가 없으면 보던 빌드를 지킨다
  assert.strictEqual(got.tab.buildId, 'd-reset', `탭을 눌렀더니 보던 빌드가 사라졌다\n${dump(got.tab)}`);
  assert.deepStrictEqual(got.tab.options, ['>(보는 중: 리셋 파괴신)']);

  // ── 설정을 연 채 단계가 넘어가도 설정 패널이 제자리
  assert.ok(got.scroll.before > 0, `설정을 열어도 넘치지 않아 시험이 무의미하다\n${dump(got.scroll)}`);
  assert.strictEqual(got.scroll.after, got.scroll.before, '단계가 넘어가자 설정 패널이 밀려났다');
  assert.ok(got.scroll.record.length > 0, '설정을 열면 담긴 기록을 보여줘야 한다');

  // ── [자동]: 실제로 읽고 옮긴다
  const auto = got.auto;
  assert.strictEqual(auto.first.turn, '0 / 30', `0턴을 못 읽었다\n${dump(auto.first)}`);
  assert.strictEqual(auto.moved.turn, '5 / 30', `5턴을 못 읽었다\n${dump(auto.moved)}`);
  assert.strictEqual(auto.moved.index, 3, '5턴이면 6턴 단계가 "지금"이다');
  // ★ 캡처 크기를 그 화면의 실제 픽셀 크기로 못 박는다 — 빼면 1280×720으로 줄어든다
  const m = auto.asked.video.mandatory;
  assert.ok(auto.source && auto.source.width > 0, `캡처 소스가 없다: ${dump(auto.source)}`);
  assert.deepStrictEqual(
    [m.minWidth, m.maxWidth, m.minHeight, m.maxHeight],
    [auto.source.width, auto.source.width, auto.source.height, auto.source.height],
    '캡처 크기를 못 박지 않았다 (CLAUDE.md "진짜 원인은 캡처였다")',
  );

  // 화면이 멈춰도 안전줄이 계속 읽되, 다음-화면 콜백을 겹쳐 걸지 않는다.
  // 안전줄은 1초 간격이라 3.5초에 두세 번 돌지만, 시험을 여럿 같이 돌리면 한 번일 때도 있다.
  // 한 번이면 충분하다 — 멈춘 동안의 읽기는 전부 안전줄이 한 것이고, 예전 코드는 그 한 번에
  // 콜백을 하나 더 걸었다.
  assert.ok(auto.stalled.read >= 1, `화면이 멈추자 읽기도 멈췄다 (${auto.stalled.read}장)`);
  assert.strictEqual(auto.stalled.pending, 1, `다음-화면 콜백이 ${auto.stalled.pending}개 걸려 있다 — 안전줄이 겹쳐 걸었다`);

  // ── [가르치기]: 연 순간의 화면과 값이 짝으로 얼어 있다
  const teach = got.teach;
  assert.strictEqual(teach.read.turn, '12 / 30');
  assert.strictEqual(teach.opened.value, '12', '연 순간 읽힌 값을 미리 넣어야 한다');
  assert.strictEqual(teach.later.value, '12');
  assert.strictEqual(teach.later.same, true, '가르치는 동안 미리보기가 새 화면으로 바뀌었다 — 그림과 값이 어긋난다');
  assert.match(teach.msg, /ok/, '가르치기가 실패했다');
  assert.strictEqual(teach.after.turn, '13 / 30', `"12" 그림을 배운 뒤 13 을 13 으로 못 읽는다\n${dump(teach.after)}`);

  // ── 인식 주기 슬라이더: 다시 켜지 않아도 먹는다 (2초 동안 몇 장 읽었나)
  const tick = got.tick;
  assert.ok(tick.fast >= 8, `100ms 에서 2초에 ${tick.fast}장밖에 안 읽었다`);
  assert.ok(tick.slow <= 6, `500ms 로 늘렸는데 2초에 ${tick.slow}장을 읽었다 — 슬라이더가 안 먹는다`);
  assert.strictEqual(tick.fps, 2, '캡처 장수가 주기를 안 따라왔다');
  assert.strictEqual(tick.back, 10);

  // ── 켬·끔·켬: 살아 있는 스트림은 화면에 걸린 하나뿐
  assert.strictEqual(got.toggle.auto, true);
  assert.strictEqual(got.toggle.opened, 2, `경합을 못 만들었다 — 시험이 무의미하다\n${dump(got.toggle)}`);
  assert.strictEqual(got.toggle.live, 1, `캡처 스트림이 샜다\n${dump(got.toggle)}`);
  assert.ok(got.toggle.shown >= 0, '살아 있는 스트림이 화면에 안 걸려 있다');

  // ── 순서 없는 빌드: 턴은 보여준다
  assert.strictEqual(got.empty.turn, '7 / 30', `순서 없는 빌드에서 읽힌 턴을 안 보여준다\n${dump(got.empty)}`);
  assert.match(got.empty.status, /7턴/, `"찾는 중"에 머물렀다: ${got.empty.status}`);

  // ── 단축키 경고: 막힌 게 있으면 띠가 떠 있다
  assert.strictEqual(got.keys.shown, got.keys.failed.length > 0);

  // ── [기본 위치]: 좌표가 아니라 이름으로
  assert.deepStrictEqual(got.preset, { preset: 'destroyer' });
  assert.deepStrictEqual(config.turnRegion, { preset: 'destroyer' });
});
