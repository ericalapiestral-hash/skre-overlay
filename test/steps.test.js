// 스킬 순서 파서 — 도감 표기가 제각각이어도 읽어내는지.
//
// 옛 파서는 백틱 `0턴` + "## 스킬 순서" + "### N라운드" 셋이 다 맞아야만 읽었다.
// 하나만 어긋나도 그 빌드가 목록에서 통째로 사라졌다. 여기 테스트는 그 "어긋난"
// 표기들을 하나씩 못 박아 둔 것이다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseBuild, parseSegments, groupVariants, flatten, stepsInLine } = require('../src/shared/steps');

// ─────────────────────────────── 기본 형태 (실제 도감 모양)

const SAMPLE = `
# 세팅
- 나타 (속공 33)
## 스킬 순서
> 턴수는 참고만
### 1라운드
\`0턴\`비스킷 아래 / \`4턴\`나타 아래
### 2라운드
\`4턴\`비스킷 위 / \`8턴\`클로에 위 (\`9턴\`미호 평타로 클리어)
### 3라운드
\`9턴\`리나 위 /
# 다른 섹션
\`99턴\` 이건 스킬 순서 밖이라 무시
`;

test('라운드별로 세그먼트를 나눈다', () => {
  const { segments } = parseSegments(SAMPLE);
  assert.deepStrictEqual(segments.map((s) => s.label), ['1라운드', '2라운드', '3라운드']);
});

test('턴과 액션을 뽑고, 남은 기호는 걷어낸다', () => {
  const { segments } = parseSegments(SAMPLE);
  assert.deepStrictEqual(segments[0].steps, [
    { turn: 0, text: '비스킷 아래' },
    { turn: 4, text: '나타 아래' },
  ]);
  assert.deepStrictEqual(segments[1].steps, [
    { turn: 4, text: '비스킷 위' },
    { turn: 8, text: '클로에 위' },
    { turn: 9, text: '미호 평타로 클리어' },
  ]);
  assert.deepStrictEqual(segments[2].steps, [{ turn: 9, text: '리나 위' }]);
});

test('스킬 순서 섹션 밖의 턴 표시는 무시한다', () => {
  const turns = parseSegments(SAMPLE).segments.flatMap((s) => s.steps.map((x) => x.turn));
  assert.ok(!turns.includes(99));
});

// ─────────────────────────────── 예전엔 못 읽던 표기들

test('백틱이 없어도 읽는다', () => {
  const { stepCount, groups } = parseBuild(`
## 스킬 순서
### 1라운드
0턴 비스킷 아래 / 4턴 나타 아래
`);
  assert.strictEqual(stepCount, 2);
  assert.deepStrictEqual(groups[0].variants[0].steps, [
    { turn: 0, text: '비스킷 아래' },
    { turn: 4, text: '나타 아래' },
  ]);
});

test('굵은 글씨를 라운드 제목으로 쓴 경우도 읽는다', () => {
  const { groups } = parseBuild(`
**스킬 순서**
**1라운드**
- 0턴: 비스킷 아래
- 4턴: 나타 아래
**2라운드**
- 8턴: 클로에 위
`);
  assert.deepStrictEqual(groups.map((g) => g.variants[0].label), ['1라운드', '2라운드']);
  assert.strictEqual(groups[0].variants[0].steps.length, 2);
});

test('표(테이블)로 적힌 순서도 읽는다', () => {
  const { groups } = parseBuild(`
## 스킬 순서
| 턴 | 행동 |
| --- | --- |
| 0턴 | 비스킷 아래 |
| 4턴 | 나타 아래 |
`);
  assert.deepStrictEqual(groups[0].variants[0].steps, [
    { turn: 0, text: '비스킷 아래' },
    { turn: 4, text: '나타 아래' },
  ]);
});

test('"스킬 순서" 제목이 아예 없어도 본문에서 찾는다', () => {
  const parsed = parseBuild('0턴 비스킷 아래 / 4턴 나타 아래');
  assert.strictEqual(parsed.stepCount, 2);
  assert.strictEqual(parsed.strategy, 'whole');
});

test('액션 안의 슬래시를 잘라먹지 않는다', () => {
  // 옛 파서는 액션을 슬래시에서 끊어 "미호"까지만 남겼다
  assert.deepStrictEqual(stepsInLine('`0턴`미호/나타 위 / `4턴`리나 아래'), [
    { turn: 0, text: '미호/나타 위' },
    { turn: 4, text: '리나 아래' },
  ]);
});

test('라운드 표기가 달라도 같은 것으로 본다', () => {
  for (const title of ['### 2라운드', '### 라운드 2', '### 2페이즈', '### R2', '### 2R']) {
    const { groups } = parseBuild(`## 스킬 순서\n${title}\n0턴 가\n`);
    assert.strictEqual(groups.length, 1, title);
    assert.strictEqual(groups[0].round, 2, title);
  }
});

test('스킬 순서가 없으면 숨기지 않고 strategy로 알린다', () => {
  const parsed = parseBuild('# 세팅\n- 나타 속공 33\n장비만 적힌 빌드');
  assert.strictEqual(parsed.stepCount, 0);
  assert.strictEqual(parsed.strategy, 'none');
});

test('본문이 비어도 죽지 않는다', () => {
  for (const body of ['', null, undefined]) {
    const parsed = parseBuild(body);
    assert.strictEqual(parsed.stepCount, 0);
  }
});

// ─────────────────────────────── 분기 (같은 라운드가 두 번)

const BRANCH = `
## 스킬 순서
### 1라운드
\`0턴\`소교 위 / \`4턴\`파스칼 위
### 2라운드 (4턴)
\`4턴\`헤브 위 / \`8턴\`샤오 아래
### 2라운드 (8턴)
\`8턴\`헤브 위 / \`12턴\`샤오 아래
`;

test('같은 라운드 번호는 변형으로 묶는다', () => {
  const groups = groupVariants(parseSegments(BRANCH).segments);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].variants.length, 1);
  assert.deepStrictEqual(groups[1].variants.map((v) => v.label), ['2라운드 (4턴)', '2라운드 (8턴)']);
});

test('변형 선택에 따라 다른 줄기가 펼쳐진다', () => {
  const groups = groupVariants(parseSegments(BRANCH).segments);
  assert.deepStrictEqual(flatten(groups, { 1: 0 }).map((s) => s.turn), [0, 4, 4, 8]);
  assert.deepStrictEqual(flatten(groups, { 1: 1 }).map((s) => s.turn), [0, 4, 8, 12]);
});

test('변형 선택이 범위를 벗어나도 안전하게 자른다', () => {
  const groups = groupVariants(parseSegments(BRANCH).segments);
  assert.deepStrictEqual(flatten(groups, { 1: 99 }).map((s) => s.turn), [0, 4, 8, 12]);
  assert.deepStrictEqual(flatten(groups, { 1: -5 }).map((s) => s.turn), [0, 4, 4, 8]);
});

test('스킬 순서 섹션이 여러 개면 라벨로 구분한다', () => {
  const { groups } = parseBuild(`
## 스킬 순서 (안전형)
### 1라운드
0턴 가
## 스킬 순서 (고점형)
### 1라운드
0턴 나
`);
  // 같은 "1라운드"지만 섹션이 달라 변형으로 묶이고, 라벨로 구분된다
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].variants.map((v) => v.label), [
    '1라운드 — 안전형',
    '1라운드 — 고점형',
  ]);
});

// ─────────────────────────────── 각주 방어

test('턴이 되돌아가면 각주로 보고 거기서 끊는다', () => {
  const { groups, notes } = parseBuild(`
## 스킬 순서
### 1라운드
\`0턴\`가 / \`4턴\`나 / \`8턴\`다
*\`4턴\`에 안 썼으면 여기서 대신
`);
  assert.deepStrictEqual(groups[0].variants[0].steps.map((s) => s.turn), [0, 4, 8]);
  assert.ok(notes.length > 0, '무엇을 건너뛰었는지 알려야 한다');
});
