@REM OpenClaw Cache Keepalive Proxy — Windows launcher
@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
