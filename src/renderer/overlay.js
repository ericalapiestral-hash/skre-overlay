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
  tickMs: 600,
  /** 마지막으로 잘라 온 화면 — [가르치기]가 쓴다 */
  lastFrame: null,
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

/** 엔진에 지금 단계 목록을 알리고, 돌려받은 것을 그린다 */
async function applyFlow({ keepIndex = false } = {}) {
  const build = currentBuild();
  const groups = build ? build.groups : [];
  const r = await api.engine.setFlow(groups, state.picks, { keepIndex });
  state.steps = r.steps;
  state.index = r.index;
  renderVariants();
  renderSteps();
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
  const branched = build ? build.groups.filter((g) => g.variants.length > 1) : [];
  wrap.classList.toggle('hidden', branched.length === 0);
  if (branched.length === 0) return;

  build.groups.forEach((group, gi) => {
    if (group.variants.length < 2) return;
    group.variants.forEach((variant, vi) => {
      const btn = document.createElement('button');
      btn.textContent = variant.label;
      btn.className = (state.picks[gi] ?? 0) === vi ? 'on' : '';
      btn.onclick = async () => {
        state.picks[gi] = vi;
        await applyFlow({ keepIndex: true });
      };
      wrap.appendChild(btn);
    });
  });
}

// ─────────────────────────────── 단계

function renderSteps() {
  const wrap = $('steps');
  const raw = $('raw');
  const build = currentBuild();
  wrap.replaceChildren();

  if (state.steps.length === 0) {
    wrap.classList.add('hidden');
    raw.classList.toggle('hidden', !build);
    if (build) $('raw-body').textContent = build.body || '(도감 본문이 비어 있어요)';
    return;
  }
  raw.classList.add('hidden');
  wrap.classList.remove('hidden');

  state.index = Math.max(0, Math.min(state.index, state.steps.length - 1));

  // 단계를 전부 그리고, 지금 할 것만 크게 강조한다.
  // 예전엔 앞뒤 몇 개만 보여줬는데, 그러면 "이 라운드에 뭐가 남았는지"를 볼 수 없어
  // 결국 창을 접었다 폈다 하게 된다. 목록은 스크롤되고 현재 단계로 자동으로 맞춘다.
  /** @type {HTMLElement|null} */
  let now = null;
  state.steps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = `step${i < state.index ? ' done' : i === state.index ? ' now' : ''}`;

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
    wrap.appendChild(row);
    if (i === state.index) now = row;
  });

  if (now) now.scrollIntoView({ block: 'center' });
}

/**
 * 손으로 단계를 옮긴다.
 * 자동을 끄지 않는다 — 엔진에도 새 위치를 알려 주므로, 한 번 밀어 놓고
 * 계속 자동으로 따라가게 둘 수 있다. (예전엔 손을 대면 자동이 꺼졌다)
 */
async function jumpTo(i) {
  if (state.steps.length === 0) return;
  state.index = Math.max(0, Math.min(i, state.steps.length - 1));
  renderSteps();
  await api.engine.setIndex(state.index);
}

const nav = (delta) => jumpTo(state.index + delta);

// ─────────────────────────────── 캡처

/** @type {MediaStream|null} */
let media = null;
let timer = null;
let busy = false;
/** toggleAuto가 비동기라 겹칠 수 있다 — 세대 번호로 늦게 도착한 호출을 무효화한다 */
let generation = 0;

function stopStream() {
  if (media) {
    for (const track of media.getTracks()) track.stop();
    media = null;
  }
  $('cap').srcObject = null;
}

function stopCapture() {
  if (timer) clearInterval(timer);
  timer = null;
  stopStream();
}

async function startCapture() {
  if (!state.region) throw new Error('턴 영역을 먼저 지정해주세요.');
  const src = await api.capture.source(state.region.displayId);
  if (!src) throw new Error('영역을 지정했던 모니터를 못 찾았어요 — 턴 영역을 다시 지정해주세요.');

  stopStream();
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
        maxFrameRate: 10,
      },
    },
  }));
  const video = $('cap');
  video.srcObject = media;
  await video.play();
}

/** RGBA → 회색조 (표준 휘도식) */
function toGray(rgba, length) {
  const gray = new Uint8Array(length);
  for (let i = 0, p = 0; p < length; i += 4, p += 1) {
    gray[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
  }
  return gray;
}

/** 지정 영역을 잘라 글자 높이가 96px 근처가 되도록 키운다 */
function cropFrame() {
  const video = $('cap');
  if (!video.videoWidth || !state.region) return null;
  const { fx, fy, fw, fh } = state.region;
  const sx = fx * video.videoWidth;
  const sy = fy * video.videoHeight;
  const sw = Math.max(4, fw * video.videoWidth);
  const sh = Math.max(4, fh * video.videoHeight);

  const scale = Math.max(1, Math.min(8, 96 / sh));
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

    if (r.turn !== null) $('turn').textContent = `${r.turn}턴`;
    if (r.index !== state.index) {
      state.index = r.index;
      renderSteps();
    }
    reportStatus(r);
  } catch (e) {
    if (state.auto && gen === generation) setStatus(`인식 오류: ${e.message}`, 'err');
  } finally {
    busy = false;
  }
}

/** 인식 상태를 사람 말로 — 안 될 때 뭘 해야 하는지까지 알려준다 */
function reportStatus(r) {
  if (r.turn === null) {
    if (r.misses >= 8) {
      setStatus('숫자를 못 읽고 있어요 — [턴 영역]을 숫자에 딱 맞게 다시 잡거나 [가르치기]를 눌러보세요.', 'err');
    } else {
      setStatus('턴 숫자를 찾는 중…', '');
    }
    return;
  }
  if (r.gap) {
    setStatus(`턴 표시 없음 (연출 중) — ${r.turn}턴에서 대기`, '');
    return;
  }
  if (r.misses >= 20) {
    setStatus('한참 턴을 못 읽고 있어요 — 오버레이 창이 숫자를 가리진 않았는지 보세요.', 'err');
    return;
  }
  setStatus(`인식 중 — ${r.turn}턴${r.snapped ? ' (빌드 턴에 맞춤)' : ''}`, 'on');
}

async function toggleAuto(on) {
  const gen = ++generation; // 이전에 걸려 있던 호출을 전부 무효화
  state.auto = on;
  $('auto').checked = on;
  $('auto-label').classList.toggle('on', on);

  if (!on) {
    stopCapture();
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
    if (timer) clearInterval(timer);
    timer = setInterval(tick, state.tickMs);
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
  $('teach-value').focus();
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
  if (state.auto) {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, state.tickMs);
  }
});
$('btn-pick-file').addEventListener('click', async () => {
  const r = await api.catalog.pickFile();
  if (r) await loadCatalog({ first: true });
});
$('btn-reveal').addEventListener('click', () => api.catalog.reveal());

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
  state.tickMs = config.tickMs || 600;

  $('opacity').value = String(config.opacity ?? 88);
  applyOpacity(config.opacity ?? 88);
  const scale = Math.round((config.scale ?? 1) * 100);
  $('scale').value = String(scale);
  applyScale(scale);
  $('tick').value = String(state.tickMs);
  $('tick-val').textContent = `${state.tickMs}ms`;

  await loadCatalog({ first: true });
  if (state.region) setStatus('턴 영역이 지정돼 있어요 — [자동]을 켜면 인식을 시작합니다.', '');
})();
