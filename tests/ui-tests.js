// Test UI headless (Playwright/Chromium) du flux "fichiers locaux" de local-ui.
// Serveur main.js réel en sandbox + stub backend — parcours complet : appairage simulé,
// choix de mode, upload fichier, waveform prête, BPM/tonalité, validation, envoi final.
'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRATCH = __dirname;
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 19948;
const STUB_PORT = 8902;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const HOME = path.join(SCRATCH, '.tmp', 'home-ui');
const TMP = path.join(SCRATCH, '.tmp', 'tmp');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
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
  // Appairage pré-rempli (sinon écran "non connectée")
  fs.writeFileSync(path.join(HOME, '.radiostation-import-studio', 'settings.json'),
    JSON.stringify({ vocal_analysis_enabled: false, fast_rip_enabled: false, server_url: STUB, device_token: 'tok-ui' }));

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

  // Indicateur d'appairage + sélecteur de mode
  const pairing = await page.textContent('#pairing-indicator');
  check('UI: indicateur "Connecté à"', pairing.includes('Connecté à'), pairing);
  await page.waitForSelector('#btn-mode-files', { timeout: 5000 });
  check('UI: sélecteur de mode affiché', true);

  // Mode CD : écran "Aucun disque" (pas de CD sur ce Pi), bouton désactivé, retour
  await page.click('#btn-mode-cd');
  await page.waitForSelector('#btn-toc', { timeout: 8000 });
  const tocDisabled = await page.$eval('#btn-toc', el => el.disabled);
  check('UI CD: sans CD → bouton pistes désactivé', tocDisabled === true);
  await page.click('#btn-back-mode');
  await page.waitForSelector('#btn-mode-files', { timeout: 5000 });
  check('UI CD: retour sélecteur de mode', true);

  // Mode fichiers : upload via input
  await page.click('#btn-mode-files');
  await page.waitForSelector('#files-input', { timeout: 5000, state: 'attached' });
  await page.setInputFiles('#files-input', path.join(SCRATCH, '.tmp', 'fixtures', 'Artist One - Nice Song.wav'));

  // Écran d'édition : waveform + résumé
  await page.waitForSelector('#btn-confirm-file', { timeout: 15000 });
  check('UI fichiers: écran édition affiché', true);
  const header = await page.textContent('.card-header');
  check('UI fichiers: titre deviné affiché', header.includes('Nice Song'), header);

  // Waveform décodée : updateSummary (événement 'ready') remplit la zone conservée
  await page.waitForFunction(() => document.getElementById('sum-kept')?.textContent.startsWith('00:10'), { timeout: 20000 });
  const kept = await page.textContent('#sum-kept');
  check('UI fichiers: waveform décodée, zone conservée = 10s', kept.trim().startsWith('00:10'), kept);
  // Fix 16 juil 2026 : la durée totale s'affiche dès le décodage (avant, restait 00:00.000)
  const timeDisp = await page.textContent('#time-display');
  check('UI fichiers: durée totale affichée au chargement', timeDisp.includes('/ 00:10'), timeDisp);

  // BPM/tonalité (aubio wasm) — attendre la fin de l'analyse (plus de "…")
  await page.waitForFunction(() => {
    const b = document.getElementById('sum-bpm')?.textContent;
    return b && b !== '…';
  }, { timeout: 30000 });
  const bpm = await page.textContent('#sum-bpm');
  const key = await page.textContent('#sum-key');
  check('UI fichiers: analyse BPM/tonalité terminée sans plantage', bpm !== '…', `bpm=${bpm} key=${key}`);
  console.log(`      (info) BPM=${bpm} Tonalité=${key} sur sinus 440Hz`);

  // Détection auto des cue points (silences) — sur un sinus continu : pas de crash attendu
  await page.click('#btn-auto-cue');
  await sleep(1500);
  check('UI fichiers: bouton détection auto sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));

  // Zoom avant/arrière/reset
  await page.click('#btn-zoom-in');
  await page.click('#btn-zoom-in');
  let zl = await page.textContent('#zoom-level');
  check('UI fichiers: zoom ×4', zl.trim() === '×4', zl);
  await page.click('#btn-zoom-reset');
  zl = await page.textContent('#zoom-level');
  check('UI fichiers: zoom reset ×1', zl.trim() === '×1', zl);

  // "Tout réinitialiser" ne plante pas (bug historique: resetToFull inexistant)
  await page.click('#btn-reset');
  check('UI fichiers: reset marqueurs sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));

  // Valider → envoi groupé vers stub → écran d'envoi
  await page.click('#btn-confirm-file');
  await page.waitForSelector('.btn-send-file', { timeout: 30000 });
  const sendDisabled = await page.$eval('.btn-send-file', el => el.disabled);
  check('UI fichiers: écran envoi, bouton actif (backendFileId reçu)', sendDisabled === false);

  // Année invalide "abc" → doit être omise du payload (fix parseYear, 16 juil 2026)
  await page.fill('.fmeta-year', 'abc');
  // Envoi individuel → succès
  await page.click('.btn-send-file');
  await page.waitForSelector('.success-box', { timeout: 10000 });
  const success = await page.textContent('.success-box');
  check('UI fichiers: piste envoyée (success-box)', success.includes('Envoyé'), success);
  await page.waitForSelector('#btn-new-files', { timeout: 5000 });
  check('UI fichiers: bouton "Importer d\'autres fichiers" final', true);

  // Le stub a bien reçu l'import avec le bon payload
  const last = await (await fetch(`${STUB}/_last`)).json();
  const imp = last.find(x => x.url === '/api/importer/import');
  check('UI fichiers: /import reçu par le backend avec titre + cue', !!imp && imp.payload.title === 'Nice Song' && 'cue_in_seconds' in imp.payload, JSON.stringify(imp?.payload));
  check('UI fichiers: année invalide "abc" omise du payload', !!imp && !('year' in imp.payload), JSON.stringify(imp?.payload));
  check('UI fichiers: BPM transmis si détecté', !!imp && (imp.payload.bpm === undefined || typeof imp.payload.bpm === 'number'), JSON.stringify(imp?.payload.bpm));

  // Erreurs JS globales sur tout le parcours
  check('UI: aucune erreur JS sur tout le parcours', pageErrors.length === 0, pageErrors.join(' ; '));

  await browser.close();
  console.log(`\nUI: ${pass} ok, ${fail} échec(s)`);
  if (failures.length) console.log('Échecs: ' + failures.join(' | '));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
