// 노션에서 긁어 온 페이지 나무 → 도감(builds.json)과 같은 모양.
//
// **왜 층을 나눴나.** 노션에서 글을 어떻게 가져오든(숨긴 창으로 긁든, 내보낸 파일을
// 읽든, 나중에 API를 쓰든) 그건 "페이지 나무 하나"로 정리된다. 그 뒤의 일 —
// 어느 페이지가 빌드인지, 이름·묶음·콘텐츠를 어떻게 정하는지 — 은 전부 여기 있고,
// 화면도 네트워크도 모르는 순수 로직이라 Node 테스트로 전부 확인할 수 있다.
//
// 나온 결과는 길드봇이 만들던 builds.json 과 **같은 모양**이다. 그래서 catalog.js도
// steps.js도 화면도 손댈 것이 없다 — 도감을 어디서 가져오든 그 뒤는 똑같이 흐른다.
'use strict';

const { parseBuild } = require('./steps');

/**
 * @typedef {{title: string, url?: string, markdown?: string, how?: string,
 *            failed?: boolean, error?: string,
 *            children?: NotionPage[]}} NotionPage
 *   how    어느 방법으로 긁혔는지 (main/notion.js 의 pickBody 결과)
 *   failed 못 연 페이지 — 제목과 주소만 있다
 * @typedef {{id: string, name: string, label: string, group: string,
 *            category: string, weekdays: string[], body: string,
 *            url: string|null, how?: string, stale?: boolean,
 *            failed?: boolean}} CatalogBuild
 *   stale  이번에 못 열어서 **지난번 도감에서 되살린** 빌드
 *   failed 지난번 도감에도 없어서 ⚠ 로만 남긴 빌드 (본문은 안내 문구)
 */

/** 묶음 이름을 이어 붙이는 기호 — 길드봇이 쓰던 것과 같게 (`강림 - 파괴신 › 파이`) */
const SEP = ' › ';

/**
 * 이 앱이 다루는 콘텐츠. 묶음 이름 어디에든 이 말이 있으면 그 탭으로 간다.
 * 없으면 비워 두고 catalog.js 의 categoryOf 가 '기타'로 넘긴다.
 */
const CATEGORIES = ['파괴신', '공성전', '구사황'];

/** 공성전은 요일마다 보스가 다르다 — 제목이나 묶음에 적힌 요일을 집어낸다 */
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

/** 노션 주소에서 페이지 id(32자 16진수)를 뽑는다 — 빌드 id를 안 흔들리게 하려고 */
function pageIdOf(url) {
  const m = String(url || '').match(/([0-9a-f]{32})/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * id는 **안 흔들려야 한다.** 마지막으로 보던 빌드(lastBuildId)를 기억하는 데 쓰고,
 * 화면이 단계·본문을 id로 물어보기 때문이다. 노션 페이지 id가 있으면 그걸 쓰고,
 * 없으면 묶음+이름으로 만든다 (같은 자리의 같은 이름이면 같은 id).
 */
function buildId(page, trail) {
  const fromUrl = pageIdOf(page.url);
  if (fromUrl) return fromUrl;
  return [...trail, page.title]
    .join('/')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 묶음 이름 어딘가에 콘텐츠 이름이 있으면 그걸로 */
function categoryOf(parts) {
  const joined = parts.join(' ');
  return CATEGORIES.find((c) => joined.includes(c)) || '';
}

/**
 * 제목·묶음에 적힌 요일. "월요일", "월 · 수", "월/수/금", "(월)", 그리고 붙여 쓴 "월수금"(세 글자
 * 이상, 요일 순서대로)을 잡는다.
 *
 * 걸러 내는 것:
 *  · **숫자 바로 뒤의 "일"** — "1일 공략", "D-7일"은 일요일이 아니다.
 *  · **"속성" 앞의 글자** — "화 속성 덱"의 화는 화요일이 아니다 (화·수·목·금·토는 속성 이름이기도 하다).
 * (예전 주석은 "월수금"도 잡는다고 했지만 실제로는 못 잡았고, 위 두 경우는 요일로 잡았다.)
 *
 * ⚠ 이 규칙은 **실제 도감을 보고 정한 것이 아니다.** 공성전 페이지에 요일이 어떻게
 * 적혀 있는지 확인하고 고칠 것. 못 잡아도 탭은 그대로 보이고 "오늘 보스 먼저 고르기"만
 * 안 될 뿐이라, 억지로 맞히려 들지 않는다.
 */
function weekdaysOf(parts) {
  const joined = parts.join(' ');
  const found = new Set();
  const days = WEEKDAYS.join('');
  // 붙여 쓴 요일 묶음 — 요일 글자로만 된 **세 글자 이상**, 그리고 **요일 순서대로** ("월수금").
  // 두 글자까지 받으면 "금화"·"금일"·"일일" 같은 흔한 낱말이 요일이 된다.
  for (const m of joined.matchAll(new RegExp(`(^|[^가-힣])([${days}]{3,7})(?=[^가-힣]|$)`, 'g'))) {
    const order = [...m[2]].map((ch) => days.indexOf(ch));
    if (order.every((v, i) => i === 0 || v > order[i - 1])) for (const d of m[2]) found.add(d);
  }
  for (const d of WEEKDAYS) {
    if (joined.includes(`${d}요일`)) found.add(d);
    // 낱자 요일 — 앞뒤가 한글이 아니어야 한다 ("일요일"의 일·"1일차"의 일을 가르려고)
    const alone = new RegExp(`(^|[^가-힣0-9])${d}(?=[^가-힣]|$)(?!\\s*속성)`, 'g');
    if (alone.test(joined)) found.add(d);
  }
  return WEEKDAYS.filter((d) => found.has(d));
}

/** 본문에 읽을 것이 있나 — 빈 페이지를 빌드로 세지 않으려고 */
function hasContent(markdown) {
  return String(markdown || '').replace(/[\s#>*_`\-|]/g, '').length > 0;
}

/**
 * 이 페이지가 빌드인가.
 *
 * **하위 페이지가 없으면 빌드다** — 노션에서 빌드 하나가 페이지 하나이기 때문이다.
 * 하위가 있어도 본문에 턴 표기가 있으면 빌드로 같이 싣는다: 묶음 페이지에 순서를
 * 적어 두는 경우가 있고, **못 읽었다고 목록에서 빼면 "빌드가 안 보인다"가 된다**
 * (CLAUDE.md — 옛 오버레이가 그래서 욕을 먹었다).
 */
function looksLikeBuild(page) {
  if (!hasContent(page.markdown)) return false;
  const kids = Array.isArray(page.children) ? page.children.length : 0;
  if (kids === 0) return true;
  return /\d+\s*턴/.test(String(page.markdown));
}

/**
 * 페이지 나무를 훑어 빌드를 모은다.
 *
 * **못 연 페이지(`failed`)를 건너뛰지 않는다.** 한 장이 끊기면 그 아래 빌드들이
 * 새 도감에서 통째로 빠지는데, 받기는 성공으로 끝나 사람은 모른다 — 이 프로젝트가
 * 제일 먼저 고친 "빌드가 안 보인다"가 조용히 되살아난다. 그래서:
 *  1. **지난번 도감(previous)에서 그 자리를 되살린다** — 같은 페이지 id 거나,
 *     그 페이지 아래 묶음에 있던 빌드들. `stale: true` 를 붙인다.
 *  2. 지난번에도 없던 자리면 **⚠ 빌드로 남긴다** — 본문은 "못 열었다"는 안내.
 *
 * @param {NotionPage} root 맨 위 페이지 (이 페이지 자체는 묶음 이름에 안 넣는다 —
 *   "PVE › 강림 - 파괴신 › 파이"가 아니라 "강림 - 파괴신 › 파이"가 되게)
 * @param {{syncedAt?: string, maxBuilds?: number,
 *          previous?: {builds?: any[]}|null}} [options]
 *   previous 지난번에 받아 둔 도감 (없으면 되살릴 것도 없다)
 * @returns {{title: string, syncedAt: string, builds: CatalogBuild[],
 *            restored: number, missing: number}}
 *   restored 지난번 도감에서 되살린 빌드 수 · missing ⚠ 로만 남긴 빌드 수
 *   (이 둘은 화면에 알리는 용도라 부르는 쪽이 파일에는 안 쓴다)
 */
function toCatalog(root, options = {}) {
  const syncedAt = options.syncedAt || new Date().toISOString();
  const maxBuilds = options.maxBuilds || 2000;
  const previous = options.previous && Array.isArray(options.previous.builds) ? options.previous.builds : [];
  /** @type {CatalogBuild[]} */
  const builds = [];
  const seen = new Set();
  let restored = 0;
  let missing = 0;

  /**
   * 못 연 페이지 자리 — 지난번 도감에서 되살리거나, ⚠ 로 남긴다.
   * @param {NotionPage} page
   * @param {string[]} trail
   */
  function recover(page, trail) {
    const id = buildId(page, trail);
    const under = [...trail, page.title].join(SEP);
    const olds = previous.filter(
      (b) => b && (b.id === id || b.group === under || String(b.group || '').startsWith(under + SEP)),
    );
    if (olds.length > 0) {
      for (const b of olds) {
        if (seen.has(b.id) || builds.length >= maxBuilds) continue;
        seen.add(b.id);
        builds.push({ ...b, stale: true });
        restored += 1;
      }
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    const parts = [...trail, page.title];
    builds.push({
      id,
      name: `⚠ ${page.title}`,
      label: `⚠ ${page.title}`,
      group: trail.join(SEP),
      category: categoryOf(parts),
      weekdays: weekdaysOf(parts),
      body:
        `이 페이지를 못 열었어요${page.error ? ` (${page.error})` : ''}.\n` +
        '설정(⚙)의 [노션에서 받기]를 다시 눌러 보세요.\n\n' +
        (page.url || ''),
      url: page.url || null,
      failed: true,
    });
    missing += 1;
  }

  /**
   * @param {NotionPage} page
   * @param {string[]} trail 위쪽 페이지 제목들 (맨 위 페이지는 빼고)
   */
  function walk(page, trail) {
    if (!page || builds.length >= maxBuilds) return;
    if (page.failed) {
      recover(page, trail);
      return;
    }
    if (looksLikeBuild(page)) {
      const id = buildId(page, trail);
      // 같은 id가 두 번 나오면(같은 페이지를 두 자리에서 가리키는 경우) 한 번만 싣는다
      if (!seen.has(id)) {
        seen.add(id);
        const parts = [...trail, page.title];
        builds.push({
          id,
          name: page.title,
          label: page.title,
          group: trail.join(SEP),
          category: categoryOf(parts),
          weekdays: weekdaysOf(parts),
          body: String(page.markdown || ''),
          url: page.url || null,
          ...(page.how ? { how: page.how } : {}),
        });
      }
    }
    for (const child of page.children || []) walk(child, [...trail, page.title]);
  }

  for (const child of (root && root.children) || []) walk(child, []);
  // 맨 위 페이지 자체에 순서가 적혀 있는 경우도 놓치지 않는다
  if (root && looksLikeBuild(root) && !(root.children || []).length) walk(root, []);

  // ★ 콘텐츠(탭)를 못 정한 빌드는 **맨 위 페이지 이름**으로 한 번 더 본다. 맨 위 이름은 묶음
  // 이름에서 뺐는데("PVE › …"가 안 되게) 콘텐츠 판정에서도 빠져서, "공성전" 페이지 주소를 바로
  // 넣으면 빌드가 전부 "기타" 탭으로 갔다. 요일도 같다.
  const rootTitle = (root && root.title) || '';
  if (rootTitle) {
    for (const b of builds) {
      if (!b.category) b.category = categoryOf([rootTitle]);
      if (!Array.isArray(b.weekdays) || b.weekdays.length === 0) b.weekdays = weekdaysOf([rootTitle]);
    }
  }

  return { title: (root && root.title) || '도감', syncedAt, builds, restored, missing };
}

/**
 * 한 페이지를 여러 방법으로 긁었을 때, **어느 것을 쓸지 재서 고른다.**
 *
 * ★ 이게 이 기능의 핵심이다. 노션이 화면을 어떻게 그리는지는 개발하는 곳에서
 * 확인할 방법이 없다 — notion.site 가 막혀 있다. 그래서 "내가 맞는 선택자를 알고
 * 있다"에 기대면 안 된다. 대신 **여러 방법으로 긁어 보고, 도감 파서에 실제로
 * 넣어 봐서 제일 잘 읽히는 것을 쓴다.** 한 방법이 깨져도 나머지가 받는다.
 *
 * 고르는 순서 (앞엣것이 먼저):
 *  1. **단계를 읽어낸 것** — 하나도 못 읽는 건 쓸모가 없다.
 *  2. **`스킬 순서` 섹션을 찾은 것**(strategy 'section') — 제목 구조가 살아 있다는 뜻이다.
 *  3. **라운드를 더 많이 나눈 것** — 맨글씨로 긁으면 라운드가 한 덩어리로 뭉친다
 *     (재 봤다: 마크다운은 2라운드로 갈리는데 맨글씨는 1덩어리가 된다).
 *  4. 단계가 더 많은 것.
 *  5. **짧은 것** — 같은 것을 읽어냈다면 군더더기가 적은 쪽이다.
 *
 * 단계를 아무도 못 읽었으면 **제일 긴 것**을 준다. 본문은 그대로 보여줘야 하기
 * 때문이다 — 순서를 못 읽었다고 빌드를 숨기지 않는다 (CLAUDE.md).
 *
 * @param {Array<{how: string, markdown: string}>} candidates
 * @returns {{how: string, markdown: string, stepCount: number, strategy: string, groups: number}}
 */
function pickBody(candidates) {
  const list = (candidates || []).filter((c) => c && typeof c.markdown === 'string');
  if (list.length === 0) return { how: 'none', markdown: '', stepCount: 0, strategy: 'none', groups: 0 };

  const scored = list.map((c) => {
    const parsed = parseBuild(c.markdown);
    return {
      how: c.how,
      markdown: c.markdown,
      stepCount: parsed.stepCount,
      strategy: parsed.strategy,
      groups: (parsed.groups || []).length,
    };
  });

  const withSteps = scored.filter((c) => c.stepCount > 0);
  if (withSteps.length === 0) {
    // 아무것도 못 읽었으면 본문이라도 제일 많이 건진 것
    return scored.reduce((a, b) => (b.markdown.length > a.markdown.length ? b : a));
  }
  return withSteps.sort((a, b) => {
    const section = (c) => (c.strategy === 'section' ? 1 : 0);
    return (
      section(b) - section(a) ||
      b.groups - a.groups ||
      b.stepCount - a.stepCount ||
      a.markdown.length - b.markdown.length
    );
  })[0];
}

module.exports = { toCatalog, pickBody, weekdaysOf, looksLikeBuild, buildId, pageIdOf, SEP, CATEGORIES };
