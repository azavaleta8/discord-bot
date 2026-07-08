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

echo [3/6] Checking FFmpeg...
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

echo [4/6] Checking C++ build tools ^(needed to compile @discordjs/opus^)...
set "VCTOOLS_OK="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "!VSWHERE!" (
    for /f "usebackq delims=" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VCTOOLS_OK=1"
)
if defined VCTOOLS_OK (
    echo   C++ build tools found.
) else (
    echo   C++ build tools not found - installing VS 2022 Build Tools via winget...
    echo   ^(Large download, may take several minutes. Node-gyp finds these via
    echo    vswhere at build time, so no new terminal is needed afterward.^)
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if errorlevel 1 (
        echo.
        echo   Automatic install failed. Install the C++ tools manually, then re-run setup:
        echo     1. Download "Build Tools for Visual Studio 2022" from
        echo        https://visualstudio.microsoft.com/downloads/  ^(under "Tools for Visual Studio"^)
        echo     2. In the installer, check the "Desktop development with C++" workload.
        echo     3. Install, then run setup.bat again.
        goto :fail
    )
    echo   C++ build tools installed.
)
echo.

echo [5/6] Installing npm dependencies...
if exist node_modules (
    echo   Removing previous node_modules for a clean install...
    rmdir /s /q node_modules 2>nul
)
call npm install
if errorlevel 1 goto :fail
echo.

echo [6/6] Building...
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
echo.
echo   If the error mentions @discordjs/opus, node-gyp, or "could not find
echo   Visual Studio", the C++ build tools are missing or incomplete. Install
echo   "Build Tools for Visual Studio 2022" with the "Desktop development with
echo   C++" workload from https://visualstudio.microsoft.com/downloads/ and
echo   run setup.bat again.
pause
exit /b 1
