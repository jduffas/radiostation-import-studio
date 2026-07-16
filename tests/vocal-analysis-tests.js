// Test réel de l'analyse vocale (zones sans voix pour jingles) : ffmpeg réellement exécuté
// sur un fichier construit pour simuler voix (bruit rose bande 300-3000 Hz, la bande que le
// filtre de l'analyse isole) et instrumental (sinus 60 Hz, hors bande vocale) :
//   0-5 s   instrumental  ← zone attendue (bonus intro)
//   5-20 s  « voix »
//   20-24 s instrumental  ← zone attendue
//   24-32 s « voix »
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
  const zones = await M.analyzeVocalZones(WAV, 32000);
  const elapsed = Date.now() - t0;
  console.log(`  (info) ${zones.length} zone(s) en ${elapsed}ms :`, JSON.stringify(zones));

  check('au moins 2 zones détectées', zones.length >= 2, String(zones.length));
  const intro = zones.find(z => overlaps(z, 0, 5000));
  const middle = zones.find(z => overlaps(z, 20000, 24000));
  check('zone intro (0-5s) détectée', !!intro, JSON.stringify(zones));
  check('zone milieu (20-24s) détectée', !!middle, JSON.stringify(zones));
  check('intro: bornes ±1s', !!intro && intro.start_ms <= 1000 && Math.abs(intro.end_ms - 5000) <= 1000, JSON.stringify(intro));
  check('milieu: bornes ±1s', !!middle && Math.abs(middle.start_ms - 20000) <= 1000 && Math.abs(middle.end_ms - 24000) <= 1000, JSON.stringify(middle));
  check('aucune zone dans les passages « voix » (8-18s / 26-30s)',
    !zones.some(z => overlaps(z, 8000, 18000) || overlaps(z, 26000, 30000)), JSON.stringify(zones));
  check('intro classée 1re (durée × bonus intro)', zones[0] === intro, JSON.stringify(zones[0]));
  check('champs complets (duration_ms, avg_rms_db)', zones.every(z => z.duration_ms > 0 && typeof z.avg_rms_db === 'number'));
  check('avg_rms_db des zones < -25 dB (vraiment calme dans la bande vocale)', zones.every(z => z.avg_rms_db < -25), JSON.stringify(zones.map(z => z.avg_rms_db)));

  console.log(`\nVOCAL: ${pass} ok, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
