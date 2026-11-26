@echo off
rem Idempotent: start only what's not already listening. Safe to run on every session start.
netstat -an | findstr /c:":7777 " | findstr LISTENING >nul || start "board-viewer" /min node "%~dp0viewer.js"
netstat -an | findstr /c:":7778 " | findstr LISTENING >nul || start "freebuff-term" /min node "%~dp0term-server.js"
netstat -an | findstr /c:":7779 " | findstr LISTENING >nul || start "dashboard" /min node "%~dp0dashboard.js"
