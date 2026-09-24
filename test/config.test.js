// 설정 저장 — 망가진 파일을 만났을 때와, 쓰다가 죽었을 때.
//
// 설정에는 사람이 공들인 것(가르친 숫자·노션 주소·턴 영역)이 들어 있다. 파일이 한 번
// 망가지면 곧이은 저장(창을 옮기기만 해도 일어난다)이 그걸 기본값으로 덮어써 버렸다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, DEFAULTS } = require('../src/main/config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skre-config-'));
}

const asides = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('config.json.broken-'));

test('없으면 기본값이고, 아무것도 비켜 두지 않는다', () => {
  const dir = tempDir();
  const store = createStore(dir);
  assert.deepStrictEqual(store.load(), DEFAULTS);
  assert.deepStrictEqual(asides(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('망가진 설정은 옆에 비켜 두고, 다음 저장이 그걸 덮지 않는다', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  // 반쯤 쓰인 파일 — 노션 주소와 가르친 숫자가 들어 있던 자리
  const broken = '{"notionUrl":"https://x.notion.site/a","userTemplates":[{"d":1,';
  fs.writeFileSync(file, broken);

  const store = createStore(dir);
  assert.deepStrictEqual(store.load(), DEFAULTS, '망가졌으면 기본값으로 시작한다');
  // 창을 옮기기만 해도 이런 저장이 일어난다
  store.save({ winBounds: { x: 1, y: 2, width: 400, height: 470 } });

  const kept = asides(dir);
  assert.strictEqual(kept.length, 1, '망가진 원본이 안 남았다');
  assert.strictEqual(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), broken, '원본이 그대로가 아니다');
  assert.deepStrictEqual(store.load().winBounds, { x: 1, y: 2, width: 400, height: 470 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JSON 이지만 설정 모양이 아니어도 비켜 둔다', () => {
  for (const text of ['[1,2]', 'null', '"문자열"', '']) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'config.json'), text);
    const store = createStore(dir);
    assert.deepStrictEqual(store.load(), DEFAULTS, `${JSON.stringify(text)}`);
    assert.strictEqual(asides(dir).length, 1, `${JSON.stringify(text)} 를 안 비켜 뒀다`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('저장은 바뀐 값만 얹고, 임시 파일을 남기지 않는다', () => {
  const dir = tempDir();
  const store = createStore(dir);
  store.save({ notionUrl: 'https://x.notion.site/a' });
  store.save({ tickMs: 200 });
  const got = store.load();
  assert.strictEqual(got.notionUrl, 'https://x.notion.site/a');
  assert.strictEqual(got.tickMs, 200);
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
