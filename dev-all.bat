@echo off
REM Bidify — one command: API + Expo + Stripe webhook forwarder
cd /d "%~dp0"
set EXPO_PUBLIC_API_URL=http://127.0.0.1:4000/api
echo [Bidify] Starting API + Expo + Stripe listen (npm run dev)...
call npm run dev
