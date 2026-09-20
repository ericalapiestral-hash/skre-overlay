// 어느 모니터를 캡처할지 — 모니터가 여럿인 PC가 여기 없으니 목록을 지어 넣어 잠근다.
//
// ★ 실제로 있었던 버그를 잠그는 자리다. 기본 턴 영역에는 displayId 가 **없는데**
// (영역을 잡은 적이 없으니 당연하다), 고르는 코드가 "id를 줬는데 못 찾았다"와
// "id가 아예 없다"를 구별하지 않았다. 그래서 **모니터가 둘 이상이면 첫 [자동]이
// 반드시 "모니터를 못 찾았어요"로 끝났다.** 게임하는 사람은 모니터를 둘 쓰는 일이
// 많으니, 사실상 "처음 켜면 안 되는" 앱이었다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pickSource } = require('../src/shared/capture');

const 한대 = {
  sources: [{ id: 'screen:0:0', display_id: '11' }],
  displays: [{ id: 11, size: { width: 1920, height: 1080 }, scaleFactor: 1 }],
  primaryId: 11,
};
const 두대 = {
  sources: [
    { id: 'screen:0:0', display_id: '11' },
    { id: 'screen:1:0', display_id: '22' },
  ],
  displays: [
    { id: 11, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 22, size: { width: 2560, height: 1440 }, scaleFactor: 1 },
  ],
  primaryId: 22, // 주 모니터가 두 번째다 — 목록 순서에 기대면 안 된다
};

test('영역을 아직 안 잡았으면 주 모니터를 쓴다 — 모니터가 둘이어도', () => {
  // ★ 이게 그 버그다. 예전엔 여기서 null 이 나와 첫 [자동]이 통째로 실패했다.
  const got = pickSource({ displayId: undefined, ...두대 });
  assert.ok(got, '기본 위치로 시작하면 캡처를 못 하면 안 된다');
  assert.strictEqual(got.sourceId, 'screen:1:0');
  assert.strictEqual(got.why, 'primary');
  assert.strictEqual(got.width, 2560);
  assert.strictEqual(got.height, 1440);
});

test('IPC를 타면서 문자열 "undefined"가 되어도 같다', () => {
  // 렌더러 → 메인으로 넘어가며 값이 문자열이 되는 경우가 있다. 그걸 id로 알아듣고
  // 찾다가 못 찾으면 예전 버그로 그대로 돌아간다.
  for (const 빈값 of [undefined, null, '', 'undefined', 'null']) {
    const got = pickSource({ displayId: 빈값, ...두대 });
    assert.ok(got, `${String(빈값)} 에서 실패했다`);
    assert.strictEqual(got.why, 'primary');
  }
});

test('영역을 잡아 뒀으면 그 모니터를 쓴다', () => {
  const got = pickSource({ displayId: 11, ...두대 });
  assert.ok(got);
  assert.strictEqual(got.sourceId, 'screen:0:0');
  assert.strictEqual(got.why, 'matched');
  assert.strictEqual(got.width, 1920);
});

test('id를 줬는데 못 찾으면 — 모니터가 여럿이면 오류를 낸다', () => {
  // 엉뚱한 모니터를 조용히 읽으면 사람은 "왜 인식이 안 되지"만 겪는다.
  // 모니터를 뽑았거나 자리를 바꾼 경우라, 영역을 다시 잡으라고 해야 맞다.
  assert.strictEqual(pickSource({ displayId: 99, ...두대 }), null);
});

test('id를 줬는데 못 찾아도 — 모니터가 하나뿐이면 그걸 쓴다', () => {
  // 모니터가 하나면 display_id 가 비어 오는 환경이 있다
  const 빈id = {
    sources: [{ id: 'screen:0:0', display_id: '' }],
    displays: [{ id: 11, size: { width: 1920, height: 1080 } }],
    primaryId: 11,
  };
  const got = pickSource({ displayId: 11, ...빈id });
  assert.ok(got);
  assert.strictEqual(got.why, 'only');
  assert.strictEqual(got.width, 1920);
});

test('고DPI 배율을 곱한 실제 픽셀 크기를 준다', () => {
  // ★ 이 값이 캡처 크기를 못 박는 데 쓰인다. 안 주면 크로미움이 1280×720으로
  // 줄여서 캡처하고, 그러면 어떤 인식기도 턴을 못 읽는다 (CLAUDE.md).
  const got = pickSource({
    displayId: 11,
    sources: [{ id: 'screen:0:0', display_id: '11' }],
    displays: [{ id: 11, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 }],
    primaryId: 11,
  });
  assert.ok(got);
  assert.strictEqual(got.width, 3840);
  assert.strictEqual(got.height, 2160);
});

test('캡처할 것이 없으면 null', () => {
  assert.strictEqual(pickSource({ displayId: 11, sources: [], displays: [], primaryId: 11 }), null);
  assert.strictEqual(pickSource(/** @type {any} */ ({ sources: null, displays: null })), null);
  // 소스는 있는데 모니터 정보가 없으면 크기를 못 박을 수 없다 — 그냥 쓰면 1280×720이 된다
  assert.strictEqual(
    pickSource({ displayId: undefined, sources: 한대.sources, displays: [], primaryId: null }),
    null,
  );
});
