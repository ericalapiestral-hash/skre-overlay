// 숫자 인식기 — 부품별 동작과, 실제로 틀렸던 상황들.
//
// 끝판 시험은 진짜 폰트로 그린 표본(test/fixtures/digits.json.gz)으로 한다.
// 표본을 그린 폰트의 대조표는 빼고 맞추므로 "처음 보는 게임 폰트" 조건이다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  GRID_W,
  GRID_H,
  MATCH,
  toGray,
  otsuThreshold,
  binarize,
  components,
  splitComponent,
  digitBoxes,
  cropBitmap,
  normalize,
  dilate,
  holeInfo,
  similarity,
  loadTemplates,
  gridToRows,
  makeShape,
  similarityOf,
  scoreShape,
  scoreGrid,
  bestValue,
  readTurn,
} = require('../src/shared/turnReader');
const { toGrid, byDigit, bench, loadFixtures, RAW } = require('../tools/bench-reader');

const TEMPLATES = loadTemplates(RAW);
const GROUPS = byDigit();

/** 표본에서 조건에 맞는 그림 한 장 */
function sample(where) {
  const data = loadFixtures();
  if (!data) return null;
  const s = data.samples.find(where);
  if (!s) return null;
  return { ...s, gray: new Uint8Array(Buffer.from(s.gray, 'base64')) };
}

/** 격자 몇 개를 나란히 놓아 회색조 그림을 만든다 (부품 시험용) */
function paste(grids, { scale = 3, gap = 2, pad = 6 } = {}) {
  const dw = GRID_W * scale;
  const dh = GRID_H * scale;
  const w = pad * 2 + grids.length * dw + (grids.length - 1) * gap;
  const h = pad * 2 + dh;
  const gray = new Uint8Array(w * h).fill(20);
  grids.forEach((grid, i) => {
    const left = pad + i * (dw + gap);
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        if (grid[((y / scale) | 0) * GRID_W + ((x / scale) | 0)]) {
          gray[(pad + y) * w + left + x] = 235;
        }
      }
    }
  });
  return { gray, w, h };
}

// ─────────────────────────────── 부품

test('회색조 변환은 휘도식을 쓴다', () => {
  const rgba = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255]);
  assert.deepStrictEqual([...toGray(rgba, 2, 1)], [255, 0]);
});

test('Otsu는 밝은 덩어리와 어두운 덩어리를 가른다', () => {
  const gray = Uint8Array.from([10, 12, 11, 200, 205, 199]);
  const t = otsuThreshold(gray);
  assert.ok(t >= 12 && t < 199, `문턱값이 두 덩어리 사이에 있어야 한다 (${t})`);
});

test('밝은 글자와 어두운 글자를 모두 뽑아낸다', () => {
  const img = paste([toGrid(GROUPS.get(8)[0].rows)]);
  const dark = img.gray.map((v) => 255 - v);
  // 어느 쪽이 글자인지 맞게 지정하면 두 경우 다 덩어리 하나가 나온다
  assert.strictEqual(
    digitBoxes(components(binarize(img.gray, img.w, img.h, true), img.w, img.h), img.h).length,
    1,
  );
  assert.strictEqual(
    digitBoxes(components(binarize(dark, img.w, img.h, false), img.w, img.h), img.h).length,
    1,
  );
  // readTurn은 어느 쪽인지 스스로 골라야 한다 — 지정해 주지 않아도 같은 답이 나온다
  const bright = readTurn(img.gray, img.w, img.h, TEMPLATES);
  const inverted = readTurn(dark, img.w, img.h, TEMPLATES);
  assert.ok(bright && inverted);
  assert.strictEqual(bright.value, 8);
  assert.strictEqual(inverted.value, 8);
});

test('구멍 개수와 위치 — 6은 아래, 9는 위, 0은 가운데', () => {
  const info = (d) => holeInfo(toGrid(GROUPS.get(d)[0].rows));
  assert.strictEqual(info(1).count, 0);
  assert.strictEqual(info(0).count, 1);
  assert.strictEqual(info(8).count, 2);
  assert.ok(info(6).y > info(0).y, '6의 구멍이 0보다 아래에 있다');
  assert.ok(info(9).y < info(0).y, '9의 구멍이 0보다 위에 있다');
});

test('닮음 점수는 자기 자신에게 1이다', () => {
  const one = toGrid(GROUPS.get(1)[0].rows);
  const zero = toGrid(GROUPS.get(0)[0].rows);
  assert.strictEqual(similarity(one, one), 1);
  assert.ok(similarity(one, zero) < similarity(zero, zero));
});

test('크기를 맞출 때 가로세로 비율을 지킨다 — 1과 0이 뭉개지면 안 된다', () => {
  const thin = { data: new Uint8Array(4 * 20).fill(1), w: 4, h: 20 };
  const grid = normalize(thin);
  let filledCols = 0;
  for (let x = 0; x < GRID_W; x += 1) {
    for (let y = 0; y < GRID_H; y += 1) {
      if (grid[y * GRID_W + x]) {
        filledCols += 1;
        break;
      }
    }
  }
  assert.ok(filledCols < GRID_W, '가로로 꽉 채우면 1과 0을 구분할 수 없다');
});

test('격자 → 행 문자열 왕복', () => {
  const grid = toGrid(GROUPS.get(5)[0].rows);
  assert.deepStrictEqual(gridToRows(grid), GROUPS.get(5)[0].rows);
});

// ─────────────────────────────── 붙은 덩어리 나누기

test('붙어 버린 두 숫자를 나눈다', () => {
  // 사이를 붙여 그리면 획이 이어져 한 덩어리가 된다 — 옛 인식기는 여기서 8을 내놨다
  const img = paste([toGrid(GROUPS.get(1)[0].rows), toGrid(GROUPS.get(2)[0].rows)], { gap: -2 });
  const comps = components(binarize(img.gray, img.w, img.h, true), img.w, img.h);
  const merged = comps.filter((c) => c.w > c.h * 0.75);
  if (merged.length > 0) {
    const parts = splitComponent(merged[0], img.w, 2);
    assert.ok(parts && parts.length === 2, '두 조각으로 나뉘어야 한다');
    assert.ok(parts[0].minX < parts[1].minX, '왼쪽 조각이 먼저다');
  }
  const got = readTurn(img.gray, img.w, img.h, TEMPLATES);
  assert.ok(got && got.value === 12, `읽은 값: ${got && got.value}`);
});

test('나눌 수 없으면 null을 돌려준다', () => {
  const img = paste([toGrid(GROUPS.get(1)[0].rows)], { scale: 1 });
  const box = components(binarize(img.gray, img.w, img.h, true), img.w, img.h)[0];
  assert.ok(box);
  assert.strictEqual(splitComponent(box, img.w, 1), null, '한 조각은 나누는 게 아니다');
  // 조각 하나가 3픽셀도 안 되게 얇아지면 나누지 않는다
  assert.strictEqual(splitComponent(box, img.w, box.w), null);
});

test('나눈 조각은 원래 덩어리를 빠짐없이 나눠 갖는다', () => {
  const img = paste([toGrid(GROUPS.get(1)[0].rows), toGrid(GROUPS.get(2)[0].rows)], { gap: -2 });
  const boxes = components(binarize(img.gray, img.w, img.h, true), img.w, img.h);
  const wide = boxes.find((b) => b.w > b.h * 0.75);
  if (!wide) return; // 이 폰트에서는 안 붙었다
  const parts = splitComponent(wide, img.w, 2);
  assert.ok(parts);
  assert.strictEqual(
    parts.reduce((n, p) => n + p.count, 0),
    wide.count,
    '조각들의 픽셀 합이 원래와 같아야 한다 — 잃어버리면 글자가 얇아져 오독이 난다',
  );
});

// ─────────────────────────────── 판단

test('후보가 없으면 확신이 있을 때만 답한다', () => {
  const clear = bestValue([[0.9, 0.2, 0, 0, 0, 0, 0, 0, 0, 0]]);
  assert.ok(clear);
  assert.strictEqual(clear.value, 0);
  // 1등과 2등이 붙어 있으면 답하지 않는다 — 틀린 턴을 믿는 것보다 낫다
  assert.strictEqual(bestValue([[0.9, 0.89, 0, 0, 0, 0, 0, 0, 0, 0]]), null);
});

test('후보가 있으면 후보 안에서 1·2등을 다시 가른다', () => {
  // 8과 0이 붙어 있다 — 둘 다 후보면 답하지 않아야 한다
  const scores = [[0.88, 0, 0, 0, 0, 0, 0, 0, 0.9, 0]];
  assert.strictEqual(bestValue(scores, { candidates: [0, 8] }), null);
  // 0이 후보가 아니면 8로 확정된다
  const only8 = bestValue(scores, { candidates: [4, 8] });
  assert.ok(only8);
  assert.strictEqual(only8.value, 8);
});

test('후보 쪽이 확실하면 원본을 제치고 그쪽으로 맞춘다', () => {
  // 원본은 0이지만 후보에는 8만 있다
  const scores = [[0.86, 0, 0, 0, 0, 0, 0, 0, 0.82, 0]];
  const got = bestValue(scores, { candidates: [8] });
  assert.ok(got);
  assert.strictEqual(got.value, 8);
  assert.strictEqual(got.snapped, true, '맞춘 값에는 표시가 붙어야 한다');
});

test('자릿수가 다른 후보는 무시한다', () => {
  const got = bestValue([[0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0]], { candidates: [100] });
  assert.ok(got === null || got.value === 0);
});

test('빈 입력에는 null', () => {
  assert.strictEqual(bestValue([]), null);
  assert.strictEqual(bestValue(/** @type {any} */ (null)), null);
  assert.strictEqual(readTurn(/** @type {any} */ (null), 0, 0, TEMPLATES), null);
  assert.strictEqual(readTurn(new Uint8Array(4), 2, 2, []), null);
});

test('아무것도 없는 화면에서는 답하지 않는다', () => {
  const gray = new Uint8Array(60 * 30).fill(30);
  assert.strictEqual(readTurn(gray, 60, 30, TEMPLATES), null);
});

// ─────────────────────────────── 빠르게 만든 길이 결과를 안 바꿨는지

test('상한 가지치기를 해도 전부 대조한 것과 결과가 같다', () => {
  // 속도를 위해 "넘을 수 없는 점수"인 템플릿은 건너뛴다. 그게 정말 결과를
  // 안 바꾸는지, 여기서 가지치기 없이 직접 계산해 비교한다.
  const exhaustive = (grid) => {
    const shape = makeShape(grid);
    const per = new Array(10).fill(0);
    for (const t of TEMPLATES) {
      const diff = Math.abs(t.shape.hole.count - shape.hole.count);
      let penalty = 1;
      if (diff === 1) penalty = MATCH.hole1;
      else if (diff >= 2) penalty = MATCH.hole2;
      else if (shape.hole.count > 0 && t.shape.hole.y >= 0 && shape.hole.y >= 0) {
        penalty = 1 - Math.min(1, Math.abs(t.shape.hole.y - shape.hole.y) * 2) * MATCH.holeY;
      }
      const s = similarityOf(shape, t.shape, MATCH.exactWeight) * (t.weight ?? 1) * penalty;
      if (s > per[t.digit]) per[t.digit] = s > 1 ? 1 : s;
    }
    return per;
  };

  for (let d = 0; d <= 9; d += 1) {
    const grid = toGrid(GROUPS.get(d)[2].rows);
    assert.deepStrictEqual(scoreGrid(grid, TEMPLATES), exhaustive(grid), `숫자 ${d}`);
  }
});

test('비트로 센 닮음 점수가 칸마다 센 것과 같다', () => {
  const slow = (a, b, ew) => {
    let both = 0;
    let either = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] && b[i]) both += 1;
      if (a[i] || b[i]) either += 1;
    }
    if (either === 0) return 0;
    const da = dilate(a);
    const db = dilate(b);
    let aOn = 0;
    let bOn = 0;
    let aIn = 0;
    let bIn = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i]) {
        aOn += 1;
        if (db[i]) aIn += 1;
      }
      if (b[i]) {
        bOn += 1;
        if (da[i]) bIn += 1;
      }
    }
    if (aOn === 0 || bOn === 0) return 0;
    return (both / either) * ew + ((aIn / aOn + bIn / bOn) / 2) * (1 - ew);
  };

  for (let d = 0; d <= 9; d += 1) {
    const a = toGrid(GROUPS.get(d)[0].rows);
    const b = toGrid(GROUPS.get((d + 3) % 10)[1].rows);
    assert.strictEqual(similarityOf(makeShape(a), makeShape(b), 0.5), slow(a, b, 0.5), `숫자 ${d}`);
  }
});

test('빈 모양은 어떤 것과도 안 닮았다', () => {
  const empty = new Uint8Array(GRID_W * GRID_H);
  assert.strictEqual(scoreGrid(empty, TEMPLATES).every((s) => s === 0), true);
  assert.strictEqual(similarityOf(makeShape(empty), makeShape(empty), 0.5), 0);
});

// ─────────────────────────────── 실제 폰트 표본

test('실제 폰트 표본을 한 자리·두 자리·세 자리 모두 읽는다', { skip: !loadFixtures() }, () => {
  for (const value of [0, 8, 12, 44, 68, 100, 128]) {
    for (const invert of [false, true]) {
      const s = sample((x) => x.value === value && x.invert === invert && x.height === 44);
      if (!s) continue;
      const got = readTurn(s.gray, s.w, s.h, TEMPLATES, { candidates: [value] });
      assert.ok(got, `${value} (반전=${invert}) 를 못 읽었다`);
      assert.strictEqual(got.value, value);
    }
  }
});

test('명암이 뒤집혀도 자릿수를 잃지 않는다', { skip: !loadFixtures() }, () => {
  // "60"이 한 덩어리로 잡힌 쪽이 마진만 높아서 이기는 바람에 7로 읽히던 문제
  for (const invert of [false, true]) {
    const s = sample((x) => x.value === 60 && x.invert === invert && x.height === 32);
    if (!s) continue;
    const got = readTurn(s.gray, s.w, s.h, TEMPLATES);
    assert.ok(got && String(got.value).length === 2, `읽은 값: ${got && got.value}`);
  }
});

test('처음 보는 폰트에서 정확도와 오독이 기준을 지킨다', { skip: !loadFixtures() }, () => {
  // 앱이 실제로 넣는 것과 같은 조건(확대 + 빌드 턴 후보)에서 잰다.
  // 지금 수치는 맞음 99.7% · 틀림 0.3%. 문턱값·대조 계수를 건드리면
  // 여기가 먼저 나빠진다 — 회귀를 잡는 자물쇠다.
  const r = bench({ useCandidates: true });
  assert.ok(r);
  const wrong = r.wrong / r.total;
  const ok = r.ok / r.total;
  assert.ok(wrong <= 0.01, `오독 ${(wrong * 100).toFixed(1)}% — 1%를 넘으면 안 된다`);
  assert.ok(ok >= 0.98, `정답 ${(ok * 100).toFixed(1)}% — 98% 아래로 떨어지면 안 된다`);
});

test('화면 확대가 정확도를 올린다', { skip: !loadFixtures() }, () => {
  // 인식 전에 크롭을 CROP_TARGET_HEIGHT 근처로 키운다. 그 값을 잘못 만지면
  // 조용히 나빠지므로, 키운 쪽이 더 나은지 자물쇠로 걸어 둔다.
  const scaled = bench({ useCandidates: true });
  const native = bench({ useCandidates: true, target: 0 });
  assert.ok(scaled && native);
  assert.ok(
    scaled.wrong <= native.wrong && scaled.ok >= native.ok,
    `키운 쪽 ${scaled.ok}/${scaled.wrong} · 원본 ${native.ok}/${native.wrong}`,
  );
});

test('문턱값은 한 번이면 충분하다 — 여러 번은 오히려 나쁘다', { skip: !loadFixtures() }, () => {
  // 여러 번 보면 나을 것 같아 넣었다가 재 보고 뺐다. 다시 넣고 싶어질 때를 위해
  // "재 보니 이랬다"를 자물쇠로 걸어 둔다.
  const once = bench({ useCandidates: true });
  const many = bench({ useCandidates: true, read: { thresholdOffsets: [0, -8, 8] } });
  assert.ok(once && many);
  assert.ok(once.wrong <= many.wrong, `한 번: 틀림 ${once.wrong} / 여러 번: 틀림 ${many.wrong}`);
  assert.ok(once.ms < many.ms, `한 번이 더 빨라야 한다 (${once.ms} vs ${many.ms})`);
});

test('후보 없이도 오독이 낮다', { skip: !loadFixtures() }, () => {
  // 빌드 턴을 후보로 넘기는 길이 막혀도(단계가 없는 빌드 등) 인식 자체가
  // 버텨야 한다. 후보에 기대어 수치가 좋아 보이는 것을 막는 자물쇠다.
  const r = bench({});
  assert.ok(r);
  const wrong = r.wrong / r.total;
  assert.ok(wrong <= 0.015, `오독 ${(wrong * 100).toFixed(1)}% — 1.5%를 넘으면 안 된다`);
});

test('한 장 읽는 시간이 예산 안에 있다', { skip: !loadFixtures() }, () => {
  // 인식 시간은 곧 인식 주기의 하한이다. 예전 구조(대조마다 부풀리기를 다시 계산)는
  // 14ms였고, 그래서 주기를 600ms로 잡을 수밖에 없었다. 지금은 1~2ms다.
  // 여기 걸린 값은 느린 기계에서도 통과할 만큼 넉넉하게 잡았다 — 구조가 무너지면
  // 열 배 단위로 나빠지므로 이 정도로도 회귀는 잡힌다.
  const r = bench({ useCandidates: true });
  assert.ok(r);
  assert.ok(r.ms < 8, `중앙값 ${r.ms.toFixed(2)}ms — 8ms를 넘으면 구조가 무너진 것이다`);
});

test('가르친 폰트에서는 더 정확하다', { skip: !loadFixtures() }, () => {
  const taught = bench({ useCandidates: true, holdout: false });
  const unseen = bench({ useCandidates: true });
  assert.ok(taught && unseen);
  assert.ok(
    taught.ok >= unseen.ok,
    '실제 화면을 가르치면 최소한 나빠지지는 않아야 한다 — 아니면 가르치기가 헛수고다',
  );
});
