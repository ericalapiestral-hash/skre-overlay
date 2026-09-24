// exe 에 무엇이 들어가나 — 도감이 새지 않게 막는 **유일한** 장치를 지킨다.
//
// 시험판 exe 는 공개 릴리스로 나간다. 도감(builds.json)은 길드 내부 자료라 exe 에 들어가면
// 안 되는데, electron-builder 는 **.gitignore 를 보지 않는다.** 막는 건 package.json 의
// build.files 한 줄뿐이다. 누가 그걸 '**/*' 로 넓히면 작업 폴더의 builds.json·data/·
// 노션 캐시·전투 기록이 그대로 exe 에 실린다. CI 체크아웃에는 도감이 없어서 공개 릴리스는
// 당장 안전하지만, 로컬 `npm run dist`(테스트-안내 "직접 짓기")에서 샌다.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('exe 에는 src 와 package.json 만 들어간다', () => {
  const include = pkg.build.files.filter((p) => !p.startsWith('!'));
  assert.deepStrictEqual(include.sort(), ['package.json', 'src/**/*'], '넣는 규칙이 넓어졌다 — 도감이 샐 수 있다');
  // 다른 길로 파일을 싣는 설정도 없어야 한다
  for (const key of ['extraResources', 'extraFiles']) {
    assert.strictEqual(pkg.build[key], undefined, `build.${key} 로 파일을 따로 싣는다`);
    assert.strictEqual((pkg.build.win || {})[key], undefined, `build.win.${key} 로 파일을 따로 싣는다`);
  }
});

test('src 안에 도감·기록 같은 파일이 없다', () => {
  // src 는 통째로 실리므로, 누가 거기에 도감을 두면 그대로 나간다
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^builds.*\.json$|^skre-(기록|노션)|^config\.json/.test(e.name)) found.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepStrictEqual(found, []);
});
