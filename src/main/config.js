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
  /**
   * 노션 공개 도감 주소. 넣으면 [노션에서 받기]로 받아 와 userData에 캐시하고,
   * buildsPath 가 그 캐시를 가리키게 된다 — 그 뒤는 파일 도감과 똑같이 흐른다.
   *
   * **기본값은 비워 둔다.** 배포판에는 도감을 넣지 않고 쓰는 사람이 자기 링크를
   * 넣게 할 것이라, 특정 길드 주소를 코드에 박으면 안 된다.
   */
  notionUrl: '',
  /** 마지막으로 보던 빌드 */
  lastBuildId: '',
  /** 창 위치·크기 */
  winBounds: null,
  /** 배경 진하기 0~100 */
  opacity: 88,
  /** 글자 크기 배율 0.8~1.6 */
  scale: 1,
  /**
   * 턴 숫자 영역 { displayId, fx, fy, fw, fh } — 화면 대비 비율이라 해상도가 바뀌어도 안전.
   * [기본 위치]를 눌렀으면 좌표 대신 { preset, displayId } 다 (shared/regions.js 의 resolveRegion).
   * 비어 있으면 화면이 기본 위치로 시작하되 **저장하지 않는다.**
   */
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
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { ...DEFAULTS }; // 아직 없다 — 처음 켠 것이다
    }
    try {
      const raw = JSON.parse(text);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...DEFAULTS, ...raw };
    } catch {
      /* 아래에서 비켜 둔다 */
    }
    setAside();
    return { ...DEFAULTS };
  }

  /**
   * 망가진 설정 파일을 **옆에 비켜 둔다** (`config.json.broken-20260904-153012`).
   *
   * 예전엔 기본값을 돌려주기만 했다. 그러면 곧이은 저장이 — 창을 옮기거나 슬라이더를
   * 움직이면 바로 일어난다 — 기본값 위에 바뀐 값만 얹어 원본을 덮어써서, 가르친 숫자·
   * 노션 주소·턴 영역이 **백업 없이** 사라졌다. 비켜 두면 손으로라도 살릴 수 있다.
   */
  function setAside() {
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp =
      `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
      `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    let aside = `${file}.broken-${stamp}`;
    for (let n = 2; fs.existsSync(aside); n += 1) aside = `${file}.broken-${stamp}-${n}`;
    try {
      fs.renameSync(file, aside);
      console.warn(`[설정] 설정 파일이 망가져 있어 옆에 비켜 두고 기본값으로 시작합니다: ${aside}`);
    } catch (e) {
      console.warn('[설정] 망가진 설정 파일을 비켜 두지 못했다:', e instanceof Error ? e.message : e);
    }
  }

  function save(patch) {
    const next = { ...load(), ...patch };
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 디스크까지 내려보낸 **뒤에** 이름을 바꾼다. 안 그러면 윈도우가 멈추거나 전원이
      // 나갔을 때 이름만 바뀌고 내용은 비어 있는 파일이 남을 수 있다 (게임 PC 에서 흔하다)
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify(next, null, 2), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
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
