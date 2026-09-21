// 노션에서 긁어오는 쪽 — 주소를 가리는 부분만.
//
// 실제로 페이지를 여는 건 Electron 창이 필요해서 여기서 못 돌린다. 대신 **어디를
// 열지 말지**를 정하는 규칙은 순수 함수라 여기서 잠근다. 페이지를 도는 코드가
// 링크를 따라가므로, 여기가 헐거우면 도감을 긁다가 엉뚱한 사이트로 새 나간다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isNotionUrl, normalizeUrl, resolveLink } = require('../src/main/notion');

test('노션 공개 페이지 주소만 연다', () => {
  assert.strictEqual(isNotionUrl('https://damageamplification.notion.site/PVE-3ce783623a1c8014bd01c2b2ce3562f0'), true);
  assert.strictEqual(isNotionUrl('https://www.notion.so/abc'), true);
  // http는 안 된다 — 중간에서 내용을 갈아끼울 수 있다
  assert.strictEqual(isNotionUrl('http://x.notion.site/a'), false);
  assert.strictEqual(isNotionUrl('https://evil.com/x'), false);
  // ★ 이름에 notion.site가 들어간 남의 도메인에 속지 않는다
  assert.strictEqual(isNotionUrl('https://notion.site.evil.com/x'), false);
  assert.strictEqual(isNotionUrl('https://xnotion.site/x'), false);
  assert.strictEqual(isNotionUrl(''), false);
  assert.strictEqual(isNotionUrl(/** @type {any} */ (null)), false);
  assert.strictEqual(isNotionUrl('file:///etc/passwd'), false);
});

test('하위 페이지는 같은 노션 원점 안에서만 따라간다', () => {
  const base = 'https://x.notion.site/PVE-1';
  assert.strictEqual(resolveLink('/abc123', base), 'https://x.notion.site/abc123');
  // 다른 워크스페이스로 넘어가지 않는다 — 남의 도감을 통째로 긁을 이유가 없다
  assert.strictEqual(resolveLink('https://y.notion.site/z', base), '');
  assert.strictEqual(resolveLink('https://evil.com/z', base), '');
  assert.strictEqual(resolveLink('javascript:alert(1)', base), '');
  // ★ 빈 href와 #조각은 **자기 자신**으로 풀린다 — 그대로 두면 같은 페이지를
  // 하위 페이지로 알고 다시 열러 간다
  assert.strictEqual(resolveLink('', base), '');
  assert.strictEqual(resolveLink('   ', base), '');
  assert.strictEqual(resolveLink('#어디', base), '');
  assert.strictEqual(resolveLink('/abc#조각', base), 'https://x.notion.site/abc');
});

test('https 를 빼고 붙여넣어도 알아듣는다', () => {
  // ★ 주소창에서 긁어 오면 스킴이 빠지는 일이 흔하다. 그걸 거절하면 사람 입장에선
  // **분명히 넣었는데 "주소를 넣어주세요"** 가 뜨는 셈이다.
  const bare = 'damageamplification.notion.site/PVE-3ce783623a1c8014bd01c2b2ce3562f0';
  assert.strictEqual(normalizeUrl(bare), `https://${bare}`);
  assert.strictEqual(isNotionUrl(bare), true);
  // 앞뒤 공백·따옴표·꺾쇠(메신저가 붙이는 것)도 뗀다
  assert.strictEqual(isNotionUrl(`  <https://${bare}>  `), true);
  assert.strictEqual(normalizeUrl(`"https://${bare}"`), `https://${bare}`);
  // 그래도 남의 사이트는 여전히 안 된다
  assert.strictEqual(isNotionUrl('evil.com/x'), false);
  assert.strictEqual(isNotionUrl('http://x.notion.site/a'), false, 'http 는 그대로 거절');
  assert.strictEqual(normalizeUrl(''), '');
  assert.strictEqual(normalizeUrl(null), '');
});
