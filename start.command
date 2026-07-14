#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
    osascript -e 'display alert "Node.js manquant" message "Installez Node.js depuis https://nodejs.org ou via : brew install node"'
    exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
    osascript -e 'display alert "ffmpeg manquant" message "Installez ffmpeg via : brew install ffmpeg"'
    exit 1
fi

echo "RadioStation Import Studio — démarrage..."
node main.js
