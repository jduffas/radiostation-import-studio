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

## UVR-MDX-NET-Voc_FT.onnx — séparation de sources (NON embarqué)

Utilisé par le mode « Précise (IA) » (`vocal-precise.js`) : isole la piste voix,
l'énergie relative voix/mix par frame STFT (~23 ms) donne la présence de chant.
~64 Mo — PAS dans le dépôt ni dans les builds : téléchargé au premier usage du
mode précis dans `~/.radiostation-import-studio/models/`, vérifié par SHA-256
(constantes dans `vocal-precise.js`).

Source : https://github.com/TRvlvr/model_repo (releases `all_public_uvr_models`),
modèle du projet Ultimate Vocal Remover (dépôt MIT). Paramètres d'inférence :
n_fft 7680, hop 1024, 3072 bins, tenseur [1,4,3072,256] — figés par
l'entraînement, ne pas les modifier.
