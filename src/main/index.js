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
const {
  loadTemplates,
  binarize,
  components,
  digitBoxes,
  cropBitmap,
  normalize,
  gridToRows,
} = require('../shared/turnReader');

const BUILTIN = loadTemplates(require('../shared/templates.json'));
const DOCTOR = process.argv.includes('--doctor');
// 화면 없이 "앱이 진짜로 뜨는지"만 확인하는 모드 — test/smoke.test.js가 쓴다.
// 단위 테스트는 순수 로직만 보므로 Electron·창·프리로드·IPC가 부러진 건 아무도 못 잡는다.
const SMOKE = process.argv.includes('--smoke');

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
    result.error =
      '도감 파일(builds.json)을 못 찾았어요. 길드봇 폴더를 바탕화면에 두고 한 번 실행했는지 보시고, 그래도 안 되면 파일을 직접 골라주세요.';
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
    const displays = screen.getAllDisplays();
    const display =
      displays.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();

    let match = sources.find((s) => String(s.display_id) === String(displayId));
    // 모니터가 하나뿐이면 display_id가 비는 환경이 있다. 여러 개인데 못 찾은 거면
    // 엉뚱한 모니터를 조용히 읽게 되므로 오류를 낸다.
    if (!match && sources.length === 1) match = sources[0];
    if (!match) return null;

    const scale = display.scaleFactor || 1;
    return {
      sourceId: match.id,
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    };
  });

  ipcMain.on('overlay:click-through', (_e, on) => {
    // 해제 단축키가 등록 안 된 상태에서 켜면 영영 못 끄게 된다
    if (on && shortcutFailures.includes('Control+Alt+L')) {
      overlayWin?.webContents.send('shortcuts:failed', [
        ...shortcutFailures,
        '(클릭 통과를 켤 수 없어요 — 해제 단축키가 막혀 있음)',
      ]);
      return;
    }
    setClickThrough(Boolean(on));
  });

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
    recorder.setFlow(engine.flow, { build: build ? build.name : '', buildId, picks });
    return r;
  });
  ipcMain.handle('engine:index', (_e, i) => {
    const index = engine.setIndex(i);
    recorder.manual(index);
    return index;
  });
  ipcMain.handle('engine:reset', () => {
    engine.reset();
    recorder.note('자동 껐다 켬');
    return true;
  });
  // 구조적 복제로 이미 Uint8Array가 넘어온다 — 한 번 더 복사하면 프레임마다 헛일이다
  ipcMain.handle('engine:feed', (_e, buf, w, h) => {
    const gray = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const r = engine.feed(gray, w, h);
    recorder.frame(r, { gray, w, h });
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
    const stamp = new Date()
      .toLocaleString('sv-SE')
      .replace(/[-: ]/g, '')
      .slice(0, 13);
    const dir = app.getPath('desktop');
    const file = path.join(dir, `skre-기록-${stamp}.json`);
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

    const gray = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    for (const bright of [true, false]) {
      const boxes = digitBoxes(components(binarize(gray, w, h, bright), w, h), h, 3);
      if (boxes.length !== text.length) continue;
      const added = boxes.map((box, i) => ({
        d: Number(text[i]),
        rows: gridToRows(normalize(cropBitmap(box, w))),
      }));
      const config = store.load();
      const userTemplates = [...(config.userTemplates || []), ...added];
      store.save({ userTemplates });
      engine.setTemplates(BUILTIN, userTemplates);
      return { ok: true, added: added.length, total: userTemplates.length };
    }
    return {
      ok: false,
      error: `화면에서 숫자 ${text.length}개를 못 찾았어요. 영역을 숫자에 더 딱 맞게 다시 잡아주세요.`,
    };
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
  if (failed.length === 0) return;
  console.warn(`[단축키] 다른 프로그램이 사용 중이라 등록 실패: ${failed.join(', ')}`);
  shortcutFailures = failed;
  overlayWin?.webContents.once('did-finish-load', () => {
    overlayWin?.webContents.send('shortcuts:failed', failed);
  });
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
  return 0;
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
            cropHeight: api && api.tune && api.tune.cropHeight,
            elements: ['app', 'steps', 'status', 'build', 'auto', 'rate']
              .filter((id) => document.getElementById(id)),
            statusText: (document.getElementById('status') || {}).textContent || '',
          };
          // 진짜 IPC 왕복 — 프리로드 다리와 메인 핸들러를 같이 확인한다
          try {
            const cat = await api.catalog.load();
            out.catalog = { ok: Boolean(cat && cat.ok), builds: (cat && cat.builds || []).length };
          } catch (e) { out.catalog = { error: String(e && e.message || e) }; }
          try {
            const cfg = await api.config.get();
            out.config = cfg && typeof cfg === 'object' ? Object.keys(cfg).sort() : null;
          } catch (e) { out.config = { error: String(e && e.message || e) }; }
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

// 두 벌이 같이 뜨면 전역 단축키를 서로 뺏어 둘 다 안 듣는다
if (!DOCTOR && !app.requestSingleInstanceLock()) {
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
