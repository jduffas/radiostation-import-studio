#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
    echo "Node.js manquant. Installez-le : sudo apt install nodejs"
    exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
    echo "ffmpeg manquant. Installez-le : sudo apt install ffmpeg"
    exit 1
fi

echo "RadioStation CD Ripper — démarrage..."
node main.js
