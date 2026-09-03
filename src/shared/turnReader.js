// 턴 숫자 전용 인식기.
//
// 범용 OCR(tesseract·ML Kit)은 "아무 글자나" 읽으려다 게임 폰트에서 흔들리고,
// 워커·모델 때문에 앱이 76MB씩 무거워진다. 여기서 가릴 것은 0~9 열 개뿐이라
// 이진화 → 덩어리 분리 → 크기 정규화 → 템플릿 대조 로 끝난다. 의존성이 없다.
//
// 옛 인식기에서 고친 것:
//  · **양쪽 명암을 모두 시도한다.** 예전엔 "화면에서 적은 쪽이 글자"라고 단정해서,
//    잘라 온 영역에 밝은 패널이 조금만 걸쳐도 글자와 배경이 뒤집혔다.
//  · **글자 줄을 찾아낸다.** 예전엔 제일 큰 덩어리 높이의 55%로 걸렀는데,
//    UI 테두리 하나가 섞이면 진짜 숫자가 전부 걸러졌다. 이제는 세로로 겹치는
//    덩어리끼리 묶어 "한 줄"을 만들고 그중 가장 그럴듯한 줄만 본다.
//  · **숫자별 점수를 그대로 내보낸다.** 예전엔 애매하면 통째로 버렸다. 이제는
//    점수표를 넘겨서, 빌드가 아는 턴 숫자(후보)로 애매한 자리를 맞출 수 있다.
//
//   const templates = loadTemplates(require('./templates.json'));
//   const got = readTurn(gray, w, h, templates, { candidates: [0, 4, 8] });
'use strict';

/** 템플릿 격자 크기 — 숫자 하나를 이 크기로 줄여 맞춘다 */
const GRID_W = 14;
const GRID_H = 24;

// ─────────────────────────────── 이진화

/** RGBA 바이트 → 회색조 */
function toGray(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    gray[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
  }
  return gray;
}

/** Otsu — 밝기 분포를 두 덩어리로 가르는 문턱값 */
function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];

  let sumB = 0;
  let countB = 0;
  let best = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    countB += hist[t];
    if (countB === 0) continue;
    const countF = total - countB;
    if (countF === 0) break;
    sumB += t * hist[t];
    const meanB = sumB / countB;
    const meanF = (sum - sumB) / countF;
    const between = countB * countF * (meanB - meanF) * (meanB - meanF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * 글자를 1, 배경을 0으로 만든다.
 * @param {boolean} bright true면 밝은 쪽을 글자로 본다
 */
function binarize(gray, w, h, bright) {
  const threshold = otsuThreshold(gray);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i += 1) {
    bin[i] = gray[i] > threshold === bright ? 1 : 0;
  }
  return bin;
}

// ─────────────────────────────── 덩어리 나누기

/**
 * 붙어 있는 픽셀을 하나의 덩어리로 묶는다 (8방향).
 * 안티에일리어싱으로 획이 살짝 끊겨도 대각선으로 이어 주려고 8방향을 쓴다.
 */
function components(bin, w, h) {
  const seen = new Uint8Array(w * h);
  const found = [];
  const stack = [];

  for (let start = 0; start < bin.length; start += 1) {
    if (!bin[start] || seen[start]) continue;

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    const pixels = [];

    while (stack.length > 0) {
      const p = stack.pop();
      const x = p % w;
      const y = (p / w) | 0;
      pixels.push(p);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (bin[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }

    found.push({ minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1, pixels });
  }
  return found;
}

/**
 * 숫자 덩어리로 볼 만한 생김새인지.
 *
 * 폭은 넉넉하게 본다 — 화면을 키우면 옆 숫자와 획이 붙어 한 덩어리가 되는 일이
 * 흔한데(안티에일리어싱), 여기서 잘라내면 "12"가 통째로 사라진다.
 * 붙은 덩어리는 뒤에서 splitComponent가 나눈다.
 */
function looksLikeDigit(c, imageH, maxDigits = 3) {
  if (c.h < 5 || c.w < 2) return false;
  if (c.pixels.length < 6) return false;
  if (c.h > imageH * 0.98 && c.w > c.h * 1.5) return false; // 가로 테두리
  if (c.w > c.h * maxDigits * 0.85) return false; // 자릿수를 넘게 긴 것은 글자가 아니다
  const fill = c.pixels.length / (c.w * c.h);
  if (fill > 0.92 && c.w / c.h > 0.45) return false; // 꽉 찬 네모 (아이콘·배경 조각)
  return true;
}

/** 픽셀 목록으로 덩어리 하나를 다시 만든다 */
function boxFrom(pixels, w) {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (const p of pixels) {
    const x = p % w;
    const y = (p / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1, pixels };
}

/**
 * 붙어 버린 덩어리를 k조각으로 나눈다.
 *
 * 화면을 키워 읽으면 "12"의 1과 2가 획 하나로 이어지는 일이 흔하다. 그러면
 * 덩어리가 하나뿐이라 두 자리가 한 글자로 눌려 엉뚱한 숫자(8 같은)가 된다 —
 * 옛 인식기가 12·32·48을 죄다 8로 읽던 이유가 이거였다.
 *
 * 세로줄마다 글자 픽셀 수를 세어, 균등 분할 자리 근처에서 **제일 얇은 곳**을 자른다.
 *
 * @returns {Array|null} 나눌 수 없으면 null
 */
function splitComponent(comp, w, k) {
  if (k < 2 || comp.w < k * 3) return null;

  const cols = new Uint32Array(comp.w);
  for (const p of comp.pixels) cols[(p % w) - comp.minX] += 1;

  const cuts = [];
  for (let i = 1; i < k; i += 1) {
    const ideal = Math.round((comp.w * i) / k);
    const span = Math.max(1, Math.round(comp.w / (k * 3)));
    let best = -1;
    let bestVal = Infinity;
    for (let x = Math.max(1, ideal - span); x <= Math.min(comp.w - 2, ideal + span); x += 1) {
      // 얇은 곳 우선, 같으면 균등 분할에 가까운 쪽
      const v = cols[x] * 1000 + Math.abs(x - ideal);
      if (v < bestVal) {
        bestVal = v;
        best = x;
      }
    }
    if (best < 0 || cuts.includes(best)) return null;
    cuts.push(best);
  }
  cuts.sort((a, b) => a - b);

  const bounds = [0, ...cuts, comp.w];
  const parts = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const lo = bounds[i];
    const hi = bounds[i + 1];
    const pixels = comp.pixels.filter((p) => {
      const x = (p % w) - comp.minX;
      return x >= lo && x < hi;
    });
    if (pixels.length < 6) return null;
    parts.push(boxFrom(pixels, w));
  }
  return parts;
}

/**
 * 세로로 겹치는 덩어리끼리 묶어 "글자 줄"을 만든다.
 * 턴 숫자 옆에 아이콘이나 다른 줄 글자가 걸쳐 들어와도, 진짜 숫자 줄만 골라내려는 것.
 */
function textLines(comps) {
  const sorted = [...comps].sort((a, b) => a.minY - b.minY);
  /** @type {Array<Array<typeof comps[0]>>} */
  const lines = [];

  for (const c of sorted) {
    let placed = false;
    for (const line of lines) {
      const top = Math.min(...line.map((x) => x.minY));
      const bottom = Math.max(...line.map((x) => x.maxY));
      const overlap = Math.min(bottom, c.maxY) - Math.max(top, c.minY) + 1;
      if (overlap > 0 && overlap >= Math.min(bottom - top + 1, c.h) * 0.5) {
        line.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) lines.push([c]);
  }
  return lines;
}

/**
 * 가장 그럴듯한 글자 줄 하나를 고른다.
 * 높이가 크고 글자 수가 적당한 줄을 좋아한다 — 턴 숫자는 화면에서 크게 나온다.
 */
function pickLine(lines, maxDigits) {
  let best = null;
  let bestScore = -1;
  for (const line of lines) {
    const heights = line.map((c) => c.h).sort((a, b) => a - b);
    const median = heights[heights.length >> 1];
    const kept = line.filter((c) => c.h >= median * 0.6 && c.h <= median * 1.6);
    if (kept.length === 0) continue;
    // 높이가 클수록, 글자 수가 자릿수 범위에 가까울수록 좋은 줄
    const overflow = Math.max(0, kept.length - maxDigits);
    const score = median * kept.length - overflow * median * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = kept;
    }
  }
  return best || [];
}

/**
 * 숫자로 볼 만한 덩어리만 왼쪽부터 정렬해 돌려준다.
 * 자릿수를 넘치면 가로로 이어진 구간 중 가장 큰 덩어리들을 남긴다 (끝에 붙은 잡티 제거).
 */
function digitBoxes(comps, imageH, maxDigits = 3) {
  const usable = comps.filter((c) => looksLikeDigit(c, imageH, maxDigits));
  if (usable.length === 0) return [];

  const line = pickLine(textLines(usable), maxDigits);
  line.sort((a, b) => a.minX - b.minX);
  if (line.length <= maxDigits) return line;

  // 연속한 maxDigits개 중 면적 합이 가장 큰 구간
  let bestAt = 0;
  let bestArea = -1;
  for (let i = 0; i + maxDigits <= line.length; i += 1) {
    let area = 0;
    for (let j = i; j < i + maxDigits; j += 1) area += line[j].pixels.length;
    if (area > bestArea) {
      bestArea = area;
      bestAt = i;
    }
  }
  return line.slice(bestAt, bestAt + maxDigits);
}

// ─────────────────────────────── 크기 맞추기

/** 덩어리만 잘라낸 작은 비트맵 */
function cropBitmap(comp, w) {
  const data = new Uint8Array(comp.w * comp.h);
  for (const p of comp.pixels) {
    const x = (p % w) - comp.minX;
    const y = ((p / w) | 0) - comp.minY;
    data[y * comp.w + x] = 1;
  }
  return { data, w: comp.w, h: comp.h };
}

/**
 * 템플릿 격자에 맞춰 줄인다.
 * **가로세로 비율을 지킨다** — 1은 홀쭉하고 0은 통통한데, 늘려 채우면 그 차이가 사라진다.
 */
function normalize(bmp) {
  const scale = Math.min(GRID_W / bmp.w, GRID_H / bmp.h);
  const dw = Math.max(1, Math.round(bmp.w * scale));
  const dh = Math.max(1, Math.round(bmp.h * scale));
  const offX = Math.floor((GRID_W - dw) / 2);
  const offY = Math.floor((GRID_H - dh) / 2);

  const grid = new Uint8Array(GRID_W * GRID_H);
  for (let y = 0; y < dh; y += 1) {
    const sy0 = Math.floor((y * bmp.h) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * bmp.h) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx0 = Math.floor((x * bmp.w) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * bmp.w) / dw));

      let on = 0;
      let total = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          total += 1;
          on += bmp.data[sy * bmp.w + sx];
        }
      }
      if (on * 2 >= total) grid[(offY + y) * GRID_W + offX + x] = 1;
    }
  }
  return grid;
}

// ─────────────────────────────── 대조

/** 한 칸씩 부풀린다 — 획 굵기가 조금 달라도 겹치게 */
function dilate(grid) {
  const out = new Uint8Array(grid.length);
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (!grid[y * GRID_W + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= GRID_H) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= GRID_W) continue;
          out[ny * GRID_W + nx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * 닮은 정도 0~1. 두 가지를 반씩 섞는다.
 *  · 딱 겹치는 비율(자카드) — 숫자끼리 구분은 잘 되지만 획 굵기 차이에 약하다
 *  · 한 칸 부풀린 뒤 서로 덮는 비율 — 굵기에 너그럽지만 뭐든 비슷해 보인다
 * 하나만 쓰면 한쪽으로 치우쳐 폰트가 바뀔 때 못 읽거나 아무거나 읽는다.
 */
function similarity(a, b, exactWeight = 0.5) {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] && b[i]) both += 1;
    if (a[i] || b[i]) either += 1;
  }
  if (either === 0) return 0;
  const exact = both / either;

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
  const loose = (aIn / aOn + bIn / bOn) / 2;

  return exact * exactWeight + loose * (1 - exactWeight);
}

/**
 * 획으로 둘러싸인 빈 곳 — 개수와 위치.
 *
 * 개수: 0·6·9는 1개, 8은 2개, 1·2·3·5·7은 0개.
 * 위치: 같은 1개라도 **6은 아래, 9는 위, 0은 가운데**에 뚫려 있다.
 *       개수만 보면 이 셋을 못 가른다 — 실제로 9를 0으로, 6을 8로 읽던 원인이었다.
 *
 * @returns {{count: number, y: number}} y는 구멍 픽셀의 세로 중심(0~1), 구멍이 없으면 -1
 */
function holeInfo(grid) {
  const outside = new Uint8Array(grid.length);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const i = y * GRID_W + x;
    if (grid[i] || outside[i]) return;
    outside[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < GRID_W; x += 1) {
    push(x, 0);
    push(x, GRID_H - 1);
  }
  for (let y = 0; y < GRID_H; y += 1) {
    push(0, y);
    push(GRID_W - 1, y);
  }
  while (stack.length > 0) {
    const p = stack.pop();
    push((p % GRID_W) - 1, (p / GRID_W) | 0);
    push((p % GRID_W) + 1, (p / GRID_W) | 0);
    push(p % GRID_W, ((p / GRID_W) | 0) - 1);
    push(p % GRID_W, ((p / GRID_W) | 0) + 1);
  }

  const seen = new Uint8Array(grid.length);
  let holes = 0;
  let sumY = 0;
  let count = 0;
  for (let start = 0; start < grid.length; start += 1) {
    if (grid[start] || outside[start] || seen[start]) continue;
    holes += 1;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = /** @type {number} */ (stack.pop());
      const x = p % GRID_W;
      const y = (p / GRID_W) | 0;
      sumY += y;
      count += 1;
      const step = (nx, ny) => {
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return;
        const q = ny * GRID_W + nx;
        if (grid[q] || outside[q] || seen[q]) return;
        seen[q] = 1;
        stack.push(q);
      };
      step(x - 1, y);
      step(x + 1, y);
      step(x, y - 1);
      step(x, y + 1);
    }
  }
  return { count: holes, y: count ? sumY / count / (GRID_H - 1) : -1 };
}

/** 구멍 개수만 (예전 이름 그대로 쓰던 곳을 위해) */
function holeCount(grid) {
  return holeInfo(grid).count;
}

/**
 * JSON(행 문자열) → 대조에 쓰는 형태.
 * 사용자가 직접 가르친 템플릿은 weight를 조금 높여 같은 점수일 때 이기게 한다 —
 * 그 사람 게임 화면에서 뽑은 것이라 어떤 기본 폰트보다 정확하다.
 */
function loadTemplates(json, { weight = 1 } = {}) {
  const list = (json && json.templates) || [];
  return list.map((t) => {
    const grid = new Uint8Array(GRID_W * GRID_H);
    (t.rows || []).forEach((row, y) => {
      if (y >= GRID_H) return;
      for (let x = 0; x < row.length && x < GRID_W; x += 1) {
        if (row[x] !== '0' && row[x] !== ' ') grid[y * GRID_W + x] = 1;
      }
    });
    return { digit: t.d, grid, hole: holeInfo(grid), weight: t.weight ?? weight };
  });
}

/** 격자 → JSON 행 문자열 (템플릿을 만들 때 쓴다) */
function gridToRows(grid) {
  const rows = [];
  for (let y = 0; y < GRID_H; y += 1) {
    let line = '';
    for (let x = 0; x < GRID_W; x += 1) line += grid[y * GRID_W + x] ? '1' : '0';
    rows.push(line);
  }
  return rows;
}

/**
 * 대조 계수 — 폰트를 바꿔 가며 재서 고른 값이다 (tools/tune-reader.js 로 재현 가능).
 * 손으로 만지지 말고, 고칠 일이 있으면 벤치를 돌려 **틀림 비율**부터 보고 정할 것.
 */
const MATCH = {
  /** 딱 겹치는 비율(자카드)에 주는 비중. 나머지는 획 굵기에 너그러운 쪽이 가져간다 */
  exactWeight: 0.5,
  /** 구멍 개수가 1 다를 때 곱하는 값 */
  hole1: 0.72,
  /** 구멍 개수가 2 이상 다를 때 */
  hole2: 0.5,
  /** 구멍 개수는 같은데 위치가 다를 때의 최대 감점 */
  holeY: 0.55,
  /** 조각을 하나 더 나눌 때마다 깎는 점수 (헛되이 나누는 걸 막는다) */
  splitCost: 0.02,
};

/** 격자 하나에 대한 0~9 점수표 */
function scoreGrid(grid, templates, params = MATCH) {
  const hole = holeInfo(grid);
  const perDigit = new Array(10).fill(0);
  for (const t of templates) {
    let s = similarity(grid, t.grid, params.exactWeight ?? 0.5) * (t.weight ?? 1);

    const diff = Math.abs(t.hole.count - hole.count);
    if (diff === 1) s *= params.hole1;
    else if (diff >= 2) s *= params.hole2;
    else if (hole.count > 0 && t.hole.y >= 0 && hole.y >= 0) {
      // 개수가 같으면 위치를 본다 — 6(아래) · 9(위) · 0(가운데)를 갈라 준다
      s *= 1 - Math.min(1, Math.abs(t.hole.y - hole.y) * 2) * params.holeY;
    }

    if (s > perDigit[t.digit]) perDigit[t.digit] = Math.min(1, s);
  }
  return perDigit;
}

/**
 * 자리마다의 점수표에서 실제 숫자를 고른다.
 *
 * @param {number[][]} scores 자리별 0~9 점수
 * @param {{minScore?: number, minMargin?: number, strictMargin?: number,
 *          candidates?: number[]}} opts
 *   candidates 이 빌드에 실제로 나오는 턴 숫자들. 애매한 자리를 여기에 맞춘다.
 *   strictMargin 후보에 없는 숫자를 그래도 믿어 주려면 필요한 차이 (기본 minMargin×3)
 * @returns {{value:number, digits:number[], confidence:number, margin:number, snapped:boolean}|null}
 */
function bestValue(scores, opts = {}) {
  // 문턱값은 재서 골랐다 (tools/bench-reader.js · tools/tune-reader.js).
  // 실제 폰트 792장에서 맞음 98.6% · 모르겠음 0.5% · 틀림 0.9%.
  // 더 올리면 "모르겠음"만 급격히 늘고 틀림은 거의 안 줄어든다.
  const minScore = opts.minScore ?? 0.7;
  const minMargin = opts.minMargin ?? 0.04;
  if (!scores || scores.length === 0) return null;

  const digits = [];
  let confidence = 1;
  let margin = 1;

  for (const per of scores) {
    let best = -1;
    let bestScore = 0;
    let runnerUp = 0;
    for (let d = 0; d <= 9; d += 1) {
      if (per[d] > bestScore) {
        runnerUp = bestScore;
        bestScore = per[d];
        best = d;
      } else if (per[d] > runnerUp) {
        runnerUp = per[d];
      }
    }
    if (best < 0) return null;
    digits.push(best);
    if (bestScore < confidence) confidence = bestScore;
    if (bestScore - runnerUp < margin) margin = bestScore - runnerUp;
  }

  const raw = Number(digits.join(''));
  const clear = confidence >= minScore && margin >= minMargin;

  // 이 빌드에 실제로 나오는 턴 — 게임이 보여줄 수 있는 숫자를 이미 아는데 안 쓰면 아깝다.
  const candidates = (opts.candidates || []).filter(
    (c) => Number.isInteger(c) && c >= 0 && String(c).length === scores.length,
  );

  if (candidates.length === 0) {
    return clear ? { value: raw, digits, confidence, margin, snapped: false } : null;
  }

  // 후보가 있으면 **후보 안에서** 1등과 2등을 다시 가른다.
  //
  // 예전엔 "후보에 있으니 맞겠지" 하고 확신 없는 읽기를 그대로 통과시켰다.
  // 한 자리 숫자에서는 0·4·7·8·9가 전부 후보라 8을 0으로 읽고도 자신 있게
  // 넘어갔다 — 오독의 제일 큰 원인이었다. 후보 안이라고 확실해지지는 않는다.
  const ranked = candidates
    .map((value) => {
      const ds = String(value).split('').map(Number);
      let sum = 0;
      let worst = 1;
      for (let i = 0; i < ds.length; i += 1) {
        const s = scores[i][ds[i]];
        sum += s;
        if (s < worst) worst = s;
      }
      return { value, digits: ds, total: sum, confidence: worst };
    })
    .sort((a, b) => b.total - a.total);

  const top = ranked[0];
  const runnerUp = ranked[1];
  const gap = runnerUp ? (top.total - runnerUp.total) / scores.length : 1;

  if (top.confidence >= minScore && gap >= minMargin) {
    return {
      value: top.value,
      digits: top.digits,
      confidence: top.confidence,
      margin: gap,
      snapped: top.value !== raw,
    };
  }

  // 후보 중에는 마땅한 게 없는데 원본은 아주 확실하다 — 빌드에 없는 턴이 화면에
  // 뜨는 경우도 있으니 길을 완전히 막지는 않는다. 대신 문턱을 훨씬 높인다.
  if (clear && margin >= (opts.strictMargin ?? minMargin * 3)) {
    return { value: raw, digits, confidence, margin, snapped: false };
  }
  return null;
}

/**
 * 잘라 온 턴 숫자 영역에서 숫자를 읽는다.
 *
 * 밝은 글자·어두운 글자 두 경우를 모두 시도해 더 확실한 쪽을 쓴다.
 * 예전엔 "화면에서 적은 쪽이 글자"라고 단정해서, 영역에 밝은 패널이 조금만
 * 걸쳐도 통째로 뒤집혀 아무것도 못 읽었다.
 *
 * @param {Uint8Array} gray 회색조 픽셀 (길이 w*h)
 * @param {{minScore?:number, minMargin?:number, maxDigits?:number, candidates?:number[]}} [opts]
 * @returns {{value:number, confidence:number, margin:number, digits:number[],
 *            bright:boolean, snapped:boolean, boxes:number}|null}
 */
/**
 * 덩어리 하나를 그대로 볼지, 2~3조각으로 나눠 볼지 인식기가 직접 고르게 한다.
 *
 * 어림짐작으로 "폭이 넓으면 나눈다"고 하면 폰트마다 어긋난다. 대신 나눠 본 뒤
 * **어느 쪽이 더 숫자답게 읽히는지** 점수로 비교한다. 나누면 자릿수가 늘어나니
 * 확실히 나을 때만 나누도록 안 나눈 쪽에 약간의 가산점을 준다.
 */
function expandBox(box, w, templates, maxDigits, params) {
  // 평균만 보면 한 조각이 엉망이어도 나머지가 가려 준다 — 제일 나쁜 조각도 같이 본다.
  // 잘못 나눈 결과는 거의 항상 "한 조각이 형편없다"로 드러난다.
  const rate = (parts) => {
    let sum = 0;
    let worst = 1;
    for (const p of parts) {
      // 너무 홀쭉하거나 넓은 조각이 나오면 나눈 자리가 틀린 것이다
      const aspect = p.w / p.h;
      if (aspect < 0.12 || aspect > 1.05) return 0;
      const s = Math.max(...scoreGrid(normalize(cropBitmap(p, w)), templates, params));
      sum += s;
      if (s < worst) worst = s;
    }
    const mean = sum / parts.length;
    // 자릿수가 늘어날수록 조금씩 불리하게 — 확실히 나을 때만 나눈다
    return (mean + worst) / 2 - (parts.length - 1) * (params.splitCost ?? 0.02);
  };

  let best = [box];
  let bestScore = rate(best);
  const maxK = Math.min(maxDigits, Math.max(1, Math.round(box.w / Math.max(1, box.h * 0.42))));
  for (let k = 2; k <= maxK; k += 1) {
    const parts = splitComponent(box, w, k);
    if (!parts) continue;
    const score = rate(parts);
    if (score > bestScore) {
      bestScore = score;
      best = parts;
    }
  }
  return best;
}

function readTurn(gray, w, h, templates, opts = {}) {
  if (!gray || w <= 0 || h <= 0 || !templates || templates.length === 0) return null;
  const maxDigits = opts.maxDigits ?? 3;
  const params = opts.match || MATCH;

  let best = null;
  for (const bright of [true, false]) {
    const found = digitBoxes(components(binarize(gray, w, h, bright), w, h), h, maxDigits);
    if (found.length === 0) continue;

    // 붙어 버린 덩어리를 풀어 준다 ("12"가 한 덩어리로 잡히는 흔한 경우)
    const boxes = [];
    for (const box of found) boxes.push(...expandBox(box, w, templates, maxDigits, params));
    if (boxes.length === 0 || boxes.length > maxDigits) continue;

    const scores = boxes.map((box) => scoreGrid(normalize(cropBitmap(box, w)), templates, params));
    const got = bestValue(scores, opts);
    if (!got) continue;

    const ranked = { ...got, bright, boxes: boxes.length };

    // ★ 자릿수를 더 많이 찾은 쪽이 이긴다.
    //
    // 점수(마진)만 보고 고르면, 글자와 배경이 뒤집힌 쪽에서 "60"이 한 덩어리로
    // 잡혀 7 하나로 읽히고, 자릿수가 하나뿐이라 경쟁자가 없어 마진이 커서
    // **그 엉터리 결과가 이겼다.** 두 자리를 찾아낸 쪽이 거의 항상 옳다.
    const better =
      !best ||
      ranked.boxes > best.boxes ||
      (ranked.boxes === best.boxes &&
        (ranked.margin > best.margin + 0.02 ||
          (Math.abs(ranked.margin - best.margin) <= 0.02 && ranked.confidence > best.confidence)));
    if (better) best = ranked;
  }
  return best;
}

module.exports = {
  GRID_W,
  GRID_H,
  MATCH,
  toGray,
  otsuThreshold,
  binarize,
  components,
  looksLikeDigit,
  boxFrom,
  splitComponent,
  textLines,
  pickLine,
  digitBoxes,
  cropBitmap,
  normalize,
  dilate,
  similarity,
  holeInfo,
  holeCount,
  loadTemplates,
  gridToRows,
  scoreGrid,
  expandBox,
  bestValue,
  readTurn,
};
