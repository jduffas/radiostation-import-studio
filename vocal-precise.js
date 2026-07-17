// ============================================================
// Analyse vocale « précise » — séparation de sources MDX-Net (ONNX)
// ============================================================
// Moteur optionnel de détection des zones sans voix : le modèle UVR-MDX-NET
// Voc FT isole la piste voix du mixage ; l'énergie relative de cette piste
// (voc − mix, en dB) par frame STFT (~23 ms) donne une réponse quasi exacte à
// « y a-t-il du chant ici ? » — mesuré sur bibliothèque réelle : chant à
// −4/−9 dB du mix, passages sans voix à −20/−26 dB (≈ 15 dB de marge, là où
// les critères DSP du mode rapide se recouvrent).
//
// Conçu pour tourner sur la machine de l'utilisateur (app Import Studio), PAS
// sur le Pi du site — c'est un choix produit : le niveau (et donc l'usage CPU)
// appartient à l'utilisateur via le réglage `vocal_analysis_level` :
//   'fast'        → ce module n'est pas utilisé (analyse ffmpeg ~2 s/titre)
//   'precise'     → séparation, tous les cœurs
//   'precise_eco' → séparation, moitié des cœurs (machine utilisable pendant)
// Ordre de grandeur : ~1-3 min/titre sur un poste de bureau récent.
//
// Le modèle (~64 Mo) n'est PAS embarqué dans l'app : téléchargé au premier
// usage du mode précis dans ~/.radiostation-import-studio/models/, vérifié
// par SHA-256. onnxruntime-node est chargé paresseusement : si la plateforme
// ne le supporte pas, l'appelant (main.js) retombe sur le mode rapide.
//
// Paramètres STFT = ceux de l'entraînement UVR (mdx.py) et NON négociables :
// n_fft 7680, hop 1024, fenêtre de Hann périodique, center=true avec padding
// réfléchi (équivalent torch.stft), 3072 premiers bins, tenseur [1,4,3072,256]
// (ch0_re, ch0_im, ch1_re, ch1_im). n_fft n'étant pas une puissance de 2, la
// DFT passe par l'algorithme de Bluestein sur une FFT pow2 (auto-testé au
// premier usage contre une DFT naïve).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MODEL_URL = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx';
const MODEL_SHA256 = '534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111';
const MODEL_FILE = 'UVR-MDX-NET-Voc_FT.onnx';

const SAMPLE_RATE = 44100;
const N_FFT = 7680, HOP = 1024, DIM_F = 3072, DIM_T = 256;
const CHUNK = HOP * (DIM_T - 1); // 261120 échantillons → exactement 256 frames centrées
const FRAME_MS = (HOP / SAMPLE_RATE) * 1000; // ≈ 23,2 ms

// Seuil de présence de voix : piste voix à moins de 15 dB du mix (courbe lissée).
// Physiquement interprétable et stable d'un titre à l'autre (cf. mesures ci-dessus).
const VOICE_REL_DB = -15;
const SMOOTH_FRAMES = 10;   // lissage ±10 frames ≈ ±230 ms
const GUARD_MS = 200;       // marge de sécurité aux bornes (avant reprise du chant)
const MIN_ZONE_MS = 3000;
const EDGE_MS = 5000;       // mêmes règles de bord que le mode rapide
const KEEP_MS = 15000;

let _ort = null;
function _loadOrt() {
  if (_ort === null) {
    try { _ort = require('onnxruntime-node'); } catch { _ort = false; }
  }
  return _ort;
}

function isAvailable() {
  return !!_loadOrt();
}

// ── Téléchargement du modèle (premier usage du mode précis) ──────────────────
function _sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function _download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error('trop de redirections'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return _download(res.headers.location, dest, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureModel(settingsDir) {
  const dir = path.join(settingsDir, 'models');
  const dest = path.join(dir, MODEL_FILE);
  if (fs.existsSync(dest)) {
    if (_sha256File(dest) === MODEL_SHA256) return dest;
    console.warn('[vocal-precise] modèle corrompu, re-téléchargement');
    try { fs.unlinkSync(dest); } catch {}
  }
  fs.mkdirSync(dir, { recursive: true });
  const part = dest + '.part';
  console.log('[vocal-precise] téléchargement du modèle (~64 Mo)…');
  await _download(MODEL_URL, part);
  if (_sha256File(part) !== MODEL_SHA256) {
    try { fs.unlinkSync(part); } catch {}
    throw new Error('SHA-256 du modèle téléchargé invalide');
  }
  fs.renameSync(part, dest);
  console.log('[vocal-precise] modèle installé:', dest);
  return dest;
}

// ── FFT radix-2 itérative (pow2) + DFT arbitraire via Bluestein ──────────────
function _makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < levels; j++) r = (r << 1) | ((i >>> j) & 1);
    rev[i] = r;
  }
  const cosT = new Float64Array(n / 2), sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos(2 * Math.PI * i / n);
    sinT[i] = Math.sin(2 * Math.PI * i / n);
  }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) {
        let t = re[i]; re[i] = re[r]; re[r] = t;
        t = im[i]; im[i] = im[r]; im[r] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cosT[k], s = inverse ? sinT[k] : -sinT[k];
          const l = j + half;
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
}

function _makeBluestein(n) {
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const fft = _makeFFT(m);
  const wRe = new Float64Array(n), wIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = Math.PI * ((k * k) % (2 * n)) / n; // k² mod 2n : stabilité numérique
    wRe[k] = Math.cos(ang); wIm[k] = -Math.sin(ang);
  }
  const bRe = new Float64Array(m), bIm = new Float64Array(m);
  bRe[0] = wRe[0]; bIm[0] = -wIm[0];
  for (let k = 1; k < n; k++) {
    bRe[k] = bRe[m - k] = wRe[k];
    bIm[k] = bIm[m - k] = -wIm[k];
  }
  fft(bRe, bIm, false);
  const aRe = new Float64Array(m), aIm = new Float64Array(m);
  return function dft(inRe, outRe, outIm) {
    aRe.fill(0); aIm.fill(0);
    for (let k = 0; k < n; k++) {
      const xr = inRe[k];
      aRe[k] = xr * wRe[k];
      aIm[k] = xr * wIm[k];
    }
    fft(aRe, aIm, false);
    for (let k = 0; k < m; k++) {
      const tre = aRe[k] * bRe[k] - aIm[k] * bIm[k];
      aIm[k] = aRe[k] * bIm[k] + aIm[k] * bRe[k];
      aRe[k] = tre;
    }
    fft(aRe, aIm, true);
    for (let k = 0; k < n; k++) {
      outRe[k] = aRe[k] * wRe[k] - aIm[k] * wIm[k];
      outIm[k] = aRe[k] * wIm[k] + aIm[k] * wRe[k];
    }
  };
}

let _selfTested = false;
function _selfTest() {
  if (_selfTested) return;
  const n = 60;
  const dft = _makeBluestein(n);
  const re = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1);
  const or_ = new Float64Array(n), oi = new Float64Array(n);
  dft(re, or_, oi);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = -2 * Math.PI * k * t / n;
      sr += re[t] * Math.cos(a); si += re[t] * Math.sin(a);
    }
    if (Math.abs(sr - or_[k]) > 1e-6 || Math.abs(si - oi[k]) > 1e-6) {
      throw new Error('auto-test Bluestein en échec');
    }
  }
  _selfTested = true;
}

// STFT d'un segment : padding réfléchi N_FFT/2 des deux côtés (torch center=true),
// retourne nFrames × {re, im} tronquées aux DIM_F premiers bins.
function _stftFrames(signal, nFrames, dft, win, out) {
  const half = N_FFT / 2;
  const L = signal.length;
  const padded = new Float64Array(L + N_FFT);
  for (let i = 0; i < half; i++) padded[i] = signal[half - i];
  padded.set(signal, half);
  for (let i = 0; i < half; i++) padded[half + L + i] = signal[L - 2 - i];
  const fre = new Float64Array(N_FFT);
  const ore = new Float64Array(N_FFT), oim = new Float64Array(N_FFT);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) fre[i] = padded[off + i] * win[i];
    dft(fre, ore, oim);
    out[f].re.set(ore.subarray(0, DIM_F));
    out[f].im.set(oim.subarray(0, DIM_F));
  }
}

// ── Décodage audio → Float64Array stéréo 44,1 kHz ────────────────────────────
function _decode(ffmpegPath, file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-v', 'quiet', '-i', file,
      '-f', 'f32le', '-ac', '2', '-ar', String(SAMPLE_RATE), 'pipe:1']);
    const bufs = [];
    proc.stdout.on('data', d => bufs.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg decode exit ' + code));
      const raw = Buffer.concat(bufs);
      const n = raw.length >> 3;
      const L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        L[i] = raw.readFloatLE(i * 8);
        R[i] = raw.readFloatLE(i * 8 + 4);
      }
      resolve({ L, R });
    });
  });
}

// ── Segmentation de la courbe vocale (pure, testée unitairement) ─────────────
// frames : [{t_ms, mix_db, voc_db}] — retourne les zones sans voix triées.
function segmentVocalCurve(frames, totalMs) {
  if (frames.length < 40) return [];
  // Lissage de voc − mix
  const rel = frames.map(w => w.voc_db - w.mix_db);
  const smooth = rel.map((_, i) => {
    const a = Math.max(0, i - SMOOTH_FRAMES), b = Math.min(rel.length, i + SMOOTH_FRAMES + 1);
    let s = 0;
    for (let j = a; j < b; j++) s += rel[j];
    return s / (b - a);
  });
  const maxMix = Math.max(...frames.map(w => w.mix_db));
  const activeMixThr = maxMix - 45;
  const mixes = frames.filter(w => w.mix_db > activeMixThr).map(w => w.mix_db).sort((a, b) => a - b);
  const medMix = mixes.length ? mixes[Math.floor(mixes.length / 2)] : maxMix;

  // Voix présente : piste voix proche du mix ET mix réellement actif
  const isVoice = frames.map((w, i) => w.mix_db > activeMixThr && smooth[i] > VOICE_REL_DB);

  const total = totalMs || (frames[frames.length - 1].t_ms + FRAME_MS);
  const zones = [];
  let i = 0;
  while (i < frames.length) {
    if (!isVoice[i]) {
      let j = i;
      while (j + 1 < frames.length && !isVoice[j + 1]) j++;
      // Marges de sécurité : ne pas coller la reprise du chant
      let s = frames[i].t_ms + (i > 0 ? GUARD_MS : 0);
      let e = frames[j].t_ms + FRAME_MS - (j < frames.length - 1 ? GUARD_MS : 0);
      s = Math.round(s); e = Math.round(Math.min(e, total));
      if (e - s >= MIN_ZONE_MS) {
        const zw = frames.slice(i, j + 1);
        const avgRel = zw.reduce((a, w) => a + (w.voc_db - w.mix_db), 0) / zw.length;
        const avgMix = zw.reduce((a, w) => a + w.mix_db, 0) / zw.length;
        zones.push({
          start_ms: s, end_ms: e, duration_ms: e - s,
          avg_rms_db: Math.round(avgRel * 10) / 10, // énergie vocale relative (dB) — plus c'est bas, plus la zone est sûre
          kind: avgMix < medMix - 10 ? 'quiet' : 'bridge',
        });
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  // Règles de bord identiques au mode rapide : petite zone de bord jetée, longue
  // zone pénétrant ≥ KEEP_MS vers l'intérieur tronquée à la marge.
  const edge = total > 30000 ? EDGE_MS : 1;
  const inside = [];
  for (let z of zones) {
    const s = Math.max(z.start_ms, edge);
    const e = Math.min(z.end_ms, total - edge);
    if (s > z.start_ms || e < z.end_ms) {
      if (e - s < KEEP_MS) continue;
      z = { ...z, start_ms: s, end_ms: e, duration_ms: e - s };
    }
    inside.push(z);
  }
  inside.sort((a, b) => b.duration_ms - a.duration_ms);
  return inside.slice(0, 5);
}

// ── Session ORT (cachée entre titres d'un même rip) ──────────────────────────
let _session = null, _sessionThreads = 0;
async function _getSession(modelPath, threads) {
  const ort = _loadOrt();
  if (!ort) throw new Error('onnxruntime indisponible');
  if (!_session || _sessionThreads !== threads) {
    _session = await ort.InferenceSession.create(modelPath, {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    });
    _sessionThreads = threads;
  }
  return _session;
}

function _threadsForLevel(level) {
  const cpus = Math.max(1, os.cpus().length);
  return level === 'precise_eco' ? Math.max(1, Math.floor(cpus / 2)) : cpus;
}

/**
 * Analyse précise d'un fichier. Retourne les zones, ou null si le moteur est
 * indisponible (plateforme sans ORT, téléchargement du modèle impossible…) —
 * l'appelant retombe alors sur le mode rapide.
 */
async function analyzePrecise(wavPath, durationMs, level, ffmpegPath, settingsDir) {
  const ort = _loadOrt();
  if (!ort) return null;
  let modelPath;
  try {
    modelPath = await ensureModel(settingsDir);
  } catch (e) {
    console.warn('[vocal-precise] modèle indisponible:', e.message);
    return null;
  }
  _selfTest();
  const t0 = Date.now();
  const { L, R } = await _decode(ffmpegPath, wavPath);
  const nS = L.length;
  if (nS < SAMPLE_RATE * 5) return [];
  const totalMs = durationMs || Math.round(nS / SAMPLE_RATE * 1000);

  const session = await _getSession(modelPath, _threadsForLevel(level));
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N_FFT));
  const dft = _makeBluestein(N_FFT);

  const fL = Array.from({ length: DIM_T }, () => ({ re: new Float32Array(DIM_F), im: new Float32Array(DIM_F) }));
  const fR = Array.from({ length: DIM_T }, () => ({ re: new Float32Array(DIM_F), im: new Float32Array(DIM_F) }));
  const segL = new Float64Array(CHUNK), segR = new Float64Array(CHUNK);
  const data = new Float32Array(4 * DIM_F * DIM_T);
  const plane = DIM_F * DIM_T;

  // Chevauchement 50 % : chaque chunk ne contribue que ses frames centrales
  // (bords pollués par le padding réfléchi local), sauf premier/dernier chunk.
  // STEP aligné sur la grille des frames (multiple de HOP) : les frames gardées
  // des chunks successifs sont exactement contiguës. Dernier chunk paddé de zéros.
  const STEP = HOP * (DIM_T / 2); // 128 frames
  const frames = [];
  const nChunks = Math.max(1, Math.ceil(nS / STEP) - 1);
  for (let c = 0; c < nChunks; c++) {
    const off = c * STEP;
    segL.fill(0); segR.fill(0);
    const len = Math.max(0, Math.min(CHUNK, nS - off));
    for (let i = 0; i < len; i++) { segL[i] = L[off + i]; segR[i] = R[off + i]; }
    _stftFrames(segL, DIM_T, dft, win, fL);
    _stftFrames(segR, DIM_T, dft, win, fR);
    for (let t = 0; t < DIM_T; t++) {
      for (let f = 0; f < DIM_F; f++) {
        const i0 = f * DIM_T + t;
        data[i0] = fL[t].re[f];
        data[plane + i0] = fL[t].im[f];
        data[2 * plane + i0] = fR[t].re[f];
        data[3 * plane + i0] = fR[t].im[f];
      }
    }
    const out = (await session.run({ input: new ort.Tensor('float32', data, [1, 4, DIM_F, DIM_T]) })).output.data;
    const tFrom = c === 0 ? 0 : DIM_T / 4;
    const tTo = c === nChunks - 1 ? DIM_T : (3 * DIM_T) / 4;
    for (let t = tFrom; t < tTo; t++) {
      const t_ms = (off + t * HOP) / SAMPLE_RATE * 1000;
      if (frames.length && t_ms <= frames[frames.length - 1].t_ms) continue; // recouvrement
      let eMix = 0, eVoc = 0;
      for (let f = 0; f < DIM_F; f++) {
        const i0 = f * DIM_T + t;
        eMix += data[i0] ** 2 + data[plane + i0] ** 2 + data[2 * plane + i0] ** 2 + data[3 * plane + i0] ** 2;
        eVoc += out[i0] ** 2 + out[plane + i0] ** 2 + out[2 * plane + i0] ** 2 + out[3 * plane + i0] ** 2;
      }
      frames.push({
        t_ms,
        mix_db: 10 * Math.log10(eMix + 1e-10),
        voc_db: 10 * Math.log10(eVoc + 1e-10),
      });
    }
  }
  const zones = segmentVocalCurve(frames, totalMs);
  console.log(`[vocal-precise] ${path.basename(wavPath)} : ${zones.length} zone(s) en ${((Date.now() - t0) / 1000).toFixed(0)}s (niveau ${level})`);
  return zones;
}

module.exports = { isAvailable, ensureModel, analyzePrecise, segmentVocalCurve, MODEL_FILE };
