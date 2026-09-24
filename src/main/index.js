// SKRE 오버레이 — 메인 프로세스.
// 투명 항상-위 창, 전역 단축키, 화면 캡처 소스, 도감 읽기, 인식 엔진을 담당한다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
} = require('electron');

const { createStore } = require('./config');
const { resolvePath, loadCatalog, watchCatalog, candidatePaths } = require('./catalog');
const { createEngine } = require('./engine');
const { createRecorder } = require('./recorder');
const { fetchTree, dumpDiagnostics, isNotionUrl } = require('./notion');
const { toCatalog } = require('../shared/notionDoc');
const { parseBuild } = require('../shared/steps');
const { pickSource } = require('../shared/capture');
const { loadTemplates, fitCrop } = require('../shared/turnReader');

const BUILTIN = loadTemplates(require('../shared/templates.json'));
const DOCTOR = process.argv.includes('--doctor');
// 화면 없이 "앱이 진짜로 뜨는지"만 확인하는 모드 — test/smoke.test.js가 쓴다.
// 단위 테스트는 순수 로직만 보므로 Electron·창·프리로드·IPC가 부러진 건 아무도 못 잡는다.
const SMOKE = process.argv.includes('--smoke');
// 노션 긁는 기계를 시험용 페이지로 한 번 돌려 본다 (test/notionScrape.test.js)
// 여러 번 주면 **창 하나로 차례로** 긁는다 — 앱이 창 하나로 수십 장을 도는 것과 같게
const NOTION_SELFTEST = process.argv
  .filter((a) => a.startsWith('--notion-selftest='))
  .map((a) => a.slice('--notion-selftest='.length));

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');

/** @type {BrowserWindow|null} */
let overlayWin = null;
/** @type {BrowserWindow|null} */
let pickerWin = null;
/** @type {{close: () => void}|null} */
let watcher = null;
let clickThrough = false;
let shortcutFailures = [];
/** 접기 전의 창 높이 (펼칠 때 복원) */
let expandedHeight = null;

let store = null;
let engine = null;
/** 전투 기록 — 자동이 도는 동안 늘 담아 둔다 (src/main/recorder.js 의 "왜 필요한가") */
let recorder = null;
/** 마지막으로 읽은 도감 — 본문과 단계 자료는 여기 남고 화면으로는 안 나간다 */
let catalog = null;

// ─────────────────────────────── 바탕화면에 남기는 파일

/**
 * 바탕화면 파일 자리 — `skre-기록-20260904-153012.json` 처럼 **초까지** 넣는다.
 *
 * 예전엔 `toLocaleString` 에서 기호를 지우고 13자로 잘라서 "분 + 초의 십의 자리"라는
 * 어중간한 이름(2026090415301)이 됐다. 문서 예시와 달라 사람이 파일을 찾을 때 헷갈렸고,
 * 10초 안에 두 번 누르면 앞 파일을 조용히 덮어썼다. 같은 이름이 있으면 `-2` 를 붙인다.
 */
function desktopFile(prefix, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-` +
    `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const dir = app.getPath('desktop');
  let file = path.join(dir, `${prefix}-${stamp}.json`);
  for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir, `${prefix}-${stamp}-${n}.json`);
  return file;
}

// ─────────────────────────────── 도감

function catalogEnv() {
  return {
    isPackaged: app.isPackaged,
    appDir: path.join(__dirname, '..', '..'),
    exeDir: path.dirname(app.getPath('exe')),
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || '',
    home: os.homedir(),
  };
}

function currentCatalog() {
  const { buildsPath } = store.load();
  const { file, found, tried } = resolvePath(buildsPath, catalogEnv());
  const result = loadCatalog(file);
  if (!result.ok && !found) {
    // 자동으로 찾다 실패한 경우엔 "어디를 봤는지"까지 알려주는 편이 훨씬 낫다
    // 앱에는 도감이 안 들어 있다 (길드 내부 자료라 배포판에서 뺀다). 그래서 이건
    // "고장"이 아니라 **처음 쓰는 사람이 당연히 보는 화면**이다 — 넣는 길을 알려준다.
    result.error =
      '아직 도감이 없어요. 설정(⚙)에서 노션 도감 주소를 넣거나, builds.json 파일을 직접 골라주세요.';
  }
  return { ...result, tried };
}

/**
 * 화면에 보낼 가벼운 목록.
 *
 * 도감 전체(빌드마다 본문 수 KB + 펼친 단계 자료)를 통째로 넘기면 빌드가 수백 개일 때
 * 갱신마다 몇 MB가 오간다 — 전투 중에 눈에 띄게 멈칫한다. 화면이 실제로 쓰는 건
 * 목록에 필요한 몇 글자와 분기 이름뿐이다. 단계와 본문은 필요할 때 id로 물어본다.
 */
function lightCatalog(c) {
  return {
    ok: c.ok,
    file: c.file,
    error: c.error,
    syncedAt: c.syncedAt,
    stats: c.stats,
    builds: c.builds.map((b) => ({
      id: b.id,
      name: b.name,
      label: b.label,
      category: b.category,
      group: b.group,
      weekdays: b.weekdays,
      stepCount: b.stepCount,
      strategy: b.strategy,
      warnings: b.warnings || [],
      // 변형이 둘 이상인 그룹만 — 칩을 그리는 데 필요한 것뿐
      branches: b.groups
        .map((g, at) => ({ at, labels: g.variants.map((v) => v.label) }))
        .filter((g) => g.labels.length > 1),
    })),
  };
}

/** 도감을 다시 읽어 메인에 담아 둔다 */
function refreshCatalog() {
  catalog = currentCatalog();
  return catalog;
}

function buildById(id) {
  if (!catalog) refreshCatalog();
  return (catalog.builds || []).find((b) => b.id === id) || null;
}

function rewatch() {
  if (watcher) watcher.close();
  watcher = null;
  const { buildsPath } = store.load();
  const { file } = resolvePath(buildsPath, catalogEnv());
  if (!file) return;
  watcher = watchCatalog(file, () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('catalog:updated');
  });
}

// ─────────────────────────────── 창

/** 저장된 창 위치가 지금 연결된 모니터 안에 있는지 — 아니면 기본 위치로 */
function visibleBounds(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return null;
  const rect = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width || 400,
    height: bounds.height || 470,
  };
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      rect.x < a.x + a.width - 40 &&
      rect.x + rect.width > a.x + 40 &&
      rect.y < a.y + a.height - 40 &&
      rect.y + rect.height > a.y + 40
    );
  });
  return onScreen ? rect : null;
}

function createOverlay() {
  const config = store.load();
  // 모니터를 분리했거나 해상도가 바뀌면 저장된 좌표가 화면 밖일 수 있다.
  // 이 창은 작업표시줄에도 Alt+Tab에도 없어서, 밖에 생기면 되찾을 방법이 없다.
  const pos = visibleBounds(config.winBounds);

  overlayWin = new BrowserWindow({
    width: (config.winBounds && config.winBounds.width) || 400,
    height: (config.winBounds && config.winBounds.height) || 470,
    x: pos ? pos.x : undefined,
    y: pos ? pos.y : undefined,
    minWidth: 300,
    minHeight: 260,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  overlayWin.once('ready-to-show', () => overlayWin && overlayWin.show());

  const remember = () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const bounds = overlayWin.getBounds();
    // 접힌 높이를 저장하면 다음에 켤 때 쪼그라든 채로 뜬다 — 펼친 높이로 기억한다
    if (expandedHeight) bounds.height = expandedHeight;
    store.save({ winBounds: bounds });
  };
  overlayWin.on('moved', remember);
  overlayWin.on('resized', remember);
  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

function setClickThrough(on) {
  clickThrough = on;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setIgnoreMouseEvents(on, { forward: true });
  overlayWin.webContents.send('overlay:click-through', on);
}

// ─────────────────────────────── 턴 영역 고르기

/**
 * 영역을 고르는 동안만 ESC를 전역으로 잡는다.
 * 게임에 포커스가 있는 채로 창을 띄우면 윈도우가 포커스를 안 넘겨줘 keydown이 오지 않는다.
 */
let escGrabbed = false;

function grabEscape() {
  if (escGrabbed) return;
  escGrabbed = globalShortcut.register('Escape', closePicker);
}

function releaseEscape() {
  if (!escGrabbed) return;
  globalShortcut.unregister('Escape');
  escGrabbed = false;
}

function closePicker() {
  releaseEscape();
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
}

function openPicker() {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.focus();
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  pickerWin = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    fullscreen: false, // bounds로 이미 화면을 덮는다 (fullscreen은 다중 모니터에서 엉킨다)
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(PRELOAD, 'picker.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  pickerWin.setAlwaysOnTop(true, 'screen-saver');
  pickerWin.loadFile(path.join(RENDERER, 'picker.html'));
  pickerWin.webContents.once('did-finish-load', () => {
    if (!pickerWin || pickerWin.isDestroyed()) return;
    pickerWin.webContents.send('picker:init', { displayId: display.id });
    // 게임에서 포커스를 뺏어 와야 창 안의 ESC가 동작한다
    pickerWin.show();
    pickerWin.focus();
    pickerWin.webContents.focus();
  });
  grabEscape(); // 포커스를 못 가져온 경우를 대비한 안전줄
  pickerWin.on('closed', () => {
    pickerWin = null;
    releaseEscape();
  });
}

// ─────────────────────────────── IPC

function registerIpc() {
  ipcMain.handle('catalog:load', () => lightCatalog(refreshCatalog()));

  /** 스킬 순서를 못 읽은 빌드를 본문 그대로 보여줄 때만 쓴다 */
  ipcMain.handle('catalog:body', (_e, id) => {
    const build = buildById(id);
    return build ? build.body : '';
  });

  ipcMain.handle('catalog:pick-file', async () => {
    const r = await dialog.showOpenDialog({
      title: '도감 파일(builds.json) 선택',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    store.save({ buildsPath: r.filePaths[0] });
    rewatch();
    return lightCatalog(refreshCatalog());
  });

  /**
   * 노션에서 도감을 받아 온다 — 숨긴 창으로 페이지를 열어 글을 긁는다 (main/notion.js).
   *
   * 받은 것은 **길드봇이 만들던 builds.json 과 같은 모양**으로 userData 에 저장하고,
   * buildsPath 가 그 파일을 가리키게 한다. 그래서 이 아래로는 손댈 것이 없다 —
   * 파일 도감이든 노션 도감이든 catalog.js 부터는 똑같이 흐른다.
   */
  // 받기는 몇십 초 걸린다. 그 사이 Enter 를 한 번 더 누르면 숨긴 창이 하나 더 떠서
  // 같은 도감을 두 번 긁었다 (단추만 막고 입력칸 Enter 는 안 막았다). 여기서 한 번 더 막는다.
  let syncing = false;
  ipcMain.handle('catalog:sync-notion', async (_e, url) => {
    if (syncing) return { ok: false, error: '이미 받는 중이에요. 끝날 때까지 기다려 주세요.' };
    syncing = true;
    try {
      return await syncNotion(url);
    } finally {
      syncing = false;
    }
  });

  async function syncNotion(url) {
    const address = String(url || '').trim() || store.load().notionUrl;
    if (!address) return { ok: false, error: '노션 도감 주소를 먼저 넣어주세요.' };

    const send = (channel, payload) => {
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
    };
    // ★ 주소는 **실패해도 저장한다.**
    //
    // 예전엔 성공했을 때만 저장해서, 한 번 실패하면 앱을 다시 켤 때 입력칸이 비었다.
    // 그러면 [페이지 저장]마저 "주소를 먼저 넣어주세요"가 뜬다 — 정작 고칠 자료를
    // 뜨려는 참인데. 잘 되는 길보다 **안 될 때의 길**이 막히면 안 된다.
    store.save({ notionUrl: address });

    // 노션 주소가 아니면 **덤프 없이** 곧바로 돌려준다. 예전엔 주소 오타 하나에 20초를
    // 기다린 뒤 노션과 무관한 페이지를 바탕화면에 뜨고 "이 파일을 주시면 고칠 수
    // 있습니다"라고 했다 — 고칠 것은 파일이 아니라 주소다.
    if (!isNotionUrl(address)) {
      return {
        ok: false,
        error: '노션 공개 페이지 주소가 아니에요. 노션에서 [공유 → 웹에 게시]한 주소(…notion.site/…)를 넣어주세요.',
      };
    }

    const got = await fetchTree(address, {
      onProgress: (done, title) => send('catalog:sync-progress', { done, title }),
    });
    if (!got.ok || !got.page) {
      const dumped = await saveNotionDump(address);
      return {
        ok: false,
        pages: got.pages,
        error:
          got.error +
          (dumped ? ` 화면을 떠서 바탕화면에 뒀어요 — 이 파일을 주시면 고칠 수 있습니다: ${dumped}` : ''),
      };
    }

    const file = path.join(app.getPath('userData'), 'builds-notion.json');
    // 지난번에 받아 둔 도감 — 이번에 못 연 페이지 자리를 여기서 되살린다 (notionDoc.toCatalog)
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      previous = null; // 처음 받는 것이면 없다
    }
    const built = toCatalog(got.page, { previous });
    if (built.builds.length === 0) {
      // 여기서 조용히 성공했다고 하면 안 된다 — 빈 도감이 남고 원인을 못 찾는다.
      //
      // 그리고 **화면을 떠서 바탕화면에 남긴다.** 노션이 화면을 어떻게 그리는지는
      // 이 저장소 안에서 확인할 방법이 없어서(개발하는 곳에서 notion.site 접속이
      // 막혀 있다), 선택자를 고치려면 실제 HTML이 있어야 한다. 전투 기록과 같은
      // 이유·같은 자리다 — 사람이 찾아서 보내 줄 수 있어야 쓸모가 있다.
      const dumped = await saveNotionDump(address);
      return {
        ok: false,
        pages: got.pages,
        error:
          `페이지는 열렸는데 빌드를 하나도 못 찾았어요 (페이지 ${got.pages}개). 주소가 도감 맨 위 페이지가 맞는지 봐주세요.` +
          (dumped ? ` 화면을 떠서 바탕화면에 뒀어요 — 이 파일을 주시면 고칠 수 있습니다: ${dumped}` : ''),
      };
    }

    try {
      // restored·missing 은 화면에 알리는 값이라 파일에는 안 쓴다 (builds.json 모양 그대로)
      const { title, syncedAt, builds } = built;
      fs.writeFileSync(file, JSON.stringify({ title, syncedAt, builds }, null, 1), 'utf8');
    } catch (e) {
      return { ok: false, error: `받아온 도감을 저장하지 못했어요: ${e instanceof Error ? e.message : e}` };
    }
    store.save({ notionUrl: address, buildsPath: file });
    refreshCatalog();
    rewatch();
    // 도감 자체는 안 돌려준다 — 화면이 catalog:load 로 가벼운 목록만 다시 받는다.
    //
    // how 는 **단계를 읽어낸 빌드만** 어느 방법으로 긁혔는지 센다. 예전엔 방문한 페이지
    // 전부를 셌는데, 링크만 있는 묶음 페이지는 늘 'plain'으로 뽑혀서(노션 방법은 하위
    // 페이지 블록의 글을 안 싣는다) "plain 10"이 **묶음 페이지 수**였을 뿐인데도 선택자가
    // 밀린 것처럼 보였다. 빌드 기준으로 세면 'notion' 이 아닌 게 있을 때만 진짜 신호다.
    const how = {};
    let noSteps = 0;
    for (const b of built.builds) {
      if (b.stale || b.failed) continue;
      if (parseBuild(b.body).stepCount === 0) {
        noSteps += 1;
        continue;
      }
      const k = b.how || '?';
      how[k] = (how[k] || 0) + 1;
    }
    return {
      ok: true,
      pages: got.pages,
      builds: built.builds.length,
      how,
      noSteps,
      // ★ 못 연 페이지를 **화면에 알린다.** 예전엔 여기서 버려서 "빌드 N개를 받았어요"만
      // 떴고, 그 아래 빌드들이 사라진 걸 아무도 몰랐다.
      failed: got.failed.length,
      failedTitles: got.failed.slice(0, 3).map((f) => f.title || f.url),
      restored: built.restored,
      missing: built.missing,
    };
  }

  /**
   * 노션 페이지를 **떠서 바탕화면에 저장한다.**
   *
   * ★ 이게 이 기능의 생명줄이다. 개발하는 곳에서 notion.site 가 막혀 있어서, 안 긁힐 때
   * 고칠 방법이 이 파일 말고는 없다. 실제 HTML과 **세 방법이 각각 뽑아낸 글**을 같이
   * 담으므로, 무엇이 왜 안 나왔는지를 그 파일 하나로 알 수 있다.
   * (전투 기록과 같은 이유·같은 자리다 — 사람이 찾아서 보내 줄 수 있어야 쓸모가 있다.)
   */
  async function saveNotionDump(address) {
    if (!isNotionUrl(address)) return '';
    try {
      const diag = await dumpDiagnostics(address);
      const file = desktopFile('skre-노션');
      fs.writeFileSync(file, JSON.stringify(diag, null, 1), 'utf8');
      return file;
    } catch {
      return ''; // 뜨는 데 실패해도 부르는 쪽 메시지는 나가야 한다
    }
  }

  ipcMain.handle('catalog:dump-notion', async (_e, url) => {
    const address = String(url || '').trim() || store.load().notionUrl;
    if (!address) return { ok: false, error: '노션 도감 주소를 먼저 넣어주세요.' };
    if (!isNotionUrl(address)) return { ok: false, error: '노션 공개 페이지 주소가 아니에요 (…notion.site/…).' };
    const file = await saveNotionDump(address);
    return file
      ? { ok: true, file }
      : { ok: false, error: '페이지를 못 떴어요. 주소가 맞는지, 인터넷이 되는지 봐주세요.' };
  });

  ipcMain.handle('catalog:reveal', () => {
    const { file } = catalog || refreshCatalog();
    if (file && fs.existsSync(file)) shell.showItemInFolder(file);
    return Boolean(file);
  });

  ipcMain.handle('config:get', () => store.load());
  ipcMain.handle('config:set', (_e, patch) => store.save(patch || {}));

  ipcMain.handle('picker:open', () => openPicker());
  ipcMain.on('picker:done', (_e, region) => {
    // region: { displayId, fx, fy, fw, fh } — 화면 대비 비율(0~1)이라 해상도가 바뀌어도 안전
    store.save({ turnRegion: region });
    closePicker();
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('turn:region', region);
  });
  ipcMain.on('picker:cancel', () => closePicker());

  /**
   * 캡처에 쓸 화면 소스 + **그 화면의 실제 픽셀 크기**.
   *
   * ★ 이 크기를 렌더러가 캡처 제약(maxWidth/maxHeight)에 그대로 넣어야 한다.
   * 안 넣으면 크로미움이 1280×720으로 줄여서 캡처한다 — 1440p·4K 화면에서는
   * 턴 숫자가 절반 이하로 뭉개져 어떤 인식기도 못 읽는다. 옛 오버레이의
   * "자동 인식이 부정확하다"의 진짜 원인이 이거였다. **지우지 말 것.**
   */
  ipcMain.handle('capture:source', async (_e, displayId) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    // 고르는 규칙은 shared/capture.js 에 순수 함수로 있다 — 모니터가 여럿인 PC가
    // 여기 없어서, 목록을 손으로 지어 넣는 테스트로만 잠글 수 있기 때문이다.
    return pickSource({
      displayId,
      sources,
      displays: screen.getAllDisplays(),
      primaryId: screen.getPrimaryDisplay().id,
    });
  });

  /**
   * 등록 못 한 단축키 — 화면이 **다 뜬 뒤에 물어본다.**
   *
   * 예전엔 창이 뜰 때 한 번 밀어 보냈는데, 화면은 곧이어 도감을 읽고 상태줄을
   * "… 자리로 시작합니다"로 덮어써서 경고가 눈 깜빡할 새 사라졌다. 다시 볼 길도 없었다.
   */
  ipcMain.handle('keys:failures', () => shortcutFailures);

  /** 접기/펼치기 — CSS로만 숨기면 투명해도 창 전체가 클릭을 막아서, 창 자체를 줄인다 */
  ipcMain.on('overlay:collapse', (_e, collapsed) => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const bounds = overlayWin.getBounds();
    if (collapsed) {
      expandedHeight = bounds.height;
      overlayWin.setMinimumSize(300, 40);
      overlayWin.setBounds({ ...bounds, height: 40 });
    } else {
      overlayWin.setMinimumSize(300, 260);
      overlayWin.setBounds({ ...bounds, height: expandedHeight || 470 });
      expandedHeight = null;
    }
  });

  ipcMain.on('overlay:quit', () => app.quit());

  // ── 인식 엔진
  // 화면은 빌드 id만 보낸다 — 단계 자료는 여기 있는 것을 쓴다
  ipcMain.handle('engine:flow', (_e, buildId, picks, opts) => {
    const build = buildById(buildId);
    const r = engine.setFlow(build ? build.groups : [], picks, opts);
    // 단계가 그대로면(도감 파일만 다시 읽힘) 기록을 **이어 간다.** 예전엔 도감이 갱신될
    // 때마다 기록이 통째로 지워져서, 이상한 걸 보고 [전투 기록 저장]을 눌러도 비어 있었다.
    if (r.same) recorder.note('도감 갱신', undefined, { index: engine.index });
    else recorder.setFlow(engine.flow, { build: build ? build.name : '', buildId, picks }, engine.index);
    return r;
  });
  ipcMain.handle('engine:index', (_e, i) => {
    const index = engine.setIndex(i);
    recorder.manual(index);
    return index;
  });
  ipcMain.handle('engine:reset', () => {
    engine.reset();
    // reset 표시를 꼭 같이 남긴다 — 이걸 빼면 되돌려 볼 때만 옛 기억을 들고 가서
    // 궤적이 그때와 달라진다 (rest 와 같은 구멍이었다. recorder.js 의 Frame 참고)
    recorder.note('자동 껐다 켬', undefined, { reset: true, index: engine.index });
    return true;
  });
  // 구조적 복제로 이미 Uint8Array가 넘어온다 — 한 번 더 복사하면 프레임마다 헛일이다
  ipcMain.handle('engine:feed', (_e, buf, w, h) => {
    // 화면은 **원본 크기로** 잘라 넘긴다. 인식기가 읽는 높이로 맞추는 일은 여기서 —
    // 벤치와 같은 함수(fitCrop)로 한다. 캔버스로 키우면 벤치가 재는 그림과 달라진다.
    const fit = fitCrop(buf instanceof Uint8Array ? buf : new Uint8Array(buf), w, h);
    const r = engine.feed(fit.gray, fit.w, fit.h);
    // 기록에는 **엔진이 본 그림**을 남긴다 — 되돌려 볼 때 같은 것을 다시 읽어야 한다
    recorder.frame(r, fit);
    return r;
  });

  ipcMain.handle('diag:state', () => ({
    frames: recorder.frameCount,
    samples: recorder.sampleCount,
    spanMs: recorder.spanMs,
  }));

  /**
   * 전투 기록 저장 — 바탕화면에 JSON 한 장.
   *
   * 바탕화면에 두는 이유: 이 파일은 사람이 찾아서 보내 줘야 쓸모가 있다.
   * userData 안에 두면 경로를 설명하는 것부터 일이다.
   */
  ipcMain.handle('diag:save', () => {
    if (!recorder.frameCount) return { ok: false, error: '기록된 프레임이 없어요. 자동을 켜고 잠시 둔 뒤 눌러 주세요.' };
    const file = desktopFile('skre-기록');
    try {
      fs.writeFileSync(file, JSON.stringify(recorder.dump(), null, 1));
    } catch (e) {
      return { ok: false, error: `저장 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    return {
      ok: true,
      file,
      frames: recorder.frameCount,
      samples: recorder.sampleCount,
      spanMs: recorder.spanMs,
    };
  });

  ipcMain.handle('diag:reveal', (_e, file) => {
    if (file) shell.showItemInFolder(file);
    return true;
  });

  /**
   * 숫자 가르치기 — 실제 게임 화면에서 뽑은 모양을 대조표에 넣는다.
   * 기본 대조표는 흔한 폰트로 만든 것이라 게임 폰트와 조금씩 다르다.
   * 한 번 가르치면 그 사람 화면에서는 어떤 기본 폰트보다 정확해진다.
   */
  ipcMain.handle('engine:teach', (_e, buf, w, h, value) => {
    const text = String(value).trim();
    if (!/^\d{1,3}$/.test(text)) return { ok: false, error: '0~999 사이 숫자를 넣어주세요.' };

    // 인식할 때와 **같은 크기로** 맞춰서 가르친다 (engine:feed 참고)
    const fit = fitCrop(buf instanceof Uint8Array ? buf : new Uint8Array(buf), w, h);
    // 자르는 일은 엔진이 인식기와 **같은 길**로 한다 (engine.teachFrom 의 설명 참고)
    const got = engine.teachFrom(fit.gray, fit.w, fit.h, text);
    if (!got.ok) {
      return {
        ok: false,
        error: got.found
          ? `화면에서 숫자를 ${got.found}개 찾았는데 ${got.want}개라고 하셨어요. 적은 값이 맞는지, 영역이 턴 숫자에 맞는지 봐주세요.`
          : '화면에서 숫자를 못 찾았어요. [턴 영역]을 턴 숫자에 더 딱 맞게 다시 잡아주세요.',
      };
    }
    const config = store.load();
    const userTemplates = [...(config.userTemplates || []), ...got.templates];
    store.save({ userTemplates });
    engine.setTemplates(BUILTIN, userTemplates);
    return { ok: true, added: got.templates.length, total: userTemplates.length };
  });

  ipcMain.handle('engine:forget', () => {
    store.save({ userTemplates: [] });
    engine.setTemplates(BUILTIN, []);
    return true;
  });
}

// ─────────────────────────────── 단축키

/** @type {Array<[string, () => void]>} */
const SHORTCUTS = [
  ['Control+Alt+O', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (overlayWin.isVisible()) overlayWin.hide();
    else overlayWin.show();
  }],
  // 클릭 통과는 **이 단축키로만** 켜고 끈다. 그래서 이게 등록 안 됐으면 켤 길도 없어서
  // "켰는데 못 끄는" 일이 안 생긴다. 화면에 켜는 단추를 달 거면 그 전에 이 단축키가
  // 등록됐는지(shortcutFailures) 먼저 볼 것 — 안 그러면 클릭이 전부 게임으로 새는 창에 갇힌다.
  ['Control+Alt+L', () => setClickThrough(!clickThrough)],
  ['Control+Alt+R', () => openPicker()],
  ['Control+Alt+Right', () => overlayWin?.webContents.send('step:nav', 1)],
  ['Control+Alt+Left', () => overlayWin?.webContents.send('step:nav', -1)],
  ['Control+Alt+Space', () => overlayWin?.webContents.send('auto:toggle')],
];

function registerShortcuts() {
  const failed = [];
  for (const [combo, handler] of SHORTCUTS) {
    if (!globalShortcut.register(combo, handler)) failed.push(combo);
  }
  shortcutFailures = failed;
  // 화면에는 화면이 물어볼 때 알린다 (keys:failures) — 여기서 밀어 보내면 시작 문구에 덮인다
  if (failed.length > 0) console.warn(`[단축키] 다른 프로그램이 사용 중이라 등록 실패: ${failed.join(', ')}`);
}

// ─────────────────────────────── 자가 점검 (--doctor)

function doctor() {
  const env = catalogEnv();
  const cat = refreshCatalog();
  console.log('── SKRE 오버레이 자가 점검 ──');
  console.log(`설정 파일 : ${store.file}`);
  console.log(`대조표    : 기본 ${BUILTIN.length}개 + 가르친 것 ${(store.load().userTemplates || []).length}개`);

  if (!cat.ok) {
    console.log(`도감      : ✗ ${cat.error}`);
    console.log('찾아본 자리:');
    for (const p of candidatePaths(env)) console.log(`  · ${p}`);
    return 1;
  }

  console.log(`도감      : ✓ ${cat.file}`);
  console.log(`동기화    : ${cat.syncedAt || '(기록 없음)'}`);
  console.log(
    `빌드      : ${cat.stats.total}개 · 스킬 순서 인식 ${cat.stats.withSteps}개 · 미인식 ${cat.stats.noSteps.length}개`,
  );
  const byCategory = {};
  for (const b of cat.builds) byCategory[b.category] = (byCategory[b.category] || 0) + 1;
  console.log(`구분      : ${JSON.stringify(byCategory)}`);
  if (cat.stats.noSteps.length > 0) {
    console.log('스킬 순서를 못 읽은 빌드 (본문은 그대로 보여줍니다):');
    for (const name of cat.stats.noSteps.slice(0, 20)) console.log(`  · ${name}`);
    if (cat.stats.noSteps.length > 20) console.log(`  … 외 ${cat.stats.noSteps.length - 20}개`);
  }
  // 파서가 무언가를 버리거나 바꾼 빌드 — 순서는 읽었지만 일부를 각주로 보거나 라운드를 나눴다
  const warned = cat.builds.filter((b) => b.warnings && b.warnings.length > 0);
  if (warned.length > 0) {
    console.log(`\n순서는 읽었지만 일부를 다르게 본 빌드 (${warned.length}개):`);
    for (const b of warned.slice(0, 20)) console.log(`  · ${b.name} — ${b.warnings.join(' / ')}`);
  }
  return 0;
}

/**
 * --notion-selftest=<주소> — 노션 긁는 기계를 한 번 돌려 결과를 한 줄 JSON으로 뱉는다.
 *
 * **진짜 노션은 여기서 못 연다** (개발 환경에서 notion.site 가 막혀 있다). 그렇다고
 * 기계 전체를 한 번도 안 돌려 보고 내보낼 수는 없어서, 노션의 **성질만** 흉내 낸
 * 시험용 페이지로 확인한다 — 자바스크립트로 그려지고, 토글이 접혀 있고, 바닥까지
 * 내려가야 붙는 부분이 있는 페이지다 (test/fixtures/notion-page.html).
 *
 * 여기서 걸리는 것: 숨긴 창에서 JS 가 안 도는 경우, executeJavaScript 가 막히는 경우,
 * PREPARE 가 토글을 못 펴거나 스크롤이 안 먹는 경우, 추출 스크립트의 문법 오류.
 *
 * ★ 주소를 여러 개 받으면 **창 하나로 차례로** 긁는다. 앱(fetchTree)이 창 하나로
 * 수십 장을 돌기 때문이다. 예전엔 새 프로세스의 첫 장 하나만 긁었는데, 숨긴 창은
 * **둘째 장부터** 화면 갱신이 더 드물어져서 늦게 붙는 부분을 더 자주 놓쳤다 — 시험은
 * 앱이 겪지 않는 가장 좋은 조건만 재고 있었다 (이 프로젝트가 네 번째로 한 실수).
 */
async function notionSelftest(urls) {
  const { createBrowser, scrapePage } = require('./notion');
  const { pickBody } = require('../shared/notionDoc');
  const win = createBrowser();
  const pages = [];
  let error = '';
  try {
    for (const url of urls) {
      const got = await scrapePage(win, url, { timeout: 15000 });
      const best = pickBody(got.candidates);
      pages.push({
        url,
        title: got.title,
        prepared: got.prepared,
        links: got.links,
        picked: { how: best.how, stepCount: best.stepCount, strategy: best.strategy, groups: best.groups },
        candidates: got.candidates.map((c) => ({ how: c.how, markdown: c.markdown })),
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const out = { ok: !error, error, pages };
  // 창을 닫기 **전에** 뱉는다 — 마지막 창이 닫히면 window-all-closed 가 앱을 끝낸다
  process.stdout.write(`\nSKRE_NOTION ${JSON.stringify(out)}\n`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(out.ok ? 0 : 1);
}

// ─────────────────────────────── 시작

/**
 * --smoke — 화면 없이 앱을 한 번 띄워 보고 결과를 한 줄 JSON으로 뱉고 끝낸다.
 *
 * 확인하는 것은 단위 테스트가 절대 못 보는 층이다: Electron이 뜨는가, 창이 생기는가,
 * 프리로드가 다리를 놓았는가, 렌더러가 에러 없이 그려졌는가, 그리고 **렌더러에서
 * 실제 IPC를 부르면 메인이 답하는가**. 채널 이름 오타나 프리로드 경로 실수는
 * 여기서만 걸린다 — 순수 로직 테스트는 전부 통과한 채로 앱이 안 뜰 수 있다.
 */
function smoke() {
  const errors = [];
  const win = overlayWin;
  if (!win) {
    process.stdout.write('\nSKRE_SMOKE {"ok":false,"errors":["창을 못 만들었다"]}\n');
    app.exit(1);
    return;
  }
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message) => {
    // 2 = warning, 3 = error
    if (level >= 3) errors.push(message);
  });
  wc.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
  wc.on('render-process-gone', (_e, d) => errors.push(`render-process-gone ${d.reason}`));
  wc.on('preload-error', (_e, file, err) => errors.push(`preload-error ${file} ${err.message}`));

  const finish = (result) => {
    process.stdout.write(`\nSKRE_SMOKE ${JSON.stringify(result)}\n`);
    app.exit(result.ok ? 0 : 1);
  };

  wc.once('did-finish-load', () => {
    // 렌더러가 첫 그림을 그릴 틈을 주고 나서 안을 들여다본다
    setTimeout(() => {
      wc.executeJavaScript(
        `(async () => {
          const api = window.overlay;
          const out = {
            bridge: api ? Object.keys(api).sort() : null,
            elements: ['app', 'steps', 'status', 'build', 'auto', 'rate']
              .filter((id) => document.getElementById(id)),
            statusText: (document.getElementById('status') || {}).textContent || '',
            presets: api && api.region && api.region.presets ? api.region.presets.map((p) => p.id) : null,
          };
          // 진짜 IPC 왕복 — 프리로드 다리와 메인 핸들러를 같이 확인한다
          try {
            const cat = await api.catalog.load();
            out.catalog = { ok: Boolean(cat && cat.ok), builds: (cat && cat.builds || []).length };
          } catch (e) { out.catalog = { error: String(e && e.message || e) }; }
          try {
            const cfg = await api.config.get();
            out.config = cfg && typeof cfg === 'object' ? Object.keys(cfg).sort() : null;
            // 앱이 알아서 쓴 기본 위치는 설정에 **안 남아야** 한다 (다음에 기본값을 고치면 닿게)
            out.turnRegion = cfg ? cfg.turnRegion : 'missing';
          } catch (e) { out.config = { error: String(e && e.message || e) }; }
          // 채널을 몇 개 더 왕복시킨다. 이름이 맞는지는 test/ipc.test.js 가 글자로 전부 맞대
          // 보고, 여기서는 **실제로 불러서 답이 오는지**를 본다 — 특히 capture:source 는
          // 죽으면 [자동]이 통째로 죽는데, 예전엔 여기서 안 불러서 이름을 바꿔도 초록이었다.
          try {
            const src = await api.capture.source(undefined);
            out.capture = src ? { id: typeof src.sourceId, width: src.width, height: src.height } : null;
          } catch (e) { out.capture = { error: String(e && e.message || e) }; }
          try {
            out.body = await api.catalog.body('smoke-2');
            out.keys = await api.keys.failures();
            const t = await api.engine.teach(new Uint8Array(80 * 40).fill(28), 80, 40, '12');
            out.teach = { ok: t.ok, error: typeof t.error };
            const d = await api.diag.state();
            out.diag = Object.keys(d).sort();
          } catch (e) { out.more = { error: String(e && e.message || e) }; }
          try {
            await api.engine.setFlow(null, {});
            const r = await api.engine.feed(new Uint8Array(80 * 40).fill(28), 80, 40);
            out.engine = { fed: Boolean(r && typeof r.index === 'number'), turn: r && r.turn };
          } catch (e) { out.engine = { error: String(e && e.message || e) }; }
          return out;
        })()`,
      )
        .then((probe) => {
          finish({
            ok: errors.length === 0,
            window: { created: true, visible: win.isVisible(), alwaysOnTop: win.isAlwaysOnTop() },
            probe,
            // 헤드리스(xvfb)에는 창 관리자가 없어 전역 단축키가 안 잡힐 수 있다 — 참고용
            shortcutFailures,
            errors,
          });
        })
        .catch((e) => finish({ ok: false, errors: [...errors, `probe: ${e.message}`] }));
    }, 1500);
  });

  setTimeout(() => finish({ ok: false, errors: [...errors, '시간 초과 — 창이 안 떴다'] }), 30000);
}

// 게임 위에 뜨는 도구라 GPU 가속 문제로 투명창이 검게 나오는 기기가 있다
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 두 벌이 같이 뜨면 전역 단축키를 서로 뺏어 둘 다 안 듣는다.
// 노션 자가 시험은 잠금을 안 잡는다 — 잡으면 개발자가 앱을 켜 둔 채 시험하거나 시험이
// 두 벌 겹칠 때 늦게 뜬 쪽이 **아무 말 없이** 끝나서 "결과를 안 남겼다"로 빨개진다.
const SOLO = DOCTOR || NOTION_SELFTEST.length > 0;
if (!SOLO && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.show();
    overlayWin.focus();
  });

  app.whenReady().then(() => {
    store = createStore(app.getPath('userData'));
    engine = createEngine({ templates: BUILTIN });
    recorder = createRecorder();
    engine.setTemplates(BUILTIN, store.load().userTemplates || []);

    if (DOCTOR) {
      app.exit(doctor());
      return;
    }
    // 노션 자가 시험에는 오버레이·단축키·도감 감시가 필요 없다 — 띄우면 개발자의 실제
    // 설정과 도감을 읽으며 CPU를 나눠 써서 재는 조건만 흐린다
    if (NOTION_SELFTEST.length > 0) {
      notionSelftest(NOTION_SELFTEST);
      return;
    }

    registerIpc();
    createOverlay();
    rewatch();
    registerShortcuts();
    if (SMOKE) smoke();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (watcher) watcher.close();
  });
  app.on('window-all-closed', () => app.quit());
}
