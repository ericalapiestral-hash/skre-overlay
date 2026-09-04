// 설정 저장 — userData 폴더의 JSON 한 장.
//
// 쓰는 도중에 앱이 죽어도 기존 설정이 남도록 임시 파일에 쓰고 이름을 바꾼다.
// 오버레이는 게임과 같이 강제 종료되는 일이 잦아서, 반쯤 쓰인 설정 파일 때문에
// 다음 실행이 통째로 초기화되는 일이 실제로 생긴다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 기본값 — 없는 키를 읽을 때 여기로 채운다 */
const DEFAULTS = {
  /** 도감 파일 경로 (비우면 자동으로 찾는다) */
  buildsPath: '',
  /** 마지막으로 보던 빌드 */
  lastBuildId: '',
  /** 창 위치·크기 */
  winBounds: null,
  /** 배경 진하기 0~100 */
  opacity: 88,
  /** 글자 크기 배율 0.8~1.6 */
  scale: 1,
  /** 턴 숫자 영역 { displayId, fx, fy, fw, fh } — 화면 대비 비율이라 해상도가 바뀌어도 안전 */
  turnRegion: null,
  /** 사용자가 직접 가르친 숫자 템플릿 { d, rows } */
  userTemplates: [],
  /**
   * 자동 인식 주기 (ms).
   * 한 장 읽는 데 1ms 안팎이라 이 값이 곧 "턴이 바뀌고 화면이 따라오기까지"의 시간이다.
   * 예전엔 600ms였는데, 그건 인식이 14ms 걸리던 때 잡은 값이다. 추적기(follower.js)의
   * "몇 프레임 이어져야 믿는다"는 규칙들도 100ms 프레임을 기준으로 잰 것이다.
   */
  tickMs: 100,
};

function createStore(dir) {
  const file = path.join(dir, 'config.json');

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS };
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function save(patch) {
    const next = { ...load(), ...patch };
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn('[설정] 저장 실패:', e instanceof Error ? e.message : e);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 지우기 실패는 무시 */
      }
    }
    return next;
  }

  return { file, load, save };
}

module.exports = { DEFAULTS, createStore };
