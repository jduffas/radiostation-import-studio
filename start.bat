@echo off
title RadioStation Import Studio
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js n'est pas installe ou pas dans le PATH.
    echo Telechargez-le sur https://nodejs.org/fr/download
    pause
    exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo ffmpeg n'est pas installe ou pas dans le PATH.
    echo Telechargez-le sur https://ffmpeg.org/download.html
    pause
    exit /b 1
)

echo RadioStation Import Studio - demarrage...
node main.js
pause
