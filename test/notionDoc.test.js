// 노션 페이지 나무 → 도감. 어디서 긁어오든 이 층은 그대로다.
//
// ⚠ 여기 규칙들은 **실제 도감 페이지를 보고 정한 것이 아니다.** 이 컨테이너에서는
// notion.site 접속이 막혀 있어서, 내보낸 Markdown을 받으면 그걸로 다시 잠글 것.
// 그때까지는 "길드봇이 만들던 builds.json 과 같은 모양이 나오는가"만 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toCatalog, weekdaysOf, looksLikeBuild, buildId, pageIdOf } = require('../src/shared/notionDoc');
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
  url: 'https://x.notion.site/PVE-3ce783623a1c8014bd01c2b2ce3562f0',
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
    pageIdOf('https://damageamplification.notion.site/PVE-3ce783623a1c8014bd01c2b2ce3562f0'),
    '3ce783623a1c8014bd01c2b2ce3562f0',
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
