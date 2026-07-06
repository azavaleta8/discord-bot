@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   Discord Bot - setup
echo ============================================
echo.

echo [1/4] Checking Node.js...
where node >nul 2>&1
if not "%errorlevel%"=="0" (
    echo   Node.js not found. Install it from https://nodejs.org ^(v22 or newer^),
    echo   then run this setup again.
    goto :fail
)
for /f "delims=" %%v in ('node -v') do echo   Node %%v found.
echo.

echo [2/4] Checking FFmpeg...
where ffmpeg >nul 2>&1
if "%errorlevel%"=="0" (
    echo   FFmpeg found.
) else (
    echo   FFmpeg not found - installing via winget...
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    echo.
    echo   NOTE: FFmpeg was just added to your PATH. After setup finishes,
    echo         CLOSE the bot panel and reopen it so it sees the new PATH,
    echo         otherwise clips will fail with "ffmpeg not found".
)
echo.

echo [3/4] Installing npm dependencies...
call npm install
if errorlevel 1 goto :fail
echo.

echo [4/4] Building...
call npm run build
if errorlevel 1 goto :fail

echo.
echo ============================================
echo   DONE. You can close this window.
echo ============================================
pause
exit /b 0

:fail
echo.
echo ============================================
echo   SETUP FAILED - see the errors above.
echo ============================================
pause
exit /b 1
