# RisuBard 자동 업데이터

## 개요

2026-08-19부터 RisuBard 공개판의 자동 업데이터는 이전 공개판의 업데이트 워커가 아니라 `rpaddict/RisuBard`의 GitHub Releases를 직접 확인한다.

- 릴리즈 확인 API: `https://api.github.com/repos/rpaddict/RisuBard/releases/latest`
- 릴리즈 다운로드 저장소: `https://github.com/rpaddict/RisuBard`
- 적용 대상: `RisuBard-public`
- 비공개 소설가 모드 저장소인 `RisuBard-private`에는 이 작업을 적용하지 않았다.

## 변경 이유

기존 서버는 이전 업데이트 워커의 응답을 사용했고, 휴대용 업데이트 스크립트도 이전 저장소의 릴리즈를 조회했다. 이 상태에서는 RisuBard가 자체 릴리즈를 발행해도 사용자에게 업데이트가 표시되거나 자동 설치되지 않는다.

이번 변경으로 웹 UI의 업데이트 확인, 포터블 셀프 업데이트, 독립 실행형 업데이트 스크립트가 모두 `rpaddict/RisuBard`를 기준으로 동작한다.

## 동작 과정

1. 클라이언트가 서버의 `GET /api/update-check`를 호출한다.
2. 서버가 `rpaddict/RisuBard`의 최신 공개 릴리즈를 GitHub API로 조회한다.
3. 릴리즈 태그의 앞에 붙은 `v`를 제거하고 현재 `package.json` 버전과 비교한다.
4. 최신 릴리즈가 더 높은 버전이면 선택 업데이트로 응답한다.
5. 포터블 배포판은 플랫폼에 맞는 릴리즈 파일이 있으면 `POST /api/self-update`로 다운로드하고 교체한다.
6. 릴리즈 빌드가 생성하는 포터블 `update.bat`과 `update.sh`는 독립 업데이터를 실행해 같은 저장소의 최신 릴리즈 파일을 사용한다.
7. 저장소 루트의 소스 빌드용 `update.sh`도 같은 저장소의 최신 태그 소스를 받아 다시 빌드한다.

GitHub가 `404`를 반환하는 경우는 공개 릴리즈가 없는 상태로 간주한다. 이때 서버는 실패 팝업을 표시하지 않고 “업데이트 없음”으로 응답한다.

## 릴리즈 요구사항

자동 업데이트에 노출하려면 릴리즈가 다음 조건을 만족해야 한다.

- 태그는 `vX.Y.Z` 형식을 사용한다. 예: `v0.1.1`
- 릴리즈는 초안이 아닌 공개 발행 상태여야 한다.
- 사전 릴리즈가 아닌 일반 릴리즈여야 `releases/latest`에서 조회된다.
- `package.json`의 현재 버전보다 태그 버전이 높아야 한다.
- 포터블 자동 설치에는 실행 환경과 일치하는 릴리즈 파일이 필요하다.

현재 `.github/workflows/release.yml`은 릴리즈를 `draft: true`로 생성한다. 빌드가 끝난 뒤 GitHub에서 초안을 검토하고 **Publish release**를 눌러야 사용자 앱이 새 버전을 발견한다.

Docker도 GitHub Release의 공개 발행 뒤에 이미지를 게시한다. 태그를 푸시해 초안 포터블을 만드는 것만으로 컨테이너의 `latest`를 변경하지 않는다. Docker 워크플로의 수동 실행은 기본적으로 로컬 이미지 빌드와 두 아키텍처의 볼륨 이관·서버 데이터·컨테이너 간 잠금 검증만 수행하며, `publish`를 명시적으로 켠 경우에만 레지스트리에 게시한다.

태그를 만들기 전에는 다음 단일 명령으로 타입 검사, 클라이언트·서버 테스트, 호환성 테스트와 프로덕션 빌드를 순서대로 실행한다. 같은 명령을 태그 릴리즈 워크플로도 패키징 전에 실행하므로 검증 실패가 있는 커밋은 릴리즈 아티팩트를 만들지 않는다.

```powershell
npm run verify:release
```

## 포터블 파일명 규칙

포터블 파일명은 `RisuBard` 접두사를 사용한다.

| 실행 환경 | 예상 파일명 |
| --- | --- |
| Windows x64 | `RisuBard-vX.Y.Z-win-x64.zip` |
| Linux x64 | `RisuBard-vX.Y.Z-linux-x64.tar.gz` |
| Linux ARM64 | `RisuBard-vX.Y.Z-linux-arm64.tar.gz` |
| macOS ARM64 | `RisuBard-vX.Y.Z-macos-arm64.tar.gz` |

릴리즈 워크플로와 `getSelfUpdateAssetInfo()`도 같은 파일명 규칙을 사용한다.

## 배포 형태별 차이

| 배포 형태 | 업데이트 알림 | 웹 셀프 업데이트 |
| --- | --- | --- |
| 포터블 (`.portable` 존재) | 지원 | 지원 |
| Git 체크아웃 | 지원 | 지원하지 않음 |
| Docker | 지원 | 지원하지 않음 |
| Termux 및 기타 환경 | 지원 | 지원하지 않음 |

포터블 이외의 환경은 새 버전을 안내할 수 있지만 설치 방법이 서로 다르므로 서버가 파일을 직접 교체하지 않는다.

## 저장소 이관이 필요한 업데이트

구버전의 업데이트 화면은 파일 교체 뒤 `/api/update-check`의 `currentVersion`을 확인한다. V2 이관 게이트도 이 읽기 전용 응답을 제공하며 `migrationRequired: true`, `hasUpdate: false`, `canSelfUpdate: false`를 함께 반환한다. 설치된 코드 버전의 확인이며, 저장소 이관이나 앱 준비 완료를 뜻하지 않는다. 구버전 화면에서 완료 후 새로고침하면 이관 동의 화면으로 진입한다. 이관 동의와 저장소 API 접근 권한은 별도로 유지한다.

이관 사전 검사는 안내 서버를 먼저 연 뒤 수행한다. 검사 실패는 안내 화면에 남고 백업·종료를 선택할 수 있으며, 기존 HTTPS 인증서가 있으면 안내 서버도 HTTPS를 사용한다. Docker의 접근 키와 볼륨 내부 이관은 [파일 정본 사용자 데이터](../ko/file-native-storage.md#docker의-기존-세이브-이관)를 따른다.

## 환경 변수

| 환경 변수 | 용도 |
| --- | --- |
| `RISU_UPDATE_CHECK=false` | 릴리즈 확인 기능을 비활성화한다. |
| `RISU_UPDATE_URL` | 기본 GitHub 최신 릴리즈 API 대신 사용할 주소를 지정한다. 응답은 GitHub Release JSON 형식이어야 한다. |

## 변경 파일

- `server/node/server.cjs`: GitHub 최신 릴리즈 직접 조회, 대상 저장소 변경
- `server/node/release-update.cjs`: 릴리즈 태그 정규화와 버전 비교
- `scripts/updater.cjs`: 독립 업데이터 대상 저장소 변경
- `update.sh`: 소스 빌드용 업데이터의 대상 저장소와 압축 해제 디렉터리 규칙 변경
- `server/node/release-update.test.ts`: 버전 비교와 업데이트 판정 테스트
- `server/node/risubard-update-release.test.ts`: 서버와 스크립트의 저장소 대상 회귀 테스트

## 검증

다음 명령으로 변경을 검증했다.

```powershell
& '.\node_modules\.bin\vitest.cmd' run --config vitest.config.server.ts `
  server/node/release-update.test.ts `
  server/node/risubard-update-release.test.ts

node --check server/node/server.cjs
node --check server/node/release-update.cjs
node --check scripts/updater.cjs
& 'C:\Program Files\Git\bin\bash.exe' -n update.sh
```

결과는 테스트 파일 2개, 테스트 3개가 모두 통과했으며 세 CommonJS 파일과 `update.sh`의 구문 검사도 통과했다.

## 관련 코드

- 업데이트 확인과 셀프 업데이트: `server/node/server.cjs`
- GitHub 릴리즈 변환과 버전 비교: `server/node/release-update.cjs`
- 독립 포터블 업데이터: `scripts/updater.cjs`
- 소스 빌드용 업데이터: `update.sh`
- 릴리즈 빌드 및 초안 생성: `.github/workflows/release.yml`
