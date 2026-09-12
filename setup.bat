@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem ===========================================================================
rem  dsh-gpt-free-relay · 一键部署（Windows 总入口）
rem
rem  这里只是**指路牌**：真正的实现在 scripts\windows\。
rem  保留这个根目录入口，是为了让你不用记子目录。
rem
rem    Windows  ->  setup.bat   （就是本文件）
rem    Unix     ->  setup.sh
rem
rem  用法：
rem    setup.bat                    完整部署
rem    setup.bat --no-browser       不装浏览器环境
rem    setup.bat --profile web      指定 profile
rem    setup.bat --dry-run          只看会做什么
rem    setup.bat --help
rem
rem  平台说明：Windows 上没有 Xvfb / x11vnc，所以远程画面不用 noVNC，
rem            改用 CDP 截图（/browser/frame）。机场线路与浏览器作答都完整可用。
rem ===========================================================================

set "SCRIPT_DIR=%~dp0"
set "CORE=%SCRIPT_DIR%scripts\windows\deploy.mjs"

rem --- 检测 1：核心脚本在不在 -----------------------------------------------
if not exist "%CORE%" (
  echo [X] 找不到核心脚本: %CORE%
  echo     这个 .bat 只是指路牌，实现在 scripts\windows\ 里。
  endlocal
  exit /b 1
)

rem --- 检测 2：node --------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 node，请先安装 Node.js ^(^>=20^)
  echo     下载: https://nodejs.org/
  endlocal
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if !NODE_MAJOR! LSS 20 (
  for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
  echo [X] Node 版本过低 ^(!NODEV!^)，需要 ^>=20
  endlocal
  exit /b 1
)

rem --- 转调本平台核心 -------------------------------------------------------
node "%CORE%" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
