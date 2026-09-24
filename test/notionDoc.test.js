// 노션 페이지 나무 → 도감. 어디서 긁어오든 이 층은 그대로다.
//
// ⚠ 여기 규칙들은 **실제 도감 페이지를 보고 정한 것이 아니다.** 이 컨테이너에서는
// notion.site 접속이 막혀 있어서, 내보낸 Markdown을 받으면 그걸로 다시 잠글 것.
// 그때까지는 "길드봇이 만들던 builds.json 과 같은 모양이 나오는가"만 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toCatalog, pickBody, weekdaysOf, looksLikeBuild, buildId, pageIdOf } = require('../src/shared/notionDoc');
const { parseBuild } = require('../src/shared/steps');

/** 실제 도감에 있던 본문 그대로 */
const BODY = [
  '# 세팅',
  '- 세인 속공 33 이상',
  '',
  '## 스킬 순서',
  '### 1라운드',
  '`0턴`비스킷 아래 / `4턴`나타 아래',
  '### 2라운드 (4턴)',
  '`4턴`세인 위 / `8턴`클로에 위',
].join('\n');

/** PVE(맨 위) › 강림 - 파괴신 › 파이 › 파이 세인 4턴 */
const TREE = {
  title: 'PVE',
  url: 'https://x.notion.site/PVE-0123456789abcdef0123456789abcdef',
  markdown: '',
  children: [
    {
      title: '강림 - 파괴신',
      markdown: '',
      children: [
        {
          title: '파이',
          markdown: '',
          children: [
            { title: '파이 세인 4턴', url: 'https://x.notion.site/aaaaaaaabbbbccccddddeeeeffff0000', markdown: BODY },
            { title: '파이 노세인', markdown: BODY },
          ],
        },
      ],
    },
    {
      title: '공성전',
      markdown: '',
      children: [{ title: '월요일 보스', markdown: BODY }],
    },
  ],
};

test('잎 페이지가 빌드가 되고, 묶음은 위쪽 제목을 이어 붙인다', () => {
  const c = toCatalog(TREE, { syncedAt: '2026-09-05T00:00:00Z' });
  assert.strictEqual(c.title, 'PVE');
  assert.strictEqual(c.syncedAt, '2026-09-05T00:00:00Z');
  assert.deepStrictEqual(c.builds.map((b) => b.name), ['파이 세인 4턴', '파이 노세인', '월요일 보스']);
  // 맨 위 페이지(PVE)는 묶음 이름에 안 들어간다 — 길드봇이 만들던 모양과 같게
  assert.strictEqual(c.builds[0].group, '강림 - 파괴신 › 파이');
  assert.strictEqual(c.builds[2].group, '공성전');
});

test('콘텐츠 이름은 묶음 어디에 있어도 잡는다', () => {
  const c = toCatalog(TREE);
  assert.strictEqual(c.builds[0].category, '파괴신');
  assert.strictEqual(c.builds[2].category, '공성전');
});

test('id는 안 흔들린다 — 노션 페이지 id가 있으면 그걸 쓴다', () => {
  // 마지막으로 보던 빌드를 기억하고, 단계·본문을 id로 물어보기 때문이다.
  // 이름을 고쳐도 노션 페이지가 그대로면 id가 유지돼야 한다.
  const c = toCatalog(TREE);
  assert.strictEqual(c.builds[0].id, 'aaaaaaaabbbbccccddddeeeeffff0000');
  const renamed = JSON.parse(JSON.stringify(TREE));
  renamed.children[0].children[0].children[0].title = '파이 세인 4턴 (수정)';
  assert.strictEqual(toCatalog(renamed).builds[0].id, c.builds[0].id, '이름을 고쳤다고 id가 바뀌면 안 된다');
  // 주소가 없으면 묶음+이름으로 — 그것도 두 번 부르면 같아야 한다
  assert.strictEqual(c.builds[1].id, toCatalog(TREE).builds[1].id);
  assert.notStrictEqual(c.builds[1].id, c.builds[2].id);
});

test('같은 페이지가 두 자리에 걸려 있어도 한 번만 싣는다', () => {
  const dup = {
    title: 'PVE',
    children: [
      { title: 'A', children: [{ title: '빌드', url: 'https://x/11111111111111111111111111111111', markdown: BODY }] },
      { title: 'B', children: [{ title: '빌드', url: 'https://x/11111111111111111111111111111111', markdown: BODY }] },
    ],
  };
  assert.strictEqual(toCatalog(dup).builds.length, 1);
});

test('빈 페이지는 빌드가 아니다', () => {
  assert.strictEqual(looksLikeBuild({ title: 'x', markdown: '' }), false);
  assert.strictEqual(looksLikeBuild({ title: 'x', markdown: '   \n## \n' }), false);
  assert.strictEqual(looksLikeBuild({ title: 'x', markdown: '메모' }), true);
});

test('하위가 있어도 턴이 적혀 있으면 빌드로 같이 싣는다', () => {
  // ★ 못 읽었다고 목록에서 빼면 "빌드가 안 보인다"가 된다 (CLAUDE.md).
  // 묶음 페이지에 순서를 적어 두는 경우가 있다.
  const tree = {
    title: 'PVE',
    children: [
      {
        title: '파괴신 공용',
        markdown: '## 스킬 순서\n### 1라운드\n`0턴`나타 아래',
        children: [{ title: '변형 A', markdown: BODY }],
      },
    ],
  };
  const names = toCatalog(tree).builds.map((b) => b.name);
  assert.deepStrictEqual(names, ['파괴신 공용', '변형 A']);
  // 하위 페이지의 묶음에는 그 묶음 페이지 이름이 들어간다
  assert.strictEqual(toCatalog(tree).builds[1].group, '파괴신 공용');
});

test('묶음 페이지에 턴이 없으면 빌드로 안 싣는다', () => {
  const tree = {
    title: 'PVE',
    children: [{ title: '설명만 있는 묶음', markdown: '여기는 안내입니다', children: [{ title: '빌드', markdown: BODY }] }],
  };
  assert.deepStrictEqual(toCatalog(tree).builds.map((b) => b.name), ['빌드']);
});

test('요일을 집어낸다', () => {
  // ⚠ 실제 도감에서 요일을 어떻게 적는지 확인하고 고칠 것
  assert.deepStrictEqual(weekdaysOf(['월요일 보스']), ['월']);
  assert.deepStrictEqual(weekdaysOf(['공성전', '수 · 토']), ['수', '토']);
  assert.deepStrictEqual(weekdaysOf(['파이 세인 4턴']), [], '엉뚱한 데서 요일을 만들면 안 된다');
  assert.deepStrictEqual(weekdaysOf(['1일차 공략']), [], '"1일차"의 일은 요일이 아니다');
});

test('주소에서 페이지 id를 뽑는다', () => {
  assert.strictEqual(
    pageIdOf('https://someguild.notion.site/PVE-0123456789abcdef0123456789abcdef'),
    '0123456789abcdef0123456789abcdef',
  );
  assert.strictEqual(pageIdOf('https://x.notion.site/그냥-페이지'), '');
  assert.strictEqual(pageIdOf(undefined), '');
  assert.strictEqual(buildId({ title: 'A' }, ['B']), 'b/a');
});

test('나온 본문을 기존 파서가 그대로 읽는다', () => {
  // ★ 이게 이 층의 존재 이유다 — 도감을 어디서 가져오든 그 뒤는 똑같이 흘러야 한다.
  const c = toCatalog(TREE);
  const parsed = parseBuild(c.builds[0].body);
  assert.ok(parsed.stepCount > 0, `단계를 못 읽었다: ${JSON.stringify(parsed)}`);
  assert.deepStrictEqual(parsed.groups[0].variants[0].steps.map((s) => s.turn), [0, 4]);
});

test('빈 나무에도 안전하다', () => {
  assert.deepStrictEqual(toCatalog(/** @type {any} */ (null)).builds, []);
  assert.deepStrictEqual(toCatalog({ title: '빈 페이지', markdown: '' }).builds, []);
  // 맨 위 페이지 하나뿐이고 거기에 순서가 있으면 그것도 빌드다
  const only = toCatalog({ title: '내 빌드', markdown: BODY });
  assert.deepStrictEqual(only.builds.map((b) => b.name), ['내 빌드']);
  assert.strictEqual(only.builds[0].group, '');
});


// ─────────────────────────────── 어느 방법으로 긁은 것을 쓸지

/** 같은 내용을 방법별로 긁었을 때 나올 법한 모양들 */
const 마크다운 = [
  '# 세팅',
  '- 세인 속공 33 이상',
  '',
  '## 스킬 순서',
  '### 1라운드',
  '`0턴`비스킷 아래 / `4턴`나타 아래',
  '### 2라운드 (8턴)',
  '`8턴`세인 위 / `12턴`클로에 위',
].join('\n');

/** innerText 로 긁으면 마크다운 기호가 통째로 사라진다 */
const 맨글씨 = 마크다운
  .replace(/[#`]/g, '')
  .replace(/^- /gm, '')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .join('\n');

test('제목 구조가 살아 있는 쪽을 고른다 — 단계 수가 같아도', () => {
  // ★ 이게 이 기능의 핵심이다. 노션 화면을 개발하는 곳에서 볼 수 없으니 "내 선택자가
  // 맞다"에 기대면 안 된다. 여러 방법으로 긁어 **파서에 실제로 넣어 보고** 고른다.
  //
  // 둘 다 4단계를 읽어내지만, 맨글씨는 **라운드 구분을 잃는다** (재 봤다: 마크다운은
  // 2라운드로 갈리는데 맨글씨는 한 덩어리). 그러면 라운드별 변형을 못 고른다.
  const got = pickBody([
    { how: 'plain', markdown: 맨글씨 },
    { how: 'notion', markdown: 마크다운 },
  ]);
  assert.strictEqual(got.how, 'notion');
  assert.strictEqual(got.strategy, 'section');
  assert.strictEqual(got.groups, 2);
  assert.strictEqual(got.stepCount, 4);

  // 순서를 바꿔 넣어도 같은 것을 골라야 한다 (먼저 온 것이 이기면 안 된다)
  assert.strictEqual(pickBody([{ how: 'notion', markdown: 마크다운 }, { how: 'plain', markdown: 맨글씨 }]).how, 'notion');
});

test('단계를 하나도 못 읽는 방법은 지운다', () => {
  const got = pickBody([
    { how: 'notion', markdown: '' },
    { how: 'semantic', markdown: '메뉴\n검색\n공유' }, // 껍데기만 긁힌 경우
    { how: 'plain', markdown: 맨글씨 },
  ]);
  assert.strictEqual(got.how, 'plain');
  assert.ok(got.stepCount > 0);
});

test('아무도 못 읽으면 제일 많이 건진 것을 준다', () => {
  // 순서를 못 읽었다고 빌드를 숨기지 않는다 — 본문은 그대로 보여줘야 한다 (CLAUDE.md)
  const got = pickBody([
    { how: 'notion', markdown: '' },
    { how: 'semantic', markdown: '짧은 메모' },
    { how: 'plain', markdown: '이 빌드는 아직 정리 중입니다. 나중에 채웁니다.' },
  ]);
  assert.strictEqual(got.how, 'plain');
  assert.strictEqual(got.stepCount, 0);
  assert.ok(got.markdown.length > 0, '본문이 비면 화면에 보여줄 것이 없다');
});

test('겹쳐 긁혀 단계가 부풀어도 제목 구조가 있는 쪽이 이긴다', () => {
  // 태그로 긁는 방법은 같은 글이 조상·자손에서 겹쳐 나올 수 있다. 그러면 단계가
  // 두 배로 세어져 "많이 읽은 쪽"이 이겨 버린다 — 그래서 단계 수보다 구조를 먼저 본다.
  const 겹침 = [맨글씨, 맨글씨].join('\n');
  const got = pickBody([
    { how: 'semantic', markdown: 겹침 },
    { how: 'notion', markdown: 마크다운 },
  ]);
  assert.strictEqual(got.how, 'notion', `부풀린 쪽이 이겼다: ${JSON.stringify(got)}`);
});

test('같은 것을 읽어냈으면 짧은 쪽 — 군더더기가 적다', () => {
  const 군더더기 = `${마크다운}\n\n메뉴\n검색\n공유\n복제\n댓글\n업데이트`;
  const got = pickBody([
    { how: 'semantic', markdown: 군더더기 },
    { how: 'notion', markdown: 마크다운 },
  ]);
  assert.strictEqual(got.how, 'notion');
});

test('빈 입력에도 안전하다', () => {
  assert.strictEqual(pickBody([]).markdown, '');
  assert.strictEqual(pickBody([]).how, 'none');
  assert.strictEqual(pickBody(/** @type {any} */ (null)).how, 'none');
  assert.strictEqual(pickBody(/** @type {any} */ ([null, undefined, { how: 'x' }])).how, 'none');
});

test('못 연 페이지 자리는 지난번 도감에서 되살리고, 없으면 ⚠ 로 남긴다', () => {
  // ★ 예전엔 못 연 페이지가 나무에서 통째로 빠지고 받기는 "성공"으로 끝나서, 잘 받아 둔
  // 도감이 **조용히 줄어든** 도감으로 덮어써졌다 — "빌드가 안 보인다"가 되살아난다.
  const leafId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const previous = {
    builds: [
      { id: leafId, name: '파이 세인', label: '파이 세인', group: '파괴신', body: '`0턴` 세인', url: `https://g.notion.site/x-${leafId}` },
      { id: 'b1', name: '밑 빌드 1', label: '밑 빌드 1', group: '공성전 › 월요일', body: '`0턴` 가', url: null },
      { id: 'b2', name: '밑 빌드 2', label: '밑 빌드 2', group: '공성전 › 월요일 › 더 밑', body: '`0턴` 나', url: null },
      { id: 'b3', name: '딴 데', label: '딴 데', group: '공성전 › 화요일', body: '`0턴` 다', url: null },
    ],
  };
  const root = {
    title: 'PVE',
    children: [
      {
        title: '파괴신',
        markdown: '# 파괴신',
        children: [
          { title: '파이 세인', url: `https://g.notion.site/x-${leafId}`, markdown: '', failed: true, children: [] },
          { title: '새 빌드', markdown: '`0턴` 새것', how: 'semantic', children: [] },
        ],
      },
      {
        title: '공성전',
        markdown: '# 공성전',
        children: [
          { title: '월요일', markdown: '', failed: true, error: 'ERR_CONNECTION_RESET', children: [] },
          { title: '처음 보는 곳', markdown: '', failed: true, children: [] },
        ],
      },
    ],
  };
  const cat = toCatalog(root, { previous });
  const byName = Object.fromEntries(cat.builds.map((b) => [b.name, b]));
  // 같은 페이지 id 면 그 빌드를 그대로 되살린다
  assert.strictEqual(byName['파이 세인'].stale, true);
  assert.strictEqual(byName['파이 세인'].body, '`0턴` 세인');
  // 묶음 페이지를 못 열었으면 그 아래에 있던 빌드들을 되살린다 (옆 묶음은 안 건드린다)
  assert.ok(byName['밑 빌드 1'] && byName['밑 빌드 1'].stale);
  assert.ok(byName['밑 빌드 2'] && byName['밑 빌드 2'].stale);
  assert.ok(!byName['딴 데'], '못 연 페이지와 상관없는 옛 빌드까지 되살렸다');
  // 지난번에도 없던 자리는 ⚠ 로 — 숨기지 않는다
  const warn = byName['⚠ 처음 보는 곳'];
  assert.ok(warn && warn.failed, `⚠ 빌드가 없다: ${cat.builds.map((b) => b.name).join(', ')}`);
  assert.match(warn.body, /못 열었어요/);
  assert.strictEqual(cat.restored, 3);
  assert.strictEqual(cat.missing, 1);
  // 새로 받은 빌드는 긁은 방법을 달고 간다 (화면이 빌드 기준으로 센다)
  assert.strictEqual(byName['새 빌드'].how, 'semantic');

  // 지난번 도감이 없으면 전부 ⚠
  const fresh = toCatalog(root);
  assert.strictEqual(fresh.restored, 0);
  assert.strictEqual(fresh.missing, 3);
});
