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

/**
 * @typedef {{title: string, url?: string, markdown?: string,
 *            children?: NotionPage[]}} NotionPage
 * @typedef {{id: string, name: string, label: string, group: string,
 *            category: string, weekdays: string[], body: string,
 *            url: string|null}} CatalogBuild
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
 * 제목·묶음에 적힌 요일. "월수금" 처럼 붙여 쓴 것도, "월 · 수" 도 잡는다.
 *
 * ⚠ 이 규칙은 **실제 도감을 보고 정한 것이 아니다.** 공성전 페이지에 요일이 어떻게
 * 적혀 있는지 확인하고 고칠 것. 못 잡아도 탭은 그대로 보이고 "오늘 보스 먼저 고르기"만
 * 안 될 뿐이라, 억지로 맞히려 들지 않는다.
 */
function weekdaysOf(parts) {
  const joined = parts.join(' ');
  const found = [];
  for (const d of WEEKDAYS) {
    // "일요일"의 '일'과 "1일차"의 '일'을 가르려고 요일 낱말 주변만 본다
    if (new RegExp(`${d}요일|(^|[^가-힣])${d}([^가-힣]|$)`).test(joined) && !found.includes(d)) {
      found.push(d);
    }
  }
  return found;
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
 * @param {NotionPage} root 맨 위 페이지 (이 페이지 자체는 묶음 이름에 안 넣는다 —
 *   "PVE › 강림 - 파괴신 › 파이"가 아니라 "강림 - 파괴신 › 파이"가 되게)
 * @param {{syncedAt?: string, maxBuilds?: number}} [options]
 * @returns {{title: string, syncedAt: string, builds: CatalogBuild[]}}
 */
function toCatalog(root, options = {}) {
  const syncedAt = options.syncedAt || new Date().toISOString();
  const maxBuilds = options.maxBuilds || 2000;
  /** @type {CatalogBuild[]} */
  const builds = [];
  const seen = new Set();

  /**
   * @param {NotionPage} page
   * @param {string[]} trail 위쪽 페이지 제목들 (맨 위 페이지는 빼고)
   */
  function walk(page, trail) {
    if (!page || builds.length >= maxBuilds) return;
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
        });
      }
    }
    for (const child of page.children || []) walk(child, [...trail, page.title]);
  }

  for (const child of (root && root.children) || []) walk(child, []);
  // 맨 위 페이지 자체에 순서가 적혀 있는 경우도 놓치지 않는다
  if (root && looksLikeBuild(root) && !(root.children || []).length) walk(root, []);

  return { title: (root && root.title) || '도감', syncedAt, builds };
}

module.exports = { toCatalog, weekdaysOf, looksLikeBuild, buildId, pageIdOf, SEP, CATEGORIES };
