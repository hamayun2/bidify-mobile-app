@echo off
cd /d "%~dp0.."
title Bidify API (port 4000)
node server\index.js
if errorlevel 1 pause
