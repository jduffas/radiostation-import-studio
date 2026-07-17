// Test réel de l'analyse vocale (zones sans voix pour jingles) : ffmpeg réellement exécuté
// sur un fichier construit pour simuler voix (bruit rose bande 300-3000 Hz, la bande que le
// filtre de l'analyse isole), instrumental calme (sinus 60 Hz, hors bande vocale) et pont
// brillant à plein volume (bruit rose 1500-3400 Hz — critère tilt spectral v2) :
//   0-5 s   instrumental calme  ← touche le tout début de la piste : DOIT être exclue (c'est
//                                 le rôle de l'intro/des cue points, pas du "jingle intérieur")
//   5-20 s  « voix »
//   20-24 s instrumental calme  ← zone attendue kind=quiet
//   24-32 s « voix »
//   32-38 s pont brillant plein volume ← zone attendue kind=bridge (indétectable en v1 :
//                                        pas calme, seulement un tilt spectral bas)
//   38-48 s « voix »
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'main.js');
const OUT = path.join(__dirname, '.tmp', 'main_testable_vocal.js');
const WAV = path.join(__dirname, '.tmp', 'fixtures', 'vocal-sim.wav');

let src = fs.readFileSync(SRC, 'utf8');
src = src.replace("server.listen(PORT, '127.0.0.1'", "if (process.env.RS_TEST_LISTEN) server.listen(PORT, '127.0.0.1'");
src += '\nmodule.exports = { analyzeVocalZones };\n';
fs.writeFileSync(OUT, src);
const M = require(OUT);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const overlaps = (z, a, b) => z.start_ms < b && z.end_ms > a;

(async () => {
  if (!fs.existsSync(WAV)) { console.error('fixture vocal-sim.wav absente — lancer generate-fixtures.sh'); process.exit(2); }
  const t0 = Date.now();
  const zones = await M.analyzeVocalZones(WAV, 48000);
  const elapsed = Date.now() - t0;
  console.log(`  (info) ${zones.length} zone(s) en ${elapsed}ms :`, JSON.stringify(zones));

  check('au moins 2 zones détectées', zones.length >= 2, String(zones.length));
  const intro = zones.find(z => overlaps(z, 0, 5000));
  const middle = zones.find(z => overlaps(z, 20000, 24000));
  const bridge = zones.find(z => overlaps(z, 32000, 38000));
  check('zone intro (0-5s) EXCLUE (touche le début de la piste)', !intro, JSON.stringify(zones));
  check('zone milieu calme (20-24s) détectée', !!middle, JSON.stringify(zones));
  check('milieu: bornes ±1s', !!middle && Math.abs(middle.start_ms - 20000) <= 1000 && Math.abs(middle.end_ms - 24000) <= 1000, JSON.stringify(middle));
  check('milieu: kind=quiet', !!middle && middle.kind === 'quiet', JSON.stringify(middle));
  check('pont brillant plein volume (32-38s) détecté via tilt', !!bridge, JSON.stringify(zones));
  check('pont: bornes ±1s', !!bridge && Math.abs(bridge.start_ms - 32000) <= 1000 && Math.abs(bridge.end_ms - 38000) <= 1000, JSON.stringify(bridge));
  check('pont: kind=bridge', !!bridge && bridge.kind === 'bridge', JSON.stringify(bridge));
  check('pont: PAS calme (avg_rms_db > -25 dB, invisible pour le critère quiet v1)',
    !!bridge && bridge.avg_rms_db > -25, JSON.stringify(bridge));
  check('aucune zone dans les passages « voix » (8-18s / 26-30s / 40-46s)',
    !zones.some(z => overlaps(z, 8000, 18000) || overlaps(z, 26000, 30000) || overlaps(z, 40000, 46000)), JSON.stringify(zones));
  check('aucune zone à moins de 5s des bords de la piste',
    zones.every(z => z.start_ms >= 5000 && z.end_ms <= 43000), JSON.stringify(zones));
  check('champs complets (duration_ms, avg_rms_db, kind)', zones.every(z => z.duration_ms > 0 && typeof z.avg_rms_db === 'number' && ['quiet', 'bridge'].includes(z.kind)));
  check('zones calmes: avg_rms_db < -25 dB (vraiment calme dans la bande vocale)',
    zones.filter(z => z.kind === 'quiet').every(z => z.avg_rms_db < -25), JSON.stringify(zones.map(z => z.avg_rms_db)));

  console.log(`\nVOCAL: ${pass} ok, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
