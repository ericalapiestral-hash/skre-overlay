// 화면까지 통째로 돌려 보는 시험의 Electron 쪽 (test/e2e.test.js 가 띄운다).
//
// **진짜 main·preload·renderer 를 그대로** 띄우고, 그 뒤에 가짜 "게임 화면" 창을 깐다.
// 화면 왼쪽 위에 `0 / 30` 같은 글자를 그려 두고 바꿔 가며, 오버레이가 실제로 화면을
// 캡처해 잘라 읽고 단계를 옮기는지 본다. 판단(엔진)은 Node 테스트가 이미 보지만,
// 그 사이 — 캡처·자르기·그리기·단추 — 는 여기서만 걸린다.
//
// 결과는 한 줄 JSON(`SKRE_E2E {...}`)으로 뱉고, 확인은 테스트 파일이 한다.
'use strict';

const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

/** @type {Record<string, any>} */
const out = { errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {BrowserWindow|null} */
let overlay = null;
/** @type {BrowserWindow|null} */
let game = null;
app.on('browser-window-created', (_e, win) => {
  // 앱이 만드는 첫 창이 오버레이다 (게임 창은 우리가 만든다)
  if (!overlay && win !== game) overlay = win;
});

require(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'));

/**
 * 가짜 게임 화면 — 짙은 배경에 흰 굵은 글씨. 자리와 크기는 화면 비율로 잡는다
 * (시험이 넣어 주는 턴 영역 { fx 0.005, fy 0.18, fw 0.1, fh 0.07 } 안에 들어가게).
 */
const GAME = `<!doctype html><html><body style="margin:0;background:#1b2a3a;overflow:hidden">
<div id="t" style="position:absolute;color:#fff;white-space:nowrap;line-height:1">0 / 30</div>
<script>
  const t = document.getElementById('t');
  t.style.left = (0.0156 * innerWidth) + 'px';
  t.style.top = (0.198 * innerHeight) + 'px';
  t.style.font = '700 ' + Math.round(26 * innerHeight / 1080) + 'px/1 "DejaVu Sans", "Liberation Sans", Arial, sans-serif';
</script></body></html>`;

/** @param {string} js */
const ev = (js) => /** @type {BrowserWindow} */ (overlay).webContents.executeJavaScript(js);

/** @param {string} text */
async function show(text) {
  await /** @type {BrowserWindow} */ (game).webContents.executeJavaScript(
    `document.getElementById('t').textContent = ${JSON.stringify(text)}; 1`,
  );
}

/** 화면 쪽 상태 한 벌 — 여러 단계가 같이 쓴다 */
const LOOK = `(() => {
  const rows = [...document.querySelectorAll('#steps .step')];
  return {
    buildId: state.buildId,
    tab: state.tab,
    index: state.index,
    auto: state.auto,
    steps: state.steps.length,
    stepRows: stepRows.length,
    now: rows.findIndex((r) => r.classList.contains('now')),
    next: rows.findIndex((r) => r.classList.contains('next')),
    heads: [...document.querySelectorAll('#steps .seg > .seg-head')].map((h) => h.textContent),
    options: [...document.getElementById('build').options].map((o) => (o.selected ? '>' : '') + o.textContent),
    status: document.getElementById('status').textContent,
    turn: document.getElementById('turn').textContent,
  };
})()`;

/**
 * 단계들 — 순서대로 돈다. 하나가 죽어도 나머지는 돈다 (어디서 죽었는지 알아야 고친다).
 * @type {Array<[string, () => Promise<any>]>}
 */
const STAGES = [
  // 앱을 켠 직후 — 기억한 빌드·요일·드롭다운
  ['start', async () => ev(LOOK)],

  // 단계 목록 — 라운드 제목은 바뀌는 자리에만, stepRows 에는 단계 줄만
  ['steps', async () => {
    await ev(`selectBuild('d-reset')`);
    await ev(`jumpTo(5)`);
    return ev(LOOK);
  }],

  // 검색어가 걸린 채 다른 탭을 누르면 — 보던 빌드를 지킨다
  ['tab', async () => {
    await ev(`(() => { const s = document.getElementById('search'); s.value = '없는이름'; s.dispatchEvent(new Event('input')); })()`);
    await ev(`[...document.querySelectorAll('#tabs button')].find((b) => b.textContent === '공성전').click()`);
    await sleep(200);
    const got = await ev(LOOK);
    await ev(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await ev(`[...document.querySelectorAll('#tabs button')].find((b) => b.textContent === '파괴신').click()`);
    await sleep(200);
    await ev(`selectBuild('d-reset')`);
    return got;
  }],

  // 설정을 연 채 단계가 넘어가도 설정 패널이 튀지 않는다
  ['scroll', async () => {
    await ev(`document.getElementById('btn-settings').click()`);
    await sleep(100);
    const before = await ev(`(() => { const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; return m.scrollTop; })()`);
    await ev(`jumpTo(1)`);
    await ev(`jumpTo(6)`);
    await sleep(100);
    const after = await ev(`document.getElementById('main').scrollTop`);
    const record = await ev(`document.getElementById('record-msg').textContent`);
    await ev(`document.getElementById('btn-settings').click()`);
    return { before, after, record };
  }],

  // [자동] — 실제 캡처·자르기·읽기·단계 이동. 캡처 크기가 못 박혔는지도 본다
  ['auto', async () => {
    // 캡처를 여는 요청을 엿본다 — 무엇을 요청했는지, 스트림이 몇 개 열렸는지.
    // __race 를 켜 두면 **첫 요청이 열리는 중에** [자동]을 끔·켬 한다 (toggle 단계)
    await ev(`(() => {
      window.__streams = [];
      window.__asked = [];
      window.__race = false;
      const md = navigator.mediaDevices;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => {
        window.__asked.push(JSON.parse(JSON.stringify(c)));
        if (window.__race) {
          window.__race = false;
          setTimeout(() => { toggleAuto(false); toggleAuto(true); }, 0);
          await new Promise((r) => setTimeout(r, 400)); // 첫 스트림이 늦게 열린다
        }
        const s = await orig(c);
        window.__streams.push(s);
        return s;
      };
      // 걸려 있는 다음-화면 콜백 수 — 하나여야 한다 (안전줄이 겹쳐 걸면 쌓인다)
      const v = document.getElementById('cap');
      const req = v.requestVideoFrameCallback.bind(v);
      const can = v.cancelVideoFrameCallback.bind(v);
      window.__pending = new Set();
      v.requestVideoFrameCallback = (cb) => {
        const id = req((...a) => { window.__pending.delete(id); cb(...a); });
        window.__pending.add(id);
        return id;
      };
      v.cancelVideoFrameCallback = (id) => { window.__pending.delete(id); can(id); };
      return true;
    })()`);
    await ev(`selectBuild('d-cont')`);
    await show('0 / 30');
    await ev(`toggleAuto(true)`);
    await sleep(1500);
    const first = await ev(LOOK);
    await show('5 / 30');
    await sleep(1500);
    const moved = await ev(LOOK);
    const source = await ev(`api.capture.source(state.region.displayId)`);
    const asked = await ev(`window.__asked[window.__asked.length - 1]`);

    // 화면이 안 오는 동안(영상을 멈춘다) 안전줄이 대신 읽고, 콜백은 **하나만** 걸려 있어야 한다
    const frames = () => ev(`api.diag.state().then((d) => d.frames)`);
    const f0 = await frames();
    await ev(`document.getElementById('cap').pause(); 1`);
    await sleep(3500);
    const stalled = { pending: await ev(`window.__pending.size`), read: (await frames()) - f0 };
    await ev(`document.getElementById('cap').play().then(() => 1)`);
    await sleep(300);
    return { first, moved, source, asked, stalled };
  }],

  // [가르치기] — 창을 연 순간의 화면을 얼려서, 그 사이 턴이 넘어가도 짝이 안 어긋난다
  ['teach', async () => {
    await show('12 / 30');
    await sleep(1200);
    const read = await ev(LOOK);
    await ev(`document.getElementById('btn-teach').click()`);
    await sleep(100);
    const view = `document.getElementById('teach-view').toDataURL()`;
    const opened = { value: await ev(`document.getElementById('teach-value').value`), image: await ev(view) };
    await show('13 / 30');
    await sleep(1200);
    const later = { value: await ev(`document.getElementById('teach-value').value`), image: await ev(view) };
    await ev(`document.getElementById('teach-save').click()`);
    await sleep(300);
    const msg = await ev(`document.getElementById('teach-msg').className`);
    await ev(`document.getElementById('teach-close').click()`);
    await sleep(1200);
    const after = await ev(LOOK);
    return { read, opened, later: { value: later.value, same: later.image === opened.image }, msg, after };
  }],

  // 인식 주기 슬라이더 — [자동]을 다시 안 켜도 먹는다
  ['tick', async () => {
    const frames = () => ev(`api.diag.state().then((d) => d.frames)`);
    const slider = (v) => ev(`(() => { const t = document.getElementById('tick'); t.value = '${v}'; t.dispatchEvent(new Event('input')); })()`);
    let a = await frames();
    await sleep(2000);
    const fast = (await frames()) - a;
    await slider(500);
    await sleep(1200); // 캡처 장수를 맞출 틈 (슬라이더를 놓고 800ms 뒤)
    a = await frames();
    await sleep(2000);
    const slow = (await frames()) - a;
    const fps = await ev(`state.captureFps`);
    await slider(100);
    await sleep(1200);
    return { fast, slow, fps, back: await ev(`state.captureFps`) };
  }],

  // [자동]을 켬·끔·켬 빠르게 — 첫 스트림이 **열리는 중에** 끄고 다시 켠다.
  // 늦게 열린 첫 스트림은 아무도 안 쓰므로 꺼져야 하고, 나중 것은 살아 있어야 한다.
  ['toggle', async () => {
    await ev(`toggleAuto(false)`);
    await ev(`window.__streams = []; window.__race = true; toggleAuto(true); 1`);
    await sleep(2000);
    return ev(`({
      auto: state.auto,
      opened: __streams.length,
      live: __streams.filter((s) => s.getTracks().some((t) => t.readyState === 'live')).length,
      shown: __streams.findIndex((s) => document.getElementById('cap').srcObject === s),
    })`);
  }],

  // 스킬 순서가 없는 빌드 — 턴은 읽히는데 "찾는 중"에 머물지 않는다
  ['empty', async () => {
    await show('7 / 30');
    await ev(`selectBuild('d-none')`);
    await sleep(1500);
    return ev(LOOK);
  }],

  // 단축키 경고 — 막힌 게 있으면 띠로 남는다 (xvfb 에서는 대개 다 잡힌다)
  ['keys', async () => ev(`api.keys.failures().then((f) => ({
    failed: f,
    shown: !document.getElementById('keys-warn').classList.contains('hidden'),
  }))`)],

  // [기본 위치] — 좌표 사본이 아니라 이름으로 저장한다
  ['preset', async () => {
    await ev(`toggleAuto(false)`);
    await ev(`document.getElementById('btn-preset').click()`);
    await sleep(300);
    return ev(`api.config.get().then((c) => c.turnRegion)`);
  }],
];

async function main() {
  await app.whenReady();
  const b = screen.getPrimaryDisplay().bounds;
  out.display = b;
  game = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, show: true });
  await game.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(GAME)}`);

  for (let i = 0; i < 100 && !overlay; i += 1) await sleep(100);
  if (!overlay) throw new Error('오버레이 창이 안 떴다');
  const wc = overlay.webContents;
  wc.on('console-message', (_e, level, message) => {
    if (level >= 3) out.errors.push(message);
  });
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', () => r(null)));
  await sleep(1500); // 시작 코드(설정·도감 읽기)가 끝날 틈

  for (const [name, run] of STAGES) {
    try {
      out[name] = await run();
    } catch (e) {
      out[name] = { error: e instanceof Error ? e.stack : String(e) };
    }
  }
}

main()
  .catch((e) => out.errors.push(e instanceof Error ? e.stack : String(e)))
  .finally(() => {
    process.stdout.write(`\nSKRE_E2E ${JSON.stringify(out)}\n`);
    app.exit(0);
  });
setTimeout(() => {
  process.stdout.write(`\nSKRE_E2E ${JSON.stringify({ ...out, errors: [...out.errors, '시간 초과'] })}\n`);
  app.exit(2);
}, 90000);
