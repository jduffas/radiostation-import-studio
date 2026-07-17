# Modèles embarqués

## bd.rnnn — RNNoise « beguiling-drafter »

Modèle de réseau de neurones récurrent (RNNoise) utilisé par l'analyse vocale
(`analyzeVocalZones`, filtre ffmpeg `arnndn`) comme détecteur appris de voix :
le filtre garde la voix et supprime le reste ; l'écart RMS entrée/sortie par
fenêtre sert de signal « présence de voix », combiné aux critères spectraux.

Source : https://github.com/GregorR/rnnoise-models (beguiling-drafter-2018-08-30)
Licence : BSD 3-clause (même licence que RNNoise/Xiph). ~300 Ko.

Choisi empiriquement (17 juil 2026) parmi les 5 modèles du dépôt : meilleure
séparation chant/instrumental mesurée sur bibliothèque réelle (bd : ~7,6 dB
sur mix aérés ; cb/sh quasi nuls, mp inversé, lq ~4 dB).
