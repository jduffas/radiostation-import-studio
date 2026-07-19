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
  // normalize_on_import_enabled: false — sinon l'upload de fixture (Phase 4) serait
  // auto-normalisé à -14 LUFS avant même le clic sur le bouton manuel « Normaliser » plus
  // bas, qui a justement besoin d'un fichier resté à son niveau d'origine pour vérifier son
  // propre calcul de gain (test dédié, distinct de la normalisation auto à l'import).
  fs.writeFileSync(path.join(HOME, '.radiostation-import-studio', 'settings.json'),
    JSON.stringify({ fast_rip_enabled: false, normalize_on_import_enabled: false, server_url: STUB, device_token: 'tok-ui' }));

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
  // "Rip rapide" ne concerne que la lecture physique d'un CD → masqué au sélecteur de mode.
  check('UI: "Rip rapide" masqué hors mode CD (sélecteur de mode)', !(await page.isVisible('#fast-rip-label')));
  // Le pré-calcul "Analyse vocale" au rip CD a été retiré (redondant/confus avec le bouton
  // adaptatif du mode jingle) : le toggle n'existe plus nulle part dans l'UI.
  check('UI: "Analyse vocale" (pré-calcul rip) absent du DOM', (await page.$('#vocal-toggle-label')) === null);

  // Mode CD : écran "Aucun disque" (pas de CD sur ce Pi), bouton désactivé, retour
  await page.click('#btn-mode-cd');
  await page.waitForSelector('#btn-toc', { timeout: 8000 });
  const tocDisabled = await page.$eval('#btn-toc', el => el.disabled);
  check('UI CD: sans CD → bouton pistes désactivé', tocDisabled === true);
  check('UI CD: "Rip rapide" visible en mode CD', await page.isVisible('#fast-rip-label'));
  check('UI CD: "Analyse vocale" (pré-calcul rip) absent en mode CD', (await page.$('#vocal-toggle-label')) === null);
  await page.click('#btn-back-mode');
  await page.waitForSelector('#btn-mode-files', { timeout: 5000 });
  check('UI CD: retour sélecteur de mode', true);

  // Mode fichiers : upload via input
  await page.click('#btn-mode-files');
  await page.waitForSelector('#files-input', { timeout: 5000, state: 'attached' });
  check('UI fichiers: "Rip rapide" masqué en mode fichiers', !(await page.isVisible('#fast-rip-label')));
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
  // Mode par défaut à l'ouverture = 'cut' (Montage, ordre logique d'utilisation) depuis le
  // 19 juil 2026 — #btn-auto-cue appartient au panneau du mode 'cue', il faut y basculer.
  await page.click('.mode-tab[data-mode="cue"]');
  await page.waitForSelector('#btn-auto-cue', { timeout: 5000 });
  await page.click('#btn-auto-cue');
  await sleep(1500);
  check('UI fichiers: bouton détection auto sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));

  // Zoom : slider (glissé continu, remplace les boutons ➕/➖ le 19 juil 2026) — 376 ≈
  // niveau 4 (mapping exponentiel ZOOM_MIN=1..ZOOM_MAX=40 sur 0..1000, cf. app.js).
  await page.$eval('#zoom-slider', el => { el.value = '376'; el.dispatchEvent(new Event('input')); });
  let zl = await page.textContent('#zoom-level');
  check('UI fichiers: zoom ~×4 (slider)', /^×4(\.\d+)?$/.test(zl.trim()), zl);
  await page.click('#btn-zoom-reset');
  zl = await page.textContent('#zoom-level');
  check('UI fichiers: zoom reset ×1', zl.trim() === '×1', zl);

  // Éditeur unifié (v1.7) : bascule entre les 4 modes sans erreur JS, panneaux rendus
  await page.click('.mode-tab[data-mode="jingle"]');
  await page.waitForSelector('#btn-overlay-add', { timeout: 5000 });
  // Étiquettes du mode cue points (DÉBUT/INTRO/TRANSITION) masquées en mode jingle — sinon
  // leur hitbox élargie interceptait le drag de la zone jingle (signalé : "on ne peut plus
  // rien attraper" en changeant de mode).
  check('UI fichiers: étiquette DÉBUT masquée en mode jingle', !(await page.isVisible('#waveform [part~="cue-in"]')));
  check('UI fichiers: étiquette INTRO masquée en mode jingle', !(await page.isVisible('#waveform [part~="intro-end"]')));
  check('UI fichiers: étiquette TRANSITION masquée en mode jingle', !(await page.isVisible('#waveform [part~="cue-out"]')));
  // "Détecter les silences" (mode cue points) n'a pas de sens en mode jingle — le mode
  // jingle a son propre bouton adaptatif ("Proposer depuis la voix détectée" ci-dessous).
  check('UI fichiers: bouton détection silences absent en mode jingle', !(await page.isVisible('#btn-auto-cue')));
  // L'analyse vocale n'est PLUS déclenchée automatiquement à l'ouverture de l'onglet
  // (signalé : se lançait seule sans que l'utilisateur l'ait demandé) — le bouton "Analyser
  // la voix" doit être immédiatement disponible, sans bannière de chargement ni round-trip.
  check('UI fichiers: pas d\'analyse auto à l\'ouverture du mode jingle', !(await page.isVisible('.vocal-loading-banner')));
  check('UI fichiers: bouton "Analyser la voix" visible (déclenchement manuel)', await page.isVisible('#btn-vocal-analyze'));
  await page.click('#btn-vocal-analyze');
  // Attendre la fin de l'analyse vocale à la demande (le panneau se re-rend à la fin —
  // cliquer pendant l'analyse risquerait un élément détaché)
  await page.waitForFunction(() => {
    const p = document.getElementById('mode-panel');
    return p && !p.textContent.includes('Analyse de la voix en cours');
  }, { timeout: 20000 });
  // Le bouton ne doit PLUS disparaître après analyse (signalé 19 juil 2026 : impossible de
  // changer de précision et de relancer sur la même piste) — il se renomme "Relancer
  // l'analyse" et reste cliquable, y compris après suppression de la zone.
  check('UI fichiers: bouton devient "Relancer l\'analyse" après analyse',
    (await page.textContent('#btn-vocal-analyze') || '').includes('Relancer'));
  // Pas de waitForSelector sur la bannière elle-même : l'analyse "fast" sur cette petite
  // fixture est parfois assez rapide pour que la bannière apparaisse ET disparaisse entre le
  // clic et le premier sondage du selector (race), cf. waitForFunction ci-dessous qui couvre
  // le même signal de façon robuste (fin d'analyse, peu importe la vitesse).
  await page.click('#btn-vocal-analyze');
  await page.waitForFunction(() => {
    const p = document.getElementById('mode-panel');
    return p && !p.textContent.includes('Analyse de la voix en cours');
  }, { timeout: 20000 });
  check('UI fichiers: "Relancer l\'analyse" relance bien une analyse', true);
  check('UI fichiers: bouton "Relancer l\'analyse" toujours présent après relance',
    (await page.textContent('#btn-vocal-analyze') || '').includes('Relancer'));
  // Sinus continu = aucune zone sans voix attendue → pose manuelle de la zone
  await page.click('#btn-overlay-add');
  const overlayInfo = await page.textContent('#overlay-info');
  check('UI fichiers: mode jingle, zone posée manuellement', overlayInfo.includes('Zone :'), overlayInfo);
  await page.click('#btn-overlay-remove');
  check('UI fichiers: zone jingle retirée', (await page.textContent('#overlay-info')).includes('Aucune zone'));
  await page.click('.mode-tab[data-mode="cut"]');
  await page.waitForSelector('#cut-list', { timeout: 5000 });
  check('UI fichiers: mode montage, liste vide', (await page.textContent('#cut-list')).includes('Aucune coupe'));
  check('UI fichiers: bouton détection silences absent en mode montage', !(await page.isVisible('#btn-auto-cue')));

  // Aperçu du montage à la lecture (signalé : ne pas couper à l'aveugle) — coupe de 3s à
  // 5s sur une piste de 10s, seek à 2.5s, lecture : le curseur doit sauter directement à la
  // fin de la coupe en l'atteignant, pas y rester/s'y arrêter.
  const waveBox = await page.locator('#waveform').boundingBox();
  const cutX1 = waveBox.x + waveBox.width * 0.30, cutX2 = waveBox.x + waveBox.width * 0.50;
  const cutY = waveBox.y + waveBox.height * 0.5;
  await page.mouse.move(cutX1, cutY);
  await page.mouse.down();
  await page.mouse.move(cutX2, cutY, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  check('UI fichiers: coupe créée (drag-selection)', !(await page.textContent('#cut-list')).includes('Aucune coupe'));
  await page.$eval('#waveform audio', el => { el.currentTime = 2.5; });
  await page.click('#btn-playpause');
  await sleep(2500);
  const timeAfterCut = await page.$eval('#waveform audio', el => el.currentTime);
  await page.click('#btn-stop');
  console.log(`      (info) coupe≈[3s,5s], seek=2.5s, après 2.5s de lecture: ${timeAfterCut.toFixed(2)}s`);
  check('UI fichiers: aperçu montage — le curseur a sauté hors de la zone de coupe', timeAfterCut < 3 || timeAfterCut >= 5, `${timeAfterCut.toFixed(2)}s`);
  check('UI fichiers: aperçu montage sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));
  // Nettoyage : retirer la coupe créée pour ne pas perturber les vérifs suivantes (compteur
  // "0" attendu par mode-panel plus loin n'existe pas ici, mais reset() est plus sûr).
  await page.click('#btn-reset');
  await page.click('.mode-tab[data-mode="volume"]');
  await page.waitForSelector('#vol-slider', { timeout: 5000 });
  check('UI fichiers: bouton détection silences absent en mode volume', !(await page.isVisible('#btn-auto-cue')));

  // ---- Bouton Normaliser (-14 LUFS) — PLAN-NORMALIZE-EDITEURS.md volet 1 ----
  // Fixture "Nice Song.wav" = sinus 440Hz 10s, mesuré ffmpeg ebur128 = -21.8 LUFS,
  // peak -21.1 dBFS → gain attendu = -14-(-21.8) = +7.8 dB, cap anti-crête (+20.1 dB)
  // non atteint. Bloc isolé : restaure le tool volume à l'état d'avant (slider -6.0,
  // vérifié plus loin ligne ~257) via #btn-reset avant de continuer le flux existant.
  check('UI fichiers: bouton Normaliser visible en mode volume', await page.isVisible('#btn-normalize'));
  const waveformSignatureApp = () => page.evaluate(() => {
    // wavesurfer rend dans un shadow DOM (élément custom) — querySelector natif ne le
    // traverse pas (contrairement aux locators Playwright, ex. page.$eval('#waveform audio')
    // utilisés plus haut) : il faut passer explicitement par .shadowRoot, comme côté site.
    const host = document.querySelector('#waveform > div');
    const canvas = host?.shadowRoot?.querySelector('canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum;
  });
  const sigBeforeNorm = await waveformSignatureApp();
  await page.click('#btn-normalize');
  await sleep(200);
  const normFeedback = await page.textContent('#normalize-feedback');
  console.log(`      (info) ${normFeedback}`);
  check('UI fichiers: clic Normaliser affiche mesure/gain', /Mesuré/.test(normFeedback), normFeedback);
  const gainMatch = normFeedback.match(/Gain\s*:\s*([+-][\d.]+)\s*dB/);
  const gainShown = gainMatch ? parseFloat(gainMatch[1]) : null;
  check('UI fichiers: gain Normaliser cohérent (sinus plein volume -21.8 LUFS -> cible -14)',
    gainShown !== null && Math.abs(gainShown - 7.8) <= 1.5, String(gainShown));
  check('UI fichiers: #vol-value cohérent avec le gain calculé',
    gainShown !== null && (await page.textContent('#vol-value')).includes(gainShown.toFixed(1)));
  const sigAfterNorm = await waveformSignatureApp();
  check('UI fichiers: waveform redessinée après clic Normaliser (échelle réelle x gain)',
    sigBeforeNorm !== null && sigAfterNorm !== null && sigBeforeNorm !== sigAfterNorm,
    `avant=${sigBeforeNorm} après=${sigAfterNorm}`);

  // Réinitialiser (scopé volume) remet le gain à 0 ET restaure l'affichage waveform
  await page.click('#btn-reset');
  const volAfterNormReset = await page.textContent('#vol-value');
  check('UI fichiers: Réinitialiser (scopé volume) remet le gain à 0', volAfterNormReset.includes('0.0'), volAfterNormReset);
  const sigAfterReset = await waveformSignatureApp();
  check('UI fichiers: waveform restaurée après Réinitialiser', sigAfterReset !== sigAfterNorm,
    `après-normalize=${sigAfterNorm} après-reset=${sigAfterReset}`);
  check('UI fichiers: Normaliser sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));

  await page.$eval('#vol-slider', el => { el.value = '-6'; el.dispatchEvent(new Event('input')); });
  check('UI fichiers: mode volume, -6.0 dB affiché', (await page.textContent('#vol-value')).includes('-6.0'));
  // Courbe d'automation (v1.9) : zoom verrouillé + clic sur la ligne → point ajouté
  check('UI fichiers: zoom verrouillé en mode volume', await page.$eval('#zoom-slider', el => el.disabled));
  // La zone de frappe est une <line> SVG (bounding box de hauteur nulle → « hidden » pour
  // Playwright) : clic aux coordonnées de la ligne 0 dB (y = 12/72 de la hauteur de l'overlay).
  await page.waitForSelector('.vol-overlay', { state: 'attached', timeout: 5000 });
  const volBox = await page.locator('.vol-overlay').boundingBox();
  await page.mouse.click(volBox.x + volBox.width * 0.5, volBox.y + volBox.height * (12 / 72));
  const volPoints = await page.locator('.vol-point').count();
  check('UI fichiers: point de volume ajouté au clic', volPoints === 1, String(volPoints));
  check('UI fichiers: compteur de points affiché', (await page.textContent('#mode-panel')).includes('1'));

  // Poignées de fondu draggables « façon Pro Tools » (parité site) : glisser la poignée
  // depuis le coin haut-gauche doit régler fadeInMs (champ #fade-in-s synchronisé en direct).
  await page.waitForSelector('.fade-overlay', { state: 'attached', timeout: 5000 });
  const fadeInBefore = Number(await page.$eval('#fade-in-s', el => el.value));
  // scrollIntoViewIfNeeded : page.mouse.move/down/up (contrairement à locator.click()) ne
  // scrolle pas automatiquement la cible dans le viewport — la poignée peut se retrouver
  // hors écran (y négatif) selon la hauteur cumulée des étapes précédentes, faisant
  // atterrir le mousedown dans le vide (signalé 19 juil 2026, après le passage du zoom en
  // slider qui a légèrement changé la hauteur de la barre de contrôles).
  await page.locator('.fade-svg').scrollIntoViewIfNeeded();
  const fadeSvgBox = await page.locator('.fade-svg').boundingBox();
  await page.mouse.move(fadeSvgBox.x, fadeSvgBox.y);
  await page.mouse.down();
  await page.mouse.move(fadeSvgBox.x + fadeSvgBox.width * 0.2, fadeSvgBox.y, { steps: 10 });
  await page.mouse.up();
  const fadeInAfter = Number(await page.$eval('#fade-in-s', el => el.value));
  check('UI fichiers: poignée de fondu d\'entrée modifie #fade-in-s', fadeInAfter > fadeInBefore, `${fadeInBefore} → ${fadeInAfter}`);
  check('UI fichiers: poignées de fondu sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));
  // Couleur distincte de la waveform (signalé : poignées invisibles, noyées dans les barres
  // bleues #4a90e2 avant ce fix — cf. .fade-handle de style.css).
  const fadeHandleColor = await page.locator('.fade-handle').first().evaluate(el => getComputedStyle(el).fill);
  check('UI fichiers: poignée de fondu visible (couleur ≠ waveform)', fadeHandleColor !== 'rgb(74, 144, 226)', fadeHandleColor);

  // Aperçu AUDIO du fondu (pas seulement visuel) : lecture depuis le début, dans la zone de
  // fondu, doit être audiblement atténuée — sinon on règle "à l'aveugle" (bug signalé, même
  // correction que côté site : cf. useDestructiveEdit.ts::fadeGainAtTime).
  await page.fill('#fade-in-s', '5');
  await page.$eval('#fade-in-s', el => el.dispatchEvent(new Event('change')));
  await page.evaluate(() => { const a = document.querySelector('#waveform audio'); if (a) a.currentTime = 0; });
  await page.click('#btn-playpause');
  await sleep(600);
  const fadeVolAtStart = await page.$eval('#waveform audio', el => el.volume);
  console.log(`      (info) volume audio ~0.6s après lecture (fondu 5s sur piste 10s) = ${fadeVolAtStart.toFixed(3)}`);
  check('UI fichiers: fondu d\'entrée audible (volume atténué en début de lecture)', fadeVolAtStart < 0.7, String(fadeVolAtStart));
  await page.click('#btn-stop');
  await sleep(200);
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'import-studio-fade-handles-debug.png') });

  await page.click('.mode-tab[data-mode="cue"]');
  check('UI fichiers: modes sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));

  // Parité v1.8 : marqueur INTRO + saisie numérique des cue points
  const introMarkers = await page.locator('#waveform [part~="intro-end"]').count();
  check('UI fichiers: marqueur INTRO présent', introMarkers === 1, String(introMarkers));
  await page.fill('#inp-cuein', '1.5');
  await page.dispatchEvent('#inp-cuein', 'change');
  const sumCueIn = await page.textContent('#sum-cuein');
  check('UI fichiers: saisie numérique Début → résumé', sumCueIn.trim() === '00:01.500', sumCueIn);
  await page.fill('#inp-intro', '3');
  await page.dispatchEvent('#inp-intro', 'change');
  const sumIntro = await page.textContent('#sum-intro');
  check('UI fichiers: saisie numérique Intro → résumé', sumIntro.trim() === '00:03.000', sumIntro);
  // Raccourci clavier O : pose TRANSITION à la position de lecture (0 → clampé à cueIn+0.1).
  // Blur d'abord : le focus est resté dans #inp-intro et les raccourcis sont (par design)
  // ignorés pendant la saisie dans un champ.
  await page.locator('#inp-intro').blur();
  await page.keyboard.press('KeyO');
  const sumCueOutShortcut = await page.textContent('#sum-cueout');
  check('UI fichiers: raccourci O pose TRANSITION', sumCueOutShortcut.trim() !== '00:00.000', sumCueOutShortcut);

  // "Tout réinitialiser" (bug historique: resetToFull inexistant, corrigé) — scopé à l'outil
  // actif (mode cue points ici, signalé) : le libellé du bouton s'adapte, et le reset ne
  // touche PAS le volume/fondu réglés plus haut en mode Volume & fondus.
  const resetLabel = await page.textContent('#btn-reset');
  check('UI fichiers: libellé "Tout réinitialiser" adapté au mode cue points', /cue points/i.test(resetLabel), resetLabel);
  await page.click('#btn-reset');
  check('UI fichiers: reset marqueurs sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));
  const sumCueInAfterReset = await page.textContent('#sum-cuein');
  check('UI fichiers: reset (mode cue) remet Début à zéro', sumCueInAfterReset.trim() === '00:00.000', sumCueInAfterReset);
  await page.click('.mode-tab[data-mode="volume"]');
  const volAfterReset = await page.textContent('#vol-value');
  check('UI fichiers: reset (mode cue) ne touche pas le volume réglé dans un autre mode', volAfterReset.includes('-6.0'), volAfterReset);
  await page.click('.mode-tab[data-mode="cue"]');

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

  // ---- Navigation "Précédent" (2 fichiers) : signalé, on ne pouvait pas revenir en
  // arrière après "Valider et continuer" — les cue points déjà confirmés doivent être
  // restaurés, pas remis à l'état par défaut. ----
  await page.click('#btn-new-files');
  await page.waitForSelector('#files-input', { timeout: 5000, state: 'attached' });
  await page.setInputFiles('#files-input', [
    path.join(SCRATCH, '.tmp', 'fixtures', 'Artist One - Nice Song.wav'),
    path.join(SCRATCH, '.tmp', 'fixtures', 'padded.wav'),
  ]);
  await page.waitForSelector('#btn-confirm-file', { timeout: 15000 });
  check('UI fichiers: pas de bouton Précédent sur le 1er fichier', !(await page.isVisible('#btn-prev-file')));
  // Attendre que la waveform (wavesurfer) soit prête avant de saisir/valider — sinon
  // collectEditPayload()/wavesurfer.getDuration() lit une durée pas encore décodée.
  await page.waitForFunction(() => {
    const b = document.getElementById('sum-bpm')?.textContent;
    return b && b !== '…';
  }, { timeout: 30000 });
  // Mode par défaut = 'cut' (Montage) depuis le 19 juil 2026 — #inp-cuein appartient au
  // panneau du mode 'cue', il faut y basculer avant de le remplir.
  await page.click('.mode-tab[data-mode="cue"]');
  await page.waitForSelector('#inp-cuein', { timeout: 5000 });
  await page.fill('#inp-cuein', '1.5');
  await page.dispatchEvent('#inp-cuein', 'change');
  await page.click('#btn-confirm-file');
  await page.waitForFunction(() => document.querySelector('.card-header')?.textContent.includes('2 / 2'), { timeout: 15000 });
  const header2 = await page.textContent('.card-header');
  check('UI fichiers: passage au 2e fichier', header2.includes('2 / 2'), header2);
  check('UI fichiers: bouton Précédent visible sur le 2e fichier', await page.isVisible('#btn-prev-file'));
  await page.click('#btn-prev-file');
  await page.waitForFunction(() => document.querySelector('.card-header')?.textContent.includes('1 / 2'), { timeout: 15000 });
  const header1 = await page.textContent('.card-header');
  check('UI fichiers: retour au 1er fichier', header1.includes('1 / 2'), header1);
  // La restauration (applyStoredCuePoints) se fait dans le callback onReady de wavesurfer
  // (décodage waveform, asynchrone) — attendre que #sum-cuein s'écarte du texte statique
  // par défaut du template (00:00.000) plutôt que l'état de #sum-bpm (qui reste "—" aussi
  // bien avant qu'après une analyse BPM infructueuse sur cette fixture : faux positif).
  await page.waitForFunction(() => document.getElementById('sum-cuein')?.textContent.trim() !== '00:00.000', { timeout: 15000 });
  const sumCueInRestored = await page.textContent('#sum-cuein');
  check('UI fichiers: Précédent restaure le cue point déjà confirmé (pas remis à 00:00.000)',
    sumCueInRestored.trim() === '00:01.500', sumCueInRestored);
  check('UI: navigation Précédent sans erreur JS', pageErrors.length === 0, pageErrors.join(' ; '));

  // Erreurs JS globales sur tout le parcours
  check('UI: aucune erreur JS sur tout le parcours', pageErrors.length === 0, pageErrors.join(' ; '));

  await browser.close();
  console.log(`\nUI: ${pass} ok, ${fail} échec(s)`);
  if (failures.length) console.log('Échecs: ' + failures.join(' | '));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
