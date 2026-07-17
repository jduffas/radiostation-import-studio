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
  detectEnergyFromMean, probeLocalDurationSeconds, normalizeEditPayload, buildEditFilter,
  editNeedsFullPass, applyAudioEdit, buildVolumeExpr };\n`;
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

  // ---- _parseAstats / _computeVocalZones (v3 : sous-bandes low/high, fenêtres 250ms,
  //      appel en fallback sans le signal arnndn : vocOutput=null) ----
  // 50 fenêtres de 250ms sur 12,5s :
  //   fenêtres 8-19  (2000-5000ms) : calmes (-45/-51) → zone kind=quiet (critère binaire)
  //   fenêtres 26-37 (6500-9500ms) : pont brillant plein volume, tilt inversé (-26/-16)
  //                                  → PAS calme, zone kind=bridge (hystérésis + binaire)
  //   ailleurs : « voix » (-20/-26, tilt +6)
  let astatsLow = '', astatsHigh = '';
  for (let i = 0; i < 50; i++) {
    const t = (i * 0.25).toFixed(2);
    let lo = -20, hi = -26;
    if (i >= 8 && i <= 19) { lo = -45; hi = -51; }
    if (i >= 26 && i <= 37) { lo = -26; hi = -16; }
    astatsLow += `frame:${i} pts:${i * 12000} pts_time:${t}\nlavfi.astats.Overall.RMS_level=${lo}.000000\n`;
    astatsHigh += `frame:${i} pts:${i * 12000} pts_time:${t}\nlavfi.astats.Overall.RMS_level=${hi}.000000\n`;
  }
  const wins = M._parseAstats(astatsLow);
  check('astats: 50 fenêtres parsées', wins.length === 50, String(wins.length));
  const zones = M._computeVocalZones(astatsLow, astatsHigh, null, 12500);
  check('vocalZones: 2 zones détectées', zones.length === 2, JSON.stringify(zones));
  const zQuiet = zones.find(z => z.kind === 'quiet');
  const zBridge = zones.find(z => z.kind === 'bridge');
  check('vocalZones: zone calme ≈ 2000-5000ms', !!zQuiet && Math.abs(zQuiet.start_ms - 2000) <= 250 && Math.abs(zQuiet.end_ms - 5000) <= 250, JSON.stringify(zQuiet));
  check('vocalZones: pont tilt ≈ 6500-9500ms', !!zBridge && Math.abs(zBridge.start_ms - 6500) <= 250 && Math.abs(zBridge.end_ms - 9500) <= 250, JSON.stringify(zBridge));
  check('vocalZones: -inf géré', M._parseAstats('pts_time:0.0\nlavfi.astats.Overall.RMS_level=-inf\n')[0].rms_db === -90);

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

  // ---- Éditeur unifié v1.7 : normalizeEditPayload / buildEditFilter / editNeedsFullPass ----
  check('editNeedsFullPass: trim simple → false', M.editNeedsFullPass({ start_ms: 1500, end_ms: 6500 }) === false);
  check('editNeedsFullPass: cuts/volume/fades → true',
    M.editNeedsFullPass({ cuts: [{ start_ms: 1, end_ms: 2 }] }) && M.editNeedsFullPass({ volume_db: -3 })
    && M.editNeedsFullPass({ fade_in_ms: 500 }) && M.editNeedsFullPass({ fade_out_ms: 500 }));

  // Complément des coupes : [1000..9000] moins [2000..3000]+[2500..4000] (chevauchement fusionné)
  const ne = M.normalizeEditPayload({
    start_ms: 1000, end_ms: 9000,
    cuts: [{ start_ms: 2500, end_ms: 4000 }, { start_ms: 2000, end_ms: 3000 }],
    volume_db: -50, fade_in_ms: 500, fade_in_curve: 'qsin', fade_out_ms: 999999, fade_out_curve: 'hackerz',
  }, 10000);
  check('normalize: plages conservées = [1000-2000, 4000-9000]',
    ne.keepRanges.length === 2 && ne.keepRanges[0].startMs === 1000 && ne.keepRanges[0].endMs === 2000
    && ne.keepRanges[1].startMs === 4000 && ne.keepRanges[1].endMs === 9000, JSON.stringify(ne.keepRanges));
  check('normalize: durée conservée 6000ms', ne.keptDurationMs === 6000, String(ne.keptDurationMs));
  check('normalize: volume clampé à -24dB', ne.volumeDb === -24, String(ne.volumeDb));
  check('normalize: fade_out clampé 30s + courbe inconnue → tri',
    ne.fadeOutMs === 30000 && ne.fadeOutCurve === 'tri' && ne.fadeInCurve === 'qsin', JSON.stringify(ne));
  check('normalize: needsFull true', ne.needsFull === true);
  check('normalize: end_ms null → durée totale',
    M.normalizeEditPayload({ start_ms: 0 }, 10000).keepRanges[0].endMs === 10000);
  check('normalize: tout coupé → erreur', (() => {
    try { M.normalizeEditPayload({ cuts: [{ start_ms: 0, end_ms: 10000 }] }, 10000); return false; }
    catch { return true; }
  })());

  const f1 = M.buildEditFilter(M.normalizeEditPayload({ start_ms: 1500, end_ms: 6500 }, 10000));
  check('buildEditFilter: plage unique sans effet → atrim direct vers [out]',
    f1 === '[0:a]atrim=start=1.500:end=6.500,asetpts=PTS-STARTPTS[out]', f1);
  const f2 = M.buildEditFilter(ne);
  check('buildEditFilter: multi-plages → asplit + concat',
    f2.includes('asplit=2[in0][in1]') && f2.includes('concat=n=2:v=0:a=1[cat]'), f2);
  check('buildEditFilter: volume + afades avec courbes sur [cat]',
    f2.includes('[cat]volume=-24.00dB') && f2.includes('afade=t=in:st=0:d=0.500:curve=qsin')
    && f2.includes('afade=t=out:st=0.000:d=30.000:curve=tri') && f2.endsWith('[out]'), f2);
  const f3 = M.buildEditFilter(M.normalizeEditPayload({ volume_db: 6, fade_out_ms: 2000, fade_out_curve: 'log' }, 10000));
  check('buildEditFilter: plage unique + effets enchaînés',
    f3.includes('volume=6.00dB') && f3.includes('afade=t=out:st=8.000:d=2.000:curve=log'), f3);

  // ---- Courbe d'automation de volume (v1.9) : buildVolumeExpr + normalisation ----
  check('volumeExpr: aucun point → 1.0', M.buildVolumeExpr([]) === '1.0');
  check('volumeExpr: point unique -6dB → gain constant',
    M.buildVolumeExpr([{ timeMs: 3000, db: -6 }]) === (10 ** (-6 / 20)).toFixed(6));
  const expr2 = M.buildVolumeExpr([{ timeMs: 0, db: 0 }, { timeMs: 2000, db: -12 }]);
  check('volumeExpr: 2 points → if imbriqués + pente',
    expr2.startsWith('if(lt(t,0.000),1.000000,') && expr2.includes('if(lt(t,2.000),(1.000000+') && expr2.endsWith(')'), expr2);
  const nv = M.normalizeEditPayload({ volume_points: [
    { time_ms: 5000, db: -100 }, { time_ms: 1000, db: 50 }, { time_ms: 1000.4, db: 0 },
  ] }, 10000);
  check('normalize: points triés/clampés/fusionnés (<1ms)',
    nv.volumePoints.length === 2 && nv.volumePoints[0].timeMs === 1000 && nv.volumePoints[0].db === 12
    && nv.volumePoints[1].db === -60 && nv.needsFull === true, JSON.stringify(nv.volumePoints));

  // applyAudioEdit ffmpeg réel : courbe constante -6dB → mean_volume baisse d'≈6 dB
  const measureMean = (f) => {
    const r = require('node:child_process').spawnSync(
      'ffmpeg', ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '');
    return m ? parseFloat(m[1]) : null;
  };
  const tmpWav4 = path.join(__dirname, '.tmp', 'volcurve.wav');
  fs.copyFileSync(path.join(FIX, 'Artist One - Nice Song.wav'), tmpWav4);
  const meanBefore = measureMean(tmpWav4);
  await M.applyAudioEdit(tmpWav4, { volume_points: [{ time_ms: 0, db: -6 }] });
  const meanAfter = measureMean(tmpWav4);
  check('applyAudioEdit: courbe -6dB → mean_volume -6 dB (±1)',
    meanBefore !== null && meanAfter !== null && Math.abs((meanBefore - meanAfter) - 6) < 1,
    `avant=${meanBefore} après=${meanAfter}`);

  // applyAudioEdit ffmpeg réel : 10s, coupe interne 2s→4s + fondus → 8s
  const tmpWav3 = path.join(__dirname, '.tmp', 'edittest.wav');
  fs.copyFileSync(path.join(FIX, 'Artist One - Nice Song.wav'), tmpWav3);
  await M.applyAudioEdit(tmpWav3, {
    cuts: [{ start_ms: 2000, end_ms: 4000 }],
    volume_db: -6, fade_in_ms: 500, fade_out_ms: 500, fade_in_curve: 'qsin', fade_out_curve: 'exp',
  });
  const dur3 = await M.probeLocalDurationSeconds(tmpWav3);
  check('applyAudioEdit: coupe interne 2s sur 10s = 8s', dur3 !== null && Math.abs(dur3 - 8.0) < 0.1, String(dur3));

  console.log(`\nUNIT: ${pass} ok, ${fail} échec(s)`);
  if (failures.length) console.log('Échecs: ' + failures.join(' | '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
