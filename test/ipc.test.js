// 프리로드와 메인이 **같은 채널 이름**을 쓰는가 — 글자만 맞춰 보는 검사.
//
// 채널 이름은 양쪽에 문자열로 따로 적혀 있다. 한쪽만 한 글자 바뀌어도 순수 로직 테스트는
// 전부 초록이고, 화면에서 그 단추만 조용히 죽는다 ("No handler registered"). 스모크 시험이
// 실제로 왕복시켜 보는 건 몇 개뿐이라(capture:source 를 고쳐도 초록이었다) 나머지를 여기서
// 전부 맞대 본다. Electron 없이 도니 어디서나 돈다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const PRELOAD = read('src/preload/overlay.js') + read('src/preload/picker.js');
const MAIN = read('src/main/index.js');

/** 정규식의 첫 무리를 전부 모은다 */
const all = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));
const sorted = (set) => [...set].sort();

// 화면 → 메인
const invoked = all(PRELOAD, /ipcRenderer\.invoke\('([^']+)'/g);
const sent = all(PRELOAD, /ipcRenderer\.send\('([^']+)'/g);
// 메인 → 화면 (프리로드의 on() 도우미와 picker 의 ipcRenderer.on)
const listened = all(PRELOAD, /\bon\('([^']+)'/g);

const handled = all(MAIN, /ipcMain\.handle\('([^']+)'/g);
const received = all(MAIN, /ipcMain\.on\('([^']+)'/g);
// webContents.send('…') 와 syncNotion 안의 send('catalog:…') 도우미
const pushed = all(MAIN, /\bsend\('([^']+)'/g);

test('화면이 부르는 채널마다 메인에 받는 쪽이 있다', () => {
  assert.ok(invoked.size >= 10, `invoke 를 거의 못 찾았다 — 정규식이 낡았다 (${invoked.size}개)`);
  assert.deepStrictEqual(sorted(invoked).filter((c) => !handled.has(c)), [], 'invoke 인데 ipcMain.handle 이 없다');
  assert.deepStrictEqual(sorted(sent).filter((c) => !received.has(c)), [], 'send 인데 ipcMain.on 이 없다');
});

test('메인이 받는 채널마다 화면에 부르는 쪽이 있다 (죽은 통로 없음)', () => {
  // 부르는 곳이 없는 통로는 "있는 줄 알고" 규칙을 거기에만 적어 두게 만든다 —
  // 실제로 클릭 통과의 '해제 단축키 확인' 규칙이 아무도 안 부르는 통로 안에만 있었다
  assert.deepStrictEqual(sorted(handled).filter((c) => !invoked.has(c)), [], 'handle 인데 부르는 곳이 없다');
  assert.deepStrictEqual(sorted(received).filter((c) => !sent.has(c)), [], 'ipcMain.on 인데 보내는 곳이 없다');
});

test('메인이 보내는 알림마다 화면에 듣는 쪽이 있다', () => {
  assert.ok(pushed.size >= 5, `send 를 거의 못 찾았다 — 정규식이 낡았다 (${pushed.size}개)`);
  assert.deepStrictEqual(sorted(pushed).filter((c) => !listened.has(c)), [], '보내는데 듣는 곳이 없다');
  assert.deepStrictEqual(sorted(listened).filter((c) => !pushed.has(c)), [], '듣는데 보내는 곳이 없다');
});

test('프리로드가 내준 것마다 화면이 실제로 쓴다', () => {
  // 프리로드는 `  묶음: {` 아래 `    이름: …` 모양으로 적혀 있다 (그 모양이 바뀌면 여기가 먼저 빨개진다)
  const exposed = [];
  let group = '';
  for (const line of read('src/preload/overlay.js').split('\n')) {
    const g = line.match(/^ {2}(\w+): \{/);
    if (g) group = g[1];
    const f = line.match(/^ {4}(\w+): /);
    if (group && f) exposed.push(`${group}.${f[1]}`);
    if (/^ {2}\},?$/.test(line)) group = '';
  }
  assert.ok(exposed.length >= 20, `내준 것을 거의 못 찾았다 — 모양이 바뀌었다 (${exposed.length}개)`);
  const renderer = read('src/renderer/overlay.js');
  const unused = exposed.filter((name) => !renderer.includes(`api.${name}`));
  assert.deepStrictEqual(unused, [], '화면이 안 쓰는 통로 — 지우거나 쓰거나');
});
