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
// 이 저장소가 도는 곳에서는 notion.site 접속이 막혀 있다. 처음 돌려 보고 안 긁히면
// `--notion-dump` 로 실제 HTML을 떠서 고칠 것 (아래 dumpHtml).
'use strict';

const { BrowserWindow } = require('electron');

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
const EXTRACT = `(() => {
  const PREFIX = {
    header: '# ', sub_header: '## ', sub_sub_header: '### ',
    bulleted_list: '- ', numbered_list: '1. ', to_do: '- ',
    toggle: '- ', quote: '> ', callout: '> ',
  };
  const root =
    document.querySelector('.notion-page-content') ||
    document.querySelector('main') ||
    document.body;

  /** 이 블록 자신의 글만 (안에 든 다른 블록의 글은 뺀다) */
  const ownText = (el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('[class*="-block"]').forEach((n) => n.remove());
    return (copy.textContent || '').replace(/\\u00a0/g, ' ').trim();
  };
  const kindOf = (el) => {
    const m = String(el.className || '').match(/notion-([a-z_]+)-block/);
    return m ? m[1] : '';
  };

  const lines = [];
  const links = [];
  const seenHref = new Set();

  const walk = (el, depth) => {
    for (const child of el.children) {
      const kind = kindOf(child);
      if (!kind) {
        walk(child, depth);
        continue;
      }
      if (kind === 'page' || kind === 'collection_view' || kind === 'link_to_page') {
        // 하위 페이지 — 글이 아니라 "저기도 가 봐라"는 표시다
        for (const a of child.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href') || '';
          const title = (a.textContent || '').trim();
          if (!href || seenHref.has(href) || !title) continue;
          seenHref.add(href);
          links.push({ href, title });
        }
        walk(child, depth);
        continue;
      }
      const text = ownText(child);
      if (text) {
        const pad = '  '.repeat(Math.min(depth, 6));
        if (kind === 'code') lines.push('\`\`\`', text, '\`\`\`');
        else if (kind === 'table' || kind === 'table_row') lines.push(pad + text);
        else lines.push(pad + (PREFIX[kind] || '') + text);
      }
      walk(child, PREFIX[kind] && PREFIX[kind].trim().endsWith('.') ? depth + 1 : depth + (kind.endsWith('_list') || kind === 'toggle' ? 1 : 0));
    }
  };
  walk(root, 0);

  // 표는 위 walk 로는 줄이 흩어진다 — 행 단위로 다시 모은다
  for (const table of document.querySelectorAll('.notion-table-block, .notion-collection_view-block table')) {
    for (const row of table.querySelectorAll('tr, [role="row"]')) {
      const cells = [...row.querySelectorAll('td, th, [role="cell"], [role="columnheader"]')]
        .map((c) => (c.textContent || '').trim())
        .filter(Boolean);
      if (cells.length > 1) lines.push(cells.join(' | '));
    }
  }

  const titleEl =
    document.querySelector('.notion-page-block .notion-page-title-text') ||
    document.querySelector('[placeholder="Untitled"]') ||
    document.querySelector('h1');
  const title = ((titleEl && titleEl.textContent) || document.title || '').trim();

  return { title, markdown: lines.join('\\n'), links, blocks: lines.length };
})()`;

/** 페이지가 다 그려졌는지 — 노션은 껍데기부터 오므로 글이 생길 때까지 기다린다 */
const READY = `(() => {
  const c = document.querySelector('.notion-page-content');
  if (c && c.children.length > 0) return true;
  return document.querySelectorAll('[class*="notion-"][class*="-block"]').length > 0;
})()`;

/** 노션 주소인가 — 아무 주소나 열지 않는다 */
function isNotionUrl(url) {
  try {
    const u = new URL(String(url));
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
 * 한 페이지를 열어 글과 하위 페이지 목록을 긁는다.
 * @returns {Promise<{title: string, markdown: string, links: Array<{href: string, title: string}>, blocks: number}>}
 */
async function scrapePage(win, url, { timeout = RENDER_TIMEOUT } = {}) {
  await win.loadURL(url);
  const until = Date.now() + timeout;
  // 다 그려질 때까지 기다린다. did-finish-load 는 껍데기만 왔을 때 이미 뜬다.
  for (;;) {
    const ready = await win.webContents.executeJavaScript(READY).catch(() => false);
    if (ready) break;
    if (Date.now() > until) throw new Error('페이지가 다 안 그려졌어요 (노션이 느리거나 주소가 잘못됐을 수 있어요).');
    await wait(250);
  }
  // 그려진 뒤에도 늦게 붙는 블록이 있다 — 한 박자 쉬고 긁는다
  await wait(400);
  return win.webContents.executeJavaScript(EXTRACT);
}

/**
 * 맨 위 페이지에서 시작해 하위 페이지를 따라가며 나무를 만든다.
 *
 * @param {string} url 노션 공개 페이지 주소
 * @param {{onProgress?: (done: number, title: string) => void, maxPages?: number,
 *          maxDepth?: number, timeout?: number, browser?: any}} [options]
 * @returns {Promise<{ok: boolean, error: string, page: any, pages: number}>}
 */
async function fetchTree(url, options = {}) {
  if (!isNotionUrl(url)) {
    return { ok: false, error: '노션 공개 페이지 주소(https://…notion.site/…)를 넣어주세요.', page: null, pages: 0 };
  }
  const maxPages = options.maxPages || MAX_PAGES;
  const maxDepth = options.maxDepth || MAX_DEPTH;
  const win = options.browser || createBrowser();
  const owned = !options.browser;
  const visited = new Set();
  let pages = 0;

  async function visit(pageUrl, depth) {
    const key = pageUrl.split('?')[0];
    if (visited.has(key) || pages >= maxPages || depth > maxDepth) return null;
    visited.add(key);
    pages += 1;
    const got = await scrapePage(win, pageUrl, { timeout: options.timeout });
    if (options.onProgress) options.onProgress(pages, got.title);
    /** @type {any} */
    const node = { title: got.title, url: pageUrl, markdown: got.markdown, children: [] };
    for (const link of got.links) {
      const next = resolveLink(link.href, pageUrl);
      if (!next) continue;
      const child = await visit(next, depth + 1);
      // 못 열었으면 제목만이라도 남긴다 — 통째로 사라지는 것보다 낫다
      if (child) node.children.push(child);
    }
    return node;
  }

  try {
    const page = await visit(url, 0);
    return { ok: Boolean(page), error: page ? '' : '페이지를 못 읽었어요.', page, pages };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `노션에서 도감을 못 받았어요: ${message}`, page: null, pages };
  } finally {
    if (owned && !win.isDestroyed()) win.destroy();
  }
}

/** 안 긁힐 때 실제 HTML을 떠 보는 길 — 선택자를 고치려면 이게 있어야 한다 */
async function dumpHtml(url, { timeout = RENDER_TIMEOUT } = {}) {
  const win = createBrowser();
  try {
    await win.loadURL(url);
    await wait(timeout / 2);
    return await win.webContents.executeJavaScript('document.documentElement.outerHTML');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { fetchTree, scrapePage, createBrowser, dumpHtml, isNotionUrl, resolveLink, EXTRACT, READY };
