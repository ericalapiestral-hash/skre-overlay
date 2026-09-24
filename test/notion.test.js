// 노션에서 긁어오는 쪽 — 주소를 가리는 규칙과 페이지 나무를 도는 길(fetchTree).
//
// 실제로 페이지를 여는 건 Electron 창이 필요해서 test/notionScrape.test.js 가 따로 본다.
// 여기서는 **어디를 열지 말지**와 **여러 장을 돌다 한 장이 실패했을 때**를 잠근다.
// fetchTree 는 창을 밖에서 받을 수 있어서(options.browser) 가짜 창으로 Node 에서 돈다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const notion = require('../src/main/notion');

const { isNotionUrl, normalizeUrl, resolveLink, fetchTree } = notion;

test('노션 공개 페이지 주소만 연다', () => {
  assert.strictEqual(isNotionUrl('https://someguild.notion.site/PVE-0123456789abcdef0123456789abcdef'), true);
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
  const bare = 'someguild.notion.site/PVE-0123456789abcdef0123456789abcdef';
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

/**
 * 가짜 창 — 주소마다 {title, markdown, links} 를 정해 두고, scrapePage 가 넣는 스크립트가
 * 무엇인지 보고 알맞은 값을 돌려준다. `fail` 에 든 주소는 loadURL 에서 던진다
 * (네트워크 끊김 · 중간에 끊긴 이동).
 */
function fakeBrowser(site, fail = new Set()) {
  let current = '';
  const opened = [];
  return {
    opened,
    isDestroyed: () => false,
    destroy() {},
    async loadURL(url) {
      opened.push(url);
      if (fail.has(url)) throw new Error('ERR_CONNECTION_RESET');
      current = url;
    },
    webContents: {
      async executeJavaScript(code) {
        const page = site[current.split('?')[0]] || { title: '', markdown: '', links: [] };
        if (code === notion.READY) return true;
        if (code === notion.PREPARE) return { opened: 0, height: 0, blocks: 0 };
        if (code === notion.TITLE) return page.title;
        if (code === notion.LINKS) return page.links.map((href) => ({ href, title: page.linkTitles?.[href] || '' }));
        if (code === notion.EXTRACT_NOTION) return page.markdown;
        return '';
      },
    },
  };
}

const ROOT = 'https://g.notion.site/PVE-00000000000000000000000000000000';
const A = 'https://g.notion.site/A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'https://g.notion.site/B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'https://g.notion.site/C-cccccccccccccccccccccccccccccccc';
const SITE = {
  [ROOT]: { title: 'PVE', markdown: '# PVE', links: ['/A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    linkTitles: { '/B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': '파괴신 B' } },
  [A]: { title: '파괴신 A', markdown: '## 스킬 순서\n`0턴` 세인', links: [] },
  [B]: { title: '파괴신 B', markdown: '## 스킬 순서\n`0턴` 리나', links: ['/C-cccccccccccccccccccccccccccccccc'] },
  [C]: { title: '파괴신 C', markdown: '## 스킬 순서\n`4턴` 루디', links: [] },
};

test('한 장이 실패해도 나머지는 살고, 못 연 장은 나무에 남는다', async () => {
  // ★ 예전엔 visit() 에 try 가 없어서 한 장의 예외가 재귀를 뚫고 올라가 **전부 0개**가
  // 됐다 (9d4467b). 그 뒤로도 못 연 장은 null 이라 제목조차 안 남았고, 받기는 성공으로
  // 끝나 그 아래 빌드들이 조용히 사라졌다.
  const win = fakeBrowser(SITE, new Set([B]));
  const got = await fetchTree(ROOT, { browser: win });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.failed.length, 1);
  assert.strictEqual(got.failed[0].url, B);
  assert.strictEqual(got.failed[0].title, '파괴신 B', '링크 글자로 제목을 남긴다');
  const kids = got.page.children;
  assert.deepStrictEqual(kids.map((k) => k.title), ['파괴신 A', '파괴신 B']);
  assert.strictEqual(kids[1].failed, true, '못 연 장은 failed 마디로 남는다');
  assert.strictEqual(kids[0].how, 'notion', '마디마다 긁은 방법을 남긴다');
});

test('같은 페이지는 한 번만 열고, 한도를 넘으면 멈춘다', async () => {
  const loop = {
    ...SITE,
    // C 가 B 로 되돌아가고, 물음표 붙은 주소로 A 를 다시 가리킨다
    [C]: { title: '파괴신 C', markdown: '`4턴` 루디', links: ['/B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '/A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?pvs=4'] },
  };
  const win = fakeBrowser(loop);
  const got = await fetchTree(ROOT, { browser: win });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(win.opened.length, 4, `열어 본 주소: ${win.opened.join(', ')}`);

  const limited = fakeBrowser(SITE);
  const cut = await fetchTree(ROOT, { browser: limited, maxPages: 2 });
  assert.strictEqual(limited.opened.length, 2, 'maxPages 를 넘겨 열었다');
  assert.strictEqual(cut.pages, 2);

  const shallow = fakeBrowser(SITE);
  await fetchTree(ROOT, { browser: shallow, maxDepth: 1 });
  assert.ok(!shallow.opened.includes(C), 'maxDepth 를 넘어 파고들었다');
});

test('맨 위 페이지를 못 열면 실패로 돌려준다', async () => {
  const got = await fetchTree(ROOT, { browser: fakeBrowser(SITE, new Set([ROOT])) });
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.page, null);
  assert.match(got.error, /ERR_CONNECTION_RESET/);
});
