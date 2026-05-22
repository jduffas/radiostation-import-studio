'use strict';

/**
 * RadioStation CD Ripper — serveur HTTP local (port 19847)
 *
 * Fonctionne de deux façons :
 *   - `node main.js`          → standalone, utilise ffmpeg du système
 *   - Lancé par Electron      → utilise ffmpeg bundlé (ffmpeg-static)
 *
 * Dépendances système (mode standalone uniquement) :
 *   ffmpeg + ffprobe   → détection pistes & rip (toutes plateformes)
 *   cdparanoia         → rip haute qualité sur Linux (optionnel)
 */

const http = require('node:http');
const https = require('node:https');
const { exec, execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { URL } = require('node:url');

const PORT = parseInt(process.env.PORT || '19847', 10);
const PLATFORM = process.platform; // 'linux' | 'darwin' | 'win32'
const TMP_DIR = path.join(os.tmpdir(), 'radiostation-cd-ripper');

// ============================================================
// Résolution des chemins ffmpeg/ffprobe
// Priorité : ffmpeg-static (bundlé Electron) > système
// ============================================================

/**
 * Dans une app Electron packagée, les binaires natifs sont dans app.asar.unpacked/.
 * On corrige le chemin retourné par ffmpeg-static qui pointe vers app.asar/.
 */
function fixAsarPath(p) {
  if (!p) return p;
  return p.replace(
    /app\.asar([/\\])/,
    'app.asar.unpacked$1'
  );
}

let FFMPEG = 'ffmpeg';
let FFPROBE = 'ffprobe';
let BUNDLED_FFMPEG = false;

try {
  const raw = require('ffmpeg-static');
  FFMPEG = fixAsarPath(raw) || 'ffmpeg';
  BUNDLED_FFMPEG = FFMPEG !== 'ffmpeg';
} catch { /* utilise ffmpeg système */ }

try {
  const raw = require('ffprobe-static').path;
  FFPROBE = fixAsarPath(raw) || 'ffprobe';
} catch { /* utilise ffprobe système */ }

// ============================================================
// État du rip en cours
// ============================================================

let ripState = {
  status: 'idle', // idle | detecting | ripping | uploading | done | error
  totalTracks: 0,
  currentTrack: 0,
  progress: 0,
  fileIds: [],
  filesMetadata: [],
  mbMetadata: null,
  error: null,
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Détection du périphérique CD
// ============================================================

function detectWindowsCdDrive() {
  try {
    const out = execSync(
      'wmic logicaldisk where drivetype=5 get deviceid /value',
      { timeout: 5000, encoding: 'utf8' }
    );
    const match = out.match(/DeviceID=([A-Z]:)/i);
    if (match) return match[1];
  } catch { /* ignore */ }
  return 'D:';
}

function getCdDevice() {
  if (process.env.CD_DEVICE) return process.env.CD_DEVICE;
  if (PLATFORM === 'win32') return detectWindowsCdDrive();
  return '';
}

function cdInputArg(trackNum) {
  const device = getCdDevice();
  return device ? `cdda://${trackNum}?device=${device}` : `cdda://${trackNum}`;
}

// ============================================================
// macOS — volume monté (évite cdda:// qui déclenche Music)
// ============================================================
// Quand un CD audio est inséré sur macOS il se monte dans /Volumes/
// avec des fichiers .cdda. afconvert (outil natif) les convertit en WAV.

function findMacosCdVolume() {
  try {
    const vols = fs.readdirSync('/Volumes');
    for (const vol of vols) {
      const volPath = path.join('/Volumes', vol);
      try {
        const files = fs.readdirSync(volPath);
        const trackFiles = files
          .filter(f => f.toLowerCase().endsWith('.cdda'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (trackFiles.length > 0) return { volumePath: volPath, trackFiles };
      } catch { /* volume non lisible */ }
    }
  } catch { /* /Volumes inaccessible */ }
  return null;
}

function ripTrackAfconvert(trackFilePath, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', trackFilePath, outPath]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(`afconvert exit ${code}: ${stderr.slice(-200)}`));
    });
  });
}

// ============================================================
// Lecture TOC via cdparanoia (Linux sans Electron bundlé)
// ============================================================

function parseToc(output) {
  const tracks = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s+(\d+)\.\s+\d+\s+\[\d+:\d+\.\d+\]\s+(\d+)/);
    if (m) {
      tracks.push({ number: parseInt(m[1], 10), offset: parseInt(m[2], 10) });
    }
  }
  const tm = output.match(/TOTAL\s+(\d+)/);
  return { tracks, leadout: tm ? parseInt(tm[1], 10) : 0 };
}

function getTocCdparanoia() {
  return new Promise(resolve => {
    exec('cdparanoia -Q 2>&1', { timeout: 15000 }, (_err, out) => {
      resolve(parseToc(out || ''));
    });
  });
}

// MSF (MM:SS.FF avec point) → secteurs LBA absolu
function msfToLba(mm, ss, ff) { return (mm * 60 + ss) * 75 + ff; }

// Lecture TOC via drutil (macOS natif)
// Format observé macOS 14/15 : "    Session  1, Track  1:      00:03.00  2ch audio..."
//                               "    Lead-out:                  32:18.03"
// Formats anciens (≤12) aussi supportés via F1/F2/F3.
function getTocDrutil() {
  return new Promise(resolve => {
    exec('drutil toc 2>&1', { timeout: 10000 }, (_err, out) => {
      const text = out || '';
      const tracks = [];
      let leadout = 0;

      // drutil donne des positions absolues (piste 1 = secteur 150 = 00:02.00).
      // computeMbDiscId() attend des positions relatives (cdparanoia : piste 1 = 0).
      // On soustrait 150 pour aligner les deux représentations.
      const toRelative = abs => Math.max(0, abs - 150);

      for (const line of text.split('\n')) {
        // Format macOS 14/15 : "Session N, Track N:      MM:SS.FF ..."
        const fS = line.match(/Session\s+\d+,\s+Track\s+(\d+):\s+(\d+):(\d+)\.(\d+)/i);
        if (fS) {
          tracks.push({ number: parseInt(fS[1], 10), offset: toRelative(msfToLba(+fS[2], +fS[3], +fS[4])) });
          continue;
        }
        // Leadout macOS 14/15 : "Lead-out:      MM:SS.FF"
        const lfS = line.match(/[Ll]ead.?[Oo]ut:\s+(\d+):(\d+)\.(\d+)/);
        if (lfS) { leadout = toRelative(msfToLba(+lfS[1], +lfS[2], +lfS[3])); continue; }

        // F1 (≤12) : "1.  Type: ...  Start: 00:02:00 (150 sectors)" — positions absolues aussi
        const f1 = line.match(/^\s*(\d+)\.\s+.*Start:\s+[\d:]+\s+\(\s*(\d+)\s+sectors?\)/i);
        if (f1) { tracks.push({ number: +f1[1], offset: toRelative(+f1[2]) }); continue; }
        // F2 (≤12) : "1.  Type: ...  LBA: 150 ..."
        const f2 = line.match(/^\s*(\d+)\.\s+.*LBA:\s*(\d+)/i);
        if (f2) { tracks.push({ number: +f2[1], offset: toRelative(+f2[2]) }); continue; }

        // Leadout F1/F2
        const lf1 = line.match(/leadout.*Start:\s+[\d:]+\s+\(\s*(\d+)\s+sectors?\)/i);
        if (lf1) { leadout = toRelative(+lf1[1]); continue; }
        const lf2 = line.match(/leadout.*LBA:\s*(\d+)/i);
        if (lf2) { leadout = toRelative(+lf2[1]); }
      }

      resolve({ tracks, leadout });
    });
  });
}

// Périphérique CD macOS depuis drutil status ("Name: /dev/disk30" → "/dev/rdisk30")
// drutil écrit sur stderr → 2>&1 obligatoire. Ne pas mettre en cache null.
let _macosDeviceCache = { ts: 0, device: null };
function getMacosCdDevice() {
  if (_macosDeviceCache.device && Date.now() - _macosDeviceCache.ts < 30000)
    return _macosDeviceCache.device;
  let device = null;
  try {
    const out = execSync('drutil status 2>&1', { timeout: 5000, encoding: 'utf8' });
    const m = out.match(/Name:\s*(\/dev\/disk\d+)/);
    if (m) device = m[1].replace('/dev/disk', '/dev/rdisk');
  } catch { /* ignore */ }
  if (device) _macosDeviceCache = { ts: Date.now(), device };
  return device;
}

// Rip via dd + ffmpeg (offsets secteurs depuis TOC — pas de cdda://, pas de Music)
// ffmpeg bundlé n'a pas libcdio → cdda:// = "Protocol not found"
function ripTrackDd(device, startSector, sectorCount, outPath) {
  return new Promise((resolve, reject) => {
    const dd = spawn('dd', [`if=${device}`, 'bs=2352', `skip=${startSector}`, `count=${sectorCount}`]);
    // CDDA = PCM 16-bit little-endian (s16le), 44100Hz stéréo — s16be produit un bruit permanent
    const ff = spawn(FFMPEG, ['-y', '-f', 's16le', '-ar', '44100', '-ac', '2',
                               '-i', 'pipe:0', '-f', 'wav', outPath]);
    dd.stdout.pipe(ff.stdin);
    dd.on('error', err => { try { ff.stdin.destroy(); } catch {} reject(err); });
    let ffStderr = '';
    ff.stderr.on('data', d => { ffStderr += d; });
    ff.on('close', code => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(`dd|ffmpeg exit ${code}: ${ffStderr.slice(-300)}`));
    });
  });
}

// Détection CD macOS — volume monté en priorité, drutil en fallback
function checkCdMacos() {
  const cd = findMacosCdVolume();
  if (cd) return Promise.resolve({ cdDetected: true, trackCount: cd.trackFiles.length });

  return new Promise(resolve => {
    exec('drutil status 2>&1', { timeout: 8000 }, (_err, out) => {
      const text = out || '';
      if (/no media|no disc|empty|aucun/i.test(text) || !text.trim()) {
        return resolve({ cdDetected: false, trackCount: 0 });
      }
      const m = text.match(/(?:Number of )?[Tt]racks:\s*(\d+)/);
      const count = m ? parseInt(m[1], 10) : 1;
      resolve({ cdDetected: true, trackCount: count });
    });
  });
}

// ============================================================
// Lecture TOC via ffprobe (cross-platform, bundlé ou système)
// ============================================================

function probeTrackFfprobe(trackNum) {
  return new Promise(resolve => {
    const input = cdInputArg(trackNum);
    exec(
      `"${FFPROBE}" -v quiet -of json -show_entries format=duration -i "${input}"`,
      { timeout: 20000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const d = JSON.parse(stdout);
          const dur = parseFloat(d.format?.duration);
          resolve(isNaN(dur) || dur <= 0 ? null : dur);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function getTocFfprobe() {
  const tracks = [];
  let cumulativeOffset = 0;

  for (let i = 1; i <= 99; i++) {
    const duration = await probeTrackFfprobe(i);
    if (duration === null) break;
    tracks.push({ number: i, offset: cumulativeOffset, durationSeconds: duration });
    cumulativeOffset += Math.round(duration * 75);
  }

  return { tracks, leadout: cumulativeOffset };
}

// Ferme Music avant tout accès CD sur macOS — ffprobe cdda:// déclenche Music
function quitMusicIfRunning() {
  if (PLATFORM !== 'darwin') return Promise.resolve();
  return new Promise(resolve => {
    exec(
      "osascript -e 'tell application \"Music\" to if running then quit'",
      { timeout: 5000 },
      () => resolve()
    );
  });
}

async function getToc() {
  // cdparanoia sur Linux standalone (offsets exacts = meilleur disc ID)
  if (PLATFORM === 'linux' && !BUNDLED_FFMPEG) {
    const toc = await getTocCdparanoia();
    if (toc.tracks.length > 0) return toc;
  }

  if (PLATFORM === 'darwin') {
    // 1. drutil toc — offsets exacts pour le disc ID MusicBrainz
    const toc = await getTocDrutil();
    if (toc.tracks.length > 0) return toc;

    // 2. Volume monté — compte les pistes depuis /Volumes (pas de cdda://)
    const cd = findMacosCdVolume();
    if (cd && cd.trackFiles.length > 0) {
      // Offsets synthétiques (relatifs, comme cdparanoia) — disc ID approximatif
      const tracks = cd.trackFiles.map((_, i) => ({ number: i + 1, offset: i * 18000 }));
      return { tracks, leadout: tracks[tracks.length - 1].offset + 18000 };
    }

    // Jamais de ffprobe sur darwin — cdda:// déclenche l'ouverture de Music
    return { tracks: [], leadout: 0 };
  }

  return getTocFfprobe();
}

let _cdStatusCache = { ts: 0, data: null };

async function checkCd() {
  if (Date.now() - _cdStatusCache.ts < 8000 && _cdStatusCache.data) {
    return _cdStatusCache.data;
  }

  let result;

  if (PLATFORM === 'linux' && !BUNDLED_FFMPEG) {
    const toc = await getTocCdparanoia();
    if (toc.tracks.length > 0) {
      result = { cdDetected: true, trackCount: toc.tracks.length };
    }
  }

  if (!result && PLATFORM === 'darwin') {
    result = await checkCdMacos();
  }

  // Sur darwin : ne pas utiliser ffprobe (cdda:// déclenche l'ouverture de Music)
  if (!result && PLATFORM !== 'darwin') {
    const dur = await probeTrackFfprobe(1);
    if (!dur) {
      result = { cdDetected: false, trackCount: 0 };
    } else {
      let count = 1;
      for (let i = 2; i <= 99; i++) {
        if (await probeTrackFfprobe(i) === null) break;
        count++;
      }
      result = { cdDetected: true, trackCount: count };
    }
  }

  if (!result) result = { cdDetected: false, trackCount: 0 };

  _cdStatusCache = { ts: Date.now(), data: result };
  return result;
}

// ============================================================
// Calcul du Disc ID MusicBrainz
// ============================================================

function computeMbDiscId(toc) {
  if (!toc.tracks.length) return null;

  const first = 1;
  const last = toc.tracks.length;
  const leadOut = toc.leadout + 150;

  let s = first.toString(16).toUpperCase().padStart(2, '0')
         + last.toString(16).toUpperCase().padStart(2, '0')
         + leadOut.toString(16).toUpperCase().padStart(8, '0');

  for (let i = 0; i < 99; i++) {
    const off = i < toc.tracks.length ? toc.tracks[i].offset + 150 : 0;
    s += off.toString(16).toUpperCase().padStart(8, '0');
  }

  return crypto.createHash('sha1')
    .update(s, 'ascii')
    .digest('base64')
    .replace(/\+/g, '.')
    .replace(/\//g, '_')
    .replace(/=/g, '-');
}

// ============================================================
// Lookup MusicBrainz
// ============================================================

let _lastMbReq = 0;

async function mbGet(apiPath) {
  const wait = 1200 - (Date.now() - _lastMbReq);
  if (wait > 0) await sleep(wait);
  _lastMbReq = Date.now();

  return new Promise(resolve => {
    const opts = {
      hostname: 'musicbrainz.org',
      path: `/ws/2${apiPath}`,
      headers: {
        'User-Agent': 'RadioStation-CDRipper/1.0 (cd-ripper@radiostation.local)',
        'Accept': 'application/json',
      },
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function lookupMb(discId) {
  if (!discId) return null;
  try {
    const data = await mbGet(`/discid/${discId}?inc=recordings+artists&fmt=json`);
    if (!data || !data.releases?.length) return null;

    const rel = data.releases[0];
    const albumArtist = rel['artist-credit']?.[0]?.artist?.name || '';
    const albumTitle = rel.title || '';
    const year = rel.date ? parseInt(rel.date.substring(0, 4), 10) : null;

    const tracks = (rel.media?.[0]?.tracks || []).map((t, i) => ({
      number: i + 1,
      title: t.recording?.title || t.title || `Track ${i + 1}`,
      artist: t.recording?.['artist-credit']?.[0]?.artist?.name || albumArtist,
      album: albumTitle,
      year,
      isrc: t.recording?.isrcs?.[0] || null,
      mbid: t.recording?.id || null,
    }));

    return { albumArtist, albumTitle, year, tracks };
  } catch {
    return null;
  }
}

// ============================================================
// Rip des pistes
// ============================================================

function ripTrackCdparanoia(trackNum, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('cdparanoia', [String(trackNum), outPath]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(`cdparanoia exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

function ripTrackFfmpeg(trackNum, outPath) {
  return new Promise((resolve, reject) => {
    const input = cdInputArg(trackNum);
    const args = ['-y', '-i', input, '-f', 'wav', outPath];
    const proc = spawn(FFMPEG, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

async function ripTrack(trackNum, outPath, toc = null) {
  if (PLATFORM === 'darwin') {
    // Essai 1 : volume monté /Volumes (afconvert, pas de cdda://)
    const cd = findMacosCdVolume();
    if (cd) {
      const trackFile = cd.trackFiles[trackNum - 1];
      if (trackFile) {
        try { return await ripTrackAfconvert(path.join(cd.volumePath, trackFile), outPath); }
        catch { /* essai suivant */ }
      }
    }
    // Essai 2 : dd + ffmpeg depuis /dev/rdiskN avec offsets TOC (pas de cdda://)
    const device = getMacosCdDevice();
    if (device && toc && toc.tracks.length > 0) {
      const track = toc.tracks[trackNum - 1];
      const next  = toc.tracks[trackNum]; // index = trackNum (1-based → idx trackNum)
      if (track) {
        // offset stocké en relatif (cdparanoia-compatible) → absolu pour dd
        const start = track.offset + 150;
        const count = (next ? next.offset : toc.leadout) - track.offset;
        if (count > 0) {
          try { return await ripTrackDd(device, start, count, outPath); }
          catch { /* essai suivant */ }
        }
      }
    }
    throw new Error(`Impossible de lire la piste ${trackNum} — device: ${device || 'non trouvé'}`);
  }

  // ffmpeg bundlé (Windows Electron) → toujours ffmpeg
  if (BUNDLED_FFMPEG) return ripTrackFfmpeg(trackNum, outPath);

  // Linux standalone → cdparanoia avec fallback ffmpeg
  if (PLATFORM === 'linux') {
    try {
      return await ripTrackCdparanoia(trackNum, outPath);
    } catch (e) {
      if (e.message.includes('exit 127') || e.message.includes('not found')) {
        return ripTrackFfmpeg(trackNum, outPath);
      }
      throw e;
    }
  }

  return ripTrackFfmpeg(trackNum, outPath);
}

// ============================================================
// Upload vers le backend RadioStation
// ============================================================

function buildMultipart(files, metadataJson) {
  const boundary = `RipBound${Date.now()}`;
  const parts = [];

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="metadata"\r\n\r\n` +
    `${metadataJson}\r\n`
  ));

  for (const { name, filePath } of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${name}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    ));
    parts.push(fs.readFileSync(filePath));
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function uploadToBackend(backendUrl, authToken, files, metaArr) {
  const { body, contentType } = buildMultipart(files, JSON.stringify(metaArr));
  return new Promise((resolve, reject) => {
    const u = new URL('/api/importer/upload-with-metadata', backendUrl);
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(d)); } catch { resolve({}); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// Cache TOC — lu une fois et réutilisé pour le rip
// ============================================================

let _tocCache = null; // { toc, mbData, discId, fetchedAt }

async function getTocWithMb() {
  if (_tocCache && Date.now() - _tocCache.fetchedAt < 120000) return _tocCache;
  await quitMusicIfRunning();
  const toc = await getToc();
  if (!toc.tracks.length) return null;
  const discId = computeMbDiscId(toc);
  const mbData = await lookupMb(discId);
  _tocCache = { toc, mbData, discId, fetchedAt: Date.now() };
  return _tocCache;
}

// ============================================================
// Workflow principal
// ============================================================

async function doRip(backendUrl, authToken, trackNumbers = null) {
  await quitMusicIfRunning();

  ripState = {
    status: 'detecting',
    totalTracks: 0, currentTrack: 0, progress: 0,
    fileIds: [], filesMetadata: [], mbMetadata: null, error: null,
  };

  _cdStatusCache = { ts: 0, data: null };

  const rippedPaths = [];

  try {
    let toc, mbData;
    if (_tocCache && Date.now() - _tocCache.fetchedAt < 300000) {
      toc = _tocCache.toc;
      mbData = _tocCache.mbData;
    } else {
      toc = await getToc();
      if (!toc.tracks.length) throw new Error('Aucun disque audio détecté dans le lecteur');
      const discId = computeMbDiscId(toc);
      mbData = await lookupMb(discId);
      _tocCache = { toc, mbData, discId: discId, fetchedAt: Date.now() };
    }

    // Filtrer les pistes si une sélection est fournie
    const tracksToRip = trackNumbers && trackNumbers.length > 0
      ? toc.tracks.filter(t => trackNumbers.includes(t.number))
      : toc.tracks;

    if (!tracksToRip.length) throw new Error('Aucune piste sélectionnée');
    ripState.totalTracks = tracksToRip.length;

    fs.mkdirSync(TMP_DIR, { recursive: true });

    ripState.status = 'ripping';
    const files = [];

    for (let i = 0; i < tracksToRip.length; i++) {
      ripState.currentTrack = i + 1;
      ripState.progress = Math.round((i / tracksToRip.length) * 70);

      const tnum = tracksToRip[i].number;
      const fname = `track${String(tnum).padStart(2, '0')}.wav`;
      const fpath = path.join(TMP_DIR, fname);

      await ripTrack(tnum, fpath, toc);
      rippedPaths.push(fpath);

      // Retrouver l'index original de la piste dans la TOC pour les métadonnées MB
      const origIdx = toc.tracks.findIndex(t => t.number === tnum);
      const tMeta = mbData?.tracks?.[origIdx >= 0 ? origIdx : i] || {};
      files.push({
        name: fname,
        filePath: fpath,
        meta: {
          title: tMeta.title || `Track ${tnum}`,
          artist: tMeta.artist || mbData?.albumArtist || '',
          album: tMeta.album || mbData?.albumTitle || '',
          year: tMeta.year || mbData?.year || null,
          track_number: tnum,
          isrc: tMeta.isrc || null,
          mbid: tMeta.mbid || null,
        },
      });
    }

    ripState.progress = 70;
    ripState.status = 'uploading';

    const metaArr = files.map(f => f.meta);
    const upResult = await uploadToBackend(
      backendUrl, authToken,
      files.map(f => ({ name: f.name, filePath: f.filePath })),
      metaArr
    );

    ripState.fileIds = (upResult.files || []).map(f => f.file_id).filter(Boolean);
    ripState.filesMetadata = (upResult.files || []).map(f => f.metadata || {});
    ripState.progress = 100;
    ripState.status = 'done';

  } catch (e) {
    ripState.status = 'error';
    ripState.error = e.message;
    console.error('[doRip]', e.message);
  } finally {
    for (const fpath of rippedPaths) {
      try { fs.unlinkSync(fpath); } catch { /* ignore */ }
    }
  }
}

// ============================================================
// Serveur HTTP
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResp(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && pathname === '/status') {
    const cd = await checkCd();
    return jsonResp(res, 200, {
      ok: true, ...cd,
      platform: PLATFORM,
      bundledFfmpeg: BUNDLED_FFMPEG,
      version: '1.2',
    });
  }

  if (req.method === 'GET' && pathname === '/rip/status') {
    return jsonResp(res, 200, { ...ripState });
  }

  if (req.method === 'GET' && pathname === '/toc') {
    try {
      const cached = await getTocWithMb();
      if (!cached) return jsonResp(res, 200, { tracks: [], discId: null, albumArtist: '', albumTitle: '', year: null });
      const { toc, mbData, discId } = cached;
      const tracks = toc.tracks.map((t, i) => {
        const mb = mbData?.tracks?.[i] || {};
        return {
          number: t.number,
          title: mb.title || `Track ${t.number}`,
          artist: mb.artist || mbData?.albumArtist || '',
          album: mb.album || mbData?.albumTitle || '',
          year: mb.year || mbData?.year || null,
          mbid: mb.mbid || null,
        };
      });
      return jsonResp(res, 200, {
        tracks,
        discId,
        albumArtist: mbData?.albumArtist || '',
        albumTitle: mbData?.albumTitle || '',
        year: mbData?.year || null,
        mbFound: !!mbData,
      });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && pathname === '/rip') {
    if (['detecting', 'ripping', 'uploading'].includes(ripState.status)) {
      return jsonResp(res, 409, { error: 'Rip déjà en cours' });
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const backendUrl = payload.backend_url || process.env.RADIOSTATION_URL || 'http://localhost:8000';
      const authToken = payload.auth_token || '';
      const trackNumbers = Array.isArray(payload.track_numbers) && payload.track_numbers.length > 0
        ? payload.track_numbers.map(Number).filter(n => n > 0)
        : null;
      doRip(backendUrl, authToken, trackNumbers).catch(e => console.error('[rip]', e));
      jsonResp(res, 200, { status: 'started' });
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/diagnostics') {
    const run = cmd => new Promise(resolve => {
      exec(cmd, { timeout: 10000 }, (_e, out) => resolve(out || ''));
    });
    const [statusOut, tocOut] = await Promise.all([
      run('drutil status 2>&1'),
      run('drutil toc 2>&1'),
    ]);
    return jsonResp(res, 200, {
      platform: PLATFORM,
      bundledFfmpeg: BUNDLED_FFMPEG,
      drutil_status: statusOut,
      drutil_toc: tocOut,
      macos_cd_volume: findMacosCdVolume(),
      macos_cd_device: PLATFORM === 'darwin' ? getMacosCdDevice() : null,
    });
  }

  // ── Préecoute d'une piste ─────────────────────────────────────────────────
  if (req.method === 'GET' && pathname.startsWith('/preview/')) {
    const trackNum = parseInt(pathname.slice('/preview/'.length), 10);
    if (!trackNum || trackNum < 1 || trackNum > 99) {
      return jsonResp(res, 400, { error: 'Numéro de piste invalide' });
    }

    const sendWavFile = (filePath) => {
      const stat = fs.statSync(filePath);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': stat.size, ...CORS_HEADERS });
      const rs = fs.createReadStream(filePath);
      rs.pipe(res);
      const cleanup = () => { try { fs.unlinkSync(filePath); } catch {} };
      res.on('finish', cleanup);
      res.on('close', cleanup);
    };

    if (PLATFORM === 'darwin') {
      // Priorité 1 : volume monté /Volumes (fichiers .cdda → afconvert)
      const cd = findMacosCdVolume();
      if (cd && cd.trackFiles[trackNum - 1]) {
        const tmpPath = path.join(os.tmpdir(), `rspreview-${trackNum}-${Date.now()}.wav`);
        try {
          await ripTrackAfconvert(path.join(cd.volumePath, cd.trackFiles[trackNum - 1]), tmpPath);
          return sendWavFile(tmpPath);
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch {}
          return jsonResp(res, 500, { error: e.message });
        }
      }
      // Priorité 2 : dd depuis /dev/rdiskN (offsets relatifs → +150 pour dd)
      const device = getMacosCdDevice();
      const toc = _tocCache?.toc;
      if (device && toc && toc.tracks.length >= trackNum) {
        const track = toc.tracks[trackNum - 1];
        const next  = toc.tracks[trackNum];
        const start = track.offset + 150;
        const count = (next ? next.offset : toc.leadout) - track.offset;
        if (count > 0) {
          const dd = spawn('dd', [`if=${device}`, 'bs=2352', `skip=${start}`, `count=${count}`]);
          const ff = spawn(FFMPEG, ['-y', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0', '-f', 'wav', 'pipe:1']);
          dd.stdout.pipe(ff.stdin);
          dd.on('error', () => { try { ff.stdin.destroy(); } catch {} });
          res.writeHead(200, { 'Content-Type': 'audio/wav', ...CORS_HEADERS });
          ff.stdout.pipe(res);
          res.on('close', () => { try { dd.kill(); } catch {} try { ff.kill(); } catch {} });
          return;
        }
      }
      return jsonResp(res, 503, { error: 'CD non disponible pour la préecoute' });
    }

    // Linux / Windows : cdda:// → ffmpeg → WAV pipe
    const input = cdInputArg(trackNum);
    const ff = spawn(FFMPEG, ['-y', '-i', input, '-f', 'wav', 'pipe:1']);
    let ffHeaderSent = false;
    ff.stdout.on('data', chunk => {
      if (!ffHeaderSent) {
        res.writeHead(200, { 'Content-Type': 'audio/wav', ...CORS_HEADERS });
        ffHeaderSent = true;
      }
      res.write(chunk);
    });
    ff.on('close', () => res.end());
    ff.on('error', (e) => { if (!ffHeaderSent) jsonResp(res, 500, { error: e.message }); else res.end(); });
    res.on('close', () => { try { ff.kill(); } catch {} });
    return;
  }

  jsonResp(res, 404, { error: 'Not found' });
});

// ============================================================
// Démarrage
// ============================================================

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RadioStation CD Ripper v1.2 — http://127.0.0.1:${PORT}`);
  console.log(`Plateforme : ${PLATFORM} | ffmpeg bundlé : ${BUNDLED_FFMPEG}`);
  if (PLATFORM === 'win32') console.log(`Lecteur CD : ${getCdDevice()}`);
});
