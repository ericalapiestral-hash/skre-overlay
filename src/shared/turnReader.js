// 턴 숫자 전용 인식기.
//
// 범용 OCR(tesseract·ML Kit)은 "아무 글자나" 읽으려다 게임 폰트에서 흔들리고,
// 워커·모델 때문에 앱이 76MB씩 무거워진다. 여기서 가릴 것은 0~9 열 개뿐이라
// 이진화 → 덩어리 분리 → 크기 정규화 → 템플릿 대조 로 끝난다. 의존성이 없다.
//
// 정확도를 위해 고친 것:
//  · **명암 두 방향을 모두 시도한다.** 예전엔 "화면에서 적은 쪽이 글자"라고 단정해서,
//    잘라 온 영역에 밝은 패널이 조금만 걸쳐도 글자와 배경이 뒤집혔다.
//  · **자릿수를 더 많이 찾은 쪽이 이긴다.** 점수만 보면 "60"이 한 덩어리로 잡힌 쪽이
//    경쟁자가 없어 마진이 커서 이겼고, 그래서 7 하나로 읽혔다.
//  · **붙어 버린 숫자를 나눈다.** 나눌지 말지는 어림짐작이 아니라 인식 점수로 정한다.
//  · **구멍의 위치까지 본다.** 개수만 보면 6(아래)·9(위)·0(가운데)를 못 가른다.
//  · **점수표를 그대로 내보낸다.** 빌드가 아는 턴(후보)으로 애매한 자리를 맞출 수 있게.
//
// 속도를 위해 고친 것 — 게임과 CPU를 나눠 쓰는 도구라 프레임당 비용이 곧 프레임 간격이다:
//  · **격자를 비트로 다룬다.** 336칸을 32비트 낱말 11개에 담아, 겹치는 칸 세기를
//    비트 AND + popcount로 한다. 칸마다 도는 것보다 열 배 넘게 빠르다.
//  · **부풀린 모양을 미리 만들어 둔다.** 예전엔 대조 한 번마다 양쪽을 새로 부풀렸다 —
//    템플릿이 130개니 같은 계산을 프레임마다 260번 다시 했다. 여기가 전체의 90%였다.
//  · **상한으로 가지친다.** 획 수 차이만 봐도 넘을 수 없는 점수가 정해지므로, 그 숫자의
//    현재 1등을 못 넘길 템플릿은 계산 자체를 건너뛴다. 결과는 조금도 달라지지 않는다.
//  · **덩어리를 라벨 지도로 다룬다.** 픽셀 목록을 만들지 않아 프레임마다 생기는
//    쓰레기가 거의 없다.
//
//   const templates = loadTemplates(require('./templates.json'));
//   const got = readTurn(gray, w, h, templates);
'use strict';

/**
 * 잘라 온 턴 영역을 이 높이(px) 근처로 키워서 읽는다.
 *
 * 크게 키울수록 좋을 것 같지만 아니다. 실제 폰트 792장으로 재 보면
 *   확대 안 함  맞음 98.9% · 틀림 0.8%
 *   48px       맞음 99.4% · 틀림 0.6%
 *   **64px       맞음 99.7% · 틀림 0.3%**   ← 여기가 제일 좋다
 *   96px       맞음 99.2% · 틀림 0.8%   (게다가 1.75배 느리다)
 * 너무 키우면 부드럽게 늘어나는 과정에서 옆 숫자와 획이 붙어 자릿수를 잃는다.
 *
 * 화면(캡처)과 벤치가 같은 값을 써야 재는 것과 실제가 어긋나지 않는다 —
 * 그래서 여기 한 곳에만 둔다.
 */
const CROP_TARGET_HEIGHT = 64;

/** 템플릿 격자 크기 — 숫자 하나를 이 크기로 줄여 맞춘다 */
const GRID_W = 14;
const GRID_H = 24;
const GRID_N = GRID_W * GRID_H;
/** 격자 한 장을 담는 32비트 낱말 수 */
const WORDS = Math.ceil(GRID_N / 32);

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
 * @param {number} [threshold] 미리 구해 둔 문턱값 (두 방향을 볼 때 Otsu를 두 번 돌리지 않게)
 */
function binarize(gray, w, h, bright, threshold) {
  const t = threshold === undefined ? otsuThreshold(gray) : threshold;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i += 1) {
    bin[i] = gray[i] > t === bright ? 1 : 0;
  }
  return bin;
}

// ─────────────────────────────── 덩어리 나누기

/**
 * @typedef {{label: number, labels: Int32Array, minX: number, minY: number,
 *            maxX: number, maxY: number, w: number, h: number, count: number}} Box
 */

/**
 * 붙어 있는 픽셀을 하나의 덩어리로 묶는다 (8방향).
 * 안티에일리어싱으로 획이 살짝 끊겨도 대각선으로 이어 주려고 8방향을 쓴다.
 *
 * 픽셀 목록 대신 **라벨 지도**를 만든다. 목록을 만들면 덩어리마다 수천 개짜리 배열이
 * 프레임마다 생겼다가 버려진다 — 지도는 한 장이면 되고, 나중에 잘라 낼 때 그 자리만 훑으면 된다.
 *
 * @returns {Box[]}
 */
function components(bin, w, h) {
  const labels = new Int32Array(w * h); // 0 = 아직 없음, 1부터 덩어리 번호
  const stack = new Int32Array(bin.length);
  const boxes = [];

  for (let start = 0; start < bin.length; start += 1) {
    if (!bin[start] || labels[start] !== 0) continue;

    const label = boxes.length + 1;
    let sp = 0;
    stack[sp] = start;
    sp += 1;
    labels[start] = label;

    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let count = 0;

    while (sp > 0) {
      sp -= 1;
      const p = stack[sp];
      const x = p % w;
      const y = (p / w) | 0;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const row = ny * w;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = row + nx;
          if (bin[q] && labels[q] === 0) {
            labels[q] = label;
            stack[sp] = q;
            sp += 1;
          }
        }
      }
    }

    boxes.push({
      label,
      labels,
      minX,
      minY,
      maxX,
      maxY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      count,
    });
  }
  return boxes;
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
  if (c.count < 6) return false;
  if (c.h > imageH * 0.98 && c.w > c.h * 1.5) return false; // 가로 테두리
  if (c.w > c.h * maxDigits * 0.85) return false; // 자릿수를 넘게 긴 것은 글자가 아니다
  const fill = c.count / (c.w * c.h);
  if (fill > 0.92 && c.w / c.h > 0.45) return false; // 꽉 찬 네모 (아이콘·배경 조각)
  return true;
}

/**
 * 슬래시를 가리는 값 — `tools/measure-slash.js` 로 **재서** 골랐다.
 *
 * 게임의 턴 표시는 그냥 숫자가 아니라 **"16 / 70"** (지금 턴 / 최대 턴)이다.
 * 오른쪽 70까지 같이 읽으면 "1670"이 되므로 슬래시를 찾아 왼쪽만 남겨야 한다.
 *
 * 값은 `tools/tune-slash.js`가 **앱과 같은 조건에서**(크롭을 64px로 키운 뒤) 재서 골랐다.
 * 원본 크기의 낱글자로 재서 고른 값을 넣었더니 오독이 일곱 배로 늘었다 — 확대하면
 * 획이 번져 ratio도 fill도 달라진다. bench가 예전에 저지른 것과 똑같은 실수다.
 * **원본 크기로 재는 쪽으로 되돌리지 말 것.**
 *
 * 앱 조건에서는 **diag가 완전히 가른다**: 숫자는 −0.15~**0.23**, 슬래시는 **0.38**~0.61.
 * 그 틈(0.15)의 가운데가 0.31이다. ratio·fill은 갈라 주지는 않지만(둘 다 겹친다)
 * 처음 보는 폰트에서 엉뚱한 덩어리가 diag만 높게 나오는 것을 막는 울타리로 같이 둔다.
 *
 * 고르는 기준 둘:
 *  · **숫자를 슬래시로 잘못 보는 일(거짓 양성)이 0**일 것. 그러면 진짜 숫자가 잘려 나가
 *    턴을 반쪽만 읽는다. 슬래시를 못 알아보는 건 예전 상태로 돌아갈 뿐이라 덜 나쁘다.
 *  · **양쪽 여유의 작은 쪽**을 키울 것. 한쪽만 넉넉한 값은 반대쪽으로 뚫린다.
 *
 * 지금 값: 숫자 덩어리 1470개 중 오검출 0, 슬래시 100% 포착, 양쪽 여유 0.07대.
 * 만질 일이 생기면 `node tools/tune-slash.js`로 **다시 재서** 정할 것.
 */
const SLASH = { maxRatio: 0.64, maxFill: 0.6, minDiag: 0.31 };

/**
 * 덩어리의 위/아래 4분의 1에서 켜진 칸의 x 무게중심 차이 (덩어리 너비 대비).
 * 슬래시는 위가 오른쪽·아래가 왼쪽이라 크게 양수다. 숫자는 어느 것도 그렇지 않다.
 */
function diagOf(box, imgW) {
  const { labels, label, minX, maxX, minY, maxY, w, h } = box;
  const band = Math.max(1, Math.round(h * 0.25));
  let topSum = 0;
  let topN = 0;
  let botSum = 0;
  let botN = 0;
  for (let y = minY; y <= maxY; y += 1) {
    const top = y < minY + band;
    const bottom = y > maxY - band;
    if (!top && !bottom) continue;
    for (let x = minX; x <= maxX; x += 1) {
      if (labels[y * imgW + x] !== label) continue;
      if (top) {
        topSum += x - minX;
        topN += 1;
      } else {
        botSum += x - minX;
        botN += 1;
      }
    }
  }
  return topN && botN ? (topSum / topN - botSum / botN) / w : 0;
}

/** "16 / 70"의 슬래시인가 */
function looksLikeSlash(box, imgW) {
  return (
    box.w / box.h < SLASH.maxRatio &&
    box.count / (box.w * box.h) < SLASH.maxFill &&
    diagOf(box, imgW) > SLASH.minDiag
  );
}

/**
 * 숫자 하나라기엔 너무 넓은 덩어리 — 두 글자가 붙은 것이다.
 * 재 본 숫자들의 가로/세로는 아무리 넓어도 0.84였다. 여유를 두고 0.9로 잡는다.
 */
const MERGED_RATIO = 0.9;

/**
 * ⚠ **어느 명암이 진짜 글자인지 "크기"나 "포함 관계"로 가르려 하지 말 것.** 두 번 해 보고
 * 두 번 다 오독이 0.3% → **14.4%** 로 뛰었다.
 *  · 높이로: 뒤집힌 쪽에서 잡히는 배경 조각이 글자보다 커서 그쪽이 이긴다.
 *  · 포함 관계로: 구멍은 글자에 **들어가지만** 배경은 글자를 **감싼다**. 방향이 반대라
 *    한쪽만 보면 배경이 이긴다.
 * 지금은 "자릿수를 더 많이 찾은 쪽이 이긴다"만 쓴다 (아래 readTurn). 표본 792장에서
 * 남는 오독은 2장뿐이고(44px "8"이 구멍 둘로 잡혀 551), 그걸 잡으려다 50배를 잃었다.
 */

/**
 * 덩어리에서 가로 [x0, x1) 구간만 떼어 낸다 (x는 덩어리 왼쪽 기준).
 * @returns {Box|null} 남는 게 거의 없으면 null
 */
function sliceBox(box, w, x0, x1) {
  const { labels, label } = box;
  let minX = box.maxX + 1;
  let maxX = -1;
  let minY = box.maxY + 1;
  let maxY = -1;
  let count = 0;

  for (let y = box.minY; y <= box.maxY; y += 1) {
    const row = y * w;
    for (let x = box.minX + x0; x < box.minX + x1; x += 1) {
      if (labels[row + x] !== label) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count < 6) return null;
  return {
    label,
    labels,
    minX,
    minY,
    maxX,
    maxY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    count,
  };
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
 * @returns {Box[]|null} 나눌 수 없으면 null
 */
function splitComponent(box, w, k) {
  if (k < 2 || box.w < k * 3) return null;

  const { labels, label } = box;
  const cols = new Uint32Array(box.w);
  for (let y = box.minY; y <= box.maxY; y += 1) {
    const row = y * w;
    for (let x = 0; x < box.w; x += 1) {
      if (labels[row + box.minX + x] === label) cols[x] += 1;
    }
  }

  const cuts = [];
  for (let i = 1; i < k; i += 1) {
    const ideal = Math.round((box.w * i) / k);
    const span = Math.max(1, Math.round(box.w / (k * 3)));
    let best = -1;
    let bestVal = Infinity;
    for (let x = Math.max(1, ideal - span); x <= Math.min(box.w - 2, ideal + span); x += 1) {
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

  const bounds = [0, ...cuts, box.w];
  const parts = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const part = sliceBox(box, w, bounds[i], bounds[i + 1]);
    if (!part) return null;
    parts.push(part);
  }
  return parts;
}

/**
 * 세로로 겹치는 덩어리끼리 묶어 "글자 줄"을 만든다.
 * 턴 숫자 옆에 아이콘이나 다른 줄 글자가 걸쳐 들어와도, 진짜 숫자 줄만 골라내려는 것.
 */
function textLines(comps) {
  const sorted = [...comps].sort((a, b) => a.minY - b.minY);
  /** @type {Array<{items: Box[], top: number, bottom: number}>} */
  const lines = [];

  for (const c of sorted) {
    let placed = false;
    for (const line of lines) {
      const overlap = Math.min(line.bottom, c.maxY) - Math.max(line.top, c.minY) + 1;
      if (overlap > 0 && overlap >= Math.min(line.bottom - line.top + 1, c.h) * 0.5) {
        line.items.push(c);
        if (c.minY < line.top) line.top = c.minY;
        if (c.maxY > line.bottom) line.bottom = c.maxY;
        placed = true;
        break;
      }
    }
    if (!placed) lines.push({ items: [c], top: c.minY, bottom: c.maxY });
  }
  return lines.map((l) => l.items);
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
function digitBoxes(comps, imageH, maxDigits = 3, opts = {}) {
  const { imgW = 0, out = null } = opts;
  if (out) {
    out.lineCount = 0;
    out.ambiguous = false;
    out.merged = false;
  }
  const usable = comps.filter((c) => looksLikeDigit(c, imageH, maxDigits));
  if (usable.length === 0) return [];

  let line = pickLine(textLines(usable), maxDigits);
  line.sort((a, b) => a.minX - b.minX);
  // 자르기 **전** 글자 수 — 어느 명암이 글자를 더 잘 갈랐는지 재는 값이다 (readTurn 참고)
  if (out) {
    out.lineCount = line.length;
    // 두 글자가 붙은 덩어리가 있나 — 슬래시가 옆 숫자에 붙었을 수 있다는 신호다
    out.merged = imgW > 0 && line.some((c) => c.w / c.h > MERGED_RATIO);

  }

  // ★ "16 / 70" 에서 슬래시 앞까지만 남긴다 — 오른쪽은 최대 턴이라 우리가 읽을 것이 아니다.
  //
  // 자릿수 제한(maxDigits)에 맡기면 안 된다. 그건 "면적 합이 제일 큰 연속 구간"을
  // 고르는 것이라 "16/70"에서 엉뚱하게 "6/7"이나 "/70"을 집는다. 슬래시를 실제로
  // 찾아서 거기서 끊어야 한다. 슬래시가 안 보이면(사용자가 영역을 숫자에만 딱 맞춰
  // 잡았으면) 아무것도 안 하므로, 예전처럼 쓰던 사람에게도 달라지는 게 없다.
  if (imgW > 0) {
    const at = line.findIndex((c) => looksLikeSlash(c, imgW));
    // 맨 앞이 슬래시로 보이면 자르지 않는다 — 남는 게 없으니 오검출일 가능성이 크다
    if (at > 0) line = line.slice(0, at);
  }

  if (line.length <= maxDigits) return line;

  // ★ 자릿수를 넘치는데 슬래시도 못 찾았고, 두 글자가 붙은 덩어리까지 있으면 **읽지 않는다.**
  //
  // "12/70"에서 슬래시가 7에 붙어 한 덩어리가 되면(작은 글자에서 실제로 생긴다) 아래
  // 면적 규칙이 "2/7 0" 같은 엉뚱한 구간을 골라 **자신 있게 틀린 턴**을 내놓는다.
  // 틀린 턴을 믿고 단계를 건너뛰면 순서가 통째로 어긋나서, 아예 못 읽고 가만히 있느니만
  // 못하다 (CLAUDE.md). 이 조건은 좁다 — 붙은 덩어리가 없으면(끝에 잡티가 붙은 흔한
  // 경우) 예전처럼 면적 규칙으로 간다.
  //
  // 여기서 그냥 빈 손으로 돌아가면 **반대쪽 명암이 그대로 이긴다.** 뒤집힌 쪽에서는
  // 글자 구멍 두어 개가 잡히는데, 그게 유일한 후보가 되어 "12/70"이 "1"로 읽혔다.
  // 그래서 "못 읽겠다"를 밖으로 알려서 프레임 전체를 물리게 한다 (readTurn 참고).
  if (out && out.merged) {
    out.ambiguous = true;
    return [];
  }

  // 연속한 maxDigits개 중 면적 합이 가장 큰 구간
  let bestAt = 0;
  let bestArea = -1;
  for (let i = 0; i + maxDigits <= line.length; i += 1) {
    let area = 0;
    for (let j = i; j < i + maxDigits; j += 1) area += line[j].count;
    if (area > bestArea) {
      bestArea = area;
      bestAt = i;
    }
  }
  return line.slice(bestAt, bestAt + maxDigits);
}

// ─────────────────────────────── 크기 맞추기

/** 덩어리만 잘라낸 작은 비트맵 */
function cropBitmap(box, w) {
  const { labels, label } = box;
  const data = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y += 1) {
    const src = (box.minY + y) * w + box.minX;
    const dst = y * box.w;
    for (let x = 0; x < box.w; x += 1) {
      if (labels[src + x] === label) data[dst + x] = 1;
    }
  }
  return { data, w: box.w, h: box.h };
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

  const grid = new Uint8Array(GRID_N);
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
  const out = new Uint8Array(GRID_N);
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (!grid[y * GRID_W + x]) continue;
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < GRID_H - 1 ? y + 1 : GRID_H - 1;
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < GRID_W - 1 ? x + 1 : GRID_W - 1;
      for (let ny = y0; ny <= y1; ny += 1) {
        for (let nx = x0; nx <= x1; nx += 1) out[ny * GRID_W + nx] = 1;
      }
    }
  }
  return out;
}

/** 켜진 비트 개수 */
function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

function pack(grid) {
  const bits = new Uint32Array(WORDS);
  for (let i = 0; i < GRID_N; i += 1) {
    if (grid[i]) bits[i >>> 5] |= 1 << (i & 31);
  }
  return bits;
}

/**
 * 대조에 바로 쓸 수 있게 미리 갈아 둔 모양.
 *
 * 부풀린 형태(dil)를 여기서 한 번만 만든다. 예전엔 대조 한 번마다 양쪽을 새로
 * 부풀렸는데, 템플릿이 130개라 같은 계산을 프레임마다 260번 되풀이했다.
 *
 * @typedef {{bits: Uint32Array, dil: Uint32Array, on: number,
 *            hole: {count: number, y: number}}} Shape
 * @returns {Shape}
 */
function makeShape(grid) {
  const bits = pack(grid);
  let on = 0;
  for (let i = 0; i < WORDS; i += 1) on += popcount(bits[i]);
  return { bits, dil: pack(dilate(grid)), on, hole: holeInfo(grid) };
}

/**
 * 닮은 정도 0~1. 두 가지를 섞는다.
 *  · 딱 겹치는 비율(자카드) — 숫자끼리 구분은 잘 되지만 획 굵기 차이에 약하다
 *  · 한 칸 부풀린 뒤 서로 덮는 비율 — 굵기에 너그럽지만 뭐든 비슷해 보인다
 * 하나만 쓰면 한쪽으로 치우쳐 폰트가 바뀔 때 못 읽거나 아무거나 읽는다.
 */
function similarityOf(a, b, exactWeight) {
  if (a.on === 0 || b.on === 0) return 0;

  let both = 0;
  let aIn = 0;
  let bIn = 0;
  for (let i = 0; i < WORDS; i += 1) {
    const av = a.bits[i];
    const bv = b.bits[i];
    both += popcount(av & bv);
    aIn += popcount(av & b.dil[i]);
    bIn += popcount(bv & a.dil[i]);
  }
  const either = a.on + b.on - both;
  if (either === 0) return 0;

  const exact = both / either;
  const loose = (aIn / a.on + bIn / b.on) / 2;
  return exact * exactWeight + loose * (1 - exactWeight);
}

/** 격자 두 장의 닮은 정도 (도구·시험용 — 프레임마다 도는 길에서는 Shape를 쓴다) */
function similarity(a, b, exactWeight = 0.5) {
  return similarityOf(makeShape(a), makeShape(b), exactWeight);
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
  const outside = new Uint8Array(GRID_N);
  const stack = new Int32Array(GRID_N);
  let sp = 0;
  const push = (x, y) => {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const i = y * GRID_W + x;
    if (grid[i] || outside[i]) return;
    outside[i] = 1;
    stack[sp] = i;
    sp += 1;
  };

  for (let x = 0; x < GRID_W; x += 1) {
    push(x, 0);
    push(x, GRID_H - 1);
  }
  for (let y = 0; y < GRID_H; y += 1) {
    push(0, y);
    push(GRID_W - 1, y);
  }
  while (sp > 0) {
    sp -= 1;
    const p = stack[sp];
    const x = p % GRID_W;
    const y = (p / GRID_W) | 0;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  const seen = new Uint8Array(GRID_N);
  let holes = 0;
  let sumY = 0;
  let count = 0;
  for (let start = 0; start < GRID_N; start += 1) {
    if (grid[start] || outside[start] || seen[start]) continue;
    holes += 1;
    sp = 0;
    stack[sp] = start;
    sp += 1;
    seen[start] = 1;
    while (sp > 0) {
      sp -= 1;
      const p = stack[sp];
      const x = p % GRID_W;
      const y = (p / GRID_W) | 0;
      sumY += y;
      count += 1;
      const step = (nx, ny) => {
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return;
        const q = ny * GRID_W + nx;
        if (grid[q] || outside[q] || seen[q]) return;
        seen[q] = 1;
        stack[sp] = q;
        sp += 1;
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
    const grid = new Uint8Array(GRID_N);
    (t.rows || []).forEach((row, y) => {
      if (y >= GRID_H) return;
      for (let x = 0; x < row.length && x < GRID_W; x += 1) {
        if (row[x] !== '0' && row[x] !== ' ') grid[y * GRID_W + x] = 1;
      }
    });
    const shape = makeShape(grid);
    return { digit: t.d, grid, shape, hole: shape.hole, weight: t.weight ?? weight };
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

/**
 * 이진화 문턱값을 Otsu 값에서 이만큼씩 옮겨 가며 본다. 기본은 **한 번만**.
 *
 * 여러 번 보면 나을 것 같아 넣었다가 재 보고 뺐다. 크롭을 CROP_TARGET_HEIGHT로
 * 키운 뒤에는 Otsu 한 번이 실제 폰트 792장을 **전부** 맞히고(오독 0), 세 번 보면
 * 오히려 2장을 틀린다 — 다른 문턱값에서 나온 그럴듯한 오답이 "자릿수가 더 많다"는
 * 규칙을 타고 이기기 때문이다. 게다가 세 번은 3배 느리다 (0.7ms → 2.3ms).
 *
 * 구조는 남겨 둔다 — 게임 화면이 유난히 흐린 경우를 다시 재 보고 싶을 때
 * `readTurn(..., { thresholdOffsets: [0, -8, 8] })` 로 바로 비교할 수 있게.
 */
const THRESHOLD_OFFSETS = [0];

/**
 * 모양 하나에 대한 0~9 점수표.
 *
 * 템플릿을 다 도는 대신 **넘을 수 없는 상한**으로 가지친다. 자카드는 획 수 비율을,
 * 부풀린 쪽은 1을 넘지 못하므로, 구멍 감점까지 곱하면 그 템플릿이 낼 수 있는
 * 최대 점수가 정해진다. 그게 그 숫자의 현재 1등보다 낮으면 계산할 이유가 없다.
 * 결과는 전부 도는 것과 **한 자리도 다르지 않다.**
 */
function scoreShape(shape, templates, params = MATCH) {
  const exactWeight = params.exactWeight ?? 0.5;
  const perDigit = new Array(10).fill(0);
  if (shape.on === 0) return perDigit;

  for (let i = 0; i < templates.length; i += 1) {
    const t = templates[i];
    const ts = t.shape;

    const diff = Math.abs(ts.hole.count - shape.hole.count);
    let penalty = 1;
    if (diff === 1) penalty = params.hole1;
    else if (diff >= 2) penalty = params.hole2;
    else if (shape.hole.count > 0 && ts.hole.y >= 0 && shape.hole.y >= 0) {
      // 개수가 같으면 위치를 본다 — 6(아래) · 9(위) · 0(가운데)를 갈라 준다
      penalty = 1 - Math.min(1, Math.abs(ts.hole.y - shape.hole.y) * 2) * params.holeY;
    }

    const w = t.weight ?? 1;
    // 상한: 자카드 ≤ 작은쪽/큰쪽, 부풀린 쪽 ≤ 1
    const ratio =
      shape.on < ts.on ? shape.on / ts.on : ts.on / shape.on;
    const ceiling = (exactWeight * ratio + (1 - exactWeight)) * w * penalty;
    if (ceiling <= perDigit[t.digit]) continue;

    const s = similarityOf(shape, ts, exactWeight) * w * penalty;
    if (s > perDigit[t.digit]) perDigit[t.digit] = s > 1 ? 1 : s;
  }
  return perDigit;
}

/** 격자 하나에 대한 0~9 점수표 (도구·시험용) */
function scoreGrid(grid, templates, params = MATCH) {
  return scoreShape(makeShape(grid), templates, params);
}

/**
 * 자리마다의 점수표에서 실제 숫자를 고른다.
 *
 * @param {number[][]} scores 자리별 0~9 점수
 * @param {{minScore?: number, minMargin?: number, strictMargin?: number,
 *          }} opts
 *   strictMargin 후보에 없는 숫자를 그래도 믿어 주려면 필요한 차이 (기본 minMargin×3)
 * @returns {{value:number, digits:number[], confidence:number, margin:number}|null}
 */
/**
 * 자리마다의 점수표에서 값 하나를 고른다. 확신이 모자라면 **아무것도 안 고른다.**
 *
 * ★ **빌드에 나오는 턴을 "후보"로 써서 맞추던 기능은 걷어냈다. 되살리지 말 것.**
 *
 * 게임의 턴 표시는 1씩 올라가는 카운터라(`16 / 70`) 화면에 뜨는 값 대부분이
 * 빌드 단계의 턴이 **아니다.** 그런데 후보에 맞추는 코드는 "읽은 값이 빌드 턴일 것"을
 * 전제하고 있어서, 18을 28로, 20을 16으로, 9를 0으로 **자신 있게 바꿔 놓았다.**
 * 실제 게임에서 "18턴을 28턴으로 읽는다"는 얘기가 나온 원인이 이것이다.
 *
 * 표본 792장을 실제와 같은 조건(빌드 턴 다섯 개만 후보로)에서 재 본 결과:
 *
 *   후보 없음                    틀림 2장 (0.3%)
 *   또렷하면 후보 무시 (절충)     틀림 20장 (2.5%)
 *   후보에 맞춤 (예전 방식)       틀림 67장 (8.5%)   ← 전부 "후보로 맞춤"이 만든 오독
 *
 * 예전 벤치가 이걸 못 잡은 이유: **표본의 정답을 전부 후보로 넣고 쟀다.** 그러면
 * "빌드 턴이 아닌 턴"을 읽는 상황이 한 번도 시험되지 않는다 — 앱이 겪는 것과 다른
 * 것을 잰 것이다. 벤치가 예전에 저지른 실수(원본 크기로 재기)와 같은 종류다.
 */
function bestValue(scores, opts = {}) {
  // 문턱값은 재서 골랐다 (tools/bench-reader.js · tools/tune-reader.js).
  // 표본 792장에서 맞음 99.7% · 틀림 0.3%.
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
  if (confidence < minScore || margin < minMargin) return null;
  return { value: raw, digits, confidence, margin };
}

/**
 * 덩어리 하나를 그대로 볼지, 2~3조각으로 나눠 볼지 인식기가 직접 고르게 한다.
 *
 * 어림짐작으로 "폭이 넓으면 나눈다"고 하면 폰트마다 어긋난다. 대신 나눠 본 뒤
 * **어느 쪽이 더 숫자답게 읽히는지** 점수로 비교한다. 나누면 자릿수가 늘어나니
 * 확실히 나을 때만 나누도록 안 나눈 쪽에 약간의 가산점을 준다.
 *
 * 고른 조각들의 점수표를 그대로 돌려준다 — 뒤에서 다시 계산하지 않게.
 * @returns {{boxes: Box[], scores: number[][]}}
 */
function expandBox(box, w, templates, maxDigits, params = MATCH) {
  // 평균만 보면 한 조각이 엉망이어도 나머지가 가려 준다 — 제일 나쁜 조각도 같이 본다.
  // 잘못 나눈 결과는 거의 항상 "한 조각이 형편없다"로 드러난다.
  const rate = (parts) => {
    const scores = [];
    let sum = 0;
    let worst = 1;
    for (const p of parts) {
      // 너무 홀쭉하거나 넓은 조각이 나오면 나눈 자리가 틀린 것이다
      const aspect = p.w / p.h;
      if (aspect < 0.12 || aspect > 1.05) return null;
      const per = scoreShape(makeShape(normalize(cropBitmap(p, w))), templates, params);
      scores.push(per);
      const s = Math.max(...per);
      sum += s;
      if (s < worst) worst = s;
    }
    const mean = sum / parts.length;
    // 자릿수가 늘어날수록 조금씩 불리하게 — 확실히 나을 때만 나눈다
    const value = (mean + worst) / 2 - (parts.length - 1) * (params.splitCost ?? 0.02);
    return { value, scores };
  };

  const whole = rate([box]);
  let best = { boxes: [box], scores: whole ? whole.scores : [] };
  let bestValue_ = whole ? whole.value : -1;

  const maxK = Math.min(maxDigits, Math.max(1, Math.round(box.w / Math.max(1, box.h * 0.42))));
  for (let k = 2; k <= maxK; k += 1) {
    const parts = splitComponent(box, w, k);
    if (!parts) continue;
    const got = rate(parts);
    if (got && got.value > bestValue_) {
      bestValue_ = got.value;
      best = { boxes: parts, scores: got.scores };
    }
  }
  return best;
}

/**
 * 잘라 온 턴 숫자 영역에서 숫자를 읽는다.
 *
 * 이진화 문턱값 셋 × 명암 방향 둘 = 여섯 번 읽어 보고 제일 잘 읽힌 것을 쓴다.
 * 예전엔 "화면에서 적은 쪽이 글자"라고 한 번만 단정해서, 영역에 밝은 패널이
 * 조금만 걸쳐도 통째로 뒤집혀 아무것도 못 읽었다.
 *
 * @param {Uint8Array} gray 회색조 픽셀 (길이 w*h)
 * @param {{minScore?:number, minMargin?:number, maxDigits?:number,
 *          match?:object, thresholdOffsets?:number[]}} [opts]
 * @returns {{value:number, confidence:number, margin:number, digits:number[],
 *            bright:boolean, threshold:number, boxes:number}|null}
 */
function readTurn(gray, w, h, templates, opts = {}) {
  if (!gray || w <= 0 || h <= 0 || !templates || templates.length === 0) return null;
  const maxDigits = opts.maxDigits ?? 3;
  const params = opts.match || MATCH;

  // 문턱값은 밝기 분포에서 나오는 값이라 명암 방향과 무관하다 — 한 번만 구해 나눠 쓴다
  const base = otsuThreshold(gray);
  const thresholds = [];
  for (const off of opts.thresholdOffsets || THRESHOLD_OFFSETS) {
    const t = Math.max(1, Math.min(254, base + off));
    if (!thresholds.includes(t)) thresholds.push(t);
  }

  let best = null;
  // 어느 명암에서 "이건 못 읽겠다"가 나왔을 때의 글자 수 — 그보다 못 가른 결과는 물린다
  let vetoSegs = -1;
  for (const threshold of thresholds) {
    for (const bright of [true, false]) {
      // lineCount = 슬래시로 자르기 **전** 의 글자 수. 아래 "자릿수가 많은 쪽이 이긴다"에 쓴다.
      const seg = {};
      const found = digitBoxes(
        components(binarize(gray, w, h, bright, threshold), w, h),
        h,
        maxDigits,
        { imgW: w, out: seg },
      );
      if (seg.ambiguous && seg.lineCount > vetoSegs) vetoSegs = seg.lineCount;
      if (found.length === 0) continue;


      // 붙어 버린 덩어리를 풀어 준다 ("12"가 한 덩어리로 잡히는 흔한 경우)
      const boxes = [];
      const scores = [];
      for (const box of found) {
        const got = expandBox(box, w, templates, maxDigits, params);
        boxes.push(...got.boxes);
        scores.push(...got.scores);
      }

      // ★ 나눈 **뒤에** 다시 한 번 슬래시를 찾아 자른다.
      //
      // 작은 글자에서는 슬래시가 옆 숫자에 붙어 한 덩어리가 된다 ("0/70"의 "/7").
      // 그러면 덩어리 단계에서는 슬래시가 안 보이고, 나눠 놓고 보면 보인다.
      // 여기서 안 자르면 자릿수를 넘겨 이 명암이 통째로 버려지고, 뒤집힌 명암에서 잡힌
      // **글자 구멍**이 유일한 후보가 되어 빌드 턴에 맞춰 자신 있는 오답을 낸다
      // (실제로 "0/70"이 "12"로 읽혔다).
      const cutAt = boxes.findIndex((b) => looksLikeSlash(b, w));
      if (cutAt > 0) {
        boxes.length = cutAt;
        scores.length = cutAt;
      }
      if (boxes.length === 0 || boxes.length > maxDigits) continue;

      const got = bestValue(scores, opts);
      if (!got) continue;

      const ranked = {
        ...got,
        bright,
        threshold,
        boxes: boxes.length,
        segs: seg.lineCount,
      };

      // ★ 자릿수를 더 많이 찾은 쪽이 이긴다.
      //
      // 점수(마진)만 보고 고르면, 글자와 배경이 뒤집힌 쪽에서 "60"이 한 덩어리로
      // 잡혀 7 하나로 읽히고, 자릿수가 하나뿐이라 경쟁자가 없어 마진이 커서
      // **그 엉터리 결과가 이겼다.** 두 자리를 찾아낸 쪽이 거의 항상 옳다.
      //
      // 세는 것은 **슬래시로 자르기 전**의 글자 수(segs)다. 자른 뒤 개수로 비교하면
      // "0/70"에서 옳은 쪽이 한 자리(0)로 줄어드는 바람에, 뒤집힌 쪽에서 잡힌
      // **글자 구멍 두 개**한테 진다 — 실제로 "0/70"이 "33"으로 읽혔다.
      // 이 규칙이 재려는 건 "어느 명암이 글자를 더 잘 갈랐나"이지 결과의 자릿수가 아니다.
      const better =
        !best ||
        ranked.segs > best.segs ||
        (ranked.segs === best.segs && ranked.boxes > best.boxes) ||
        (ranked.segs === best.segs &&
          ranked.boxes === best.boxes &&
          (ranked.margin > best.margin + 0.02 ||
            (Math.abs(ranked.margin - best.margin) <= 0.02 &&
              ranked.confidence > best.confidence)));
      if (better) best = ranked;
    }
  }
  // 글자를 더 잘 가른 쪽이 "못 읽겠다"였다면, 덜 가른 쪽의 답도 믿지 않는다.
  // 그쪽 답은 대개 뒤집힌 명암에서 잡힌 글자 구멍이라 자신 있게 틀린다.
  if (best && best.segs < vetoSegs) return null;
  return best;
}

module.exports = {
  CROP_TARGET_HEIGHT,
  SLASH,
  looksLikeSlash,
  diagOf,
  GRID_W,
  GRID_H,
  GRID_N,
  MATCH,
  THRESHOLD_OFFSETS,
  toGray,
  otsuThreshold,
  binarize,
  components,
  looksLikeDigit,
  sliceBox,
  splitComponent,
  textLines,
  pickLine,
  digitBoxes,
  cropBitmap,
  normalize,
  dilate,
  popcount,
  makeShape,
  similarity,
  similarityOf,
  holeInfo,
  holeCount,
  loadTemplates,
  gridToRows,
  scoreShape,
  scoreGrid,
  expandBox,
  bestValue,
  readTurn,
};
