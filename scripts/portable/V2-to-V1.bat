@echo off
chcp 65001 >nul
setlocal

if not "%~1"=="" set "SOURCE=%~1"
if not defined SOURCE (
  echo V2 데이터 폴더의 전체 경로를 입력하세요.
  set /p "SOURCE=> "
)
set "SOURCE=%SOURCE:"=%"
if not defined SOURCE goto :cancel

"%~dp0bin\node.exe" "%~dp0scripts\convert-v2-to-v0925.cjs" "%SOURCE%"
if errorlevel 1 goto :fail

echo.
echo 변환이 완료되었습니다. 원본 옆의 -v1 폴더를 사용하세요.
pause
exit /b 0

:cancel
echo 입력이 취소되었습니다.
pause
exit /b 1

:fail
echo.
echo 변환에 실패했습니다. 위 오류를 확인하세요. 원본은 변경되지 않았습니다.
pause
exit /b 1
