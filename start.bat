@echo off
title RadioStation CD Ripper
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

echo RadioStation CD Ripper - demarrage...
node main.js
pause
