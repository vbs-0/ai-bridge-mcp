@echo off
rem Start the whole AI-team stack (board viewer, freebuff terminal, dashboard)
start "board-viewer" /min node "%~dp0viewer.js"
start "freebuff-term" /min node "%~dp0term-server.js" %1
start "dashboard" /min node "%~dp0dashboard.js"
timeout /t 2 /nobreak >nul
start http://localhost:7779
echo Dashboard:        http://localhost:7779
echo Freebuff terminal: http://localhost:7778
echo Board viewer:      http://localhost:7777
