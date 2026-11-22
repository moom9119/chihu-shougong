@echo off
rem ============================================================
rem  赤狐收工 · 局域网演示模式
rem  同一个 Wi-Fi 下的手机 / 其他电脑也能打开（现场评审用）
rem  关掉这个窗口就失效；只在可信网络里用。
rem ============================================================
setlocal enabledelayedexpansion
chcp 65001 >nul
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

echo.
echo  正在以「局域网可访问」方式启动，下面会打印可以给手机/评委打开的地址……
echo.
"%NODE_BIN%" "tools\serve.mjs" --host 0.0.0.0
pause