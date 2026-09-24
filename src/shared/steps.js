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

/**
 * 스킬 순서 섹션으로 볼 제목.
 * "스킬 사용 순서"를 맨 앞에 둔다 — 뒤에 두면 "스킬 사용"이 먼저 걸려 꼬리 "순서"가
 * 구분자로 남아 라벨이 "1라운드 — 순서"가 됐다.
 */
const ORDER_TITLE = /(스킬\s*사용\s*순서|스킬\s*순서|스킬순서|사용\s*순서|진행\s*순서|공략\s*순서|스킬\s*사용)/;
/**
 * "순서"라는 말이 들어간 제목 — 이걸 먼저 찾는다. "스킬 사용"만 있는 제목("## 스킬 사용 팁")을
 * 먼저 잡으면 그 섹션이 끝나는 곳에서 멈춰 아래의 진짜 "## 스킬 순서"를 못 봤다.
 */
const STRICT_ORDER = /(스킬\s*사용\s*순서|스킬\s*순서|스킬순서|사용\s*순서|진행\s*순서|공략\s*순서)/;

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
 * `0턴` / **0턴** / 0턴 / 0 턴 / 0턴: / 0~4턴·0-4턴(앞 숫자를 쓴다) / 4턴째·4턴차 를 모두 잡는다.
 * 백틱·별표는 마크다운 장식일 뿐이라 있어도 없어도 같은 뜻이다.
 * (예전엔 "0-4턴"을 **4턴**으로 읽고 "4턴째"의 "째"를 행동 앞에 남겼다 — 조용히 틀린다.)
 */
const TURN_MARKER = /[`*_]*\s*(\d{1,3})\s*(?:[~\-–]\s*\d{1,3}\s*)?턴(?:째|차)?\s*[`*_]*/g;

/** 액션 텍스트 앞뒤에 남는 마크다운·구분 기호 (괄호는 아래에서 짝을 보고 뗀다) */
const EDGE_JUNK = /^[\s:：\-–—>·•/|,→⇒➜]+|[\s:：\-–—>·•/|,→⇒➜(\[{*`_]+$/g;

/** 전각 숫자(０~９)를 보통 숫자로 — 같은 숫자다 */
const toHalfWidth = (line) => line.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

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
  // 들여쓴 제목도 제목이다 — 노션에서 토글 두 겹 안의 "### 2라운드"는 네 칸 넘게 들여써진다.
  // 예전엔 세 칸까지만 봐서 그 라운드가 앞 라운드에 조용히 합쳐졌다.
  const md = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
  if (md) return { level: md[1].length, title: md[2].trim() };

  // 줄 전체가 굵은 글씨 하나뿐 — 헤딩 대용으로 자주 쓰인다
  const bold = line.match(/^\s*(?:[-*+]\s*)?\*\*(.+?)\*\*\s*[:：]?\s*$/);
  if (bold) return { level: 7, title: bold[1].trim() };

  // 한 줄이 통째로 **라운드 이름**인 경우 — "- 2라운드", "> 2라운드", "1. 1라운드", "2라운드:",
  // 그냥 "1라운드". 노션에서 긁으면 굵은 글씨 기호가 사라져(글자만 긁는다) 굵은 문단
  // "1라운드"가 맨 글줄이 된다. 예전엔 목록 줄만 봐서 나머지는 라운드가 하나로 뭉쳤고,
  // 리셋 빌드는 1라운드 뒤를 통째로 "각주"로 버렸다.
  const title = plainRoundTitle(line);
  if (title) return { level: 8, title };
  return null;
}

/**
 * 줄이 통째로 라운드 이름이면 그 이름 (아니면 null).
 * 라운드 이름 말고 붙은 말이 짧아야 한다 — "2라운드 넘어가기 전에 체력 확인" 같은 문장까지
 * 제목으로 보면 라운드 한가운데가 갈라진다. 끝의 괄호("2라운드 (4턴)")는 분기 이름이라 턴
 * 표시가 있어도 제목이다.
 */
function plainRoundTitle(line) {
  const text = String(line)
    .replace(/^\s*(?:[-*+>]\s*|\d+[.)]\s+)*/, '')
    .replace(/[*`_]/g, '')
    .replace(/\s*[:：]\s*$/, '')
    .trim();
  if (!text || roundOf(text) === null) return null;
  const paren = text.match(/^(.*?)\s*\(([^()]*)\)$/);
  const core = paren ? paren[1] : text;
  TURN_MARKER.lastIndex = 0;
  const hasTurn = TURN_MARKER.test(core);
  TURN_MARKER.lastIndex = 0;
  if (hasTurn) return null;
  let rest = core;
  for (const re of ROUND_PATTERNS) rest = rest.replace(re, '');
  if (rest.replace(/[\s\-–—·:：]/g, '').length > 8) return null;
  return text;
}

/**
 * "1라운드: 0턴 A / 4턴 B" 처럼 라운드 이름 **뒤에 바로 순서가 오는** 줄 (표의 "1라운드 | 0턴 | A" 도).
 * @returns {{title: string, round: number, rest: string}|null}
 */
function roundLine(line) {
  const text = String(line)
    .replace(/^\s*(?:[-*+>]\s*|\d+[.)]\s+)*/, '')
    .replace(/^\|\s*/, '');
  const m = text.match(/^\**\s*(\d+\s*라운드|라운드\s*\d+|\d+\s*페이즈|페이즈\s*\d+|\d+\s*R|R\s*\d+)\s*\**\s*[:：|)\-–—]\s*(.+)$/i);
  if (!m) return null;
  TURN_MARKER.lastIndex = 0;
  const has = TURN_MARKER.test(m[2]);
  TURN_MARKER.lastIndex = 0;
  if (!has) return null;
  return { title: m[1].replace(/\s+/g, ' ').trim(), round: /** @type {number} */ (roundOf(m[1])), rest: m[2] };
}

/**
 * 줄이 **턴 표시 하나뿐**이면 그 턴 ("- 8턴", "### 0턴", "**4턴**"). 행동은 다음 줄에 있다 —
 * 노션 목록에서 턴 아래 하위 목록으로 행동을 적거나, 턴을 제목으로 쓰는 경우다.
 */
function turnOnly(line) {
  const text = String(line)
    .replace(/^\s*(?:#{1,6}\s+|[-*+>]\s*|\d+[.)]\s+)*/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
  const m = text.match(/^[`*_]*\s*(\d{1,3})\s*(?:[~\-–]\s*\d{1,3}\s*)?턴(?:째|차)?\s*[`*_]*$/);
  return m ? Number(m[1]) : null;
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

/** 스킬 순서 섹션 제목 찾기 — "순서"가 들어간 제목을 먼저, 없으면 "스킬 사용"까지 */
function findOrder(lines) {
  for (const re of [STRICT_ORDER, ORDER_TITLE]) {
    for (let i = 0; i < lines.length; i += 1) {
      const h = headingOf(lines[i]);
      if (h && re.test(h.title)) return { at: i, level: h.level };
    }
  }
  return { at: -1, level: 0 };
}

/**
 * 본문 → 세그먼트(라운드) 목록.
 *
 * @param {string} body
 * @returns {{segments: Array<{label: string, round: number|null, steps: Array<{turn:number,text:string}>}>,
 *            strategy: 'section'|'whole', notes: string[]}}
 */
function parseSegments(body) {
  const lines = String(body ?? '').split('\n').map(toHalfWidth);

  // ① 스킬 순서 섹션을 찾는다. 없으면 문서 전체에서 턴 표시를 찾는다(예비 경로).
  const order = findOrder(lines);
  if (order.at >= 0) {
    const got = parseFrom(lines, order.at, order.level, 'section');
    if (got.segments.length > 0) return got;
    // ★ 섹션을 찾았는데 단계가 0개면 **본문 전체로 한 번 더** 본다. 예전엔 여기서 끝나서
    // "## 스킬 순서" 바로 밑에 "## 참고"가 오고 그 아래 라운드가 있는 빌드 같은 것이 미인식이 됐다.
    const whole = parseFrom(lines, -1, 0, 'whole');
    if (whole.segments.length > 0) {
      whole.notes.unshift('스킬 순서 제목 아래에서 순서를 못 찾아 본문 전체에서 찾았어요.');
      return whole;
    }
    return got;
  }
  const whole = parseFrom(lines, -1, 0, 'whole');
  whole.notes.unshift('스킬 순서 제목을 못 찾아 본문 전체에서 턴 표시를 찾았어요.');
  return whole;
}

/** 이 줄의 k번째 단계부터 뒤로, 턴이 줄지 않고 이어지는 단계가 몇 개인가 (제목에서 멈춘다) */
function ascendingAhead(lines, i, found, k) {
  let last = found[k].turn;
  let n = 0;
  for (let j = k; j < found.length; j += 1) {
    if (found[j].turn < last) return n;
    last = found[j].turn;
    n += 1;
  }
  for (let x = i + 1; x < lines.length; x += 1) {
    if (headingOf(lines[x])) return n;
    for (const st of stepsInLine(lines[x])) {
      if (st.turn < last) return n;
      last = st.turn;
      n += 1;
    }
  }
  return n;
}

function parseFrom(lines, orderAt, orderLevel0, strategy) {
  let orderLevel = orderLevel0;
  const notes = [];
  const segments = [];
  const state = {
    /** @type {null | {label: string, round: number|null, steps: Array<{turn:number,text:string}>, closed: boolean, auto?: boolean}} */
    current: null,
    /** 섹션 제목에 붙은 구분자 — "스킬 순서 (고점형)" 의 "고점형" */
    tag: '',
    /** 턴만 있고 행동이 다음 줄에 오는 경우 그 턴 */
    pendingTurn: /** @type {number|null} */ (null),
  };

  const open = (label, round, auto = false) => {
    /** @type {{label: string, round: number|null, steps: Array<{turn:number,text:string}>, closed: boolean, auto?: boolean}} */
    const seg = {
      label: state.tag ? `${label} — ${state.tag}` : label,
      round,
      steps: [],
      closed: false,
      auto,
    };
    state.current = seg;
    segments.push(seg);
    return seg;
  };
  const tagOf = (title) =>
    cleanTitle(title)
      .replace(ORDER_TITLE, '')
      .replace(/[()[\]]/g, ' ')
      .replace(/^[\s:：—–-]+|[\s:：—–-]+$/g, '')
      .trim();

  /** 단계 하나를 지금 세그먼트에 넣는다 — 되돌아가면 각주이거나 다음 라운드다 */
  const place = (step, i, found, k) => {
    let seg = state.current || open(state.tag || '스킬 순서', null, true);
    if (seg.closed) return;
    const prev = seg.steps[seg.steps.length - 1];
    if (prev && step.turn < prev.turn) {
      // ★ **처음(0·1턴)으로 돌아가서 한참 이어지면 다음 라운드다.** 라운드 이름이 제목으로
      // 안 잡힌 리셋 빌드(노션에서 굵은 글씨가 사라진 "1라운드" 문단 등)에서, 예전엔 이걸
      // 전부 각주로 보고 1라운드 뒤를 통째로 버렸다 — "인식됨"으로 세면서.
      if (step.turn <= 1 && ascendingAhead(lines, i, found, k) >= 2) {
        const base = seg.label.replace(/ \(\d+\)$/, '');
        const n = segments.filter((x) => x.label === base || x.label.startsWith(`${base} (`)).length + 1;
        // 순서 앞에 "12턴 클리어" 같은 한 줄이 먼저 잡혔던 것이면 그건 순서가 아니었다
        if (seg.auto && seg.steps.length === 1 && segments.length === 1) {
          notes.push(`"${seg.steps[0].turn}턴 ${seg.steps[0].text}"은 순서가 아닌 것으로 보고 뺐어요.`);
          seg.steps = [];
        } else {
          notes.push(`"${seg.label}" 뒤에서 턴이 ${step.turn}턴으로 다시 시작해서 다음 라운드로 봤어요.`);
          const label = `${base} (${n})`;
          seg = { label, round: null, steps: [], closed: false, auto: true };
          state.current = seg;
          segments.push(seg);
        }
      } else {
        // 한 라운드 안에서 턴은 되돌아가지 않는다. 되돌아가는 표시가 나오면
        // 그건 본문 아래의 각주·조건부 대안이다 ("*46턴에 안 썼으면 48턴에…").
        seg.closed = true;
        notes.push(`"${seg.label}"에서 ${step.turn}턴부터는 각주로 보고 건너뛰었어요.`);
        return;
      }
    }
    seg.steps.push(step);
  };

  const start = orderAt >= 0 ? orderAt + 1 : 0;
  if (orderAt >= 0) state.tag = tagOf(lines[orderAt]);

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    // 턴만 있는 줄 — 행동은 다음 줄이다 ("- 8턴" 아래 "  - 리나 아래", "### 0턴" 아래 문단)
    const only = turnOnly(line);
    if (only !== null) {
      state.pendingTurn = only;
      continue;
    }

    const rl = roundLine(line);
    const h = rl ? null : headingOf(line);

    if (h) {
      state.pendingTurn = null;
      // 스킬 순서 섹션이 여러 개인 빌드(안전형/고점형 등) — 뒤 섹션도 이어서 읽는다
      if (ORDER_TITLE.test(h.title)) {
        state.tag = tagOf(h.title);
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

    // "1라운드: 0턴 A / 4턴 B" — 라운드를 열고 같은 줄의 순서를 넣는다. 표의 줄마다 같은
    // 라운드가 되풀이되면("1라운드 | 0턴 | A", "1라운드 | 4턴 | B") 같은 라운드를 이어 간다.
    let text = line;
    if (rl) {
      state.pendingTurn = null;
      const label = state.tag ? `${rl.title} — ${state.tag}` : rl.title;
      if (!state.current || state.current.round !== rl.round || state.current.label !== label) open(rl.title, rl.round);
      text = rl.rest;
    }

    const found = stepsInLine(text);
    if (found.length === 0) {
      if (state.pendingTurn !== null && !rl) {
        const action = cleanText(text);
        if (action) place({ turn: state.pendingTurn, text: action }, i, [{ turn: state.pendingTurn, text: action }], 0);
      }
      state.pendingTurn = null;
      continue;
    }
    state.pendingTurn = null;
    found.forEach((step, k) => place(step, i, found, k));
  }

  for (const s of segments) {
    delete s.closed;
    delete s.auto;
  }
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
