@echo off
rem ============================================================
rem  赤狐收工 · 屏幕时间限制管理器 —— 一键启动
rem  优先使用系统 PATH 里的 node；找不到就用 DSH 内置运行时。
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODE_BIN="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_BIN set "NODE_BIN=%%i"
)

if not defined NODE_BIN (
  set "NODE_BIN=C:\Users\CAOLVCHONG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
)

if not exist "%NODE_BIN%" (
  echo [错误] 找不到 node.exe，请安装 Node.js 18+ 后重试。
  pause
  exit /b 1
)

echo 使用 Node: %NODE_BIN%
"%NODE_BIN%" "tools\serve.mjs"
pause
