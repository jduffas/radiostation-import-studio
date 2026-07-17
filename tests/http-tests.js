// Tests d'intégration HTTP contre le vrai main.js (spawné en sandbox) + stub backend.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRATCH = __dirname;
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 19947;
const STUB_PORT = 8901;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const FIX = path.join(SCRATCH, '.tmp', 'fixtures');
const HOME = path.join(SCRATCH, '.tmp', 'home');
const TMP = path.join(SCRATCH, '.tmp', 'tmp');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUp(url, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(url); return true; } catch { await sleep(150); }
  }
  return false;
}

async function j(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* vide */ }
  return { status: res.status, body, headers: res.headers };
}

(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(path.join(HOME, '.radiostation-import-studio'), { recursive: true, force: true });
  fs.rmSync(path.join(HOME, '.radiostation-cd-ripper'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'radiostation-import-studio'), { recursive: true, force: true });

  const stub = spawn('node', [path.join(SCRATCH, 'stub-backend.js')], { stdio: 'inherit', env: { ...process.env, STUB_PORT: String(STUB_PORT) } });
  const srv = spawn('node', ['main.js'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT: String(PORT), HOME, TMPDIR: TMP },
  });
  const cleanup = () => { try { srv.kill(); } catch {} try { stub.kill(); } catch {} };
  process.on('exit', cleanup);

  if (!await waitUp(`${BASE}/settings`) || !await waitUp(`${STUB}/_last`)) {
    console.error('serveurs non démarrés'); process.exit(2);
  }

  // ── Statique / page locale ──
  let r = await fetch(`${BASE}/`);
  const html = await r.text();
  check('GET / → index.html', r.status === 200 && html.includes('app'), String(r.status));
  r = await fetch(`${BASE}/local-ui/app.js`);
  check('GET /local-ui/app.js → 200 JS', r.status === 200 && (r.headers.get('content-type') || '').includes('javascript'));
  r = await fetch(`${BASE}/local-ui/vendor/wavesurfer.esm.js`);
  check('GET vendor wavesurfer → 200', r.status === 200);
  // Traversée de répertoire
  r = await fetch(`${BASE}/local-ui/..%2Fmain.js`);
  check('traversée ..%2F → 404', r.status === 404, String(r.status));
  const rawReq = await new Promise(resolve => {
    // fetch normalise ../ — requête brute pour tester le serveur lui-même
    const net = require('node:net');
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`GET /local-ui/../main.js HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let d = '';
    sock.on('data', c => { d += c; });
    sock.on('end', () => resolve(d));
    sock.on('error', () => resolve(''));
  });
  check('traversée brute ../main.js → pas de fuite', !rawReq.includes('SETTINGS_DIR') && (rawReq.startsWith('HTTP/1.1 404') || rawReq.startsWith('HTTP/1.1 200')), rawReq.slice(0, 40));

  // ── CORS ──
  r = await fetch(`${BASE}/settings`, { headers: { Origin: 'https://evil.com' } });
  check('CORS: evil.com → 403', r.status === 403, String(r.status));
  r = await fetch(`${BASE}/settings`, { headers: { Origin: 'http://192.168.1.50:3000' } });
  check('CORS: LAN → 200 + ACAO', r.status === 200 && r.headers.get('access-control-allow-origin') === 'http://192.168.1.50:3000');
  r = await fetch(`${BASE}/settings`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
  check('CORS: preflight OPTIONS → 204', r.status === 204, String(r.status));

  // ── Settings ──
  let s = await j(`${BASE}/settings`);
  check('GET /settings défauts', s.status === 200 && s.body.vocal_analysis_enabled === false && s.body.fast_rip_enabled === false, JSON.stringify(s.body));
  s = await j(`${BASE}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vocal_analysis_enabled: 'yes', ignored_key: 123 }) });
  check('POST /settings coercition bool + clé inconnue ignorée', s.body.vocal_analysis_enabled === true && s.body.ignored_key === undefined, JSON.stringify(s.body));
  s = await j(`${BASE}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vocal_analysis_level: 'precise_eco' }) });
  check('POST /settings niveau analyse accepté', s.body.vocal_analysis_level === 'precise_eco', JSON.stringify(s.body));
  s = await j(`${BASE}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vocal_analysis_level: 'turbo' }) });
  check('POST /settings niveau invalide ignoré', s.body.vocal_analysis_level === 'precise_eco', JSON.stringify(s.body));
  // Retour à 'fast' : les tests d'analyse vocale de la suite doivent rester sur le moteur rapide
  s = await j(`${BASE}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vocal_analysis_level: 'fast' }) });
  check('POST /settings retour niveau fast', s.body.vocal_analysis_level === 'fast', JSON.stringify(s.body));
  const settingsFile = path.join(HOME, '.radiostation-import-studio', 'settings.json');
  check('settings.json persisté en sandbox', fs.existsSync(settingsFile));
  // repli legacy : settings dans l'ancien dossier lus si le nouveau est absent
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(path.join(HOME, '.radiostation-import-studio'), { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.radiostation-cd-ripper'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.radiostation-cd-ripper', 'settings.json'), JSON.stringify({ device_token: 'legacy-tok', server_url: 'http://old' }));
  s = await j(`${BASE}/settings`);
  check('repli legacy .radiostation-cd-ripper lu', s.body.device_token === 'legacy-tok', JSON.stringify(s.body));

  // ── /import non appairé vs appairé ──
  fs.rmSync(path.join(HOME, '.radiostation-cd-ripper'), { recursive: true, force: true });
  s = await j(`${BASE}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('/import non appairé → 401', s.status === 401, JSON.stringify(s));
  await j(`${BASE}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_url: STUB, device_token: 'tok-123' }) });
  s = await j(`${BASE}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 'f1', title: 'T' }) });
  check('/import appairé → 200 proxy', s.status === 200 && s.body.track_id === 4242, JSON.stringify(s));
  let last = (await j(`${STUB}/_last`)).body;
  const lastImport = last[last.length - 1];
  check('/import: Bearer device_token transmis', lastImport.auth === 'Bearer tok-123', JSON.stringify(lastImport.auth));
  check('/import: payload transmis intact', lastImport.payload.file_id === 'f1' && lastImport.payload.title === 'T');
  await j(`${STUB}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'fail' }) });
  s = await j(`${BASE}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 'f1' }) });
  check('/import: erreur backend → 502 + detail', s.status === 502 && s.body.error === 'import refusé (stub)', JSON.stringify(s));
  await j(`${STUB}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'ok' }) });

  // ── /files/upload ──
  const wavBuf = fs.readFileSync(path.join(FIX, 'Artist One - Nice Song.wav'));
  const mkFd = (name, buf) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), name);
    return fd;
  };
  s = await j(`${BASE}/files/upload`, { method: 'POST', body: mkFd('Artist One - Nice Song.wav', wavBuf) });
  check('/files/upload → file_id + durée 10s', s.status === 200 && s.body.file_id && Math.abs(s.body.duration_seconds - 10) < 0.1, JSON.stringify(s.body));
  check('/files/upload: titre/artiste devinés', s.body.title === 'Nice Song' && s.body.artist === 'Artist One', JSON.stringify(s.body));
  const fid = s.body.file_id;
  s = await j(`${BASE}/files/upload`, { method: 'POST', body: (() => { const fd = new FormData(); fd.append('autre', 'x'); return fd; })() });
  check('/files/upload sans champ file → 400', s.status === 400, JSON.stringify(s));

  // ── /files/preview ──
  r = await fetch(`${BASE}/files/preview/${fid}`);
  const previewBytes = Buffer.from(await r.arrayBuffer());
  check('/files/preview → octets complets', r.status === 200 && previewBytes.length === wavBuf.length, `${previewBytes.length} vs ${wavBuf.length}`);
  r = await fetch(`${BASE}/files/preview/inexistant`);
  check('/files/preview inconnu → 404', r.status === 404);

  // ── /files/convert ──
  s = await j(`${BASE}/files/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fid, format: 'flac' }) });
  check('/files/convert flac → done', s.status === 200 && s.body.status === 'done', JSON.stringify(s));
  r = await fetch(`${BASE}/files/preview/${fid}`);
  check('/files/preview après convert → flac servi', r.status === 200 && (r.headers.get('content-type') || '') === 'audio/flac', r.headers.get('content-type'));
  s = await j(`${BASE}/files/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fid, format: 'mp3' }) });
  check('/files/convert format invalide → 400', s.status === 400, JSON.stringify(s));
  s = await j(`${BASE}/files/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 'nope', format: 'flac' }) });
  check('/files/convert file_id inconnu → 404', s.status === 404);
  s = await j(`${BASE}/files/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fid, format: 'original' }) });
  check('/files/convert retour original', s.status === 200 && s.body.status === 'done');

  // ── /files/trim (sur l'original, positions absolues) ──
  s = await j(`${BASE}/files/trim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fid, start_ms: 1500, end_ms: 6500 }) });
  check('/files/trim 1.5→6.5s → 5.0s', s.status === 200 && Math.abs(s.body.duration_seconds - 5.0) < 0.1, JSON.stringify(s.body));
  s = await j(`${BASE}/files/trim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 'nope', start_ms: 0 }) });
  check('/files/trim inconnu → 404', s.status === 404);

  // ── /files/trim en mode édition complète (éditeur unifié v1.7) : coupe interne +
  // volume + fondus en une passe filter_complex — 10s moins [2s..4s] = 8s ──
  s = await j(`${BASE}/files/upload`, { method: 'POST', body: mkFd('Edit Me - Full Edit.wav', wavBuf) });
  const fidEdit = s.body.file_id;
  s = await j(`${BASE}/files/trim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: fidEdit, start_ms: 0, end_ms: null,
      cuts: [{ start_ms: 2000, end_ms: 4000 }],
      volume_db: -6, fade_in_ms: 500, fade_in_curve: 'qsin', fade_out_ms: 500, fade_out_curve: 'exp',
    }),
  });
  check('/files/trim montage+volume+fondus → 8.0s', s.status === 200 && Math.abs(s.body.duration_seconds - 8.0) < 0.1, JSON.stringify(s.body));
  s = await j(`${BASE}/files/trim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fidEdit, cuts: [{ start_ms: 0, end_ms: 60000 }] }),
  });
  check('/files/trim tout coupé → 500 explicite', s.status === 500 && /conservé/i.test(s.body.error || ''), JSON.stringify(s));

  // ── /files/trim avec courbe de volume seule (v1.9) : durée inchangée ──
  s = await j(`${BASE}/files/upload`, { method: 'POST', body: mkFd('Vol Curve - Test.wav', wavBuf) });
  const fidVol = s.body.file_id;
  s = await j(`${BASE}/files/trim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fidVol, volume_points: [{ time_ms: 0, db: 0 }, { time_ms: 8000, db: -24 }] }),
  });
  check('/files/trim courbe de volume seule → durée inchangée 10s', s.status === 200 && Math.abs(s.body.duration_seconds - 10) < 0.1, JSON.stringify(s.body));

  // ── /files/analyze-vocal (zones sans voix, à la demande) ──
  s = await j(`${BASE}/files/analyze-vocal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fidEdit }) });
  check('/files/analyze-vocal → tableau zones', s.status === 200 && Array.isArray(s.body.zones), JSON.stringify(s.body));
  s = await j(`${BASE}/files/analyze-vocal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: 'nope' }) });
  check('/files/analyze-vocal inconnu → 404', s.status === 404);

  // ── /files/detect-cue sur fichier avec 2s de silence en tête, 1.5s en queue ──
  const paddedBuf = fs.readFileSync(path.join(FIX, 'padded.wav'));
  s = await j(`${BASE}/files/upload`, { method: 'POST', body: mkFd('padded.wav', paddedBuf) });
  const fidPad = s.body.file_id;
  s = await j(`${BASE}/files/detect-cue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fidPad }) });
  check('/files/detect-cue: intro ≈2s outro ≈1.5s', s.status === 200 && Math.abs(s.body.intro_seconds - 2) < 0.3 && Math.abs(s.body.outro_seconds - 1.5) < 0.3, JSON.stringify(s.body));

  // ── /files/analyze-loudness ──
  s = await j(`${BASE}/files/analyze-loudness`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fidPad, cue_in_seconds: 2 }) });
  check('/files/analyze-loudness: valeurs plausibles', s.status === 200 && s.body.loudness_lufs != null && s.body.loudness_lufs >= -60 && s.body.loudness_lufs <= 0
    && s.body.energy >= 1 && s.body.energy <= 5 && ['fade', 'cold', 'sustain'].includes(s.body.end_type) && ['hit', 'build', 'ambient'].includes(s.body.start_type), JSON.stringify(s.body));

  // ── /files/finish : échec réseau → fichiers conservés, retry OK ──
  await j(`${STUB}/_reset`, { method: 'POST', body: '{}' });
  await j(`${STUB}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'fail' }) });
  const items = [
    { file_id: fid, title: 'Nice Song', artist: 'Artist One', album: 'Alb', year: 2020 },
    { file_id: fidPad, title: 'Padded', artist: 'A2', album: '', year: null },
  ];
  s = await j(`${BASE}/files/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  check('/files/finish backend down → 502', s.status === 502, JSON.stringify(s));
  r = await fetch(`${BASE}/files/preview/${fid}`);
  check('/files/finish échec → fichiers conservés', r.status === 200, String(r.status));
  await j(`${STUB}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'ok' }) });
  s = await j(`${BASE}/files/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  check('/files/finish retry → 200 + 2 file_ids', s.status === 200 && (s.body.file_ids || []).length === 2, JSON.stringify(s.body));
  last = (await j(`${STUB}/_last`)).body;
  const up = last.find(x => x.url === '/api/importer/upload-with-metadata' && x.mode === 'ok');
  check('/files/finish: multipart 2 fichiers + metadata', up && up.fileCount === 2 && Array.isArray(up.metadata) && up.metadata[0].title === 'Nice Song', JSON.stringify(up && { fileCount: up.fileCount, metadata: up.metadata }));
  check('/files/finish: Bearer token transmis', up && up.auth === 'Bearer tok-123', up && up.auth);
  check('/files/finish: nom de fichier basé titre + ext', up && up.filenames[0] === 'Nice Song.wav', up && JSON.stringify(up.filenames));
  await sleep(300); // nettoyage post-réponse
  r = await fetch(`${BASE}/files/preview/${fid}`);
  check('/files/finish succès → fichiers nettoyés', r.status === 404, String(r.status));
  s = await j(`${BASE}/files/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  check('/files/finish re-POST après succès → 400', s.status === 400, JSON.stringify(s));
  s = await j(`${BASE}/files/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }) });
  check('/files/finish items vide → 400', s.status === 400);

  // ── /files/finish : désalignement index si un file_id est inconnu ──
  s = await j(`${BASE}/files/upload`, { method: 'POST', body: mkFd('B - Song B.wav', wavBuf) });
  const fidB = s.body.file_id;
  await j(`${STUB}/_reset`, { method: 'POST', body: '{}' });
  s = await j(`${BASE}/files/finish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [ { file_id: 'disparu', title: 'Fantôme' }, { file_id: fidB, title: 'Song B', artist: 'B' } ] }),
  });
  // Le client (finishFilesUpload) mappe file_ids[i] → items[i] : la réponse doit rester
  // alignée sur items, avec null aux positions skippées (fix du 16 juil 2026).
  check('/files/finish avec id inconnu: réponse alignée [null, id]',
    s.body.file_ids?.length === 2 && s.body.file_ids[0] === null && typeof s.body.file_ids[1] === 'string',
    JSON.stringify(s.body));
  check('/files/finish avec id inconnu: metadata alignée aussi',
    s.body.files_metadata?.length === 2 && s.body.files_metadata[0] === null && s.body.files_metadata[1]?.title === 'Song B',
    JSON.stringify(s.body.files_metadata));

  // ── Machine à états rip (sans CD) ──
  s = await j(`${BASE}/rip/status`);
  check('/rip/status initial idle', s.status === 200 && s.body.status === 'idle', JSON.stringify(s.body));
  s = await j(`${BASE}/status`);
  check('/status: pas de CD détecté', s.status === 200 && s.body.ok === true && s.body.cdDetected === false, JSON.stringify(s.body));
  s = await j(`${BASE}/trim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track_number: 1, start_ms: 0 }) });
  check('/trim sans rip en attente → 409', s.status === 409);
  s = await j(`${BASE}/rip/confirm`, { method: 'POST' });
  check('/rip/confirm sans rip → 409', s.status === 409);
  s = await j(`${BASE}/rip/retry-upload`, { method: 'POST' });
  check('/rip/retry-upload sans échec → 409', s.status === 409);
  r = await fetch(`${BASE}/rip-preview/1`);
  check('/rip-preview sans rip → 404', r.status === 404);

  // POST /rip sans CD → passe en erreur proprement (avec overrides de métadonnées : ne doit pas planter)
  s = await j(`${BASE}/rip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend_url: STUB, auth_token: 'tok-123', track_numbers: [1, 2], tracks: [{ number: 1, title: 'Titre édité', artist: 'Artiste édité' }, { number: 'x' }] }) });
  check('POST /rip accepté (started)', s.status === 200 && s.body.status === 'started', JSON.stringify(s.body));
  let ripSt = null;
  for (let i = 0; i < 40; i++) { await sleep(500); ripSt = (await j(`${BASE}/rip/status`)).body; if (ripSt.status === 'error' || ripSt.status === 'trimming') break; }
  check('/rip sans CD → status error explicite', ripSt.status === 'error' && /disque/i.test(ripSt.error || ''), JSON.stringify(ripSt));

  // double POST /rip très rapprochés : le 2e doit être refusé (409) — course connue ?
  await sleep(200);
  const [r1, r2] = await Promise.all([
    j(`${BASE}/rip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    j(`${BASE}/rip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  ]);
  const codes = [r1.status, r2.status].sort().join(',');
  check('[connu] double POST /rip simultané: un seul accepté ?', codes === '200,409', codes);

  // ── /update-check (réseau GitHub réel — informatif) ──
  s = await j(`${BASE}/update-check`);
  check('/update-check répond', s.status === 200 && 'update_available' in s.body, JSON.stringify(s.body));

  // ── 404 générique ──
  s = await j(`${BASE}/nimporte-quoi`);
  check('route inconnue → 404', s.status === 404);

  console.log(`\nHTTP: ${pass} ok, ${fail} échec(s)`);
  if (failures.length) console.log('Échecs: ' + failures.join(' | '));
  cleanup();
  process.exit(0);
})().catch(e => { console.error('ERREUR FATALE', e); process.exit(2); });
