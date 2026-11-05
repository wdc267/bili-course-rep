@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo B站课代表 · 调试启动（关闭本窗口即停止服务）
node server.mjs
pause
