@echo off
rem Launch the Discord Bot control panel window (hidden PowerShell host).
rem Double-click this file, or pin it to the taskbar / Start.
powershell -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File "%~dp0bot-panel.ps1"
