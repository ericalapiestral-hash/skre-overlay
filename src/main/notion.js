// 노션 공개 페이지를 숨긴 창으로 열어 글을 긁어온다.
//
// **왜 창을 쓰나.** 노션 공개 페이지는 HTML에 글이 없다 — 자바스크립트가 그린다.
// 그래서 주소만 받아 오면 빈 껍데기가 온다. 방법이 둘 있는데:
//
//  · 노션 **내부 API**(loadPageChunk)를 부른다 — 빠르지만 비공개라 노션이 예고 없이
//    바꾸면 조용히 깨진다. 게다가 응답이 노션의 내부 블록 구조라 다루기 번거롭다.
//  · **화면에 그려진 걸 읽는다** — Electron 안에 이미 크로미움이 있으니 안 보이는 창에서
//    페이지를 열고, 다 그려지면 글을 긁는다. 느리지만 **사람이 보는 것과 같은 것**을
//    읽으므로 내부 API가 바뀌어도 안 깨진다. 토큰도 길드봇도 필요 없다.
//
// 뒤쪽을 골랐다. 도감은 하루에 몇 번 바뀔까 말까 하고, 받아 온 것은 파일로 캐시해
// 두므로 느린 건 처음 한 번뿐이다.
//
// ⚠ **여기 있는 선택자(.notion-…-block)는 실제 페이지로 확인하지 못했다.**
// 이 저장소가 도는 곳에서는 notion.site 접속이 막혀 있다. 안 긁히면 사용자에게
// 설정의 **[페이지 저장]**(catalog:dump-notion → 아래 dumpDiagnostics)으로 실제 HTML과
// 세 방법이 뽑은 글을 떠 달라고 해서 고칠 것.
'use strict';

const { BrowserWindow } = require('electron');
const { pickBody } = require('../shared/notionDoc');

/** 한 페이지가 다 그려지기를 기다리는 한도 (ms) */
const RENDER_TIMEOUT = 20000;
/** 몇 단계까지 파고들지 — PVE › 콘텐츠 › 보스 › 빌드 면 4단계다 */
const MAX_DEPTH = 5;
/** 몇 페이지까지 — 도감이 커도 여기서 멈춘다 (실수로 노션 전체를 긁지 않게) */
const MAX_PAGES = 400;

/**
 * 페이지 안에서 도는 코드. **여기서 돌아가는 건 노션 페이지 안이라 Node가 없다.**
 * 돌려주는 값은 JSON으로 넘어갈 수 있는 것이어야 한다.
 *
 * 노션 블록은 `notion-<종류>-block` 클래스를 단다. 종류별로 마크다운 기호를 붙여,
 * **노션이 "Markdown으로 내보내기"로 뽑아 주는 글과 비슷하게** 만든다 — 그래야
 * 기존 파서(steps.js)가 그대로 읽고, 사람이 내보낸 파일과 견줘 볼 수 있다.
 */
/**
 * 긁기 **전에** 페이지를 준비한다. 여기가 없으면 글의 상당 부분을 통째로 놓친다.
 *
 *  · **접힌 토글을 편다.** 빌드를 토글 안에 넣어 두면 접힌 동안은 DOM에 아예 없다.
 *  · **끝까지 훑어 내린다.** 노션은 긴 페이지를 **보이는 만큼만 그린다.** 창을 길게
 *    잡는 것만으로는 부족해서, 바닥까지 내려 높이가 안 늘 때까지 기다려야 한다.
 *
 * 둘 다 "안 하면 조용히 절반만 긁히는" 종류라 실패해도 티가 안 난다 — 그래서
 * 몇 번 폈고 얼마나 늘었는지 숫자로 돌려준다.
 */
const PREPARE = `(async () => {
  const rest = (ms) => new Promise((r) => setTimeout(r, ms));
  let opened = 0;
  for (let round = 0; round < 4; round += 1) {
    const closed = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
    if (closed.length === 0) break;
    for (const el of closed.slice(0, 300)) {
      try { el.click(); opened += 1; } catch (e) { /* 못 눌러도 계속 */ }
    }
    await rest(250);
  }

  const scroller =
    document.querySelector('.notion-frame .notion-scroller') ||
    document.querySelector('.notion-scroller') ||
    document.scrollingElement ||
    document.body;
  // **한 번 조용하다고 끝난 게 아니다.** 예전엔 높이가 한 틱(200ms) 안 늘면 바로
  // 끝냈는데, 늦게 붙는 부분이 그 200ms 안에 안 들어오면 (느린 회선·바쁜 CPU)
  // 거기서 멈춰 **페이지 절반을 조용히 버렸다.** 오류도 안 나고 빌드 수만 줄어든다.
  // 실제로 시험용 페이지에서 CPU를 물려 놓으면 세 번에 한 번 그렇게 됐다.
  // 세 틱(600ms) 연속으로 안 늘어야 바닥으로 본다.
  //
  // ★ **조용함은 스크롤이 페이지에 닿은 뒤부터 센다.** scroll 이벤트(그리고
  // IntersectionObserver)는 화면을 그리는 프레임에 실려 나가는데, **숨긴 창은 프레임이
  // 드물다** — 재 보니 스크롤하고 한가할 때 0.2초, CPU가 바쁘면 **0.8초 뒤에야** 이벤트가
  // 갔다 (backgroundThrottling 과 무관하다 — 창이 화면에 없어서다). 그동안 "조용하다"를
  // 세면 페이지는 아직 스크롤된 줄도 모르는데 바닥으로 보고 끝낸다. 전체 시험에서
  // 가끔 늦게 붙는 부분이 통째로 빠지던 원인이 이것이었다. 그래서 실제로 움직인
  // 스크롤은 다음 프레임이 올 때까지 기다린다 (프레임이 영영 안 와도 멈추지는 않게 상한).
  const frame = () => new Promise((r) => {
    let done = false;
    const go = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(go);
    setTimeout(go, 2000);
  });
  let last = -1;
  let quiet = 0;
  for (let i = 0; i < 60; i += 1) {
    const before = [scroller.scrollTop, window.scrollY];
    try { scroller.scrollTop = scroller.scrollHeight; } catch (e) { /* 무시 */ }
    window.scrollTo(0, document.body.scrollHeight);
    if (scroller.scrollTop !== before[0] || window.scrollY !== before[1]) await frame();
    await rest(200);
    const h = Math.max(scroller.scrollHeight || 0, document.body.scrollHeight || 0);
    if (h === last) {
      quiet += 1;
      if (quiet >= 3) break;
      continue;
    }
    quiet = 0;
    last = h;
  }
  try { scroller.scrollTop = 0; } catch (e) { /* 무시 */ }
  window.scrollTo(0, 0);
  await rest(150);
  return {
    opened,
    height: last,
    blocks: document.querySelectorAll('[class*="notion-"][class*="-block"]').length,
  };
})()`;

/**
 * 하위 페이지 링크는 **긁는 방법과 상관없이 한 번만** 모은다.
 * 링크는 글이 아니라 "저기도 가 봐라"는 표시라, 어느 방법을 쓰든 같아야 한다.
 */
const LINKS = `(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const title = (a.textContent || '').replace(/\\u00a0/g, ' ').trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, title });
  }
  return out;
})()`;

/** 세 방법이 같이 쓰는 도우미 — 이 덩어리 자신의 글만 (안에 든 덩어리는 뺀다) */
const OWN_TEXT = `
  const clean = (t) => (t || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').trim();
  const ownText = (el, sel) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(sel).forEach((n) => n.remove());
    return clean(copy.textContent);
  };
`;

/**
 * 방법 1 — **노션 블록 클래스로.** 제일 좋은 결과가 나오지만, `notion-…-block` 이라는
 * 내부 클래스 이름에 기댄다. 노션이 바꾸면 이 방법만 깨지고 아래 둘이 받는다.
 */
const EXTRACT_NOTION = `(() => {
  ${OWN_TEXT}
  const PREFIX = {
    header: '# ', sub_header: '## ', sub_sub_header: '### ',
    bulleted_list: '- ', numbered_list: '1. ', to_do: '- ',
    toggle: '- ', quote: '> ', callout: '> ',
  };
  const root = document.querySelector('.notion-page-content') || document.querySelector('main') || document.body;
  const kindOf = (el) => {
    const m = String(el.className || '').match(/notion-([a-z_]+)-block/);
    return m ? m[1] : '';
  };
  const lines = [];
  const walk = (el, depth) => {
    for (const child of el.children) {
      const kind = kindOf(child);
      if (!kind) { walk(child, depth); continue; }
      if (kind === 'page' || kind === 'link_to_page') { walk(child, depth); continue; }
      // 표는 **그 자리에서** 줄로 푼다. 예전엔 표 줄을 전부 문서 맨 끝에 모아 붙여서,
      // "## 스킬 순서" 아래 표 뒤에 "# 메모" 같은 제목이 오면 표 줄이 그 뒤로 밀려
      // 섹션 밖으로 잘렸다. 라운드마다 표를 두면 어느 라운드 것인지도 잃었다.
      if (kind === 'table' || kind === 'collection_view' || kind === 'table_row') {
        const rows = child.tagName === 'TR' ? [child] : Array.from(child.querySelectorAll('tr'));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td, th')).map((c) => clean(c.textContent)).filter(Boolean);
          if (cells.length > 1) lines.push('  '.repeat(Math.min(depth, 6)) + cells.join(' | '));
        }
        if (rows.length === 0) walk(child, depth);
        continue;
      }
      const text = ownText(child, '[class*="-block"]');
      if (text) {
        const pad = '  '.repeat(Math.min(depth, 6));
        if (kind === 'code') lines.push('\\\`\\\`\\\`', text, '\\\`\\\`\\\`');
        else lines.push(pad + (PREFIX[kind] || '') + text);
      }
      walk(child, depth + (kind.endsWith('_list') || kind === 'toggle' ? 1 : 0));
    }
  };
  walk(root, 0);
  return lines.join('\\n');
})()`;

/**
 * 방법 2 — **평범한 HTML 태그로.** h1·li·tr 같은 표준 태그만 본다. 노션이 클래스
 * 이름을 통째로 바꿔도 이건 산다.
 *
 * 겹쳐 나오는 것은 **같은 글이 두 요소에서** 나오는 경우뿐이다 — 표 줄(tr)이 칸 안의
 * p·li 글을 이미 담고 있는데 그 p·li 를 또 넣는 것. 그래서 표 줄 **안쪽** 요소만 건너뛴다.
 * 예전엔 "똑같은 줄은 한 번만" 넣었는데, 리셋 빌드는 라운드마다 같은 행동 줄이 흔하고
 * 안전형·고점형 섹션마다 "### 1라운드" 가 되풀이된다 — 그게 조용히 지워져 뒤 라운드
 * 단계가 빠지고 라벨이 "고점형 — 고점형"이 됐다. **글이 같다고 지우지 말 것.**
 */
const EXTRACT_SEMANTIC = `(() => {
  ${OWN_TEXT}
  const TAG = {
    H1: '# ', H2: '## ', H3: '### ', H4: '### ', H5: '### ', H6: '### ',
    LI: '- ', BLOCKQUOTE: '> ', P: '', PRE: '',
  };
  const BLOCKS = 'h1,h2,h3,h4,h5,h6,li,p,blockquote,pre,tr';
  const root = document.querySelector('main') || document.body;
  const lines = [];
  const push = (line) => {
    if (line.trim()) lines.push(line);
  };
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.tagName !== 'TR' && el.closest('tr')) continue;
    if (el.tagName === 'TR') {
      const cells = Array.from(el.querySelectorAll('td, th')).map((c) => clean(c.textContent)).filter(Boolean);
      if (cells.length > 1) push(cells.join(' | '));
      continue;
    }
    const text = ownText(el, BLOCKS);
    if (text) push((TAG[el.tagName] || '') + text);
  }
  return lines.join('\\n');
})()`;

/**
 * 방법 3 — **보이는 글 그대로.** 마지막 보루다. 어떤 페이지에서도 무언가는 나온다.
 * 다만 마크다운 기호가 없어 **라운드 구분을 잃는다** (재 봤다: 마크다운은 2라운드로
 * 갈리는데 이건 한 덩어리가 된다). 그래서 앞의 둘이 되면 그쪽이 이긴다 — 고르는
 * 일은 shared/notionDoc.js 의 pickBody 가 실제로 파서에 넣어 보고 정한다.
 */
const EXTRACT_PLAIN = `(() => {
  const root = document.querySelector('.notion-page-content') || document.querySelector('main') || document.body;
  return (root.innerText || '')
    .replace(/\\u00a0/g, ' ')
    .split('\\n')
    .map((l) => l.replace(/[ \\t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\\n');
})()`;

/** 페이지 제목 */
const TITLE = `(() => {
  const el =
    document.querySelector('.notion-page-block .notion-page-title-text') ||
    document.querySelector('[placeholder="Untitled"]') ||
    document.querySelector('h1');
  return ((el && el.textContent) || document.title || '').replace(/\\u00a0/g, ' ').trim();
})()`;

/**
 * 페이지가 다 그려졌는지 — 노션은 껍데기부터 오므로 글이 생길 때까지 기다린다.
 *
 * **노션 클래스에만 기대지 않는다.** 그 이름이 바뀌거나 페이지가 다른 모양이면
 * 여기서 영영 못 기다리고 통째로 실패한다 — 정작 글은 다 그려져 있는데도.
 * 그래서 "글이 충분히 그려졌다"도 준비된 것으로 본다. 뒤의 세 방법 중
 * `semantic`·`plain` 은 노션 클래스가 없어도 읽어낸다.
 */
const READY = `(() => {
  const c = document.querySelector('.notion-page-content');
  if (c && c.children.length > 0) return true;
  if (document.querySelectorAll('[class*="notion-"][class*="-block"]').length > 0) return true;
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, '');
  return text.length > 200;
})()`;

/**
 * 사람이 붙여넣은 주소를 다듬는다.
 *
 * 주소창에서 긁어 오면 `https://` 가 빠지는 일이 흔하다 (`어느길드.notion.site/…`).
 * 그걸 그대로 `new URL()` 에 넣으면 던져서 **"주소를 넣어주세요"만 뜨고 끝난다** —
 * 사람 입장에선 분명히 넣었는데 안 넣었다고 하는 셈이다. 앞뒤 공백과 따옴표도 뗀다.
 */
function normalizeUrl(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^["'<]+|["'>]+$/g, '');
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  // 스킴이 없으면 https 로 본다 (http 로 적었으면 위에서 그대로 통과해 아래서 걸린다)
  return `https://${text}`;
}

/** 노션 주소인가 — 아무 주소나 열지 않는다 */
function isNotionUrl(url) {
  try {
    const u = new URL(normalizeUrl(url));
    return u.protocol === 'https:' && /(^|\.)notion\.(site|so)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 하위 페이지 주소를 절대 주소로. 다른 사이트로 새 나가지 않게 원점을 확인한다.
 *
 * 빈 href와 `#어디`는 **자기 자신**으로 풀린다 (new URL('', base) === base).
 * 그걸 그대로 돌려주면 같은 페이지를 하위 페이지로 알고 다시 열러 간다 — 조각(#)을
 * 떼고 빈 것은 거른다. 테스트가 이걸 잡았다.
 */
function resolveLink(href, base) {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('#')) return '';
  try {
    const u = new URL(raw, base);
    if (!isNotionUrl(u.href) || new URL(base).origin !== u.origin) return '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

/**
 * 숨긴 창 하나로 여러 페이지를 돈다. 창은 한 번만 만들어 돌려 쓴다 —
 * 페이지마다 새로 만들면 그것만으로 몇 초씩 더 걸린다.
 */
function createBrowser() {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1600, // 길쭉하게 — 노션은 화면에 보이는 만큼만 그리는 구간이 있다
    webPreferences: {
      offscreen: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      images: false, // 글만 필요하다 — 그림까지 받으면 몇 배 느리다
      backgroundThrottling: false,
    },
  });
  return win;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 한 페이지를 열어 **세 가지 방법으로** 글을 긁고, 하위 페이지 링크를 모은다.
 *
 * 어느 것을 쓸지는 여기서 안 정한다 — 부르는 쪽이 `pickBody`로 **실제 파서에 넣어
 * 보고** 고른다 (shared/notionDoc.js). 내가 노션 화면을 못 보는 상태에서 "이 선택자가
 * 맞다"에 기대지 않으려는 것이다.
 *
 * @returns {Promise<{ready: boolean, title: string,
 *                    candidates: Array<{how: string, markdown: string}>,
 *                    links: Array<{href: string, title: string}>, prepared: any}>}
 */
async function scrapePage(win, url, { timeout = RENDER_TIMEOUT } = {}) {
  await win.loadURL(url);
  const until = Date.now() + timeout;
  // 다 그려질 때까지 기다린다. did-finish-load 는 껍데기만 왔을 때 이미 뜬다.
  //
  // ★ 시간이 지나도 **던지지 않는다.** 던지면 글이 멀쩡히 그려져 있는데도 아무것도
  // 못 건지고 끝난다 — 페이지 모양이 예상과 다를 때가 바로 그 경우다. 일단 긁어
  // 보고, 아무것도 안 나오면 부르는 쪽이 화면을 떠서 남긴다 (그래야 고칠 수 있다).
  let ready = false;
  for (;;) {
    ready = await win.webContents.executeJavaScript(READY).catch(() => false);
    if (ready || Date.now() > until) break;
    await wait(250);
  }
  // 토글 펴고 끝까지 훑어 내린다 — 안 하면 조용히 절반만 긁힌다 (PREPARE 참고)
  const prepared = await win.webContents.executeJavaScript(PREPARE).catch(() => null);
  await wait(300);

  const run = (code) => win.webContents.executeJavaScript(code).catch(() => '');
  const [title, notion, semantic, plain, links] = await Promise.all([
    run(TITLE),
    run(EXTRACT_NOTION),
    run(EXTRACT_SEMANTIC),
    run(EXTRACT_PLAIN),
    win.webContents.executeJavaScript(LINKS).catch(() => []),
  ]);
  return {
    ready,
    title: String(title || ''),
    candidates: [
      { how: 'notion', markdown: String(notion || '') },
      { how: 'semantic', markdown: String(semantic || '') },
      { how: 'plain', markdown: String(plain || '') },
    ],
    links: Array.isArray(links) ? links : [],
    prepared,
  };
}

/**
 * 맨 위 페이지에서 시작해 하위 페이지를 따라가며 나무를 만든다.
 *
 * @param {string} url 노션 공개 페이지 주소
 * @param {{onProgress?: (done: number, title: string) => void, maxPages?: number,
 *          maxDepth?: number, timeout?: number, browser?: any}} [options]
 * @returns {Promise<{ok: boolean, error: string, page: any, pages: number,
 *                    how: Record<string, number>,
 *                    failed: Array<{url: string, title: string, error: string}>}>}
 *   how = 방법별로 몇 페이지가 뽑혔는지 (묶음 페이지까지 센다 — 화면에 보일 수는
 *         빌드 기준으로 따로 센다, index.js) · failed = 못 연 페이지
 *
 * 나무의 마디마다 `how`(뽑힌 방법)를 남기고, 못 연 페이지는 `failed: true` 마디로 남긴다.
 */
async function fetchTree(url, options = {}) {
  if (!isNotionUrl(url)) {
    return {
      ok: false,
      error: '노션 공개 페이지 주소(https://…notion.site/…)를 넣어주세요.',
      page: null,
      pages: 0,
      how: {},
      failed: [],
    };
  }
  const start = normalizeUrl(url);
  const maxPages = options.maxPages || MAX_PAGES;
  const maxDepth = options.maxDepth || MAX_DEPTH;
  const win = options.browser || createBrowser();
  const owned = !options.browser;
  const visited = new Set();
  /** @type {Record<string, number>} 방법별로 몇 페이지가 뽑혔는지 — 어느 길로 긁혔는지 보여주려고 */
  const how = {};
  /** @type {Array<{url: string, title: string, error: string}>} 못 연 페이지 — 조용히 삼키지 않는다 */
  const failed = [];
  let pages = 0;

  /**
   * @returns {Promise<any>} 페이지 마디. 이미 봤거나 한도를 넘었으면 null.
   *   못 열었으면 **`failed: true` 마디**를 돌려준다 — 부르는 쪽이 나무에 남기도록.
   */
  async function visit(pageUrl, depth, title = '') {
    const key = pageUrl.split('?')[0];
    if (visited.has(key) || pages >= maxPages || depth > maxDepth) return null;
    visited.add(key);
    pages += 1;
    // ★ **한 장이 실패해도 전체를 버리지 않는다.**
    //
    // 예전엔 여기에 try 가 없어서, 하위 페이지 한 장이 느리거나 못 열리면 그 예외가
    // 재귀를 뚫고 올라가 **수십 장 긁은 것이 통째로 0개가 됐다.** 바로 아래 주석이
    // "못 열었으면 제목만이라도 남긴다"인데 그 처리는 예외에는 닿지 않았다.
    let got;
    try {
      got = await scrapePage(win, pageUrl, { timeout: options.timeout });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ url: pageUrl, title, error });
      // 못 열었어도 **나무에 남긴다.** 예전엔 null 을 돌려줘서 제목조차 안 남았고,
      // 받기는 "성공"으로 끝나 그 아래 빌드들이 조용히 사라졌다 ("빌드가 안 보인다").
      // 이 마디를 보고 index.js 가 지난번 도감에서 그 자리를 되살리거나 ⚠ 로 보여준다.
      return { title: title || pageUrl, url: pageUrl, markdown: '', children: [], failed: true, error };
    }
    if (options.onProgress) options.onProgress(pages, got.title);
    // 세 방법 중 **실제로 제일 잘 읽히는 것**을 쓴다 (pickBody가 파서에 넣어 보고 고른다)
    const best = pickBody(got.candidates);
    how[best.how] = (how[best.how] || 0) + 1;
    /** @type {any} */
    const node = { title: got.title || title, url: pageUrl, markdown: best.markdown, how: best.how, children: [] };
    for (const link of got.links) {
      const next = resolveLink(link.href, pageUrl);
      if (!next) continue;
      const child = await visit(next, depth + 1, link.title);
      if (child) node.children.push(child);
    }
    return node;
  }

  try {
    const page = await visit(start, 0);
    const ok = Boolean(page) && !page.failed;
    const why = failed.length > 0 ? failed[0].error : '페이지를 못 읽었어요.';
    return { ok, error: ok ? '' : why, page: ok ? page : null, pages, how, failed };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `노션에서 도감을 못 받았어요: ${message}`, page: null, pages, how, failed };
  } finally {
    if (owned && !win.isDestroyed()) win.destroy();
  }
}

/**
 * 진단 자료 한 벌 — 실제 HTML과 **세 방법이 각각 뽑아낸 글**을 통째로 뜬다.
 *
 * 이게 이 기능의 생명줄이다. 개발하는 곳에서 notion.site 가 막혀 있어서, 안 긁힐 때
 * 고칠 방법이 이 파일 말고는 없다. HTML만 뜨면 "무엇이 왜 안 나왔는지"를 다시
 * 재현해야 하므로, 앱이 실제로 본 결과까지 같이 담는다.
 */
async function dumpDiagnostics(url, { timeout = RENDER_TIMEOUT } = {}) {
  // 아무 주소나 열지 않는다 — 부르는 쪽이 먼저 거르지만 여기서도 한 번 더 막는다.
  // 예전엔 주소 오타 하나에 20초를 기다린 뒤 노션과 무관한 페이지를 바탕화면에 떴다.
  if (!isNotionUrl(url)) throw new Error('노션 공개 페이지 주소가 아니에요.');
  const win = createBrowser();
  const address = normalizeUrl(url);
  try {
    const got = await scrapePage(win, address, { timeout }).catch((e) => ({
      title: '',
      candidates: [],
      links: [],
      prepared: null,
      error: e instanceof Error ? e.message : String(e),
    }));
    const html = await win.webContents
      .executeJavaScript('document.documentElement.outerHTML')
      .catch(() => '');
    const best = pickBody(got.candidates);
    return {
      url: address,
      title: got.title,
      prepared: got.prepared,
      error: /** @type {any} */ (got).error || '',
      picked: { how: best.how, stepCount: best.stepCount, strategy: best.strategy, groups: best.groups },
      candidates: (got.candidates || []).map((c) => ({ how: c.how, length: c.markdown.length, markdown: c.markdown })),
      links: got.links,
      html,
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = {
  fetchTree,
  scrapePage,
  createBrowser,
  dumpDiagnostics,
  isNotionUrl,
  normalizeUrl,
  resolveLink,
  PREPARE,
  EXTRACT_NOTION,
  EXTRACT_SEMANTIC,
  EXTRACT_PLAIN,
  LINKS,
  TITLE,
  READY,
};
