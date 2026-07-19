// Test de précision du zoom waveform (Playwright/Chromium headless) : vérifie que le
// glissé d'un marqueur de cue point correspond au temps affiché SANS décalage, à ×1 puis
// à ×8 (avec défilement horizontal), et que le zoom améliore réellement la précision
// (1 px vaut ~8× moins de millisecondes).
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
const HOME = path.join(SCRATCH, '.tmp', 'home-zoom');
const TMP = path.join(SCRATCH, '.tmp', 'tmp');
const DUR = 10; // durée du fichier de test (s)

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
// "Transition (avant fin) : MM:SS.mmm" → secondes avant la fin
function parseCueOut(txt) {
  const m = txt.match(/(\d+):(\d+)\.(\d+)/);
  return m ? (+m[1]) * 60 + (+m[2]) + (+m[3]) / 1000 : NaN;
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.radiostation-import-studio'), { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(HOME, '.radiostation-import-studio', 'settings.json'),
    JSON.stringify({ server_url: STUB, device_token: 'tok-zoom' }));

  const stub = spawn('node', [path.join(SCRATCH, 'stub-backend.js')], { stdio: 'ignore', env: { ...process.env, STUB_PORT: String(STUB_PORT) } });
  const srv = spawn('node', ['main.js'], { cwd: APP_DIR, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), HOME, TMPDIR: TMP } });
  const cleanup = () => { try { srv.kill(); } catch {} try { stub.kill(); } catch {} };
  process.on('exit', cleanup);
  if (!await waitUp(`${BASE}/settings`)) { console.error('serveur KO'); process.exit(2); }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-mode-files');
  await page.setInputFiles('#files-input', path.join(SCRATCH, '.tmp', 'fixtures', 'Artist One - Nice Song.wav'));
  await page.waitForFunction(() => document.getElementById('sum-kept')?.textContent.startsWith('00:10'), { timeout: 20000 });
  // Mode par défaut = 'cut' (Montage) depuis le 19 juil 2026 — trim-keep/cue-out
  // n'existent (display) qu'en mode 'cue', il faut y basculer avant de les mesurer.
  await page.click('.mode-tab[data-mode="cue"]');

  const keepSel = '#waveform [part~="trim-keep"]';
  // Étiquette "TRANSITION" (region-content du marqueur cue-out) : la poignée de drag réelle,
  // centrée sur le marqueur (left:50% + translateX(-50%)) → son centre = position du
  // marqueur. Nécessite le patch vendor `l<=s+n` (cf. vendor/README.md) : sans lui, un
  // marqueur à start=durée n'est jamais dans le DOM. Hors du viewport virtuel (zoom+scroll),
  // il est retiré du DOM par la virtualisation → défiler jusqu'à lui avant de le mesurer.
  const cueOutSel = '#waveform [part~="cue-out"] [part="region-content"]';
  const scrollSel = '#waveform [part="scroll"]';
  const markerX = async () => {
    const b = await page.locator(cueOutSel).boundingBox();
    return b.x + b.width / 2;
  };

  const keepBox1 = await page.locator(keepSel).boundingBox();
  const pxPerSec1 = keepBox1.width / DUR;
  console.log(`  (info) ×1 : ${pxPerSec1.toFixed(1)} px/s → 1 px = ${(1000 / pxPerSec1).toFixed(1)} ms`);

  // ---- Glissé du marqueur TRANSITION (par son corps, au milieu de la waveform) ----
  const dragTo = async (targetTimeS) => {
    const keepBox = await page.locator(keepSel).boundingBox();
    const pxPerSec = keepBox.width / DUR;
    const box = await page.locator(cueOutSel).boundingBox();
    const markerCenterX = box.x + box.width / 2; // = position du marqueur (étiquette centrée)
    // Point de saisie GARANTI visible : l'étiquette d'un marqueur en bord de piste déborde
    // du conteneur (clippée) — son centre exact peut être hors zone cliquable. Le drag du
    // plugin fonctionne en delta, peu importe où on saisit l'étiquette.
    const grabX = Math.max(box.x + 4, Math.min(markerCenterX, keepBox.x + keepBox.width - 6));
    const y = box.y + box.height / 2;
    const targetX = grabX + (keepBox.x + targetTimeS * pxPerSec - markerCenterX);
    await page.mouse.move(grabX, y);
    await page.mouse.down();
    await page.mouse.move(targetX, y, { steps: 12 });
    await page.mouse.up();
    await sleep(250);
  };

  await dragTo(7.0);
  const cueOut1 = parseCueOut(await page.textContent('#sum-cueout')); // = 10 − position
  const err1ms = Math.abs((DUR - cueOut1) - 7.0) * 1000;
  console.log(`  (info) ×1 : visé 7.000s → obtenu ${(DUR - cueOut1).toFixed(3)}s (écart ${err1ms.toFixed(1)} ms)`);
  check('×1 : marqueur posé à ±2,5 px du temps visé', err1ms <= 2.5 * (1000 / pxPerSec1), `${err1ms.toFixed(1)} ms`);
  // Régression "poignée vole le drag" : la zone bleue ne doit PAS avoir bougé (le marqueur
  // par défaut est superposé pixel pour pixel à la poignée droite de la zone bleue).
  check('×1 : le drag n\'a pas redimensionné la zone bleue (poignée non volée)',
    (await page.textContent('#sum-kept')).trim().startsWith('00:10'), await page.textContent('#sum-kept'));

  // Position DOM du marqueur = temps × px/s (alignement rendu ↔ état interne)
  let kBox = await page.locator(keepSel).boundingBox();
  const domErr1 = Math.abs((await markerX() - kBox.x) - (DUR - cueOut1) * (kBox.width / DUR));
  check('×1 : position DOM du marqueur alignée (±2 px)', domErr1 <= 2, `${domErr1.toFixed(1)} px`);

  // ---- Zoom ×8 ----
  // Slider (glissé continu, remplace les boutons ➕/➖ le 19 juil 2026) : mapping exponentiel
  // ZOOM_MIN=1..ZOOM_MAX=40 sur 0..1000 (cf. sliderFromZoomLevel/zoomLevelFromSlider dans
  // app.js) — valeur 564 ≈ niveau 8.01, pas exactement 8 (approximation acceptée, contrôle
  // continu). 1000*log(8)/log(40) ≈ 563.7.
  await page.$eval('#zoom-slider', el => { el.value = '564'; el.dispatchEvent(new Event('input')); });
  await sleep(300);
  const zoomLevelTxt = (await page.textContent('#zoom-level')).trim();
  check('×8 : niveau affiché (~×8)', /^×8(\.\d+)?$/.test(zoomLevelTxt), zoomLevelTxt);
  const keepBox8 = await page.locator(keepSel).boundingBox();
  const pxPerSec8 = keepBox8.width / DUR;
  console.log(`  (info) ×8 : ${pxPerSec8.toFixed(1)} px/s → 1 px = ${(1000 / pxPerSec8).toFixed(2)} ms`);
  check('×8 : largeur waveform ×8 (±5%)', Math.abs(pxPerSec8 / pxPerSec1 - 8) < 0.4, String(pxPerSec8 / pxPerSec1));

  // Pas de décalage induit par le zoom : le marqueur n'a pas bougé dans le temps
  const cueOutAfterZoom = parseCueOut(await page.textContent('#sum-cueout'));
  check('×8 : temps du marqueur inchangé par le zoom', Math.abs(cueOutAfterZoom - cueOut1) < 0.001, `${cueOut1} → ${cueOutAfterZoom}`);

  // ---- Défilement pour amener t≈7 s à l'écran (le marqueur hors champ est virtualisé) ----
  const scroller = page.locator(scrollSel);
  await scroller.evaluate((el, x) => { el.scrollLeft = x; }, Math.round(7.0 * pxPerSec8 - 400));
  await sleep(300);
  kBox = await page.locator(keepSel).boundingBox();
  const domErr8 = Math.abs((await markerX() - kBox.x) - (DUR - cueOutAfterZoom) * (kBox.width / DUR));
  check('×8 : position DOM toujours alignée après zoom+scroll (±2 px)', domErr8 <= 2, `${domErr8.toFixed(1)} px`);

  // ---- Précision du glissé à ×8 ----
  await dragTo(7.2);
  const cueOut8 = parseCueOut(await page.textContent('#sum-cueout'));
  const err8ms = Math.abs((DUR - cueOut8) - 7.2) * 1000;
  console.log(`  (info) ×8 : visé 7.200s → obtenu ${(DUR - cueOut8).toFixed(3)}s (écart ${err8ms.toFixed(2)} ms)`);
  check('×8 : marqueur posé à ±2,5 px du temps visé', err8ms <= 2.5 * (1000 / pxPerSec8), `${err8ms.toFixed(2)} ms`);
  check('×8 : précision réellement ~8× meilleure qu\'à ×1 (1 px en ms)',
    (1000 / pxPerSec8) < (1000 / pxPerSec1) / 6, `${(1000 / pxPerSec8).toFixed(2)} vs ${(1000 / pxPerSec1).toFixed(2)} ms/px`);

  // ---- Clic de seek à ×8 : le curseur va bien au temps cliqué (alignement audio ↔ pixels) ----
  kBox = await page.locator(keepSel).boundingBox();
  const seekTarget = 6.5;
  await page.mouse.click(kBox.x + seekTarget * (kBox.width / DUR), kBox.y + kBox.height * 0.75);
  await sleep(300);
  const timeTxt = await page.textContent('#time-display');
  const tm = timeTxt.match(/^(\d+):(\d+)\.(\d+)/);
  const seekGot = tm ? (+tm[1]) * 60 + (+tm[2]) + (+tm[3]) / 1000 : NaN;
  const seekErrMs = Math.abs(seekGot - seekTarget) * 1000;
  console.log(`  (info) seek ×8 : visé 6.500s → curseur à ${seekGot.toFixed(3)}s (écart ${seekErrMs.toFixed(2)} ms)`);
  check('×8 : clic-seek aligné (±1 px)', seekErrMs <= 1.5 * (1000 / pxPerSec8), `${seekErrMs.toFixed(2)} ms`);

  // ---- Retour ×1 : le marqueur reste au même temps ----
  await page.click('#btn-zoom-reset');
  await sleep(200);
  const cueOutBack = parseCueOut(await page.textContent('#sum-cueout'));
  check('retour ×1 : temps du marqueur conservé', Math.abs(cueOutBack - cueOut8) < 0.001, `${cueOut8} → ${cueOutBack}`);

  check('aucune erreur JS pendant les manipulations zoom/drag', pageErrors.length === 0, pageErrors.join(' ; '));

  await browser.close();
  console.log(`\nZOOM: ${pass} ok, ${fail} échec(s)`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
