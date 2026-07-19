// Vérifie le comportement de l'outil Volume quand normalize_on_import_enabled est actif
// (défaut) : le fichier a déjà été auto-normalisé -14 LUFS à l'upload (/files/upload) AVANT
// que l'éditeur n'ouvre — donc "Mesuré" doit s'afficher dès l'entrée dans l'outil (sans clic
// sur Normaliser), et un clic sur Normaliser ne doit PAS bouger la courbe (gain ~0, skip <
// 0,5 dB, même seuil que main.js::performAutoNormalize et le backend audio_normalize.py).
// Bug rapporté : "je dois cliquer sur le bouton pour le faire apparaître, et modifier la
// courbe" — reproduit et corrigé dans main.js/local-ui/app.js (voir commit associé).
// Usage : NODE_PATH=/home/radiostation/app/node_modules node tests/normalize-auto-check.js
'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRATCH = __dirname;
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 19949;
const STUB_PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const HOME = path.join(SCRATCH, '.tmp', 'home-normalize-auto');
const TMP = path.join(SCRATCH, '.tmp', 'tmp-normalize-auto');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUp(url, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { await fetch(url); return true; } catch { await sleep(150); } }
  return false;
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(path.join(HOME, '.radiostation-import-studio'), { recursive: true });
  // normalize_on_import_enabled explicitement true (comportement par défaut, posé ici pour
  // que le test reste correct même si le défaut change un jour).
  fs.writeFileSync(path.join(HOME, '.radiostation-import-studio', 'settings.json'),
    JSON.stringify({ fast_rip_enabled: false, normalize_on_import_enabled: true, server_url: STUB, device_token: 'tok-normalize-auto' }));

  const stub = spawn('node', [path.join(SCRATCH, 'stub-backend.js')], { stdio: 'ignore', env: { ...process.env, STUB_PORT: String(STUB_PORT) } });
  const srv = spawn('node', ['main.js'], {
    cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), HOME, TMPDIR: TMP },
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  const cleanup = () => { try { srv.kill(); } catch {} try { stub.kill(); } catch {} };
  process.on('exit', cleanup);
  if (!await waitUp(`${BASE}/settings`) || !await waitUp(`${STUB}/_last`)) { console.error('serveurs KO'); process.exit(2); }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#btn-mode-files', { timeout: 5000 });

  await page.click('#btn-mode-files');
  await page.waitForSelector('#files-input', { timeout: 5000, state: 'attached' });
  // Fixture sinusoïdale pleine puissance (déterministe, ~-21.8 LUFS avant normalisation) —
  // même fixture que ui-tests.js, générée par generate-fixtures.sh.
  const fixture = path.join(SCRATCH, '.tmp', 'fixtures', 'Artist One - Nice Song.wav');
  if (!fs.existsSync(fixture)) { console.error('fixture manquante, lancer generate-fixtures.sh'); process.exit(2); }
  const [uploadResp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/files/upload') && r.status() === 200),
    page.setInputFiles('#files-input', fixture),
  ]);
  const uploadBody = await uploadResp.json();
  console.log(`  (info) réponse /files/upload loudness_lufs : ${uploadBody.loudness_lufs}`);
  check('upload : fichier déjà normalisé (~-14 LUFS) grâce au réglage actif',
    uploadBody.loudness_lufs != null && Math.abs(uploadBody.loudness_lufs - (-14)) <= 1.0,
    JSON.stringify(uploadBody.loudness_lufs));

  await page.waitForSelector('#btn-confirm-file', { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('sum-kept')?.textContent.startsWith('00:10'), { timeout: 20000 });

  await page.click('.mode-tab[data-mode="volume"]');
  await sleep(300);

  // Fix A : "Mesuré" déjà affiché, SANS avoir cliqué sur Normaliser.
  const feedbackBeforeClick = await page.textContent('#normalize-feedback').catch(() => null);
  check('Mesuré déjà affiché à l\'entrée dans l\'outil (sans clic)', !!feedbackBeforeClick && feedbackBeforeClick.includes('Mesuré'), feedbackBeforeClick);
  console.log(`  (info) feedback avant clic : ${feedbackBeforeClick}`);
  const volValueBefore = await page.textContent('#vol-value').catch(() => null);
  check('Gain affiché à 0.0 avant tout clic (courbe pas encore touchée)', volValueBefore === '0.0 dB', volValueBefore);

  async function waveformSignature() {
    return page.evaluate(() => {
      const canvas = document.querySelector('#waveform canvas, #waveform shadow-root canvas')
        || document.querySelector('#waveform')?.shadowRoot?.querySelector('canvas');
      if (!canvas) {
        // wavesurfer.js rend dans un shadow DOM sous un div enfant — recherche large.
        const host = document.querySelector('#waveform > div');
        const c = host?.shadowRoot?.querySelector('canvas');
        if (!c) return null;
        const ctx = c.getContext('2d');
        const { width, height } = c;
        const data = ctx.getImageData(0, 0, width, height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
        return sum;
      }
      const ctx = canvas.getContext('2d');
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
      return sum;
    });
  }
  const sigBefore = await waveformSignature();

  await page.click('#btn-normalize');
  await sleep(300);

  const feedbackAfterClick = await page.textContent('#normalize-feedback').catch(() => null);
  console.log(`  (info) feedback après clic : ${feedbackAfterClick}`);
  const volValueAfter = await page.textContent('#vol-value').catch(() => null);
  check('Fix B : gain reste à 0.0 après clic (déjà à la cible, skip < 0.5 dB)', volValueAfter === '0.0 dB', volValueAfter);
  // Fix C (19 juil 2026) : un écart réel de mesure entre le moteur serveur (ffmpeg ebur128,
  // celui qui a VRAIMENT normalisé ce fichier à l'import) et la remesure client (BS.1770 JS)
  // peut dépasser le seuil de skip de 0.5 dB sur un signal complexe (0.7 dB observé en
  // production) — le clic sur Normaliser réappliquait alors un gain sur un fichier pourtant
  // déjà correct. Le texte affiché doit désormais reprendre la mesure SERVEUR (autorité,
  // celle qui a produit le fichier réel), pas la remesure client, quand elle motive le skip.
  check('Fix C : "Mesuré" après clic reprend la mesure serveur (autorité), pas une remesure client divergente',
    feedbackAfterClick != null && feedbackAfterClick.includes(uploadBody.loudness_lufs.toFixed(1)),
    `attendu ${uploadBody.loudness_lufs.toFixed(1)} dans "${feedbackAfterClick}"`);

  const sigAfter = await waveformSignature();
  check('Fix B : waveform PAS redessinée (aucune modification de la courbe)',
    sigBefore !== null && sigAfter !== null && sigBefore === sigAfter,
    `avant=${sigBefore} après=${sigAfter}`);

  // ---- Régression : intro quasi silencieuse — main.js::detectLoudnessLufs lisait la valeur
  // ebur128 CUMULATIVE d'un bloc pas encore convergé (mesurée sur l'intro calme, très loin de
  // la vraie loudness du titre) au lieu du résumé final "Summary". Signalé par l'utilisateur
  // (écart +0.8/+1.1 dB observé) puis creusé : sur cette fixture, la valeur fautive était
  // ~-44.7 LUFS au lieu de ~-15.7 réels — le gain de normalisation auto saturait alors au
  // clamp ±24 dB au lieu du petit gain réellement nécessaire. Testé en réimportant le fichier
  // TEL QUE TRAITÉ par le round précédent (fetch /files/preview → réupload), 3 fois de suite
  // — simule enregistrement + réimport réel : la valeur annoncée doit rester stable ET
  // proche de -14 à chaque passage, jamais dériver. ----
  let currentFixturePath = path.join(SCRATCH, '.tmp', 'fixtures', 'quiet-intro.wav');
  if (!fs.existsSync(currentFixturePath)) { console.error('fixture manquante, lancer generate-fixtures.sh'); process.exit(2); }
  const lufsSeen = [];
  for (let round = 1; round <= 3; round++) {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-mode-files', { timeout: 5000 });
    await page.click('#btn-mode-files');
    await page.waitForSelector('#files-input', { timeout: 5000, state: 'attached' });
    const [uploadRespQ] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/files/upload') && r.status() === 200),
      page.setInputFiles('#files-input', currentFixturePath),
    ]);
    const uploadBodyQ = await uploadRespQ.json();
    console.log(`  (info) intro calme, round ${round} : loudness_lufs = ${uploadBodyQ.loudness_lufs}`);
    lufsSeen.push(uploadBodyQ.loudness_lufs);
    check(`intro calme (round ${round}) : loudness_lufs proche de -14 (pas une valeur transitoire fausse)`,
      uploadBodyQ.loudness_lufs != null && Math.abs(uploadBodyQ.loudness_lufs - (-14)) <= 1.0,
      JSON.stringify(uploadBodyQ.loudness_lufs));
    // Réimporte EXACTEMENT le fichier tel que traité par ce round (fetch /files/preview,
    // servi par main.js) pour le round suivant — simule un enregistrement + réimport réel.
    const roundBuf = await (await fetch(`${BASE}/files/preview/${uploadBodyQ.file_id}`)).arrayBuffer();
    const roundPath = path.join(SCRATCH, '.tmp', `quiet-intro-round${round}.wav`);
    fs.writeFileSync(roundPath, Buffer.from(roundBuf));
    currentFixturePath = roundPath;
  }
  check('intro calme : valeur stable sur 3 imports successifs (pas de dérive)',
    lufsSeen.every(v => v != null && Math.abs(v - lufsSeen[0]) <= 0.2), JSON.stringify(lufsSeen));

  // ---- Régression : fichier DÉJÀ à -14 LUFS AVANT même l'upload (pas besoin de gain à
  // l'import, performAutoNormalize skip < 0.5 dB côté serveur local) — signalé par
  // l'utilisateur : /files/upload renvoyait loudness_lufs=null dans CE cas précis (skip
  // confondu avec "pas mesuré"), privant editorContext.initialLoudnessLufs de toute mesure
  // serveur ; le clic Normaliser retombait alors sur la seule remesure client (BS.1770 JS)
  // et rouvrait un gain résiduel (+0.8 dB observé en prod) sur un fichier déjà correct. ----
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#btn-mode-files', { timeout: 5000 });
  await page.click('#btn-mode-files');
  await page.waitForSelector('#files-input', { timeout: 5000, state: 'attached' });
  const skipFixture = path.join(SCRATCH, '.tmp', 'fixtures', 'already-normalized.wav');
  if (!fs.existsSync(skipFixture)) { console.error('fixture manquante, lancer generate-fixtures.sh'); process.exit(2); }
  const [uploadResp2] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/files/upload') && r.status() === 200),
    page.setInputFiles('#files-input', skipFixture),
  ]);
  const uploadBody2 = await uploadResp2.json();
  console.log(`  (info) réponse /files/upload (fixture déjà à la cible) loudness_lufs : ${uploadBody2.loudness_lufs}`);
  check('upload (skip < 0.5dB) : loudness_lufs mesuré quand même, PAS null',
    uploadBody2.loudness_lufs != null && Math.abs(uploadBody2.loudness_lufs - (-14)) <= 1.0,
    JSON.stringify(uploadBody2.loudness_lufs));

  await page.waitForSelector('#btn-confirm-file', { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('sum-kept')?.textContent.startsWith('00:10'), { timeout: 20000 });
  await page.click('.mode-tab[data-mode="volume"]');
  await sleep(300);
  const feedbackSkip = await page.textContent('#normalize-feedback').catch(() => null);
  check('upload (skip < 0.5dB) : "Mesuré" affiché dès l\'entrée dans l\'outil (mesure serveur dispo)',
    !!feedbackSkip && feedbackSkip.includes('Mesuré'), feedbackSkip);
  await page.click('#btn-normalize');
  await sleep(300);
  const volValueSkip = await page.textContent('#vol-value').catch(() => null);
  check('upload (skip < 0.5dB) : clic Normaliser laisse le gain à 0.0 (fichier déjà correct)',
    volValueSkip === '0.0 dB', volValueSkip);

  check('aucune erreur JS pendant la session', pageErrors.length === 0, pageErrors.join('\n'));

  await browser.close();
  cleanup();

  console.log(`\nNORMALIZE AUTO (app): ${pass} ok, ${fail} échec(s)`);
  process.exit(fail > 0 ? 1 : 0);
})();
