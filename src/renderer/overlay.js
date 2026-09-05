// 오버레이 화면 — 고르고, 그리고, 캡처한다. 판단은 하지 않는다.
//
// 인식·투표·단계 이동은 전부 메인의 엔진에 있다(src/main/engine.js).
// 여기 남은 건 "화면을 잘라 넘기고, 돌아온 결과를 그리는 것"뿐이다.
'use strict';

const api = window.overlay;

/**
 * 화면 요소 하나. 여긴 우리가 만든 HTML만 다루고 id도 전부 고정이라
 * 요소마다 타입을 다시 못 박는 것은 잡음만 늘린다 (로직은 전부 메인에 있다).
 * @returns {any}
 */
const $ = (id) => document.getElementById(id);

/** 요일 이름 — 공성전은 요일 보스라 오늘 것을 먼저 보여준다 */
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const state = {
  /** @type {any[]} 도감의 모든 빌드 (스킬 순서가 없는 것도 포함) */
  builds: [],
  tab: '',
  buildId: '',
  /** 그룹별 변형 선택 */
  picks: {},
  /** @type {Array<{turn:number,text:string,label:string}>} */
  steps: [],
  index: 0,
  auto: false,
  /** @type {{displayId:number, fx:number, fy:number, fw:number, fh:number}|null} */
  region: null,
  tickMs: 100,
  /** 실제로 요청한 캡처 장수 (초당) — 프레임을 흘려보낼 문턱의 기준 */
  captureFps: 10,
  /** 마지막으로 잘라 온 화면 — [가르치기]가 쓴다 */
  lastFrame: null,
  /** @type {number|null} 마지막으로 읽힌 턴 값 — [가르치기]에 미리 채워 준다 */
  lastRead: null,
  stats: null,
  file: '',
};

// ─────────────────────────────── 도감

async function loadCatalog({ first = false } = {}) {
  const r = await api.catalog.load();
  state.file = r.file || '';
  $('file-path').textContent = `도감: ${state.file || '(못 찾음)'}`;

  if (!r.ok) {
    state.builds = [];
    state.stats = null;
    renderTabs();
    renderBuildList();
    showEmpty(r.error);
    return;
  }
  hideEmpty();
  state.builds = r.builds;
  state.stats = r.stats;
  $('diag').textContent =
    `빌드 ${r.stats.total}개 · 스킬 순서 인식 ${r.stats.withSteps}개` +
    (r.stats.noSteps.length ? ` · 미인식 ${r.stats.noSteps.length}개(본문으로 표시)` : '') +
    (r.syncedAt ? ` · 갱신 ${String(r.syncedAt).slice(0, 16).replace('T', ' ')}` : '');

  const cats = categories();
  if (!cats.includes(state.tab)) state.tab = cats[0] || '';
  renderTabs();

  // 도감이 갱신됐을 뿐이면 보던 빌드·변형·진행 위치를 지킨다 — 전투 중일 수 있다
  if (!first && currentBuild()) {
    await applyFlow({ keepIndex: true });
    renderBuildList();
    return;
  }

  const config = await api.config.get();
  const remembered = config.lastBuildId
    ? state.builds.find((b) => b.id === config.lastBuildId)
    : null;
  if (remembered) {
    state.tab = remembered.category;
    renderTabs();
    await selectBuild(remembered.id, { save: false });
  } else {
    renderBuildList();
    await selectBuild(defaultBuildId(), { save: false });
  }
}

function categories() {
  const seen = [];
  for (const b of state.builds) if (!seen.includes(b.category)) seen.push(b.category);
  // 파괴신·공성전을 앞으로 (이 오버레이가 있는 이유다)
  const head = ['파괴신', '공성전'].filter((c) => seen.includes(c));
  return [...head, ...seen.filter((c) => !head.includes(c))];
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const cat of categories()) {
    const btn = document.createElement('button');
    btn.textContent = cat;
    btn.className = cat === state.tab ? 'on' : '';
    btn.onclick = async () => {
      state.tab = cat;
      renderTabs();
      renderBuildList();
      await selectBuild(defaultBuildId());
    };
    tabs.appendChild(btn);
  }
}

function visibleBuilds() {
  const q = $('search').value.trim().toLowerCase();
  return state.builds
    .filter((b) => b.category === state.tab)
    .filter(
      (b) =>
        !q ||
        b.label.toLowerCase().includes(q) ||
        b.name.toLowerCase().includes(q) ||
        b.group.toLowerCase().includes(q),
    );
}

/** 지금 탭에서 처음 고를 빌드 — 공성전은 오늘 요일 것을 먼저 */
function defaultBuildId() {
  const list = visibleBuilds();
  if (list.length === 0) return '';
  const today = WEEKDAYS[new Date().getDay()];
  const todays = list.find((b) => b.weekdays.includes(today));
  return (todays || list[0]).id;
}

function buildOptionText(b) {
  const day = b.weekdays.length ? `[${b.weekdays.join('·')}] ` : '';
  const mark = b.stepCount === 0 ? '⚠ ' : '';
  return `${mark}${day}${b.name}`;
}

function renderBuildList() {
  const select = $('build');
  const list = visibleBuilds();
  select.replaceChildren();

  for (const b of list) {
    const option = document.createElement('option');
    option.value = b.id;
    option.textContent = buildOptionText(b);
    select.appendChild(option);
  }

  if (list.some((b) => b.id === state.buildId)) {
    select.value = state.buildId;
    return;
  }
  // 지금 보는 빌드가 검색어·탭 때문에 목록에서 빠졌을 뿐이면 그대로 둔다
  // (한 글자 잘못 쳤다고 전투 중인 빌드가 바뀌면 안 된다)
  const cur = currentBuild();
  if (cur) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = `(보는 중: ${cur.name})`;
    select.prepend(placeholder);
  }
}

function currentBuild() {
  return state.builds.find((b) => b.id === state.buildId) || null;
}

/**
 * 엔진에 지금 보는 빌드를 알리고, 펼쳐진 단계를 돌려받아 그린다.
 *
 * 단계 자료는 메인이 들고 있고 여기로는 빌드 id만 넘긴다 — 도감 전체(본문·단계까지)를
 * 화면으로 나르면 빌드가 수백 개일 때 갱신마다 눈에 띄게 멈칫한다.
 */
async function applyFlow({ keepIndex = false } = {}) {
  const build = currentBuild();
  const r = await api.engine.setFlow(build ? build.id : '', state.picks, { keepIndex });
  state.steps = r.steps;
  state.index = r.index;
  renderVariants();
  await renderSteps();
}

async function selectBuild(id, { save = true } = {}) {
  if (!id) {
    state.buildId = '';
    state.picks = {};
    await applyFlow();
    return;
  }
  state.buildId = id;
  state.picks = {};
  const select = $('build');
  if (select.value !== id) select.value = id;
  await applyFlow();
  if (save) api.config.set({ lastBuildId: id });
}

// ─────────────────────────────── 분기

function renderVariants() {
  const wrap = $('variants');
  const build = currentBuild();
  wrap.replaceChildren();
  const branches = (build && build.branches) || [];
  wrap.classList.toggle('hidden', branches.length === 0);
  if (branches.length === 0) return;

  for (const branch of branches) {
    branch.labels.forEach((label, vi) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.className = (state.picks[branch.at] ?? 0) === vi ? 'on' : '';
      btn.onclick = async () => {
        state.picks[branch.at] = vi;
        await applyFlow({ keepIndex: true });
      };
      wrap.appendChild(btn);
    });
  }
}

// ─────────────────────────────── 단계

/** @type {HTMLElement[]} 그려 둔 단계 줄 — 위치만 바뀔 땐 이것만 손본다 */
let stepRows = [];

/**
 * 단계 목록을 처음부터 그린다. 빌드·변형이 바뀔 때만 부른다.
 *
 * 단계를 전부 그리고 지금 할 것만 크게 강조한다. 예전엔 앞뒤 몇 개만 보여줬는데,
 * 그러면 "이 라운드에 뭐가 남았는지"를 볼 수 없어 창을 접었다 폈다 하게 된다.
 */
async function renderSteps() {
  const wrap = $('steps');
  const raw = $('raw');
  const build = currentBuild();
  wrap.replaceChildren();
  stepRows = [];

  if (state.steps.length === 0) {
    wrap.classList.add('hidden');
    raw.classList.toggle('hidden', !build);
    if (build) {
      // 본문은 필요할 때만 받아 온다 — 도감 전체를 화면으로 나르면 갱신 때마다 멈칫한다
      $('raw-body').textContent = (await api.catalog.body(build.id)) || '(도감 본문이 비어 있어요)';
    }
    return;
  }
  raw.classList.add('hidden');
  wrap.classList.remove('hidden');

  const frag = document.createDocumentFragment();
  state.steps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'step';

    const turn = document.createElement('span');
    turn.className = 'turn';
    turn.textContent = `${step.turn}턴`;
    const act = document.createElement('span');
    act.className = 'act';
    act.textContent = step.text;
    const seg = document.createElement('span');
    seg.className = 'seg';
    seg.textContent = step.label;

    row.append(turn, act, seg);
    row.onclick = () => jumpTo(i);
    frag.appendChild(row);
    stepRows.push(row);
  });
  wrap.appendChild(frag);
  highlightStep();
}

/**
 * 지금 할 단계만 옮긴다.
 *
 * 자동 인식은 주기마다 도는데, 그때마다 줄을 전부 다시 만들면 화면이 깜빡이고
 * 스크롤이 튄다. 바뀌는 건 표시뿐이라 줄은 그대로 두고 표시만 옮긴다.
 */
function highlightStep() {
  if (stepRows.length === 0) return;
  state.index = Math.max(0, Math.min(state.index, stepRows.length - 1));
  stepRows.forEach((row, i) => {
    const cls = `step${i < state.index ? ' done' : i === state.index ? ' now' : ''}`;
    if (row.className !== cls) row.className = cls;
  });
  const now = stepRows[state.index];
  if (now) now.scrollIntoView({ block: 'center', behavior: 'instant' });
}

/**
 * 손으로 단계를 옮긴다.
 * 자동을 끄지 않는다 — 엔진에도 새 위치를 알려 주므로, 한 번 밀어 놓고
 * 계속 자동으로 따라가게 둘 수 있다. (예전엔 손을 대면 자동이 꺼졌다)
 */
async function jumpTo(i) {
  if (state.steps.length === 0) return;
  state.index = Math.max(0, Math.min(i, state.steps.length - 1));
  highlightStep();
  await api.engine.setIndex(state.index);
}

const nav = (delta) => jumpTo(state.index + delta);

// ─────────────────────────────── 캡처

/** @type {MediaStream|null} */
let media = null;
let timer = null;
/** 화면이 한동안 안 올 때를 대비한 안전줄 */
let watchdog = null;
/** requestVideoFrameCallback 핸들 */
let frameHandle = 0;
/** 마지막으로 인식을 돌린 시각 */
let lastProcessed = 0;
/** 실제 인식 간격(ms) — 평활한 값 */
let rateMs = 0;
let rateShownAt = 0;
let busy = false;
/** toggleAuto가 비동기라 겹칠 수 있다 — 세대 번호로 늦게 도착한 호출을 무효화한다 */
let generation = 0;
/** 회색조 버퍼는 크기가 안 바뀌는 한 다시 만들지 않는다 (프레임마다 버리면 쓰레기만 쌓인다) */
let grayBuffer = null;

function stopStream() {
  if (media) {
    for (const track of media.getTracks()) track.stop();
    media = null;
  }
  $('cap').srcObject = null;
}

function stopCapture() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  const video = $('cap');
  if (frameHandle && typeof video.cancelVideoFrameCallback === 'function') {
    video.cancelVideoFrameCallback(frameHandle);
  }
  frameHandle = 0;
  stopStream();
}

/**
 * 새 화면이 올 때마다 깨어나되, 인식은 주기마다 한 번만 돌린다.
 *
 * 예전엔 setInterval로 시간만 보고 돌렸다. 그러면 캡처가 초당 몇 장 안 올 때
 * **같은 화면을 두 번 읽는다** — 투표(vote.js)는 그걸 "두 프레임이 같게 읽혔다"로
 * 세어서, 한 번 잘못 읽은 화면을 확정해 버릴 수 있다. 이제 새 화면이 왔을 때만 센다.
 */
function pump() {
  if (!state.auto) return;
  const video = $('cap');
  if (typeof video.requestVideoFrameCallback === 'function') {
    frameHandle = video.requestVideoFrameCallback(onFrame);
  } else {
    timer = setTimeout(onFrame, state.tickMs);
  }
}

function onFrame() {
  frameHandle = 0;
  timer = null;
  if (!state.auto) return;
  const now = performance.now();

  // ★ 문턱은 **주기가 아니라 캡처 간격**을 기준으로 잡는다 (반 장 분량).
  //
  // 주기를 문턱으로 쓰면 읽는 속도가 반으로 깎인다: 캡처가 주기에 맞춰 오는데
  // 도착이 조금이라도 이르면 그 장을 흘려보내고 다음 장(두 배 뒤)을 기다리기 때문이다.
  // 우리가 정하는 건 캡처 장수이므로, 온 장은 다 읽는 게 맞다. 낮춰도 폭주하지 않는다 —
  // 장수 제약이 무시돼 훨씬 빨리 오는 환경에서도 이 문턱이 상한이 된다.
  if (now - lastProcessed >= 500 / state.captureFps) {
    measureRate(now);
    lastProcessed = now;
    tick();
  }
  pump();
}

/** 실제로 초당 몇 번 읽고 있는지 — 설정 패널에 보여준다 (정말 도는지 눈으로 확인하려고) */
function measureRate(now) {
  if (lastProcessed > 0) {
    const dt = now - lastProcessed;
    // 지수 평활 — 한 프레임 튀어도 숫자가 안 흔들린다
    rateMs = rateMs > 0 ? rateMs * 0.8 + dt * 0.2 : dt;
  }
  if (now - rateShownAt < 500) return;
  rateShownAt = now;
  $('rate').textContent = rateMs > 0 ? `실제 ${(1000 / rateMs).toFixed(1)}회/초` : '';
}

/**
 * 안전줄 — 화면이 한동안 안 오면 그냥 한 번 읽는다.
 *
 * requestVideoFrameCallback은 새 화면이 올 때만 부른다. 화면이 안 바뀌는 동안
 * 캡처가 새 장을 안 보내는 환경이 있는데, 그러면 콜백이 끊기고 **조용히 추적이
 * 멈춘다.** 오버레이는 그대로 떠 있어서 멈춘 줄도 모른다 — 그게 제일 나쁘다.
 */
function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  const gap = Math.max(1000, state.tickMs * 4);
  watchdog = setInterval(() => {
    if (!state.auto) return;
    if (performance.now() - lastProcessed < gap) return;
    lastProcessed = performance.now();
    tick();
    pump(); // 콜백이 끊겼을 수 있으니 다시 건다
  }, gap);
}

async function startCapture() {
  if (!state.region) throw new Error('턴 영역을 먼저 지정해주세요.');
  const src = await api.capture.source(state.region.displayId);
  if (!src) throw new Error('영역을 지정했던 모니터를 못 찾았어요 — 턴 영역을 다시 지정해주세요.');

  stopStream();
  // 화면을 통째로 받아 오는 일이라 초당 장수가 곧 시스템 부담이다.
  // 인식 주기와 **같게** 받는다 — 온 장은 다 읽으므로 이게 곧 인식 속도가 된다.
  const fps = Math.max(1, Math.min(20, Math.round(1000 / state.tickMs)));
  state.captureFps = fps;
  media = await navigator.mediaDevices.getUserMedia(/** @type {any} */ ({
    audio: false,
    video: {
      // ★ 크기를 못 박는 것이 핵심이다.
      // 안 주면 크로미움이 1280×720으로 줄여서 캡처한다 — 1440p·4K 화면에서는
      // 턴 숫자가 절반 이하로 뭉개져 어떤 인식기도 못 읽는다.
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: src.sourceId,
        minWidth: src.width,
        maxWidth: src.width,
        minHeight: src.height,
        maxHeight: src.height,
        maxFrameRate: fps,
      },
    },
  }));
  const video = $('cap');
  video.srcObject = media;
  await video.play();
}

/** RGBA → 회색조 (표준 휘도식). 버퍼는 크기가 같으면 다시 쓴다 */
function toGray(rgba, length) {
  if (!grayBuffer || grayBuffer.length !== length) grayBuffer = new Uint8Array(length);
  const gray = grayBuffer;
  for (let i = 0, p = 0; p < length; i += 4, p += 1) {
    gray[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
  }
  return gray;
}

/**
 * 지정 영역을 잘라 인식기가 좋아하는 높이로 키운다.
 * 목표 높이는 인식기 쪽(CROP_TARGET_HEIGHT)에 있다 — 재는 것과 실제가 어긋나지 않게.
 */
function cropFrame() {
  const video = $('cap');
  if (!video.videoWidth || !state.region) return null;
  const { fx, fy, fw, fh } = state.region;
  const sx = fx * video.videoWidth;
  const sy = fy * video.videoHeight;
  const sw = Math.max(4, fw * video.videoWidth);
  const sh = Math.max(4, fh * video.videoHeight);

  const scale = Math.max(1, Math.min(8, api.tune.cropHeight / sh));
  const canvas = /** @type {HTMLCanvasElement} */ ($('crop'));
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    gray: toGray(img.data, canvas.width * canvas.height),
    w: canvas.width,
    h: canvas.height,
    image: img,
  };
}

async function tick() {
  if (busy || !state.auto) return;
  const frame = cropFrame();
  if (!frame) return;
  state.lastFrame = frame;
  if (!$('teach').classList.contains('hidden')) drawTeachView();

  busy = true;
  const gen = generation;
  try {
    const r = await api.engine.feed(frame.gray, frame.w, frame.h);
    if (!state.auto || gen !== generation) return; // 기다리는 동안 상태가 바뀌었다

    // 최대 턴을 알아냈으면 화면에도 "16 / 70"으로 보여준다 — 인식이 슬래시를
    // 제대로 갈랐는지 사람이 한눈에 확인할 수 있는 자리다
    if (r.turn !== null) $('turn').textContent = r.max ? `${r.turn} / ${r.max}` : `${r.turn}턴`;
    if (r.raw !== null) state.lastRead = r.raw; // [가르치기]를 열 때 미리 채워 준다
    if (r.index !== state.index) {
      state.index = r.index;
      highlightStep();
    }
    reportStatus(r);
  } catch (e) {
    if (state.auto && gen === generation) setStatus(`인식 오류: ${e.message}`, 'err');
  } finally {
    busy = false;
  }
}

/** 인식 상태를 사람 말로 — 안 될 때 뭘 해야 하는지, 왜 안 움직이는지까지 알려준다 */
function reportStatus(r) {
  // 최대 턴과 안 맞아 버린 프레임 — "왜 안 넘어가지?"의 답이 되는 자리다.
  // 슬래시를 엉뚱한 데서 잘랐다는 뜻이라 그 프레임은 통째로 안 믿는다.
  if (r.dropped !== null && r.dropped !== undefined) {
    setStatus(`숫자가 최대 턴(${r.max})과 안 맞아 건너뜀 (${r.dropped}) — 잠시 뒤 다시 읽어요`, '');
    return;
  }
  if (r.turn === null) {
    if (r.hidden && r.hiddenMs >= 3000) {
      setStatus('숫자를 못 읽고 있어요 — [턴 영역]을 숫자에 딱 맞게 다시 잡거나 [가르치기]를 눌러보세요.', 'err');
    } else {
      setStatus('턴 숫자를 찾는 중…', '');
    }
    return;
  }
  if (r.hidden) {
    setStatus(
      r.hiddenMs >= 8000
        ? '한참 턴을 못 읽고 있어요 — 오버레이 창이 숫자를 가리진 않았는지 보세요.'
        : `턴 표시 없음 (연출 중) — ${r.turn}턴에서 대기`,
      r.hiddenMs >= 8000 ? 'err' : '',
    );
    return;
  }
  // 추적기가 일부러 안 움직이는 중이면 그 이유를 보여준다 — "왜 안 넘어가지?"를 없애려고
  const waiting = {
    'jump-wait': '크게 건너뛰는 중인지 확인 중',
    'reset-wait': '다음 라운드인지 확인 중',
    'restart-wait': '재시작인지 확인 중',
    'start-wait': '고른 라운드가 시작했는지 확인 중',
    pushback: '턴이 뒤로 밀림 — 단계 유지',
    hold: '엉뚱한 숫자 — 단계 유지',
  }[r.why];
  setStatus(
    `인식 중 — ${r.turn}턴${waiting ? ` · ${waiting}` : ''}`,
    'on',
  );
}

async function toggleAuto(on) {
  const gen = ++generation; // 이전에 걸려 있던 호출을 전부 무효화
  state.auto = on;
  $('auto').checked = on;
  $('auto-label').classList.toggle('on', on);

  if (!on) {
    stopCapture();
    $('rate').textContent = '';
    setStatus(state.region ? '자동 꺼짐 — 켜면 턴을 읽습니다.' : '턴 영역을 아직 지정하지 않았어요.', '');
    return;
  }
  try {
    await startCapture();
    if (gen !== generation || !state.auto) {
      stopStream(); // 이 호출이 만든 스트림은 이 호출이 치운다
      return;
    }
    await api.engine.reset();
    lastProcessed = 0; // 켜자마자 한 장 읽는다 (한 주기를 기다리지 않게)
    rateMs = 0;
    pump();
    startWatchdog();
    setStatus('인식 중…', 'on');
  } catch (e) {
    if (gen !== generation) return;
    state.auto = false;
    $('auto').checked = false;
    $('auto-label').classList.remove('on');
    stopCapture();
    setStatus(e.message, 'err');
  }
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

// ─────────────────────────────── 숫자 가르치기

function drawTeachView() {
  const frame = state.lastFrame;
  const view = /** @type {HTMLCanvasElement} */ ($('teach-view'));
  view.classList.toggle('hidden', !frame);
  if (!frame) return;
  view.width = frame.w;
  view.height = frame.h;
  view.getContext('2d').putImageData(frame.image, 0, 0);
}

function openTeach() {
  $('teach').classList.remove('hidden');
  $('teach-msg').textContent = '';
  if (!state.lastFrame) {
    // 자동이 꺼져 있어도 한 장은 잡아 보여준다 — 뭘 가르치는지 눈으로 보게
    const frame = cropFrame();
    if (frame) state.lastFrame = frame;
  }
  drawTeachView(); // 잡힌 화면이 없으면 미리보기 자체를 숨긴다 (빈 검은 상자보다 낫다)
  if (!state.lastFrame) teachMsg('먼저 [턴 영역]을 지정하고 [자동]을 한 번 켜주세요.', 'err');

  // 지금 읽고 있는 값을 미리 넣어 준다 — 맞으면 그대로 [가르치기], 틀리면 고쳐서 누르면 된다.
  // 가르치기는 "인식이 이상할 때" 여는 것이라, 맞는 값을 매번 손으로 치게 하면
  // 귀찮아서 안 쓰게 된다. 정답은 어차피 사람이 확인한다.
  const input = /** @type {HTMLInputElement} */ ($('teach-value'));
  if (!input.value && state.lastRead !== null) {
    input.value = String(state.lastRead);
    input.select();
  }
  input.focus();
}

function teachMsg(text, cls) {
  const el = $('teach-msg');
  el.textContent = text;
  el.className = cls || '';
}

async function saveTeach() {
  const frame = state.lastFrame;
  if (!frame) return teachMsg('보여줄 화면이 없어요 — [자동]을 한 번 켜주세요.', 'err');
  const value = $('teach-value').value.trim();
  const r = await api.engine.teach(frame.gray, frame.w, frame.h, value);
  if (!r.ok) return teachMsg(r.error, 'err');
  $('teach-value').value = '';
  teachMsg(`숫자 ${r.added}개를 배웠어요 (모두 ${r.total}개). 이제 이 화면에서 훨씬 잘 읽습니다.`, 'ok');
}

// ─────────────────────────────── 빈 상태

function showEmpty(message) {
  const el = $('empty');
  el.classList.remove('hidden');
  el.replaceChildren();
  const p = document.createElement('div');
  p.textContent = message;
  const btn = document.createElement('button');
  btn.textContent = 'builds.json 직접 선택';
  btn.onclick = async () => {
    const r = await api.catalog.pickFile();
    if (r && r.ok) await loadCatalog({ first: true });
  };
  el.append(p, btn);
}

const hideEmpty = () => $('empty').classList.add('hidden');

// ─────────────────────────────── 설정

function applyOpacity(v) {
  document.documentElement.style.setProperty('--bg-alpha', String(v / 100));
}

function applyScale(v) {
  document.documentElement.style.setProperty('--scale', String(v / 100));
}

// ─────────────────────────────── 배선

$('build').addEventListener('change', (e) => selectBuild(e.target.value));
$('search').addEventListener('input', renderBuildList);
$('search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = visibleBuilds()[0];
  if (first) selectBuild(first.id);
});

$('btn-prev').addEventListener('click', () => nav(-1));
$('btn-next').addEventListener('click', () => nav(1));
$('btn-region').addEventListener('click', () => api.region.open());

/**
 * 기본 위치로 맞춘다 (파괴신·공성전은 턴이 늘 왼쪽 위 같은 자리에 있다).
 * @param {boolean} [save] 설정에 저장할지 — 앱이 알아서 쓴 경우엔 저장하지 않는다
 */
async function usePreset(save = true) {
  const preset = api.region.presets[0];
  if (!preset) return;
  state.region = { displayId: state.region ? state.region.displayId : undefined, ...preset.region };
  if (save) await api.config.set({ turnRegion: state.region });
  if (state.auto) {
    await toggleAuto(false);
    await toggleAuto(true);
  }
}

$('btn-preset').addEventListener('click', async () => {
  await usePreset();
  setStatus(`${api.region.presets[0].label} 자리로 맞췄어요 — 안 맞으면 [턴 영역]으로 직접 잡으세요.`, '');
});
$('auto').addEventListener('change', (e) => toggleAuto(e.target.checked));

$('btn-teach').addEventListener('click', () => {
  const teach = $('teach');
  if (teach.classList.contains('hidden')) {
    $('settings').classList.add('hidden');
    openTeach();
  } else {
    teach.classList.add('hidden');
  }
});
$('teach-close').addEventListener('click', () => $('teach').classList.add('hidden'));
$('teach-save').addEventListener('click', saveTeach);
$('teach-value').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveTeach();
});
$('teach-forget').addEventListener('click', async () => {
  await api.engine.forget();
  teachMsg('가르친 숫자를 모두 지웠어요. 기본 대조표만 씁니다.', '');
});

$('btn-settings').addEventListener('click', () => {
  // 한 번에 하나만 — 둘 다 열면 정작 단계가 안 보인다
  $('teach').classList.add('hidden');
  $('settings').classList.toggle('hidden');
});
$('opacity').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  applyOpacity(v);
  api.config.set({ opacity: v });
});
$('scale').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  applyScale(v);
  api.config.set({ scale: v / 100 });
});
$('tick').addEventListener('input', (e) => {
  state.tickMs = Number(e.target.value);
  $('tick-val').textContent = `${state.tickMs}ms`;
  api.config.set({ tickMs: state.tickMs });
  // 주기는 바로 반영된다. 캡처 장수는 다음에 [자동]을 켤 때 맞춰진다 —
  // 전투 중에 스트림을 다시 여는 것이 더 손해다.
});
$('btn-pick-file').addEventListener('click', async () => {
  const r = await api.catalog.pickFile();
  if (r) await loadCatalog({ first: true });
});
$('btn-reveal').addEventListener('click', () => api.catalog.reveal());

// 전투 기록 저장 — 이상한 걸 본 **뒤에** 누르는 버튼이다. 기록은 자동이 도는 동안
// 늘 담기고 있으므로 미리 켜 둘 필요가 없다 (src/main/recorder.js 참고).
$('btn-record').addEventListener('click', async () => {
  const msg = $('record-msg');
  msg.textContent = '저장 중…';
  const r = await api.diag.save();
  if (!r.ok) {
    msg.textContent = r.error;
    return;
  }
  const secs = Math.round(r.spanMs / 1000);
  msg.textContent = `바탕화면에 저장했어요 (${secs}초 · 표본 ${r.samples}장)`;
  api.diag.reveal(r.file);
});

$('btn-collapse').addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('collapsed');
  $('btn-collapse').textContent = collapsed ? '▸' : '▾';
  // CSS로만 숨기면 투명한 창이 그대로 게임 클릭을 막는다 — 창 자체를 제목줄 높이로 줄인다
  api.win.collapse(collapsed);
});
$('btn-quit').addEventListener('click', () => api.win.quit());

api.keys.onNav((delta) => nav(delta));
api.keys.onAutoToggle(() => toggleAuto(!state.auto));
api.keys.onFailed((combos) =>
  setStatus(`⚠️ 단축키 사용 불가: ${combos.join(', ')} (다른 프로그램이 사용 중)`, 'err'),
);
api.win.onClickThrough((on) => $('lock').classList.toggle('hidden', !on));
api.catalog.onUpdated(() => loadCatalog());
api.region.onPicked(async (region) => {
  state.region = region;
  setStatus('턴 영역을 지정했어요 — [자동]을 켜면 인식을 시작합니다.', '');
  if (state.auto) {
    await toggleAuto(false);
    await toggleAuto(true);
  }
});

// 창을 닫을 때 캡처 스트림을 정리한다
window.addEventListener('beforeunload', stopCapture);

// ─────────────────────────────── 시작

(async () => {
  const config = await api.config.get();
  state.region = config.turnRegion || null;
  // 아직 한 번도 안 잡았으면 기본 위치로 시작한다 — 켜자마자 바로 써 볼 수 있게.
  // 저장은 안 한다: 사용자가 고른 값과 앱이 짐작한 값을 섞으면, 다음에 기본값을
  // 고쳤을 때 이미 저장돼 버린 옛 값에 발이 묶인다.
  const usingPreset = !state.region;
  if (usingPreset) await usePreset(false);
  state.tickMs = config.tickMs || 100;

  $('opacity').value = String(config.opacity ?? 88);
  applyOpacity(config.opacity ?? 88);
  const scale = Math.round((config.scale ?? 1) * 100);
  $('scale').value = String(scale);
  applyScale(scale);
  $('tick').value = String(state.tickMs);
  $('tick-val').textContent = `${state.tickMs}ms`;

  await loadCatalog({ first: true });
  if (usingPreset) {
    setStatus(`${api.region.presets[0].label} 자리로 시작합니다 — [자동]을 켜 보세요.`, '');
  } else if (state.region) {
    setStatus('턴 영역이 지정돼 있어요 — [자동]을 켜면 인식을 시작합니다.', '');
  }
})();
