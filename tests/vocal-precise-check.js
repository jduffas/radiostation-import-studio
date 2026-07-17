// Vérification RÉELLE du moteur d'analyse vocale précis (séparation MDX-Net).
// À lancer sur la machine de l'utilisateur (PAS sur le Pi du site — choix produit) :
//
//   node tests/vocal-precise-check.js "/chemin/vers/un/titre.flac" [precise|precise_eco]
//
// Télécharge le modèle (~64 Mo) au premier lancement dans
// ~/.radiostation-import-studio/models/, affiche les zones sans voix détectées
// et le temps d'analyse. NON inclus dans run-all.sh (inférence lourde).
'use strict';
const os = require('node:os');
const path = require('node:path');

const file = process.argv[2];
const level = process.argv[3] === 'precise_eco' ? 'precise_eco' : 'precise';
if (!file) {
  console.error('Usage: node tests/vocal-precise-check.js <fichier audio> [precise|precise_eco]');
  process.exit(2);
}

const VP = require(path.join(__dirname, '..', 'vocal-precise.js'));
if (!VP.isAvailable()) {
  console.error('onnxruntime-node indisponible sur cette plateforme (npm ci dans le dossier de l’app ?)');
  process.exit(1);
}

const SETTINGS_DIR = path.join(os.homedir(), '.radiostation-import-studio');
const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

(async () => {
  const t0 = Date.now();
  const zones = await VP.analyzePrecise(file, null, level, 'ffmpeg', SETTINGS_DIR);
  if (zones === null) {
    console.error('Moteur précis indisponible (modèle non téléchargeable ?)');
    process.exit(1);
  }
  console.log(`\n${zones.length} zone(s) sans voix — niveau ${level} — ${((Date.now() - t0) / 1000).toFixed(0)}s d'analyse`);
  for (const z of zones) {
    const beat = z.bpm ? `, bornes calées sur la grille ${z.bpm} BPM` : '';
    console.log(`  ${fmt(z.start_ms)} → ${fmt(z.end_ms)}  (${(z.duration_ms / 1000).toFixed(1)}s, ${z.kind}, score ${z.score}, voix à ${z.avg_rms_db} dB du mix${beat})`);
  }
  process.exit(0);
})().catch(e => { console.error('ERREUR', e); process.exit(1); });
