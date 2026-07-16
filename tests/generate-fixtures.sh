#!/bin/bash
# Génère les fichiers audio de test (non versionnés) dans tests/.tmp/fixtures/.
set -e
DIR="$(dirname "$0")/.tmp/fixtures"
mkdir -p "$DIR"
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=10" -ar 44100 -ac 2 "$DIR/Artist One - Nice Song.wav"
ffmpeg -y -v error -f lavfi -i "aevalsrc=0:d=2[s1];sine=f=440:d=5[t0];[t0]volume=0.8[t];aevalsrc=0:d=1.5[s2];[s1][t][s2]concat=n=3:v=0:a=1" -ar 44100 -ac 2 "$DIR/padded.wav"
echo "fixtures OK dans $DIR"
