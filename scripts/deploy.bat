@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem ===========================================================================
rem  一键部署（Windows）
rem
rem  这个文件只是**外壳**：检测 node 是否可用，然后把参数原样转给共用的
rem  跨平台核心 scripts\deploy.mjs。真正的逻辑在那边，Unix 用的是同一个。
rem
rem  用法：
rem    deploy.bat                    完整部署
rem    deploy.bat --no-browser       不装浏览器环境
rem    deploy.bat --profile web      指定 profile
rem    deploy.bat --dry-run          只看会做什么，不改动
rem    deploy.bat --help
rem
rem  平台说明：Windows 上没有 Xvfb / x11vnc，所以「有头浏览器 + 远程画面」
rem            那套不可用；「普通端 / 机场线路」是完整的。这不是脚本偷懒，
rem            是平台限制，核心脚本会检测出来并告诉你。
rem ===========================================================================

set "SCRIPT_DIR=%~dp0"
set "CORE=%SCRIPT_DIR%deploy.mjs"

rem --- 检测 1：核心脚本在不在 -----------------------------------------------
if not exist "%CORE%" (
  echo [X] 找不到核心脚本: %CORE%
  echo     这个 .bat 只是外壳，逻辑在同目录的 deploy.mjs 里。
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

rem --- 转调共享核心 ---------------------------------------------------------
node "%CORE%" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
