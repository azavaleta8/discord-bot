@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo ============================================
echo   Discord Bot - setup
echo ============================================
echo.

echo [1/5] Ensuring Node.js 22 LTS...
set "NODE_OK="
where node >nul 2>&1
if "%errorlevel%"=="0" (
    for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
    for /f "tokens=1 delims=." %%a in ("!NODEVER!") do set "NODEMAJOR=%%a"
    set "NODEMAJOR=!NODEMAJOR:v=!"
    if "!NODEMAJOR!"=="22" (
        echo   Node !NODEVER! - OK.
        set "NODE_OK=1"
    ) else (
        echo   Node !NODEVER! detected; Node 22 LTS is required.
    )
) else (
    echo   Node.js not found.
)

if not defined NODE_OK (
    where nvm >nul 2>&1
    if "!errorlevel!"=="0" (
        echo   nvm found - installing and activating Node 22.12.0...
        nvm install 22.12.0
        nvm use 22.12.0
    ) else (
        echo   nvm not found - installing nvm-windows via winget...
        winget install --id CoreyButler.NVMforWindows -e --accept-source-agreements --accept-package-agreements
        echo.
        echo   nvm was just installed, but it is NOT on PATH in this window yet.
        echo   Close this window, open a NEW terminal, and run setup.bat again -
        echo   it will then install and activate Node 22 automatically.
        goto :abort
    )
    rem Re-check that Node 22 is now the active version.
    set "NODEVER="
    where node >nul 2>&1
    if not "!errorlevel!"=="0" goto :nodefail
    for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
    for /f "tokens=1 delims=." %%a in ("!NODEVER!") do set "NODEMAJOR=%%a"
    set "NODEMAJOR=!NODEMAJOR:v=!"
    if not "!NODEMAJOR!"=="22" goto :nodefail
    echo   Node !NODEVER! is now active.
)
echo.

echo [2/5] Checking install location...
echo   !CD! | findstr /i "OneDrive" >nul
if "%errorlevel%"=="0" (
    echo.
    echo   WARNING: this folder is inside OneDrive:
    echo     !CD!
    echo   OneDrive locks files while syncing and breaks native-module installs
    echo   ^(EPERM errors^). Move the project to a plain local path such as
    echo   C:\Users\%USERNAME%\discord-bot and run setup from there.
    echo.
    choice /m "   Continue anyway"
    if errorlevel 2 goto :abort
)
echo.

echo [3/5] Checking FFmpeg...
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

echo [4/5] Installing npm dependencies...
call npm install
if errorlevel 1 goto :fail
echo.

echo [5/5] Building...
call npm run build
if errorlevel 1 goto :fail

echo.
echo ============================================
echo   DONE. You can close this window.
echo ============================================
pause
exit /b 0

:nodefail
echo.
echo   Could not activate Node 22. On nvm-windows, 'nvm use' needs Administrator
echo   rights. Right-click setup.bat and "Run as administrator", or run these in
echo   an elevated terminal, then run setup again:
echo       nvm install 22.12.0
echo       nvm use 22.12.0
pause
exit /b 1

:abort
echo.
echo Setup stopped. Address the message above, then run setup again.
pause
exit /b 1

:fail
echo.
echo ============================================
echo   SETUP FAILED - see the errors above.
echo ============================================
pause
exit /b 1
