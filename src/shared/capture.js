// 어느 모니터를 캡처할지 고른다.
//
// **왜 따로 뺐나.** 여기서 잘못 고르면 "턴 영역이 처음부터 맞춰져 있다"는 말이
// 통째로 무너지는데(아래), 그걸 확인하려면 모니터가 여럿인 실제 PC가 필요하다.
// 이 저장소에는 그런 게 없다 — 그래서 고르는 규칙만 순수 함수로 꺼내 두고,
// 모니터 목록을 손으로 지어 넣어 Node 테스트로 잠근다.
//
// ★ 실제로 있었던 버그: 기본 턴 영역에는 `displayId`가 **없다**(사람이 영역을 잡은
// 적이 없으니 당연하다). 그런데 고르는 코드가 "id를 줬는데 못 찾았다"와 "id가 아예
// 없다"를 구별하지 않아서, **모니터가 둘 이상이면 첫 [자동]이 반드시 실패했다.**
// 게임하는 사람은 모니터를 둘 쓰는 경우가 많으니 사실상 "처음 켜면 안 되는" 앱이었다.
'use strict';

/**
 * @typedef {{id: string, display_id?: string}} Source 크로미움이 준 캡처 소스
 * @typedef {{id: number|string, size: {width: number, height: number},
 *            scaleFactor?: number}} Display
 */

/** 값이 "안 정해짐"인가 — 문자열 'undefined'까지 본다 (IPC를 타면 그렇게 온다) */
function unset(v) {
  return v === undefined || v === null || v === '' || v === 'undefined' || v === 'null';
}

/**
 * @param {{displayId?: any, sources: Source[], displays: Display[],
 *          primaryId?: any}} input
 * @returns {{sourceId: string, width: number, height: number, why: string}|null}
 *   why: 'matched'(id로 찾음) · 'primary'(id가 없어 주 모니터) · 'only'(하나뿐)
 */
function pickSource({ displayId, sources, displays, primaryId }) {
  const list = Array.isArray(sources) ? sources : [];
  const screens = Array.isArray(displays) ? displays : [];
  if (list.length === 0) return null;

  const wanted = unset(displayId) ? null : String(displayId);
  const primary = unset(primaryId) ? null : String(primaryId);

  let match = null;
  let why = '';

  if (wanted) {
    match = list.find((s) => String(s.display_id) === wanted) || null;
    why = 'matched';
    // ★ id를 **줬는데** 못 찾았으면 아무거나 쓰면 안 된다 — 엉뚱한 모니터를 조용히
    // 읽게 되고, 사람은 "왜 인식이 안 되지"만 겪는다. 하나뿐일 때만 구제한다
    // (모니터가 하나면 display_id가 비어 오는 환경이 있다).
    if (!match && list.length === 1) {
      match = list[0];
      why = 'only';
    }
  } else {
    // id가 **아예 없다** = 아직 영역을 안 잡았다(기본 위치로 시작). 이건 오류가
    // 아니라 정상적인 첫 실행이다. 게임은 대개 주 모니터에서 돌므로 거기를 쓴다.
    match = (primary && list.find((s) => String(s.display_id) === primary)) || list[0] || null;
    why = 'primary';
  }
  if (!match) return null;

  const id = wanted || primary;
  const display =
    (id && screens.find((d) => String(d.id) === String(match.display_id))) ||
    (id && screens.find((d) => String(d.id) === String(id))) ||
    screens.find((d) => String(d.id) === String(match.display_id)) ||
    screens[0];
  if (!display || !display.size) return null;

  // ★ 크기를 못 박는 값이 여기서 나온다. 안 주면 크로미움이 1280×720으로 줄여서
  // 캡처하고, 1440p·4K에서는 턴 숫자가 절반 이하로 뭉개진다 (CLAUDE.md).
  const scale = display.scaleFactor || 1;
  return {
    sourceId: match.id,
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
    why,
  };
}

module.exports = { pickSource };
