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

// ─────────────────────────────── 노션에서 긁었을 때 나오는 모양 (점검에서 재현한 것들)

const turnsOf = (body) => parseSegments(body).segments.map((s) => `${s.label}:${s.steps.map((x) => x.turn).join(',')}`);

test('라운드 이름이 제목 기호 없이 한 줄로만 있어도 라운드로 나눈다', () => {
  // ★ 노션에서 긁으면 굵은 글씨 기호가 사라져 "1라운드"가 맨 글줄이 된다. 예전엔 라운드가
  // 하나로 뭉치고, 리셋 빌드는 1라운드 뒤를 통째로 "각주"로 버렸다 — "인식됨"으로 세면서.
  for (const mark of ['', '> ', '1. ', '- ', '']) {
    const body = ['## 스킬 순서', `${mark}1라운드`, '`0턴`비스킷 / `4턴`나타', `${mark}2라운드`, '`0턴`세인 / `4턴`리나'].join('\n');
    assert.deepStrictEqual(turnsOf(body), ['1라운드:0,4', '2라운드:0,4'], `표시 "${mark}"`);
  }
  // "2라운드:" 처럼 끝에 쌍점이 붙어도
  assert.deepStrictEqual(turnsOf('## 스킬 순서\n1라운드:\n0턴 가 / 4턴 나\n2라운드:\n0턴 다'), ['1라운드:0,4', '2라운드:0']);
});

test('라운드 이름 뒤에 바로 순서가 오는 줄도 읽는다 (표 줄 포함)', () => {
  assert.deepStrictEqual(
    turnsOf('## 스킬 순서\n1라운드: 0턴 비스킷 아래 / 4턴 나타 아래\n2라운드: 0턴 세인 위'),
    ['1라운드:0,4', '2라운드:0'],
  );
  // 표의 줄마다 라운드 칸이 되풀이되면 같은 라운드를 이어 간다
  assert.deepStrictEqual(
    turnsOf('## 스킬 순서\n1라운드 | 0턴 | 비스킷 아래\n1라운드 | 4턴 | 나타 아래\n2라운드 | 0턴 | 세인 위'),
    ['1라운드:0,4', '2라운드:0'],
  );
});

test('문장처럼 긴 줄은 라운드 제목으로 안 본다', () => {
  // 라운드 한가운데의 메모("2라운드 넘어가기 전에 …")까지 제목으로 보면 라운드가 갈라진다
  const body = '## 스킬 순서\n### 1라운드\n0턴 가\n2라운드 넘어가기 전에 체력 확인하고 힐 먼저\n4턴 나';
  assert.deepStrictEqual(turnsOf(body), ['1라운드:0,4']);
});

test('분기 이름에 턴이 들어간 목록 제목("- 2라운드 (4턴)")도 제목이다', () => {
  // 예전엔 턴 표시가 있다고 제목으로 안 봐서 두 분기가 한 줄로 이어졌다 ([0,4,4,8,8,12])
  const body = '## 스킬 순서\n- 1라운드\n0턴 가\n- 2라운드 (4턴)\n4턴 나 / 8턴 다\n- 2라운드 (8턴)\n8턴 라 / 12턴 마';
  const groups = groupVariants(parseSegments(body).segments);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(groups[1].variants.map((v) => v.label), ['2라운드 (4턴)', '2라운드 (8턴)']);
});

test('들여쓴 제목도 제목이다 — 토글 두 겹 안의 "### 2라운드"', () => {
  const body = '## 스킬 순서\n### 1라운드\n0턴 가\n    ### 2라운드\n    0턴 나';
  assert.deepStrictEqual(turnsOf(body), ['1라운드:0', '2라운드:0']);
});

test('라운드 이름이 없어도 처음(0·1턴)으로 돌아가 이어지면 다음 라운드로 본다', () => {
  // 리셋 빌드인데 라운드 구분이 아예 없는 경우. 예전엔 1라운드 뒤를 각주로 버렸다.
  const r = parseSegments('## 스킬 순서\n0턴 가 / 4턴 나 / 8턴 다\n0턴 라 / 4턴 마');
  assert.deepStrictEqual(r.segments.map((s) => s.steps.map((x) => x.turn)), [[0, 4, 8], [0, 4]]);
  assert.notStrictEqual(r.segments[0].label, r.segments[1].label, '라벨이 달라야 추적기가 라운드로 본다');
  assert.ok(r.notes.some((n) => n.includes('다음 라운드')), '무엇을 했는지 알린다');
  // 각주(처음이 아닌 곳으로 되돌아감, 또는 한 번뿐)는 예전처럼 버린다
  const foot = parseSegments('## 스킬 순서\n0턴 가 / 46턴 나 / 48턴 다\n*46턴에 안 썼으면 48턴에 쓴다');
  assert.deepStrictEqual(foot.segments.map((s) => s.steps.map((x) => x.turn)), [[0, 46, 48]]);
  const once = parseSegments('## 스킬 순서\n0턴 가 / 8턴 나\n0턴에 스킬 쓰지 말 것');
  assert.deepStrictEqual(once.segments.map((s) => s.steps.map((x) => x.turn)), [[0, 8]]);
});

test('순서 앞의 "목표 12턴" 같은 한 줄이 진짜 순서를 밀어내지 않는다', () => {
  // 예전엔 그 한 줄만 단계가 되고 진짜 순서 전부가 각주로 버려졌다
  const r = parseSegments('목표 12턴 클리어\n0턴 가 / 4턴 나 / 8턴 다');
  assert.deepStrictEqual(r.segments.map((s) => s.steps.map((x) => x.turn)), [[0, 4, 8]]);
  assert.ok(r.notes.some((n) => n.includes('순서가 아닌 것으로')));
});

test('"스킬 사용 팁" 같은 제목이 먼저 있어도 진짜 스킬 순서를 찾는다', () => {
  const body = '## 스킬 사용 팁\n평타 위주\n## 세팅\n속공 33\n## 스킬 순서\n### 1라운드\n0턴 가 / 4턴 나';
  const r = parseBuild(body);
  assert.strictEqual(r.stepCount, 2);
  assert.strictEqual(r.strategy, 'section');
  // "스킬 사용 순서" 의 꼬리 "순서"가 라벨에 남지 않는다
  const tail = parseSegments('## 스킬 사용 순서\n### 1라운드\n0턴 가');
  assert.strictEqual(tail.segments[0].label, '1라운드');
});

test('섹션 아래에서 순서를 못 찾으면 본문 전체로 한 번 더 본다', () => {
  const body = '## 스킬 순서\n## 참고\n### 1라운드\n0턴 가 / 4턴 나';
  const r = parseBuild(body);
  assert.strictEqual(r.stepCount, 2, '예전엔 0단계(미인식)였다');
});

test('턴과 행동이 다른 줄에 있어도 읽는다', () => {
  // 노션 목록에서 턴 아래 하위 목록으로 행동을 적거나, 턴을 제목으로 쓰는 경우
  assert.deepStrictEqual(turnsOf('## 스킬 순서\n- 0턴\n  - 비스킷 아래\n- 4턴\n  - 나타 아래'), ['스킬 순서:0,4']);
  assert.deepStrictEqual(turnsOf('## 스킬 순서\n### 0턴\n비스킷 아래\n### 4턴\n나타 아래'), ['스킬 순서:0,4']);
});

test('조용히 틀리게 읽던 표기들', () => {
  // "0-4턴"을 4턴으로 읽었다 ("~"만 앞 숫자로 봤다)
  assert.deepStrictEqual(stepsInLine('0-4턴 비스킷 아래'), [{ turn: 0, text: '비스킷 아래' }]);
  // "4턴째"의 "째"가 행동 앞에 남았다
  assert.deepStrictEqual(stepsInLine('4턴째 나타 아래'), [{ turn: 4, text: '나타 아래' }]);
  // 화살표로 이어 쓰면 행동 끝에 "→"가 남았다
  assert.deepStrictEqual(stepsInLine('0턴 가 → 4턴 나'), [
    { turn: 0, text: '가' },
    { turn: 4, text: '나' },
  ]);
  // 전각 숫자는 같은 숫자다
  assert.deepStrictEqual(turnsOf('## 스킬 순서\n０턴 가 / ４턴 나'), ['스킬 순서:0,4']);
});
