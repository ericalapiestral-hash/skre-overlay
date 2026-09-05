// 도감(builds.json) 찾기 · 읽기 · 감시.
//
// 도감은 **파일 한 장**이다. 그 파일이 어디서 왔는지는 여기서 안 따진다:
//  · 길드봇이 노션에서 읽어 만들어 둔 것이거나,
//  · 앱이 [노션에서 받기]로 직접 긁어 userData에 캐시해 둔 것이거나
//    (main/notion.js → shared/notionDoc.js 가 **같은 모양**으로 만들어 준다),
//  · 사람이 손으로 고른 것이거나.
// 어느 쪽이든 이 아래는 똑같이 흐른다 — 그래서 도감을 가져오는 길을 늘려도
// 여기부터 화면까지 손댈 것이 없다.
//
// 옛 오버레이는 스킬 순서가 안 잡힌 빌드를 목록에서 **아예 빼 버렸다.** 도감에는
// 분명히 있는데 오버레이에는 없으니, 쓰는 사람 입장에선 "빌드가 안 보인다"가 된다.
// 여기서는 전부 싣고, 순서가 안 잡힌 빌드는 표시만 다르게 해서 본문을 보여준다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseBuild } = require('../shared/steps');

/**
 * 도감 파일을 찾아볼 자리들 (앞에 있는 것이 우선).
 *
 * 길드봇을 바탕화면에 두고 쓰는 게 기본이라 그 경로를 먼저 본다.
 * 포장하면 __dirname이 app.asar 안이 되어 소스 때 쓰던 상대경로가 통하지 않는다 —
 * 그래서 exe가 놓인 자리를 따로 잡는다. **상대경로로 되돌리지 말 것.**
 *
 * @param {{isPackaged: boolean, appDir: string, exeDir?: string,
 *          portableDir?: string, home?: string}} env
 */
function candidatePaths(env) {
  const list = [];
  const push = (...parts) => {
    const p = path.join(...parts);
    if (!list.includes(p)) list.push(p);
  };

  if (env.portableDir) {
    push(env.portableDir, 'data', 'builds.json');
    push(env.portableDir, 'builds.json');
  }
  if (env.exeDir && env.isPackaged) {
    push(env.exeDir, 'data', 'builds.json');
    push(env.exeDir, 'builds.json');
  }
  if (!env.isPackaged) {
    // 개발 중: 저장소 옆에 길드봇을 나란히 두고 쓰는 경우
    push(env.appDir, 'data', 'builds.json');
    push(env.appDir, '..', 'guild-bot', 'data', 'builds.json');
    push(env.appDir, '..', '길드봇', 'data', 'builds.json');
  }
  if (env.home) {
    // 바탕화면의 길드봇 폴더 — 실제로 쓰는 자리
    for (const desktop of ['Desktop', '바탕 화면', 'OneDrive/Desktop', 'OneDrive/바탕 화면']) {
      for (const folder of ['길드봇', 'guild-bot']) {
        push(env.home, ...desktop.split('/'), folder, 'data', 'builds.json');
      }
    }
  }
  return list;
}

/**
 * 실제로 읽을 도감 경로를 정한다.
 * @returns {{file: string, found: boolean, tried: string[]}}
 */
function resolvePath(configured, env) {
  if (configured) {
    return { file: configured, found: fs.existsSync(configured), tried: [configured] };
  }
  const tried = candidatePaths(env);
  const hit = tried.find((p) => fs.existsSync(p));
  return { file: hit || tried[0] || '', found: Boolean(hit), tried };
}

/** category가 비어 있는 묶음(구사황·기타)도 탭 하나로 보여준다 */
function categoryOf(build) {
  if (build.category) return build.category;
  const group = String(build.group || '');
  if (group.includes('구사황')) return '구사황';
  return '기타';
}

/**
 * @typedef {{total: number, withSteps: number, noSteps: string[]}} CatalogStats
 * @typedef {{ok: boolean, file: string, error: string, syncedAt: string|null,
 *            builds: any[], stats: CatalogStats}} Catalog
 */

/** 실패했을 때의 빈 도감 — 호출부가 매번 undefined를 따지지 않게 모양을 맞춰 둔다 */
function emptyCatalog(file, error) {
  return {
    ok: false,
    file,
    error,
    syncedAt: null,
    builds: [],
    stats: { total: 0, withSteps: 0, noSteps: [] },
  };
}

/** 알 수 없는 예외에서 쓸 만한 것만 꺼낸다 */
function errorOf(e) {
  const err = /** @type {{code?: string, message?: string}} */ (e || {});
  return { code: err.code || '', message: err.message || String(e) };
}

/**
 * builds.json → 오버레이가 쓸 형태.
 * @returns {Catalog}
 */
function loadCatalog(file) {
  if (!file) return emptyCatalog('', '도감 파일 경로가 없어요.');

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const { code, message } = errorOf(e);
    return emptyCatalog(
      file,
      code === 'ENOENT'
        ? '도감 파일이 그 자리에 없어요. 설정(⚙)에서 [노션에서 받기]를 누르거나, builds.json 파일을 직접 골라주세요.'
        : `도감 파일을 읽지 못했어요: ${message}`,
    );
  }
  if (!raw || !Array.isArray(raw.builds)) {
    return emptyCatalog(file, '도감 파일 형식이 예상과 달라요 (builds 배열이 없어요).');
  }

  const noSteps = [];
  const builds = raw.builds
    .filter((b) => b && typeof b.name === 'string')
    .map((b, i) => {
      const body = typeof b.body === 'string' ? b.body : '';
      const parsed = parseBuild(body);
      if (parsed.stepCount === 0) noSteps.push(b.name);
      return {
        id: b.id || `#${i}`,
        name: b.name,
        label: b.label || b.name,
        category: categoryOf(b),
        group: b.group || '',
        weekdays: Array.isArray(b.weekdays) ? b.weekdays : [],
        url: b.url || null,
        body,
        groups: parsed.groups,
        stepCount: parsed.stepCount,
        strategy: parsed.strategy,
        notes: parsed.notes,
      };
    });

  return {
    ok: true,
    file,
    error: '',
    syncedAt: raw.syncedAt || null,
    builds,
    stats: {
      total: builds.length,
      withSteps: builds.filter((b) => b.stepCount > 0).length,
      noSteps,
    },
  };
}

/**
 * 도감 파일이 바뀌면 알려준다.
 * 봇은 tmp에 쓰고 rename으로 갈아끼우므로 이벤트가 두 번 온다 — 한 번으로 모은다.
 *
 * @returns {{close: () => void}}
 */
function watchCatalog(file, onChange, { delay = 300 } = {}) {
  let watcher = null;
  let timer = null;

  const close = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* 이미 닫혔으면 무시 */
      }
      watcher = null;
    }
  };

  try {
    watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name && name !== path.basename(file)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, delay);
    });
    // 감시 중인 폴더가 지워지면 비동기 error가 나는데, 핸들러가 없으면 프로세스가 통째로 죽는다
    watcher.on('error', close);
  } catch {
    /* 폴더가 없으면 감시 생략 — 파일을 고르면 다시 건다 */
  }

  return { close };
}

module.exports = { candidatePaths, resolvePath, categoryOf, loadCatalog, watchCatalog };
