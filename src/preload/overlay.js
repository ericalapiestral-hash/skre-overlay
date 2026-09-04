// 렌더러가 쓸 수 있는 것만 골라 내보낸다.
//
// 렌더러에는 Node를 열어 주지 않는다(contextIsolation). 게임 위에 뜨는 창이라
// 원격 콘텐츠를 실을 일이 없어도, 창 하나에 파일 시스템을 통째로 열어 둘 이유도 없다.
// 무엇보다 이렇게 해야 판단 로직이 전부 메인에 남아 테스트로 확인된다.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { CROP_TARGET_HEIGHT } = require('../shared/turnReader');
const { PRESETS } = require('../shared/regions');

/** 메인 → 렌더러 알림. 해제 함수를 돌려준다 */
function on(channel, handler) {
  const wrapped = (_e, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('overlay', {
  /** 인식기와 맞춰야 하는 값들 — 화면이 제 맘대로 정하면 재는 것과 어긋난다 */
  tune: { cropHeight: CROP_TARGET_HEIGHT },
  catalog: {
    load: () => ipcRenderer.invoke('catalog:load'),
    /** 스킬 순서를 못 읽은 빌드의 도감 본문 — 필요할 때만 받아 온다 */
    body: (id) => ipcRenderer.invoke('catalog:body', id),
    pickFile: () => ipcRenderer.invoke('catalog:pick-file'),
    reveal: () => ipcRenderer.invoke('catalog:reveal'),
    onUpdated: (fn) => on('catalog:updated', fn),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },
  region: {
    open: () => ipcRenderer.invoke('picker:open'),
    onPicked: (fn) => on('turn:region', fn),
    /** 콘텐츠별 기본 위치 — 사람이 매번 드래그하지 않아도 되게 (src/shared/regions.js) */
    presets: PRESETS,
  },
  capture: {
    source: (displayId) => ipcRenderer.invoke('capture:source', displayId),
  },
  engine: {
    setFlow: (buildId, picks, opts) => ipcRenderer.invoke('engine:flow', buildId, picks, opts),
    setIndex: (i) => ipcRenderer.invoke('engine:index', i),
    reset: () => ipcRenderer.invoke('engine:reset'),
    /** gray는 Uint8Array — 구조적 복제로 넘어간다 (몇 KB라 부담 없다) */
    feed: (gray, w, h) => ipcRenderer.invoke('engine:feed', gray, w, h),
    teach: (gray, w, h, value) => ipcRenderer.invoke('engine:teach', gray, w, h, value),
    forget: () => ipcRenderer.invoke('engine:forget'),
  },
  /** 전투 기록 — 실제 게임에서 벌어진 일을 시나리오로 뽑아낸다 */
  diag: {
    state: () => ipcRenderer.invoke('diag:state'),
    save: () => ipcRenderer.invoke('diag:save'),
    reveal: (file) => ipcRenderer.invoke('diag:reveal', file),
  },
  win: {
    collapse: (on_) => ipcRenderer.send('overlay:collapse', on_),
    clickThrough: (on_) => ipcRenderer.send('overlay:click-through', on_),
    quit: () => ipcRenderer.send('overlay:quit'),
    onClickThrough: (fn) => on('overlay:click-through', fn),
  },
  keys: {
    onNav: (fn) => on('step:nav', fn),
    onAutoToggle: (fn) => on('auto:toggle', fn),
    onFailed: (fn) => on('shortcuts:failed', fn),
  },
});
