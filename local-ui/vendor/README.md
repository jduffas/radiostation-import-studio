# wavesurfer.js (vendored)

Version 7.12.1, copiée depuis `frontend/node_modules/wavesurfer.js/dist/` (repo principal) —
`wavesurfer.esm.js` (bibliothèque) + `plugins/regions.esm.js` (région de coupe/cue points).

Licence BSD-3-Clause — https://github.com/katspaugh/wavesurfer.js

Vendorisé (pas de dépendance npm ici) car cette page est servie directement par `main.js`
sans bundler ni accès réseau garanti sur la machine qui rippe le CD.

# aubiojs (vendored)

Version 0.2.1 (npm `aubiojs`, `qiuxiang/aubiojs`), fichier unique auto-suffisant
`build/aubio.esm.js` (~208 Ko, wasm embarqué en base64, `export default aubio` —
`const { Tempo, Pitch } = await aubio()`). Compilation WASM de la vraie lib C aubio, mêmes
algorithmes que le backend (`services/audio_analysis.py`, `aubio tempo`/`aubio pitch -m
yinfft`). Utilisé pour calculer BPM (`Tempo`) et tonalité (`Pitch` + chroma, cf.
`key-detect.js`) directement dans la webview, sans round-trip HTTP — spike résolu et validé
réellement le 14 juillet 2026 (voir `docs/PLAN-CD-RIPPER-NATIF.md`, Phase 4).

Licence GPLv3 (héritée d'aubio) — https://github.com/qiuxiang/aubiojs

## Patch local sur regions.esm.js (16 juillet 2026)

Une modification d'un caractère par rapport à l'upstream 7.12.1, dans `virtualAppend`
(rendu virtuel des régions) : `l<s+n` → `l<=s+n`. Sans elle, une région/marqueur dont le
`start` tombe exactement à la fin de la piste (cas du marqueur TRANSITION par défaut,
`start = durée`) n'est **jamais ajoutée au DOM** — sa position pixel `l` vaut exactement la
largeur totale, et la comparaison stricte échoue quel que soit le zoom ou le défilement
(à un pixel d'arrondi près, d'où un comportement « parfois visible, parfois absent » selon
la largeur de fenêtre). Démontré par `tests/zoom-tests.js`. En cas de mise à jour de
wavesurfer.js, réappliquer ce patch (chercher `>s&&l<s+n` dans le fichier minifié).
