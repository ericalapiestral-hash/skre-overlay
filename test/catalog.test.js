// 도감 읽기 — 길드봇이 만들어 두는 builds.json을 어떻게 찾고 읽는지.
//
// 제일 중요한 약속: **스킬 순서를 못 읽었다고 빌드를 숨기지 않는다.**
// 옛 오버레이는 숨겼고, 그래서 도감에 있는 빌드가 오버레이엔 없었다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidatePaths, resolvePath, categoryOf, loadCatalog, watchCatalog } = require('../src/main/catalog');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skre-'));
}

function writeCatalog(dir, payload) {
  const file = path.join(dir, 'builds.json');
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

const BUILD = {
  id: '#a1',
  name: '월요일 - 루디 / 쥬리, 나타 딜러',
  label: '루디',
  group: '공성전 › 월',
  category: '공성전',
  weekdays: ['월'],
  body: '## 스킬 순서\n### 1라운드\n`0턴`나타 아래 / `4턴`쥬리 위\n',
};

// ─────────────────────────────── 경로 찾기

test('바탕화면의 길드봇 폴더를 먼저 본다', () => {
  const paths = candidatePaths({ isPackaged: false, appDir: '/app', home: '/home/erica' });
  const desktop = paths.find((p) => p.includes('길드봇'));
  assert.ok(desktop, '바탕화면 길드봇 경로가 후보에 있어야 한다');
  assert.ok(desktop.endsWith(path.join('data', 'builds.json')));
});

test('포터블 exe 옆을 exe 폴더보다 먼저 본다', () => {
  const paths = candidatePaths({
    isPackaged: true,
    appDir: '/app',
    exeDir: '/tmp/unpacked',
    portableDir: 'D:/게임/오버레이',
  });
  assert.ok(paths[0].startsWith('D:/게임/오버레이'), '포터블 자리가 먼저다');
});

test('직접 고른 경로가 있으면 그것만 쓴다', () => {
  const dir = tmpdir();
  const file = writeCatalog(dir, { builds: [BUILD] });
  const r = resolvePath(file, { isPackaged: false, appDir: dir });
  assert.strictEqual(r.file, file);
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.tried, [file]);
});

test('아무 데도 없으면 찾아본 자리를 알려준다', () => {
  const r = resolvePath('', { isPackaged: false, appDir: '/nope', home: '/nope' });
  assert.strictEqual(r.found, false);
  assert.ok(r.tried.length > 1, '어디를 찾아봤는지 알려줘야 한다');
});

// ─────────────────────────────── 읽기

test('빌드를 읽고 스킬 순서를 함께 뽑는다', () => {
  const file = writeCatalog(tmpdir(), { syncedAt: '2026-09-01T00:00:00Z', builds: [BUILD] });
  const r = loadCatalog(file);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.builds.length, 1);
  assert.strictEqual(r.builds[0].stepCount, 2);
  assert.strictEqual(r.builds[0].category, '공성전');
  assert.strictEqual(r.syncedAt, '2026-09-01T00:00:00Z');
});

test('스킬 순서를 못 읽은 빌드도 목록에 남긴다', () => {
  const file = writeCatalog(tmpdir(), {
    builds: [BUILD, { ...BUILD, id: '#b2', name: '세팅만 적힌 빌드', body: '- 나타 속공 33' }],
  });
  const r = loadCatalog(file);
  assert.strictEqual(r.builds.length, 2, '숨기면 "도감엔 있는데 오버레이엔 없다"가 된다');
  assert.deepStrictEqual(r.stats.noSteps, ['세팅만 적힌 빌드']);
  assert.strictEqual(r.stats.withSteps, 1);
  assert.strictEqual(r.builds[1].strategy, 'none');
  assert.ok(r.builds[1].body, '본문은 그대로 보여줄 수 있게 들고 있어야 한다');
});

test('구분이 비어 있으면 구사황·기타로 나눈다', () => {
  assert.strictEqual(categoryOf({ category: '파괴신' }), '파괴신');
  assert.strictEqual(categoryOf({ category: null, group: '강림 - 구사황 › 태오' }), '구사황');
  assert.strictEqual(categoryOf({ category: null, group: '잡다' }), '기타');
});

test('파일이 없으면 무엇을 해야 하는지 알려준다', () => {
  const r = loadCatalog(path.join(tmpdir(), 'none.json'));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /길드봇|직접 골라/);
});

test('깨진 파일이나 엉뚱한 형식에도 죽지 않는다', () => {
  const dir = tmpdir();
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ 이건 JSON이 아니', 'utf8');
  assert.strictEqual(loadCatalog(broken).ok, false);

  const wrong = writeCatalog(dir, { builds: '배열이 아님' });
  assert.strictEqual(loadCatalog(wrong).ok, false);
  assert.strictEqual(loadCatalog('').ok, false);
});

test('망가진 항목이 섞여 있어도 나머지는 살린다', () => {
  const file = writeCatalog(tmpdir(), { builds: [null, { name: 123 }, BUILD] });
  const r = loadCatalog(file);
  assert.strictEqual(r.builds.length, 1);
});

// ─────────────────────────────── 감시

test('도감이 바뀌면 한 번만 알려준다', async () => {
  const dir = tmpdir();
  const file = writeCatalog(dir, { builds: [BUILD] });
  let calls = 0;
  const watcher = watchCatalog(file, () => { calls += 1; }, { delay: 30 });

  // 봇은 tmp에 쓰고 rename으로 갈아끼운다 — 이벤트가 두 번 온다
  fs.writeFileSync(file + '.tmp', JSON.stringify({ builds: [BUILD] }), 'utf8');
  fs.renameSync(file + '.tmp', file);
  await new Promise((r) => setTimeout(r, 200));
  watcher.close();
  assert.ok(calls <= 1, `한 번으로 모여야 한다 (${calls}번 불림)`);
});

test('감시할 폴더가 없어도 죽지 않는다', () => {
  const watcher = watchCatalog('/없는폴더/builds.json', () => {});
  assert.doesNotThrow(() => watcher.close());
});
