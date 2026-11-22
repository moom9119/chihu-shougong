@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo.
echo  赤狐收工 · 推送到 GitHub
echo  先在 https://github.com/new 新建一个空仓库（不要勾 README / .gitignore / LICENSE）
echo  然后把仓库地址粘贴到下面（形如 https://github.com/你的账号/chihu-shougong）
echo.
set /p REPO=仓库地址: 
if "%REPO%"=="" (echo 没填地址，已取消 & pause & exit /b 1)

set "GIT=git"
where git >nul 2>nul || set "GIT=%LOCALAPPDATA%\Programs\MinGit\cmd\git.exe"

"%GIT%" remote remove origin 2>nul
"%GIT%" remote add origin "%REPO%"
"%GIT%" branch -M main
echo.
echo  正在推送……（第一次会弹浏览器让你登录 GitHub）
"%GIT%" push -u origin main
echo.
if errorlevel 1 (echo  推送失败：检查仓库地址、登录状态，或改用 Token 推送) else (echo  推送成功！仓库地址就是 %REPO%)
pause
