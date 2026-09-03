// 빌드 본문(마크다운) → 스킬 순서 단계 목록.
//
// 옛 오버레이는 도감 표기가 딱 한 가지일 때만 읽었다:
//   "## 스킬 순서" 헤딩 아래 "### N라운드" 헤딩, 단계는 백틱으로 감싼 `N턴`.
// 셋 중 하나만 어긋나도 단계가 0개가 되고, 목록에서 그 빌드가 통째로 사라졌다.
// 그래서 여기서는 **읽는 방법을 여러 겹으로 두고, 실패해도 빌드를 숨기지 않는다.**
//
//  1) 스킬 순서 섹션을 찾는다. 못 찾으면 문서 전체를 본다.
//  2) 라운드 구분을 찾는다. 헤딩이든 굵은 글씨든 목록이든 본다. 없으면 한 덩어리로 둔다.
//  3) 턴 표시를 찾는다. 백틱·굵은 글씨·맨글씨·표 칸 모두 인정한다.
//  4) 그래도 단계가 없으면 strategy 'none'으로 알린다 — 화면은 본문을 그대로 보여준다.
'use strict';

/** 스킬 순서 섹션으로 볼 제목 */
const ORDER_TITLE = /(스킬\s*순서|스킬순서|사용\s*순서|진행\s*순서|공략\s*순서|스킬\s*사용)/;

/**
 * 라운드 구분으로 볼 제목.
 * "2라운드" · "라운드 2" · "2R" · "R2" · "2페이즈" · "2번째" 를 모두 같은 것으로 본다.
 * 도감을 쓰는 사람마다 표기가 달라서, 하나만 인정하면 그 사람 빌드가 통째로 안 나온다.
 */
const ROUND_PATTERNS = [
  /(\d+)\s*라운드/,
  /라운드\s*(\d+)/,
  /(\d+)\s*페이즈/,
  /페이즈\s*(\d+)/,
  /(\d+)\s*번째/,
  /\b(\d+)\s*R\b/i,
  /\bR\s*(\d+)\b/i,
];

/**
 * 턴 표시.
 * `0턴` / **0턴** / 0턴 / 0 턴 / 0턴: / 0~4턴(앞 숫자를 쓴다) 을 모두 잡는다.
 * 백틱·별표는 마크다운 장식일 뿐이라 있어도 없어도 같은 뜻이다.
 */
const TURN_MARKER = /[`*_]*\s*(\d{1,3})\s*(?:~\s*\d{1,3}\s*)?턴\s*[`*_]*/g;

/** 액션 텍스트 앞뒤에 남는 마크다운·구분 기호 (괄호는 아래에서 짝을 보고 뗀다) */
const EDGE_JUNK = /^[\s:：\-–—>·•/|,]+|[\s:：\-–—>·•/|,(\[{*`_]+$/g;

const COUNT = (text, ch) => text.split(ch).length - 1;

/**
 * 액션 한 줄을 다듬는다.
 *
 * 괄호는 **짝이 안 맞을 때만** 뗀다. "(`9턴`미호 평타로 클리어)" 처럼 마커를 감싼
 * 괄호는 액션에 반쪽만 남으니 떼야 하지만, "미호(각성)"의 괄호는 뜻이 있어서
 * 무턱대고 떼면 안 된다.
 */
function cleanText(text) {
  let t = String(text).replace(/[`*_]/g, '').replace(EDGE_JUNK, '').trim();
  while (t.endsWith(')') && COUNT(t, ')') > COUNT(t, '(')) {
    t = t.slice(0, -1).replace(EDGE_JUNK, '').trim();
  }
  while (t.startsWith('(') && COUNT(t, '(') > COUNT(t, ')')) {
    t = t.slice(1).replace(EDGE_JUNK, '').trim();
  }
  return t;
}

/** 제목에서 라운드 번호를 뽑는다. 못 찾으면 null */
function roundOf(title) {
  const t = String(title);
  for (const re of ROUND_PATTERNS) {
    const m = t.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 마크다운 장식만 벗긴 표시용 제목 */
function cleanTitle(title) {
  return String(title)
    .replace(/[*`_]/g, '')
    .replace(/^[#\s>|-]+|[\s|]+$/g, '')
    .trim();
}

/**
 * 한 줄이 "제목처럼 쓰인 줄"인지 본다.
 * 노션에서 옮겨 오면 라운드 구분이 헤딩이 아니라 굵은 글씨 한 줄이거나
 * "- 2라운드" 같은 목록 한 줄인 경우가 흔하다. 그것도 제목으로 인정한다.
 *
 * @returns {{level: number, title: string}|null}
 */
function headingOf(line) {
  const md = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
  if (md) return { level: md[1].length, title: md[2].trim() };

  // 줄 전체가 굵은 글씨 하나뿐 — 헤딩 대용으로 자주 쓰인다
  const bold = line.match(/^\s*(?:[-*+]\s*)?\*\*(.+?)\*\*\s*[:：]?\s*$/);
  if (bold) return { level: 7, title: bold[1].trim() };

  // "- 2라운드" 처럼 목록 한 줄이 통째로 라운드 이름인 경우
  const item = line.match(/^\s*[-*+]\s+(.+?)\s*[:：]?\s*$/);
  if (item && roundOf(item[1]) !== null && !TURN_MARKER.test(item[1])) {
    TURN_MARKER.lastIndex = 0;
    return { level: 8, title: item[1].trim() };
  }
  TURN_MARKER.lastIndex = 0;
  return null;
}

/**
 * 한 줄에서 `N턴 액션` 들을 뽑는다.
 *
 * 옛 파서는 액션을 `[^/\`\n]*` 로 잘랐다 — 슬래시에서 멈추게 해 둔 것이라
 * "미호/나타 위" 같은 액션이 "미호"로 잘렸다. 여기서는 **다음 턴 표시까지**를
 * 액션으로 보고, 끝에 남은 구분 기호만 걷어낸다.
 *
 * @returns {Array<{turn: number, text: string}>}
 */
function stepsInLine(line) {
  const marks = [];
  TURN_MARKER.lastIndex = 0;
  for (let m = TURN_MARKER.exec(line); m; m = TURN_MARKER.exec(line)) {
    marks.push({ turn: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  if (marks.length === 0) return [];

  const out = [];
  marks.forEach((mark, i) => {
    const stop = i + 1 < marks.length ? marks[i + 1].start : line.length;
    const text = cleanText(line.slice(mark.end, stop));
    if (text) out.push({ turn: mark.turn, text });
  });
  return out;
}

/**
 * 본문 → 세그먼트(라운드) 목록.
 *
 * @param {string} body
 * @returns {{segments: Array<{label: string, round: number|null, steps: Array<{turn:number,text:string}>}>,
 *            strategy: 'section'|'whole', notes: string[]}}
 */
function parseSegments(body) {
  const lines = String(body ?? '').split('\n');

  // ① 스킬 순서 섹션을 찾는다. 없으면 문서 전체에서 턴 표시를 찾는다(예비 경로).
  let orderAt = -1;
  let orderLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const h = headingOf(lines[i]);
    if (h && ORDER_TITLE.test(h.title)) {
      orderAt = i;
      orderLevel = h.level;
      break;
    }
  }
  const strategy = orderAt >= 0 ? 'section' : 'whole';
  const notes = [];
  if (strategy === 'whole') notes.push('스킬 순서 제목을 못 찾아 본문 전체에서 턴 표시를 찾았어요.');

  const segments = [];
  const state = {
    /** @type {null | {label: string, round: number|null, steps: Array<{turn:number,text:string}>, closed: boolean}} */
    current: null,
    /** 섹션 제목에 붙은 구분자 — "스킬 순서 (고점형)" 의 "고점형" */
    tag: '',
  };

  const open = (label, round) => {
    /** @type {{label: string, round: number|null, steps: Array<{turn:number,text:string}>, closed: boolean}} */
    const seg = {
      label: state.tag ? `${label} — ${state.tag}` : label,
      round,
      steps: [],
      closed: false,
    };
    state.current = seg;
    segments.push(seg);
    return seg;
  };

  const start = orderAt >= 0 ? orderAt + 1 : 0;
  if (orderAt >= 0) {
    state.tag = cleanTitle(lines[orderAt])
      .replace(ORDER_TITLE, '')
      .replace(/[()[\]]/g, ' ')
      .replace(/^[\s:：—–-]+|[\s:：—–-]+$/g, '')
      .trim();
  }

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    const h = headingOf(line);

    if (h) {
      // 스킬 순서 섹션이 여러 개인 빌드(안전형/고점형 등) — 뒤 섹션도 이어서 읽는다
      if (ORDER_TITLE.test(h.title)) {
        state.tag = cleanTitle(h.title)
          .replace(ORDER_TITLE, '')
          .replace(/[()[\]]/g, ' ')
          .replace(/^[\s:：—–-]+|[\s:：—–-]+$/g, '')
          .trim();
        state.current = null;
        if (h.level <= 6) orderLevel = h.level;
        continue;
      }

      const round = roundOf(h.title);
      if (round !== null) {
        open(cleanTitle(h.title), round);
        continue;
      }
      // 섹션과 같거나 더 큰 제목이 나오면 스킬 순서가 끝난 것 (예비 경로에서는 계속 본다)
      if (strategy === 'section' && h.level <= orderLevel) break;
      state.current = null;
      continue;
    }

    const found = stepsInLine(line);
    if (found.length === 0) continue;
    const seg = state.current || open(state.tag || '스킬 순서', null);
    if (seg.closed) continue;

    for (const step of found) {
      // 한 라운드 안에서 턴은 되돌아가지 않는다. 되돌아가는 표시가 나오면
      // 그건 본문 아래의 각주·조건부 대안이다 ("*46턴에 안 썼으면 48턴에…").
      const prev = seg.steps[seg.steps.length - 1];
      if (prev && step.turn < prev.turn) {
        seg.closed = true;
        notes.push(`"${seg.label}"에서 ${step.turn}턴부터는 각주로 보고 건너뛰었어요.`);
        break;
      }
      seg.steps.push(step);
    }
  }

  for (const s of segments) delete s.closed;
  return { segments: segments.filter((s) => s.steps.length > 0), strategy, notes };
}

/**
 * 세그먼트를 변형 그룹으로 묶는다.
 * 같은 라운드 번호가 두 번 나오면(예: "2라운드 (4턴)" / "2라운드 (8턴)") 둘 중 하나만 진행한다.
 *
 * @returns {Array<{round: number|null, variants: Array<{label: string, steps: Array<{turn:number,text:string}>}>}>}
 */
function groupVariants(segments) {
  const groups = [];
  const byRound = new Map();
  segments.forEach((seg, i) => {
    const variant = { label: seg.label, steps: seg.steps };
    const key = seg.round === null ? `_${i}` : `r${seg.round}`;
    const existing = seg.round === null ? null : byRound.get(key);
    if (existing) {
      existing.variants.push(variant);
      return;
    }
    const group = { round: seg.round, variants: [variant] };
    groups.push(group);
    if (seg.round !== null) byRound.set(key, group);
  });
  return groups;
}

/**
 * 변형 선택(그룹 번호 → 변형 번호)에 따라 한 줄로 펼친다.
 * @returns {Array<{turn: number, text: string, label: string}>}
 */
function flatten(groups, picks = {}) {
  const out = [];
  groups.forEach((group, gi) => {
    const pick = Math.min(Math.max(0, picks[gi] ?? 0), group.variants.length - 1);
    for (const step of group.variants[pick].steps) {
      out.push({ turn: step.turn, text: step.text, label: group.variants[pick].label });
    }
  });
  return out;
}

/**
 * 빌드 본문 하나를 오버레이가 쓸 형태로 만든다.
 *
 * @param {string|null|undefined} body 도감 본문(마크다운)
 * @returns {{groups: ReturnType<typeof groupVariants>, stepCount: number,
 *            strategy: 'section'|'whole'|'none', notes: string[]}}
 */
function parseBuild(body) {
  const { segments, strategy, notes } = parseSegments(body ?? '');
  const groups = groupVariants(segments);
  const stepCount = groups.reduce((n, g) => n + g.variants[0].steps.length, 0);
  return {
    groups,
    stepCount,
    strategy: stepCount > 0 ? strategy : 'none',
    notes,
  };
}

module.exports = {
  ORDER_TITLE,
  cleanText,
  roundOf,
  headingOf,
  stepsInLine,
  parseSegments,
  groupVariants,
  flatten,
  parseBuild,
};
