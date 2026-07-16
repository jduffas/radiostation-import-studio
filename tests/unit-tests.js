// Tests unitaires des fonctions pures de main.js (module patché : listen désactivé + exports).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = require('node:path').resolve(__dirname, '..', 'main.js');
const OUT = path.join(__dirname, '.tmp', 'main_testable.js');
const FIX = path.join(__dirname, '.tmp', 'fixtures');

let src = fs.readFileSync(SRC, 'utf8');
if (!src.includes("server.listen(PORT, '127.0.0.1'")) throw new Error('patch point listen introuvable');
src = src.replace("server.listen(PORT, '127.0.0.1'", "if (process.env.RS_TEST_LISTEN) server.listen(PORT, '127.0.0.1'");
src += `\nmodule.exports = { parseToc, computeMbDiscId, isVersionNewer, parseFilenameTitleArtist,
  _parseAstats, _computeVocalZones, isAllowedOrigin, parseMultipart, trimWavFile, msfToLba,
  detectEnergyFromMean, probeLocalDurationSeconds };\n`;
fs.writeFileSync(OUT, src);

const M = require(OUT);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  // ---- parseToc (sortie cdparanoia -Q réaliste) ----
  const cdparanoiaOut = `cdparanoia III release 10.2
Table of contents (audio tracks only):
track        length               begin        copy pre ch
===========================================================
  1.    15213 [03:22.63]        0 [00:00.00]    no   no  2
  2.    16951 [03:46.01]    15213 [03:22.63]    no   no  2
  3.    14278 [03:10.28]    32164 [07:08.64]    no   no  2
TOTAL   46442 [10:19.17]    (audio only)
`;
  const toc = M.parseToc(cdparanoiaOut);
  check('parseToc: 3 pistes', toc.tracks.length === 3, JSON.stringify(toc));
  check('parseToc: offsets', toc.tracks[0].offset === 0 && toc.tracks[1].offset === 15213 && toc.tracks[2].offset === 32164);
  check('parseToc: leadout', toc.leadout === 46442, String(toc.leadout));

  // ---- computeMbDiscId (exemple officiel musicbrainz.org/doc/Disc_ID_Calculation) ----
  // Offsets absolus doc: 150,15363,32314,46592,63414,80489 leadout 95462 → ID 49HHV7Eb8UKF3aQiNmu1GR8vKTY-
  // main.js stocke des offsets RELATIFS (piste1=0) et ajoute 150 lui-même.
  const mbToc = {
    tracks: [0, 15213, 32164, 46442, 63264, 80339].map((o, i) => ({ number: i + 1, offset: o })),
    leadout: 95312,
  };
  const discId = M.computeMbDiscId(mbToc);
  check('computeMbDiscId: exemple officiel MB', discId === '49HHV7Eb8UKF3aQiNmu1GR8vKTY-', discId);
  check('computeMbDiscId: toc vide → null', M.computeMbDiscId({ tracks: [], leadout: 0 }) === null);

  // ---- isVersionNewer ----
  check('version: 1.6.10 > 1.6.9', M.isVersionNewer('1.6.10', '1.6.9') === true);
  check('version: 1.6.2 !> 1.6.2', M.isVersionNewer('1.6.2', '1.6.2') === false);
  check('version: v2.0.0 > 1.9.9', M.isVersionNewer('v2.0.0', '1.9.9') === true);
  check('version: 1.6 !> 1.6.0', M.isVersionNewer('1.6', '1.6.0') === false);
  check('version: 1.0.0 > dev', M.isVersionNewer('1.0.0', 'dev') === true);

  // ---- parseFilenameTitleArtist ----
  let p = M.parseFilenameTitleArtist('Artist One - Nice Song.wav');
  check('filename: "A - T"', p.artist === 'Artist One' && p.title === 'Nice Song', JSON.stringify(p));
  p = M.parseFilenameTitleArtist('Artist_Title.mp3');
  check('filename: "A_T"', p.artist === 'Artist' && p.title === 'Title', JSON.stringify(p));
  p = M.parseFilenameTitleArtist('JustATitle.flac');
  check('filename: titre seul', p.artist === '' && p.title === 'JustATitle', JSON.stringify(p));
  p = M.parseFilenameTitleArtist('My_File With Space.wav');
  check('filename: underscore+espace → pas de split', p.title === 'My_File With Space', JSON.stringify(p));

  // ---- isAllowedOrigin ----
  check('origin: absent → true', M.isAllowedOrigin(undefined) === true);
  check('origin: localhost:3000', M.isAllowedOrigin('http://localhost:3000') === true);
  check('origin: 127.0.0.1:19847', M.isAllowedOrigin('http://127.0.0.1:19847') === true);
  check('origin: 192.168.1.50:3000', M.isAllowedOrigin('http://192.168.1.50:3000') === true);
  check('origin: 10.0.0.5', M.isAllowedOrigin('http://10.0.0.5') === true);
  check('origin: 172.16.0.1', M.isAllowedOrigin('http://172.16.0.1') === true);
  check('origin: 172.31.255.1', M.isAllowedOrigin('http://172.31.255.1') === true);
  check('origin: 172.15.0.1 → false', M.isAllowedOrigin('http://172.15.0.1') === false);
  check('origin: 172.32.0.1 → false', M.isAllowedOrigin('http://172.32.0.1') === false);
  check('origin: evil.com → false', M.isAllowedOrigin('https://evil.com') === false);
  check('origin: sous-domaine trompeur → false', M.isAllowedOrigin('https://192.168.1.50.evil.com') === false);
  check('origin: garbage → false', M.isAllowedOrigin('not-a-url') === false);

  // ---- parseMultipart (payload navigateur avec binaire contenant \r\n) ----
  const boundary = '----WebKitFormBoundaryAbc123';
  const binData = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x0d, 0x0a, 0x00, 0xff, 0x0d, 0x0a]), Buffer.from('data')]);
  const mp = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Mon Fichier.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    binData,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}--\r\n`),
  ]);
  const parts = M.parseMultipart(mp, `multipart/form-data; boundary=${boundary}`);
  check('multipart: 2 parties', parts.length === 2, String(parts.length));
  const fpart = parts.find(x => x.name === 'file');
  check('multipart: filename', fpart?.filename === 'Mon Fichier.wav');
  check('multipart: binaire intact (CRLF interne)', fpart && Buffer.compare(fpart.data, binData) === 0,
    fpart ? `${fpart.data.length} vs ${binData.length}` : 'part absente');
  check('multipart: champ texte', parts.find(x => x.name === 'note')?.data.toString() === 'hello');
  check('multipart: boundary manquant → []', M.parseMultipart(Buffer.from('x'), 'text/plain').length === 0);

  // ---- _parseAstats / _computeVocalZones ----
  // 20 fenêtres de 500ms : actives à -20dB sauf fenêtres 4-9 (2000-4500ms) calmes à -45dB
  let astats = '';
  for (let i = 0; i < 20; i++) {
    const t = (i * 0.5).toFixed(2);
    const rms = (i >= 4 && i <= 9) ? -45 : -20;
    astats += `frame:${i} pts:${i * 22050} pts_time:${t}\nlavfi.astats.Overall.RMS_level=${rms}.000000\n`;
  }
  const wins = M._parseAstats(astats);
  check('astats: 20 fenêtres parsées', wins.length === 20, String(wins.length));
  const zones = M._computeVocalZones(astats, 10000);
  check('vocalZones: 1 zone détectée', zones.length === 1, JSON.stringify(zones));
  check('vocalZones: zone ≈ 2000-5000ms', zones.length === 1 && zones[0].start_ms === 2000 && zones[0].end_ms === 5000, JSON.stringify(zones[0]));
  check('vocalZones: -inf géré', M._parseAstats('pts_time:0.0\nlavfi.astats.Overall.RMS_level=-inf\n')[0].rms_db === -60);

  // ---- detectEnergyFromMean ----
  check('energy: -5→5, -10→4, -16→3, -22→2, -30→1, null→null',
    M.detectEnergyFromMean(-5) === 5 && M.detectEnergyFromMean(-10) === 4 && M.detectEnergyFromMean(-16) === 3 &&
    M.detectEnergyFromMean(-22) === 2 && M.detectEnergyFromMean(-30) === 1 && M.detectEnergyFromMean(null) === null);

  // ---- trimWavFile (ffmpeg réel) : positions absolues 1.5s→6.5s sur 10s → 5.0s ----
  const tmpWav = path.join(__dirname, '.tmp', 'trimtest.wav');
  fs.copyFileSync(path.join(FIX, 'Artist One - Nice Song.wav'), tmpWav);
  await M.trimWavFile(tmpWav, 1500, 6500);
  const dur = await M.probeLocalDurationSeconds(tmpWav);
  check('trimWavFile: 1.5→6.5s sur 10s = 5.0s', dur !== null && Math.abs(dur - 5.0) < 0.1, String(dur));

  // trim start seul (endMs null) : coupe 2s de tête → 8s
  const tmpWav2 = path.join(__dirname, '.tmp', 'trimtest2.wav');
  fs.copyFileSync(path.join(FIX, 'Artist One - Nice Song.wav'), tmpWav2);
  await M.trimWavFile(tmpWav2, 2000, null);
  const dur2 = await M.probeLocalDurationSeconds(tmpWav2);
  check('trimWavFile: start seul 2s → 8s', dur2 !== null && Math.abs(dur2 - 8.0) < 0.1, String(dur2));

  // ---- msfToLba ----
  check('msfToLba: 03:22.63', M.msfToLba(3, 22, 63) === 15213);

  console.log(`\nUNIT: ${pass} ok, ${fail} échec(s)`);
  if (failures.length) console.log('Échecs: ' + failures.join(' | '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
