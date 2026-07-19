#!/bin/bash
# Génère les fichiers audio de test (non versionnés) dans tests/.tmp/fixtures/.
set -e
DIR="$(dirname "$0")/.tmp/fixtures"
mkdir -p "$DIR"
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=10" -ar 44100 -ac 2 "$DIR/Artist One - Nice Song.wav"
# Sinus déjà mesuré à -14.0 LUFS (même méthode ebur128 que main.js::detectLoudnessLufs) —
# gain +7.8dB sur le sinus brut ci-dessus (dont le peak réel est ~-21dBFS, pas 0dBFS malgré
# une amplitude lavfi "pleine" : marge suffisante, aucun écrêtage). Sert à reproduire le cas
# "déjà normalisé à l'upload" (skip < 0,5 dB), distinct de la fixture ci-dessus qui elle
# nécessite un VRAI gain de normalisation (~-21.8 LUFS avant, testée ailleurs).
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=10" -af "volume=7.8dB" -ar 44100 -ac 2 "$DIR/already-normalized.wav"
ffmpeg -y -v error -f lavfi -i "aevalsrc=0:d=2[s1];sine=f=440:d=5[t0];[t0]volume=0.8[t];aevalsrc=0:d=1.5[s2];[s1][t][s2]concat=n=3:v=0:a=1" -ar 44100 -ac 2 "$DIR/padded.wav"
# Simulation voix/instrumental pour vocal-analysis-tests.js : « voix » = bruit rose dans la
# bande 300-3000 Hz (celle que l'analyse isole), « instrumental calme » = sinus 60 Hz hors
# bande, « pont brillant » = bruit rose 1500-3400 Hz À PLEIN VOLUME (critère tilt spectral v2 :
# indétectable par le seul critère quiet, doit être trouvé via le tilt).
# Segments : 0-5s instru / 5-20s voix / 20-24s instru / 24-32s voix / 32-38s pont brillant / 38-48s voix.
ffmpeg -y -v error -f lavfi -i "sine=f=60:d=5[i1];anoisesrc=d=15:c=pink:a=0.7[v0];[v0]highpass=f=300,lowpass=f=3000,volume=2.0[v1];sine=f=60:d=4[i2];anoisesrc=d=8:c=pink:a=0.7[v2b];[v2b]highpass=f=300,lowpass=f=3000,volume=2.0[v2];anoisesrc=d=6:c=pink:a=0.7[b0];[b0]highpass=f=1500,lowpass=f=3400,volume=4.5[b1];anoisesrc=d=10:c=pink:a=0.7[v3b];[v3b]highpass=f=300,lowpass=f=3000,volume=2.0[v3];[i1][v1][i2][v2][b1][v3]concat=n=6:v=0:a=1" -ar 44100 -ac 2 "$DIR/vocal-sim.wav"
echo "fixtures OK dans $DIR"
