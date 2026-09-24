// 몇 번째 판인지 — 전투 기록·노션 덤프·설정 화면에 같이 찍는다.
//
// 개발은 "쓰는 사람이 보낸 기록을 되돌려 본다"에 기댄다. 그런데 시험판은 package.json 의
// version 이 늘 0.9.0 이고 판 구분은 릴리스 파일 이름에만 있어서, **기록이 어느 판의
// 추적기·인식기에서 나왔는지 파일만으로는 알 수 없었다.** 다른 판의 코드로 되돌려 보면
// "(그때는 N)" 차이가 버그처럼 보인다.
//
// 그래서 CI 가 exe 를 지을 때 태그와 커밋을 package.json 에 심는다
// (`-c.extraMetadata.skreBuild=v0.9.0-test.7+abc1234`, .github/workflows/build.yml).
// 손으로 띄운 앱에는 그 값이 없으므로 `0.9.0-dev` 로 찍힌다 — 시험판이 아니라는 뜻이다.
'use strict';

/**
 * @param {{version?: string, skreBuild?: string}} pkg
 * @returns {string}
 */
function buildStamp(pkg) {
  if (pkg && typeof pkg.skreBuild === 'string' && pkg.skreBuild.trim()) return pkg.skreBuild.trim();
  return `${(pkg && pkg.version) || '0.0.0'}-dev`;
}

const BUILD = buildStamp(require('../../package.json'));

module.exports = { BUILD, buildStamp };
