# V2 세이브를 V1 구조로 변환하기

RisuBard 0.9.28은 0.9.25의 V1 저장 구조를 사용합니다. 0.9.26~0.9.27에서 V2로 이관한 세이브는 별도 변환기로 새 V1 폴더를 만든 뒤 사용할 수 있습니다.

변환기는 원본 폴더를 읽기만 합니다. 원본 안의 파일을 수정하거나 삭제하지 않으며, 이미 존재하는 목적지에는 쓰지 않습니다. 변환이 끝나기 전에는 임시 폴더에 저장하고 전체 검증이 성공한 경우에만 목적지 이름으로 바꿉니다.

## 변환 전 준비

1. 실행 중인 RisuBard를 모두 종료합니다.
2. V2 원본과 충분한 여유 공간이 있는 새 목적지 경로를 정합니다.
3. 목적지 폴더가 아직 존재하지 않는지 확인합니다. 원본의 내부나 상위 폴더를 목적지로 지정할 수 없습니다.

## 소스 저장소에서 실행

RisuBard 소스 폴더에서 PowerShell을 열고 다음 명령을 실행합니다.

```powershell
pnpm run convert:v2-to-v1 -- "E:\RisuBard-userdata-v2" "E:\RisuBard-userdata-v1"
```

Node.js로 직접 실행해도 됩니다.

```powershell
node scripts/convert-v2-to-v0925.cjs "E:\RisuBard-userdata-v2" "E:\RisuBard-userdata-v1"
```

## 포터블판에서 실행

0.9.28 포터블 폴더에서 PowerShell을 열고 다음 명령을 실행합니다.

```powershell
.\bin\node.exe .\scripts\convert-v2-to-v0925.cjs "E:\RisuBard-userdata-v2" "E:\RisuBard-userdata-v1"
```

## 변환 결과 확인

성공하면 목적지에 `conversion/v2-to-v0925.json` 검증 기록이 생성됩니다. 이 기록에는 원본 전체의 SHA-256 요약과 변환한 캐릭터·자산·KV 항목 수가 들어 있습니다.

변환기는 다음 내용을 대조한 뒤에만 성공합니다.

- 설정과 로그인 정보
- 캐릭터, 대화, 모든 메시지와 초안
- 모듈, 페르소나, 프롬프트, 전역 로어북
- KV 데이터와 참조된 이미지·음성 자산
- BardWiki, 로그 등 별도 보조 폴더
- 변환 전후 V2 원본 전체의 파일 목록·크기·해시

오류가 발생하면 최종 목적지 폴더를 만들지 않습니다. 오류 원인을 해결한 뒤 존재하지 않는 새 목적지 경로로 다시 실행하세요.

## 변환본으로 실행

개발 환경에서는 서버를 시작할 PowerShell에서 변환본을 지정합니다.

```powershell
$env:RISUBARD_DATA_ROOT = "E:\RisuBard-userdata-v1"
pnpm run dev:server
```

포터블판에서는 같은 방식으로 환경 변수를 지정한 뒤 실행합니다.

```powershell
$env:RISUBARD_DATA_ROOT = "E:\RisuBard-userdata-v1"
.\RisuBard.exe
```

정상 작동을 확인할 때까지 V2 원본을 그대로 보관하세요.
