// RadioStation Import Studio — interface locale embarquée (Phase 2b « interface embarquée »)
//
// Servie directement par main.js (127.0.0.1:19847) — aucune dépendance réseau au site
// RadioStation pour l'interface elle-même : détection CD, rip, coupe du silence et cue points
// tournent entièrement en local (main.js). Seul l'envoi final (POST /import, proxié par
// main.js vers le vrai backend avec le jeton d'appareil déjà appairé) touche le réseau.
import WaveSurfer from './vendor/wavesurfer.esm.js'
import RegionsPlugin from './vendor/regions.esm.js'
import aubioFactory from './vendor/aubio.esm.js'
import { keyFromChroma } from './vendor/key-detect.js'

const $app = document.getElementById('app')
const $pairingIndicator = document.getElementById('pairing-indicator')
const $vocalToggle = document.getElementById('vocal-toggle')
const $vocalToggleLabel = document.getElementById('vocal-toggle-label')
const $fastRipToggle = document.getElementById('fast-rip-toggle')
const $fastRipLabel = document.getElementById('fast-rip-label')
const $pageTitle = document.getElementById('page-title')

// Titre/en-tête dynamiques selon le mode choisi — l'app n'est plus limitée au CD depuis
// Phase 4 (import de fichiers locaux), le libellé générique par défaut reflète maintenant
// les deux (cf. aussi le renommage des items de menu tray "Importer un CD…" -> "Nouvel import…").
function updatePageTitle() {
  const label = appMode === 'cd' ? 'Import CD' : appMode === 'files' ? 'Import fichiers' : 'Import'
  const icon = appMode === 'cd' ? '📀' : appMode === 'files' ? '📁' : '📥'
  document.title = `RadioStation — ${label}`
  if ($pageTitle) $pageTitle.textContent = `${icon} ${label}`
  // "Rip rapide" (cdparanoia -Z) ne concerne que la lecture physique d'un CD — masqué hors
  // du mode CD (sélecteur de mode, import fichiers) où il n'a aucun effet.
  if ($fastRipLabel) $fastRipLabel.style.display = appMode === 'cd' ? '' : 'none'
  // "Analyse vocale" ne fait que PRÉ-calculer les zones jingle pendant le rip CD (sinon
  // calculées à la demande, sans réglage, au premier passage en mode jingle — cf.
  // ensureVocalZones) : sans effet en mode fichiers, où le bouton de détection du mode
  // jingle fait le même travail à la demande quoi qu'il arrive. Masqué hors mode CD, comme
  // "Rip rapide" (signalé : redondant/confus avec le bouton adaptatif du mode jingle).
  if ($vocalToggleLabel) $vocalToggleLabel.style.display = appMode === 'cd' ? '' : 'none'
}

let settings = {}
let currentRipState = null
let cdStatus = null
let pollTimer = null

// Mode choisi par l'utilisateur sur l'écran d'accueil — null tant qu'aucun choix n'a été
// fait (aucun sondage CD démarré tant que le mode n'est pas 'cd', cf. enterCdMode()).
let appMode = null // null | 'cd' | 'files'

// État local (pas dans /rip/status) : sélection des pistes avant rip
let localView = 'boot' // 'boot' | 'toc-loading' | 'toc-ready' | 'toc-error'
let tocTracks = []
let tocError = null
let tocLoadingMsg = ''

// État local : cue points réglés pendant l'étape 'trimming' (indexés comme pendingFiles,
// appliqués aux fileIds correspondants une fois l'upload terminé — même ordre garanti tout du
// long du pipeline côté main.js, cf. commentaire équivalent dans useCdRipper.ts).
let trimIndex = 0
const localCuePoints = {}

// État local : suivi de l'envoi individuel de chaque piste après upload (étape 'done')
let sendResults = [] // [{status:'pending'|'sending'|'done'|'error', error, title, artist, album, year}]

let wavesurfer = null // instance courante (une piste à la fois, détruite entre les pistes)

// ---- État du flux "fichiers locaux" hors CD (Phase 4) ----
// Entièrement piloté côté client : contrairement au rip CD (lecture disque potentiellement
// longue, nécessite un sondage /rip/status en tâche de fond), chaque appel /files/* est
// attendu et répond directement — pas de machine à états côté serveur à interroger.
let filesStep = 'select' // 'select' | 'editing' | 'sending'
let filesItems = [] // [{id, name, title, artist, album, year, durationSeconds, cueInSeconds, cueOutSeconds, bpm, key, loudnessLufs, energy, startType, endType, analyzing, sendStatus, sendError, backendFileId}]
let filesEditingIndex = 0
let filesFinishing = false
let aubioModule = null // chargé paresseusement (une seule fois, coût wasm non négligeable)

// ---- HTTP ----
async function api(path, opts = {}) {
  const res = await fetch(path, opts)
  let json = {}
  try { json = await res.json() } catch { /* réponse vide */ }
  if (!res.ok) throw new Error(json.error || json.detail || `HTTP ${res.status}`)
  return json
}

// Année saisie librement (champ texte) → entier ou undefined. Sans ce garde, "abc" devenait
// Number("abc") = NaN, sérialisé null dans le JSON d'import.
function parseYear(value) {
  const y = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(y) && y > 0 ? y : undefined
}

function formatTime(seconds) {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

// ---- Bootstrap + polling ----
// Le sondage tourne uniquement quand une vue a besoin d'être rafraîchie automatiquement
// (détection CD, progression du rip/upload). Il est arrêté pendant la sélection des pistes et
// la coupe locale ('trimming') — sinon un tick reconstruirait toute la vue (et détruirait la
// waveform WaveSurfer en cours d'édition) toutes les 1,5s, rendant le glissé des marqueurs
// quasi impossible. Même comportement que pollCdRip côté Vue (useCdRipper.ts), qui s'arrête
// explicitement dès que le statut passe à 'trimming'.
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function resumePolling() {
  stopPolling()
  pollTimer = setInterval(tick, 1500)
}

async function init() {
  try {
    settings = await api('/settings')
  } catch {
    settings = {}
  }
  updatePairingIndicator()
  $vocalToggle.checked = !!settings.vocal_analysis_enabled
  $fastRipToggle.checked = !!settings.fast_rip_enabled
  if (!settings.server_url || !settings.device_token) {
    stopPolling()
    localView = 'not-paired'
    appMode = null
    updatePageTitle()
    render()
    return
  }
  // Écran de choix de mode d'abord — pas de sondage CD tant que l'utilisateur n'a pas
  // choisi (cf. enterCdMode()), pour ne pas faire tourner /status en fond inutilement
  // pendant un import de fichiers locaux.
  appMode = null
  updatePageTitle()
  render()
}

async function enterCdMode() {
  appMode = 'cd'
  updatePageTitle()
  localView = 'boot'
  await tick()
  resumePolling()
}

function enterFilesMode() {
  appMode = 'files'
  updatePageTitle()
  filesStep = 'select'
  filesItems = []
  filesEditingIndex = 0
  filesFinishing = false
  render()
}

function backToModeSelector() {
  stopPolling()
  if (wavesurfer) { wavesurfer.destroy(); wavesurfer = null }
  appMode = null
  updatePageTitle()
  render()
}

function updatePairingIndicator() {
  const ok = !!(settings.server_url && settings.device_token)
  $pairingIndicator.textContent = ok ? `Connecté à ${settings.server_url}` : 'Non connecté'
  $pairingIndicator.className = 'pairing-indicator ' + (ok ? 'ok' : 'ko')
}

// Élément statique du topbar (pas recréé par render()) : câblage une seule fois ici plutôt
// que dans render(), sinon perte du focus/listener à chaque tick de polling.
$vocalToggle.onchange = async () => {
  const enabled = $vocalToggle.checked
  try {
    settings = await api('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vocal_analysis_enabled: enabled }),
    })
  } catch (e) {
    $vocalToggle.checked = !enabled // revert
    alert("Impossible de sauvegarder le réglage : " + e.message)
  }
}

$fastRipToggle.onchange = async () => {
  const enabled = $fastRipToggle.checked
  try {
    settings = await api('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fast_rip_enabled: enabled }),
    })
  } catch (e) {
    $fastRipToggle.checked = !enabled // revert
    alert("Impossible de sauvegarder le réglage : " + e.message)
  }
}

async function tick() {
  try {
    cdStatus = await api('/status')
  } catch {
    cdStatus = null
  }
  try {
    currentRipState = await api('/rip/status')
  } catch {
    currentRipState = null
  }
  // 'trimming'/'done'/'error' : états stables tant que l'utilisateur n'agit pas — inutile (et
  // nuisible pour 'trimming'/'done', qui ont leur propre état d'édition local) de continuer.
  if (['trimming', 'done', 'error'].includes(currentRipState?.status)) stopPolling()
  render()
}

// ---- Rendu principal ----
function render() {
  if (localView === 'not-paired') return renderNotPaired()
  if (appMode === null) return renderModeSelector()
  if (appMode === 'files') return renderFiles()

  if (!currentRipState) { $app.innerHTML = '<p class="loading">Connexion au serveur local…</p>'; return }

  const status = currentRipState.status

  if (status === 'idle') {
    if (localView === 'toc-loading') return renderTocLoading()
    if (localView === 'toc-ready') return renderTocSelection()
    if (localView === 'toc-error') return renderTocError()
    return renderIdle()
  }
  if (['detecting', 'ripping', 'analyzing'].includes(status)) return renderProgress(status)
  if (status === 'trimming') return renderTrimming()
  if (status === 'uploading') return renderProgress(status)
  if (status === 'done') return renderFinalize()
  if (status === 'error') return renderRipError()
}

function renderNotPaired() {
  $app.innerHTML = `
    <div class="card">
      <div class="card-header">Application non connectée</div>
      <div class="card-body">
        <p>Cette application doit d'abord être connectée à votre RadioStation, depuis le site :
        ouvrez la page d'import CD (<code>/admin/import/cd</code>), cliquez sur
        « Connecter l'application », puis cliquez sur le lien généré.</p>
        <button class="btn" id="btn-retry">Réessayer</button>
      </div>
    </div>`
  document.getElementById('btn-retry').onclick = init
}

function renderIdle() {
  const detected = cdStatus?.cdDetected
  $app.innerHTML = `
    <div class="card">
      <div class="card-header">${detected ? `CD détecté — ${cdStatus.trackCount} piste(s)` : 'Aucun disque'}</div>
      <div class="card-body">
        <p class="hint">${detected ? 'Prêt à lire la table des matières.' : 'Insérez un CD audio pour commencer.'}</p>
        <button class="btn" id="btn-toc" ${detected ? '' : 'disabled'}>Sélectionner les pistes…</button>
      </div>
      <div class="actions">
        <button class="btn-secondary" id="btn-back-mode">← Changer de mode</button>
      </div>
    </div>`
  const btn = document.getElementById('btn-toc')
  if (btn) btn.onclick = openTrackSelection
  document.getElementById('btn-back-mode').onclick = backToModeSelector
}

// ---- Écran de choix de mode (Phase 4) ----
function renderModeSelector() {
  $app.innerHTML = `
    <div class="card">
      <div class="card-header">Que souhaitez-vous importer ?</div>
      <div class="card-body mode-select">
        <button class="btn mode-btn" id="btn-mode-cd">💿 Importer un CD</button>
        <button class="btn mode-btn" id="btn-mode-files">📁 Importer des fichiers locaux</button>
      </div>
    </div>`
  document.getElementById('btn-mode-cd').onclick = enterCdMode
  document.getElementById('btn-mode-files').onclick = enterFilesMode
}

// ---- Sélection des pistes (TOC) ----
async function openTrackSelection() {
  stopPolling() // pas besoin de rafraîchir automatiquement pendant la sélection des pistes
  localView = 'toc-loading'
  tocLoadingMsg = 'Lecture du disque en cours…'
  tocError = null
  tocTracks = []
  render()

  const MAX_ATTEMPTS = 6
  const RETRY_DELAY_MS = 2000

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const d = await api('/toc')
      if ((d.tracks || []).length > 0) {
        tocTracks = d.tracks.map(t => ({ ...t, selected: true }))
        localView = 'toc-ready'
        render()
        return
      }
      if (attempt < MAX_ATTEMPTS) {
        tocLoadingMsg = `En attente du disque… (${attempt}/${MAX_ATTEMPTS})`
        render()
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
      } else {
        tocError = 'Aucune piste trouvée sur le disque.'
      }
    } catch (e) {
      tocError = 'Impossible de lire la table des matières : ' + e.message
      break
    }
  }
  localView = 'toc-error'
  render()
}

function renderTocLoading() {
  $app.innerHTML = `<div class="card"><div class="card-body"><p class="loading">${tocLoadingMsg}</p></div></div>`
}

function renderTocError() {
  $app.innerHTML = `
    <div class="card">
      <div class="card-body">
        <div class="error-box">${escapeHtml(tocError)}</div>
        <button class="btn-secondary" id="btn-cancel-toc-error">Annuler</button>
        <button class="btn" id="btn-retry-toc">Réessayer</button>
      </div>
    </div>`
  document.getElementById('btn-retry-toc').onclick = openTrackSelection
  document.getElementById('btn-cancel-toc-error').onclick = () => { localView = 'boot'; resumePolling(); tick() }
}

function renderTocSelection() {
  const rows = tocTracks.map((t, i) => `
    <li>
      <input type="checkbox" data-idx="${i}" class="toc-check" ${t.selected ? 'checked' : ''}>
      <span>${t.number}.</span>
      <input type="text" data-idx="${i}" class="toc-title" value="${escapeHtml(t.title || '')}" placeholder="Titre">
      <input type="text" data-idx="${i}" class="toc-artist" value="${escapeHtml(t.artist || '')}" placeholder="Artiste">
    </li>`).join('')

  $app.innerHTML = `
    <div class="card">
      <div class="card-header">Sélection des pistes ${tocTracks[0]?.album ? '— ' + escapeHtml(tocTracks[0].album) : ''}</div>
      <div class="card-body">
        <ul class="track-list">${rows}</ul>
      </div>
      <div class="actions">
        <button class="btn-secondary" id="btn-cancel-toc">Annuler</button>
        <button class="btn" id="btn-start-rip">Lancer le rip</button>
      </div>
    </div>`

  document.querySelectorAll('.toc-check').forEach(el => {
    el.onchange = () => { tocTracks[+el.dataset.idx].selected = el.checked }
  })
  document.querySelectorAll('.toc-title').forEach(el => {
    el.oninput = () => { tocTracks[+el.dataset.idx].title = el.value }
  })
  document.querySelectorAll('.toc-artist').forEach(el => {
    el.oninput = () => { tocTracks[+el.dataset.idx].artist = el.value }
  })
  document.getElementById('btn-cancel-toc').onclick = () => { localView = 'boot'; resumePolling(); tick() }
  document.getElementById('btn-start-rip').onclick = startRip
}

async function startRip() {
  const selected = tocTracks.filter(t => t.selected)
  if (!selected.length) { alert('Sélectionnez au moins une piste.'); return }
  try {
    await api('/rip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track_numbers: selected.map(t => t.number),
        // Titres/artistes édités sur cet écran — sans ce champ, les modifications étaient
        // silencieusement perdues (le rip ne connaissait que MusicBrainz).
        tracks: selected.map(t => ({ number: t.number, title: t.title, artist: t.artist })),
      }),
    })
    localView = 'boot'
    Object.keys(localCuePoints).forEach(k => delete localCuePoints[k])
    trimIndex = 0
    await tick()
    resumePolling() // ripping/analyzing/uploading doivent se rafraîchir automatiquement
  } catch (e) {
    alert('Impossible de démarrer le rip : ' + e.message)
  }
}

function renderProgress(status) {
  const labels = {
    detecting: 'Lecture de la table des matières…',
    ripping: `Rip piste ${currentRipState.currentTrack}/${currentRipState.totalTracks}`,
    analyzing: `Analyse vocale piste ${currentRipState.currentTrack}/${currentRipState.totalTracks}…`,
    uploading: 'Envoi des fichiers vers RadioStation…',
  }
  $app.innerHTML = `
    <div class="card">
      <div class="card-body">
        <p>${labels[status] || status}</p>
        <div class="progress-bar"><div class="progress-fill" style="width:${currentRipState.progress}%"></div></div>
      </div>
    </div>`
}

function renderRipError() {
  $app.innerHTML = `
    <div class="card">
      <div class="card-body">
        <div class="error-box">Erreur : ${escapeHtml(currentRipState.error || 'inconnue')}</div>
        <p class="hint">Si l'erreur vient du réseau (ex. serveur RadioStation injoignable), les
        pistes déjà rippées sont conservées : "Réessayer l'envoi" relance juste l'upload, sans
        repasser par le lecteur CD.</p>
        <button class="btn" id="btn-retry-upload">Réessayer l'envoi</button>
        <button class="btn-secondary" id="btn-back-idle">Retour (abandonner)</button>
      </div>
    </div>`
  document.getElementById('btn-back-idle').onclick = init
  document.getElementById('btn-retry-upload').onclick = async () => {
    try {
      await api('/rip/retry-upload', { method: 'POST' })
      $app.innerHTML = '<div class="card"><div class="card-body"><p class="loading">Nouvel essai d\'envoi…</p></div></div>'
      resumePolling()
    } catch (e) {
      alert("Impossible de réessayer l'envoi : " + e.message)
    }
  }
}

// ---- Coupe locale + cue points (statut 'trimming') ----
function renderTrimming() {
  const pending = currentRipState.pendingFiles || []
  if (!pending.length) { $app.innerHTML = '<p class="loading">Préparation…</p>'; return }
  if (trimIndex >= pending.length) trimIndex = pending.length - 1
  const track = pending[trimIndex]

  $app.innerHTML = `
    <div class="card">
      <div class="card-header">
        Piste ${trimIndex + 1} / ${pending.length} — ${escapeHtml(track.title)}
      </div>
      ${editorModeTabsHtml()}
      <div class="waveform-container"><div id="waveform"></div></div>
      <div class="controls-bar">
        <div class="playback-group">
          <button class="btn-ctrl" id="btn-playpause">►</button>
          <button class="btn-ctrl" id="btn-stop">Stop</button>
          <button class="btn-ctrl" id="btn-reset">Tout réinitialiser</button>
        </div>
        <div class="zoom-group">
          <button class="btn-ctrl" id="btn-zoom-out" title="Zoom arrière">➖</button>
          <span class="zoom-level" id="zoom-level">×1</span>
          <button class="btn-ctrl" id="btn-zoom-in" title="Zoom avant (précision des cue points)">➕</button>
          <button class="btn-ctrl" id="btn-zoom-reset" title="Ajuster à la fenêtre">Ajuster</button>
        </div>
        <div class="time-display" id="time-display">00:00.000 / 00:00.000</div>
      </div>
      <div class="summary-row">
        <div class="summary-item"><span class="summary-dot dot-blue"></span> Zone conservée : <strong id="sum-kept">—</strong></div>
        <div class="summary-item">
          <span class="summary-dot dot-cyan"></span> Début (skip) : <strong id="sum-cuein">00:00.000</strong>
          <button class="btn-preview" id="btn-preview-start">🔊 Écouter</button>
        </div>
        <div class="summary-item">
          <span class="summary-dot dot-orange"></span> Intro : <strong id="sum-intro">00:00.000</strong>
        </div>
        <div class="summary-item">
          <span class="summary-dot dot-red"></span> Transition (avant fin) : <strong id="sum-cueout">00:00.000</strong>
          <button class="btn-preview" id="btn-preview-end">🔊 Écouter</button>
        </div>
      </div>
      <div id="mode-panel"></div>
      <div class="actions">
        ${trimIndex > 0 ? '<button class="btn-secondary" id="btn-prev-track">◀ Précédent</button>' : ''}
        <button class="btn-secondary" id="btn-skip-track">Passer (garder tel quel)</button>
        <button class="btn" id="btn-confirm-track">Valider et continuer</button>
      </div>
    </div>`

  editorContext = { flow: 'cd', trackNumber: track.trackNumber, initialVocalZones: track.vocalZones || null }
  // Retour arrière (bouton Précédent) sur une piste déjà validée une fois : restaure les
  // cue points/zone jingle confirmés au lieu de rouvrir à l'état par défaut (signalé :
  // "on ne peut pas revenir en arrière"). Rien de stocké pour un "Passer" (localCuePoints
  // n'est renseigné que par advanceTrimming(data) avec data non-null).
  setupTrimWaveform(`/rip-preview/${track.trackNumber}`, () => {
    if (localCuePoints[trimIndex]) applyStoredCuePoints(localCuePoints[trimIndex])
  })
  wireEditorModeTabs()
  renderModePanel()
  if (trimIndex > 0) {
    document.getElementById('btn-prev-track').onclick = () => { trimIndex -= 1; render() }
  }

  document.getElementById('btn-skip-track').onclick = () => advanceTrimming(null)
  document.getElementById('btn-confirm-track').onclick = onConfirmTrack
  document.getElementById('btn-reset').onclick = () => resetCurrentMode()
}

let trimMarkers = null // { trimStart, trimEnd, cueInPos, cueOutPos, keepRegion, cueInRegion, cueOutRegion, mode, overlay*, cuts, volumeDb, fade* }

// Contexte du fichier/piste en cours d'édition — permet aux briques partagées de l'éditeur
// (analyse vocale à la demande, panneaux de mode) de savoir quel endpoint appeler.
let editorContext = null // { flow: 'cd'|'files', trackNumber?, fileId?, initialVocalZones }

// Couleurs des nouvelles régions de l'éditeur unifié (v1.7)
const OVERLAY_COLOR = 'rgba(76,175,80,0.30)' // zone « jingle intérieur » (vert)
const CUT_COLOR = 'rgba(244,67,54,0.30)' // passages supprimés au montage (rouge)

// Courbes de fondu proposées (whitelist AFADE_CURVES côté main.js — garder synchronisé)
const FADE_CURVES = [
  ['tri', 'Linéaire'],
  ['qsin', 'Doux (sinus)'],
  ['esin', 'Sinus accentué'],
  ['exp', 'Exponentiel'],
  ['log', 'Logarithmique'],
]
// fitPxPerSec = pixels/seconde qui remplit exactement le conteneur sans scroll (niveau ×1) ;
// recalculé à chaque 'ready' (largeur dispo + durée changent à chaque piste/fichier). Les
// régions WaveSurfer sont positionnées en % de la durée totale (cf. regions.esm.js
// renderPosition, `left:100*start/totalDuration+"%"`) donc aucun recalcul manuel n'est
// nécessaire pour rester alignées quand le zoom change — uniquement le niveau à appliquer.
let waveZoom = { level: 1, fitPxPerSec: 0 }
const ZOOM_MIN = 1
const ZOOM_MAX = 40

function applyZoom(level) {
  waveZoom.level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
  if (wavesurfer && waveZoom.fitPxPerSec > 0) {
    wavesurfer.zoom(waveZoom.fitPxPerSec * waveZoom.level)
  }
  const $zoomLevel = document.getElementById('zoom-level')
  if ($zoomLevel) $zoomLevel.textContent = `×${waveZoom.level % 1 === 0 ? waveZoom.level : waveZoom.level.toFixed(1)}`
}

// Généralisé (Phase 4) pour servir aussi bien la préecoute CD (/rip-preview/:n) que celle
// des fichiers locaux (/files/preview/:id) — même waveform, mêmes régions, seule l'URL
// change. `onReady` optionnel : callback additionnel une fois la waveform décodée (utilisé
// par le flux fichiers locaux pour lancer l'analyse BPM/tonalité côté client, cf. analyzeBpmKey).
function setupTrimWaveform(previewUrl, onReady) {
  if (wavesurfer) { wavesurfer.destroy(); wavesurfer = null }
  volOverlay = null // le DOM #waveform est recréé à chaque piste/fichier
  fadeOverlay = null
  const regions = RegionsPlugin.create()
  wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#4a90e2',
    progressColor: '#2c5aa0',
    cursorColor: '#e0e0e0',
    height: 140,
    barWidth: 2,
    barGap: 1,
    normalize: true,
    plugins: [regions],
    url: previewUrl,
  })

  trimMarkers = {
    trimStart: 0, trimEnd: 0, cueInPos: 0, cueOutPos: 0,
    // Fin d'intro (parité éditeur du site, v1.8) : position absolue dans la waveform,
    // = cueInPos quand pas d'intro. Envoyée à /import via intro_seconds (timeline finale).
    introPos: 0, introRegion: null,
    keepRegion: null, cueInRegion: null, cueOutRegion: null, updating: false,
    // Éditeur unifié (v1.7) : mode courant + zone jingle intérieur + montage + volume/fondus
    mode: 'cue', // 'cue' | 'jingle' | 'cut' | 'volume'
    regionsPlugin: regions,
    overlayStart: null, overlayEnd: null, overlayRegion: null,
    overlayTouched: false, // true dès que l'utilisateur a déplacé/posé/retiré la zone lui-même
    vocalZones: editorContext?.initialVocalZones || null, // null = pas encore analysé
    vocalLoading: false,
    cuts: [], cutSeq: 0, // [{id, region}]
    disableDragSel: null,
    volumeDb: 0, fadeInMs: 0, fadeInCurve: 'tri', fadeOutMs: 0, fadeOutCurve: 'tri',
    volumePoints: [], // [{timeMs, db}] — courbe d'automation (timeline waveform)
  }

  // Régions créées à la souris en mode montage (enableDragSelection) : adoptées comme
  // coupes après clamp — les régions connues (trim-keep/cue/overlay) passent aussi par cet
  // événement à leur création, d'où le garde sur l'id.
  regions.on('region-created', (region) => {
    if (['trim-keep', 'cue-in', 'intro-end', 'cue-out', 'overlay-zone'].includes(region.id)) return
    if (String(region.id).startsWith('cut-')) return
    adoptCutRegion(region)
  })

  wavesurfer.on('ready', () => {
    const dur = wavesurfer.getDuration()
    // Affiche la durée totale dès le décodage — 'timeupdate' ne se déclenche qu'à la
    // lecture, le compteur restait sinon à 00:00.000 / 00:00.000 tant qu'on ne jouait pas.
    const $time = document.getElementById('time-display')
    if ($time) $time.textContent = `${formatTime(0)} / ${formatTime(dur)}`
    const containerWidth = document.getElementById('waveform')?.clientWidth || 0
    // -1px de marge : évite qu'un arrondi ceil() interne à wavesurfer (scrollWidth vs
    // clientWidth) ne déclenche une barre de scroll fantôme dès le niveau ×1 (fit exact).
    waveZoom.fitPxPerSec = dur > 0 && containerWidth > 1 ? (containerWidth - 1) / dur : 0
    applyZoom(1)
    trimMarkers.trimStart = 0
    trimMarkers.trimEnd = dur
    trimMarkers.cueInPos = 0
    trimMarkers.cueOutPos = dur
    trimMarkers.introPos = 0
    trimMarkers.keepRegion = regions.addRegion({ id: 'trim-keep', start: 0, end: dur, color: 'rgba(74,144,226,0.15)', drag: true, resize: true })
    trimMarkers.cueInRegion = regions.addRegion({ id: 'cue-in', start: 0, color: 'rgba(33,150,243,0.9)', drag: true, resize: false, content: markerLabel('DÉBUT', '#2196f3') })
    // Étiquette INTRO décalée verticalement (top 26px) : DÉBUT et INTRO démarrent tous
    // deux à 0 — sans décalage, une étiquette masquerait l'autre et volerait son drag
    // (même problème que SKIP/INTRO superposés dans l'éditeur du site).
    trimMarkers.introRegion = regions.addRegion({ id: 'intro-end', start: 0, color: 'rgba(255,152,0,0.9)', drag: true, resize: false, content: markerLabel('INTRO', '#ff9800', 26) })
    trimMarkers.cueOutRegion = regions.addRegion({ id: 'cue-out', start: dur, color: 'rgba(244,67,54,0.9)', drag: true, resize: false, content: markerLabel('TRANSITION', '#f44336') })
    // Applique l'interactivité du mode courant (les régions viennent seulement d'exister) —
    // en mode 'cue' par défaut, comportement identique à avant l'éditeur unifié.
    ensureVolumeOverlay()
    updateVolumeOverlayVisibility()
    ensureFadeOverlay()
    updateFadeOverlayVisibility()
    setEditorMode(trimMarkers.mode)
    updateSummary()
    onReady?.()
  })

  wavesurfer.on('timeupdate', (t) => {
    document.getElementById('time-display').textContent = `${formatTime(t)} / ${formatTime(wavesurfer.getDuration())}`
    // Toujours appelée (pas seulement si volumePoints.length) : sinon un fondu réglé sans
    // courbe de volume ne s'entendait jamais à la lecture — se réduit naturellement au
    // volume de base quand ni fondu ni courbe ne sont actifs (gains à 1.0).
    updatePreviewVolume(t)
  })

  regions.on('region-updated', onRegionMoved)
  regions.on('region-update', onRegionMoved)

  document.getElementById('btn-playpause').onclick = () => wavesurfer.playPause()
  document.getElementById('btn-stop').onclick = () => wavesurfer.stop()
  document.getElementById('btn-zoom-in').onclick = () => applyZoom(waveZoom.level * 2)
  document.getElementById('btn-zoom-out').onclick = () => applyZoom(waveZoom.level / 2)
  document.getElementById('btn-zoom-reset').onclick = () => applyZoom(1)
  document.getElementById('btn-preview-start').onclick = () => {
    wavesurfer.setTime(trimMarkers.cueInPos)
    wavesurfer.play()
    setTimeout(() => wavesurfer?.pause(), 3000)
  }
  document.getElementById('btn-preview-end').onclick = () => {
    const from = Math.max(trimMarkers.cueOutPos - 3, trimMarkers.trimStart)
    wavesurfer.setTime(from)
    wavesurfer.play()
    setTimeout(() => wavesurfer?.pause(), 3000)
  }
}

function markerLabel(text, color, top = 2) {
  const el = document.createElement('div')
  // top POSITIF (à l'intérieur de la piste) : le conteneur de scroll de wavesurfer est en
  // overflow hidden — à top:-22px (au-dessus de la piste) l'étiquette était rognée, donc
  // invisible ET impossible à saisir (elle est la vraie poignée de drag du marqueur).
  // Même contrainte que le triangle du curseur, cf. commentaire ::part(cursor) de style.css.
  // `top` paramétrable : étiquettes superposées au même instant (DÉBUT/INTRO à 0) empilées
  // verticalement pour rester saisissables toutes les deux.
  el.style.cssText = `background:${color};color:#fff;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:bold;white-space:nowrap;cursor:ew-resize;position:absolute;top:${top}px;left:50%;transform:translateX(-50%);user-select:none;`
  el.textContent = text
  return el
}

function onRegionMoved(region) {
  if (!trimMarkers || trimMarkers.updating) return
  const dur = wavesurfer.getDuration()

  if (region.id === 'trim-keep') {
    const prevStart = trimMarkers.trimStart
    const prevEnd = trimMarkers.trimEnd
    const start = Math.max(0, Math.min(region.start, dur - 0.2))
    const end = Math.max(start + 0.2, Math.min(region.end, dur))
    trimMarkers.trimStart = start
    trimMarkers.trimEnd = end
    // Les marqueurs DÉBUT/TRANSITION suivent le bord qu'ils accompagnent (delta, pas un
    // simple clamp) : sinon, resserrer puis rouvrir la zone bleue faisait "sauter" la durée
    // affichée (clampCueMarkers écrasait cueOutPos de façon irréversible en rétrécissant,
    // sans jamais le restaurer en ré-agrandissant).
    trimMarkers.cueInPos += start - prevStart
    trimMarkers.introPos += start - prevStart
    trimMarkers.cueOutPos += end - prevEnd
    if (Math.abs(region.start - start) > 0.01 || Math.abs(region.end - end) > 0.01) {
      trimMarkers.updating = true
      region.setOptions({ start, end })
      trimMarkers.updating = false
    }
    clampCueMarkers()
    trimMarkers.updating = true
    trimMarkers.cueInRegion?.setOptions({ start: trimMarkers.cueInPos })
    trimMarkers.introRegion?.setOptions({ start: trimMarkers.introPos })
    trimMarkers.cueOutRegion?.setOptions({ start: trimMarkers.cueOutPos })
    trimMarkers.updating = false
  } else if (region.id === 'cue-in') {
    const clamped = Math.max(trimMarkers.trimStart, Math.min(region.start, trimMarkers.cueOutPos - 0.1))
    trimMarkers.cueInPos = clamped
    if (Math.abs(region.start - clamped) > 0.01) {
      trimMarkers.updating = true
      region.setOptions({ start: clamped })
      trimMarkers.updating = false
    }
    // L'intro ne peut pas finir avant le début (sémantique site : intro ≥ cue_in)
    if (trimMarkers.introPos < clamped) {
      trimMarkers.introPos = clamped
      trimMarkers.updating = true
      trimMarkers.introRegion?.setOptions({ start: clamped })
      trimMarkers.updating = false
    }
  } else if (region.id === 'intro-end') {
    const clamped = Math.max(trimMarkers.cueInPos, Math.min(region.start, trimMarkers.trimEnd))
    trimMarkers.introPos = clamped
    if (Math.abs(region.start - clamped) > 0.01) {
      trimMarkers.updating = true
      region.setOptions({ start: clamped })
      trimMarkers.updating = false
    }
  } else if (region.id === 'cue-out') {
    const clamped = Math.min(trimMarkers.trimEnd, Math.max(region.start, trimMarkers.cueInPos + 0.1))
    trimMarkers.cueOutPos = clamped
    if (Math.abs(region.start - clamped) > 0.01) {
      trimMarkers.updating = true
      region.setOptions({ start: clamped })
      trimMarkers.updating = false
    }
  } else if (region.id === 'overlay-zone') {
    const start = Math.max(trimMarkers.trimStart, Math.min(region.start, trimMarkers.trimEnd - 0.2))
    const end = Math.min(trimMarkers.trimEnd, Math.max(region.end, start + 0.2))
    trimMarkers.overlayStart = start
    trimMarkers.overlayEnd = end
    trimMarkers.overlayTouched = true
    if (Math.abs(region.start - start) > 0.01 || Math.abs(region.end - end) > 0.01) {
      trimMarkers.updating = true
      region.setOptions({ start, end })
      trimMarkers.updating = false
    }
    updateOverlayInfo()
  } else if (String(region.id).startsWith('cut-')) {
    const start = Math.max(trimMarkers.trimStart, Math.min(region.start, trimMarkers.trimEnd - 0.1))
    const end = Math.min(trimMarkers.trimEnd, Math.max(region.end, start + 0.1))
    if (Math.abs(region.start - start) > 0.01 || Math.abs(region.end - end) > 0.01) {
      trimMarkers.updating = true
      region.setOptions({ start, end })
      trimMarkers.updating = false
    }
    updateCutList()
  }
  updateSummary()
}

function clampCueMarkers() {
  const newIn = Math.max(trimMarkers.trimStart, Math.min(trimMarkers.cueInPos, trimMarkers.trimEnd - 0.1))
  const newOut = Math.min(trimMarkers.trimEnd, Math.max(trimMarkers.cueOutPos, trimMarkers.trimStart + 0.1))
  if (Math.abs(newIn - trimMarkers.cueInPos) > 0.01) {
    trimMarkers.cueInPos = newIn
    trimMarkers.cueInRegion?.setOptions({ start: newIn })
  }
  if (Math.abs(newOut - trimMarkers.cueOutPos) > 0.01) {
    trimMarkers.cueOutPos = newOut
    trimMarkers.cueOutRegion?.setOptions({ start: newOut })
  }
  const newIntro = Math.max(trimMarkers.cueInPos, Math.min(trimMarkers.introPos, trimMarkers.trimEnd))
  if (Math.abs(newIntro - trimMarkers.introPos) > 0.01) {
    trimMarkers.introPos = newIntro
    trimMarkers.introRegion?.setOptions({ start: newIntro })
  }
}

function updateSummary() {
  if (!trimMarkers) return
  // « Zone conservée » = durée du fichier final : coupe tête/queue MOINS les coupes de montage.
  const totalCut = sortedCuts().reduce((s, c) => s + (c.end - c.start), 0)
  const kept = Math.max(0, trimMarkers.trimEnd - trimMarkers.trimStart - totalCut)
  const cueIn = Math.max(0, trimMarkers.cueInPos - trimMarkers.trimStart)
  const intro = Math.max(0, trimMarkers.introPos - trimMarkers.trimStart)
  const cueOut = Math.max(0, trimMarkers.trimEnd - trimMarkers.cueOutPos)
  const $kept = document.getElementById('sum-kept')
  const $in = document.getElementById('sum-cuein')
  const $intro = document.getElementById('sum-intro')
  const $out = document.getElementById('sum-cueout')
  if ($kept) $kept.textContent = formatTime(kept)
  if ($in) $in.textContent = formatTime(cueIn)
  if ($intro) $intro.textContent = formatTime(intro)
  if ($out) $out.textContent = formatTime(cueOut)
  // Synchronise les saisies numériques du mode cue — sauf celle en cours d'édition
  syncNumInput('inp-cuein', cueIn)
  syncNumInput('inp-intro', intro)
  syncNumInput('inp-cueout', cueOut)
}

function syncNumInput(id, valueSeconds) {
  const el = document.getElementById(id)
  if (el && document.activeElement !== el) el.value = valueSeconds.toFixed(2)
}

// ══ Éditeur unifié (v1.7) : modes, zone jingle intérieur, montage, volume & fondus ══════

function editorModeTabsHtml() {
  return `
    <div class="mode-tabs" id="mode-tabs">
      <button class="mode-tab active" data-mode="cue">🎯 Cue points</button>
      <button class="mode-tab" data-mode="jingle">📢 Jingle intérieur</button>
      <button class="mode-tab" data-mode="cut">✂️ Montage</button>
      <button class="mode-tab" data-mode="volume">🔊 Volume &amp; fondus</button>
    </div>`
}

function wireEditorModeTabs() {
  document.querySelectorAll('.mode-tab').forEach(el => {
    el.onclick = () => setEditorMode(el.dataset.mode)
  })
}

// Change le mode actif SANS re-render global : la waveform (et ses régions) doit survivre
// au changement de mode. Seuls le panneau bas et l'interactivité des régions changent —
// les régions des autres modes sont MASQUÉES (display:none), pas seulement rendues non
// cliquables : les laisser visibles (ancien comportement) laissait aussi leurs étiquettes
// et poignées (hitbox élargie des marqueurs DÉBUT/INTRO/TRANSITION) intercepter le drag
// des contrôles du mode actif — signalé : « on ne peut plus rien attraper » en changeant
// de mode. Le clic-seek et la sélection à la souris du mode montage passent au travers
// d'une région masquée de toute façon (display:none = hors du rendu ET du hit-test).
function setEditorMode(mode) {
  if (!trimMarkers) return
  trimMarkers.mode = mode
  document.querySelectorAll('.mode-tab').forEach(el => el.classList.toggle('active', el.dataset.mode === mode))

  const setActive = (region, active, withResize) => {
    if (!region) return
    const opts = { drag: active }
    if (withResize) opts.resize = active
    region.setOptions(opts)
    if (region.element) {
      region.element.style.pointerEvents = active ? 'all' : 'none'
      region.element.style.display = active ? '' : 'none'
    }
  }
  setActive(trimMarkers.keepRegion, mode === 'cue', true)
  setActive(trimMarkers.cueInRegion, mode === 'cue', false)
  setActive(trimMarkers.introRegion, mode === 'cue', false)
  setActive(trimMarkers.cueOutRegion, mode === 'cue', false)
  setActive(trimMarkers.overlayRegion, mode === 'jingle', true)
  trimMarkers.cuts.forEach(c => setActive(c.region, mode === 'cut', true))

  if (trimMarkers.disableDragSel) { trimMarkers.disableDragSel(); trimMarkers.disableDragSel = null }
  if (mode === 'cut' && trimMarkers.regionsPlugin) {
    trimMarkers.disableDragSel = trimMarkers.regionsPlugin.enableDragSelection({ color: CUT_COLOR })
  }

  if (mode === 'jingle') ensureVocalZones()

  // Mode volume : zoom verrouillé à ×1 — la courbe SVG est mappée sur la largeur visible,
  // elle n'est alignée avec la waveform qu'en vue non zoomée (pas de scroll horizontal).
  if (mode === 'volume') applyZoom(1)
  ;['btn-zoom-in', 'btn-zoom-out', 'btn-zoom-reset'].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.disabled = (mode === 'volume')
  })
  ensureVolumeOverlay()
  updateVolumeOverlayVisibility()
  renderVolumeCurve()
  ensureFadeOverlay()
  updateFadeOverlayVisibility()
  renderFadeOverlay()

  // "Tout réinitialiser" ne réinitialise que l'outil affiché (cf. resetCurrentMode) —
  // le libellé du bouton statique du controls-bar doit le refléter à chaque changement
  // de mode (signalé : un "Tout réinitialiser" qui remettait tous les outils à zéro,
  // pas seulement celui affiché, était trompeur et destructif pour le travail déjà fait
  // sur les autres outils).
  const $reset = document.getElementById('btn-reset')
  if ($reset) $reset.textContent = RESET_LABELS[mode] || RESET_LABELS.cue

  renderModePanel()
}

// Libellés de #btn-reset par mode — cf. resetCurrentMode().
const RESET_LABELS = {
  cue: '↺ Réinitialiser les cue points',
  jingle: '↺ Réinitialiser la zone jingle',
  cut: '↺ Réinitialiser le montage',
  volume: '↺ Réinitialiser volume & fondus',
}

// Remplace trimMarkers.resetToFull() comme action du bouton #btn-reset : ne remet à zéro
// QUE le plan de l'outil actif, pas tous les outils à la fois (signalé : un fondu réglé en
// mode volume ne devrait pas disparaître parce qu'on clique "réinitialiser" en mode cue).
function resetCurrentMode() {
  if (!trimMarkers || !wavesurfer) return
  const dur = wavesurfer.getDuration()
  const mode = trimMarkers.mode
  if (mode === 'cue') {
    trimMarkers.trimStart = 0; trimMarkers.trimEnd = dur
    trimMarkers.cueInPos = 0; trimMarkers.cueOutPos = dur; trimMarkers.introPos = 0
    trimMarkers.updating = true
    trimMarkers.keepRegion?.setOptions({ start: 0, end: dur })
    trimMarkers.cueInRegion?.setOptions({ start: 0 })
    trimMarkers.introRegion?.setOptions({ start: 0 })
    trimMarkers.cueOutRegion?.setOptions({ start: dur })
    trimMarkers.updating = false
  } else if (mode === 'jingle') {
    if (trimMarkers.overlayRegion) { trimMarkers.overlayRegion.remove(); trimMarkers.overlayRegion = null }
    trimMarkers.overlayStart = null
    trimMarkers.overlayEnd = null
    trimMarkers.overlayTouched = true
  } else if (mode === 'cut') {
    trimMarkers.cuts.forEach(c => c.region.remove())
    trimMarkers.cuts = []
    updateCutList()
  } else if (mode === 'volume') {
    trimMarkers.volumeDb = 0; trimMarkers.fadeInMs = 0; trimMarkers.fadeOutMs = 0
    trimMarkers.fadeInCurve = 'tri'; trimMarkers.fadeOutCurve = 'tri'
    trimMarkers.volumePoints = []
    renderVolumeCurve()
    updateVolumeOverlayVisibility()
    renderFadeOverlay()
    wavesurfer.setVolume(1)
  }
  renderModePanel()
  updateSummary()
}

function renderModePanel() {
  const $panel = document.getElementById('mode-panel')
  if (!$panel || !trimMarkers) return
  const mode = trimMarkers.mode

  if (mode === 'cue') {
    $panel.innerHTML = `
      <p class="hint mode-hint">
        <strong>Zone bleue</strong> (toute la piste par défaut) : glissez ses bords pour couper
        le silence/déchet en tête/queue — coupe définitive, avant l'envoi.
        <strong>DÉBUT</strong> (cyan) / <strong>INTRO</strong> (orange, fin de l'intro parlée/instrumentale)
        / <strong>TRANSITION</strong> (rouge) : cue points, aucun n'est obligatoire, affinables après import.
        ${editorContext?.flow === 'files' ? '« Détecter automatiquement » propose des positions à partir des silences détectés. ' : ''}
        Zoomez (➕/➖) pour les placer avec précision.
        Raccourcis pendant la lecture : <strong>Espace</strong> lecture/pause,
        <strong>I</strong> pose DÉBUT, <strong>N</strong> pose INTRO, <strong>O</strong> pose TRANSITION.
      </p>
      <div class="panel-row">
        <label class="panel-field">Début (s)
          <input type="number" id="inp-cuein" min="0" step="0.01" value="${(trimMarkers.cueInPos - trimMarkers.trimStart).toFixed(2)}">
        </label>
        <label class="panel-field">Fin d'intro (s)
          <input type="number" id="inp-intro" min="0" step="0.01" value="${(trimMarkers.introPos - trimMarkers.trimStart).toFixed(2)}">
        </label>
        <label class="panel-field">Transition avant fin (s)
          <input type="number" id="inp-cueout" min="0" step="0.01" value="${(trimMarkers.trimEnd - trimMarkers.cueOutPos).toFixed(2)}">
        </label>
        ${editorContext?.flow === 'files' ? '<button class="btn-ctrl" id="btn-auto-cue">🔍 Détecter les silences (Début/Transition)</button>' : ''}
      </div>`
    if (editorContext?.flow === 'files') {
      document.getElementById('btn-auto-cue').onclick = () => autoDetectCue()
    }
    document.getElementById('inp-cuein').onchange = (e) => {
      const v = Math.max(0, Number(e.target.value) || 0)
      const pos = Math.max(trimMarkers.trimStart, Math.min(trimMarkers.trimStart + v, trimMarkers.cueOutPos - 0.1))
      trimMarkers.cueInPos = pos
      trimMarkers.updating = true
      trimMarkers.cueInRegion?.setOptions({ start: pos })
      trimMarkers.updating = false
      clampCueMarkers()
      updateSummary()
    }
    document.getElementById('inp-intro').onchange = (e) => {
      const v = Math.max(0, Number(e.target.value) || 0)
      const pos = Math.max(trimMarkers.cueInPos, Math.min(trimMarkers.trimStart + v, trimMarkers.trimEnd))
      trimMarkers.introPos = pos
      trimMarkers.updating = true
      trimMarkers.introRegion?.setOptions({ start: pos })
      trimMarkers.updating = false
      updateSummary()
    }
    document.getElementById('inp-cueout').onchange = (e) => {
      const v = Math.max(0, Number(e.target.value) || 0)
      const pos = Math.min(trimMarkers.trimEnd, Math.max(trimMarkers.trimEnd - v, trimMarkers.cueInPos + 0.1))
      trimMarkers.cueOutPos = pos
      trimMarkers.updating = true
      trimMarkers.cueOutRegion?.setOptions({ start: pos })
      trimMarkers.updating = false
      updateSummary()
    }
    return
  }

  if (mode === 'jingle') {
    const hasZone = trimMarkers.overlayStart != null
    const zones = trimMarkers.vocalZones
    const detectInfo = trimMarkers.vocalLoading
      ? '⏳ Analyse de la voix en cours…'
      : zones === null
        ? ''
        : zones.length
          ? `${zones.length} passage(s) sans voix détecté(s).`
          : 'Aucun passage sans voix détecté sur cette piste.'
    $panel.innerHTML = `
      <p class="hint mode-hint">
        <strong>Zone verte (JINGLE)</strong> : passage sans voix où la radio pourra superposer
        un jingle pendant la diffusion (« jingle intérieur »). Glissez la zone ou ses bords.
        Enregistrée à l'import, modifiable ensuite sur le site.
      </p>
      <div class="panel-row">
        <button class="btn-ctrl" id="btn-overlay-suggest" ${trimMarkers.vocalLoading || !(zones && zones.length) ? 'disabled' : ''}>📢 Proposer depuis la voix détectée</button>
        <button class="btn-ctrl" id="btn-overlay-add" ${hasZone ? 'disabled' : ''} title="Pose une zone de 8 s à la position de lecture">➕ Poser une zone</button>
        <button class="btn-ctrl" id="btn-overlay-remove" ${hasZone ? '' : 'disabled'}>Supprimer la zone</button>
        <span class="panel-info" id="overlay-info"></span>
        <span class="panel-info">${detectInfo}</span>
      </div>`
    updateOverlayInfo()
    const $suggest = document.getElementById('btn-overlay-suggest')
    if ($suggest) $suggest.onclick = () => applyBestVocalZone(true)
    const $add = document.getElementById('btn-overlay-add')
    if ($add) $add.onclick = addManualOverlayZone
    const $remove = document.getElementById('btn-overlay-remove')
    if ($remove) $remove.onclick = removeOverlayZone
    return
  }

  if (mode === 'cut') {
    $panel.innerHTML = `
      <p class="hint mode-hint">
        <strong>Montage</strong> : cliquez-glissez sur la forme d'onde pour marquer un passage
        à supprimer (zone rouge). Les passages marqués sont retirés définitivement du fichier
        envoyé — cue points et zone jingle sont recalés automatiquement.
      </p>
      <div class="panel-row"><div class="cut-list" id="cut-list"></div></div>`
    updateCutList()
    return
  }

  // mode === 'volume'
  const curveOptions = (selected) => FADE_CURVES
    .map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${label}</option>`).join('')
  const volLabel = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
  const nPoints = trimMarkers.volumePoints.length
  $panel.innerHTML = `
    <p class="hint mode-hint">
      <strong>Volume &amp; fondus</strong> : appliqués définitivement au fichier envoyé.
      <strong>Courbe de volume</strong> : cliquez sur la ligne jaune de la forme d'onde pour
      ajouter un point, glissez pour déplacer, Ctrl+clic (ou clic droit) pour supprimer —
      le zoom est verrouillé dans ce mode. Le volume s'entend à la lecture (aperçu limité
      aux baisses) ; les fondus ne sont pas prévisualisés.
    </p>
    <div class="panel-row">
      <span class="panel-info">Courbe : <strong>${nPoints}</strong> point(s)</span>
      <button class="btn-ctrl" id="btn-vol-clear" ${nPoints ? '' : 'disabled'}>Effacer la courbe</button>
    </div>
    <div class="panel-row volume-row">
      <label class="panel-field">Volume
        <input type="range" id="vol-slider" min="-12" max="12" step="0.5" value="${trimMarkers.volumeDb}">
        <strong id="vol-value">${volLabel(trimMarkers.volumeDb)}</strong>
      </label>
      <label class="panel-field">Fondu d'entrée
        <input type="number" id="fade-in-s" min="0" max="30" step="0.1" value="${(trimMarkers.fadeInMs / 1000).toFixed(1)}"> s
        <select id="fade-in-curve">${curveOptions(trimMarkers.fadeInCurve)}</select>
      </label>
      <label class="panel-field">Fondu de sortie
        <input type="number" id="fade-out-s" min="0" max="30" step="0.1" value="${(trimMarkers.fadeOutMs / 1000).toFixed(1)}"> s
        <select id="fade-out-curve">${curveOptions(trimMarkers.fadeOutCurve)}</select>
      </label>
    </div>`
  const $vol = document.getElementById('vol-slider')
  $vol.oninput = () => {
    trimMarkers.volumeDb = Number($vol.value) || 0
    document.getElementById('vol-value').textContent = volLabel(trimMarkers.volumeDb)
    // Aperçu à la lecture : le volume d'un élément média est plafonné à 1, seule une
    // baisse est donc réellement audible ici — le gain positif ne s'applique qu'au rendu.
    updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
  }
  const $volClear = document.getElementById('btn-vol-clear')
  if ($volClear) $volClear.onclick = () => {
    trimMarkers.volumePoints = []
    renderVolumeCurve()
    updateVolumeOverlayVisibility()
    renderModePanel()
    updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
  }
  document.getElementById('fade-in-s').onchange = (e) => {
    trimMarkers.fadeInMs = Math.max(0, Math.min(30, Number(e.target.value) || 0)) * 1000
    renderFadeOverlay()
    updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
  }
  document.getElementById('fade-out-s').onchange = (e) => {
    trimMarkers.fadeOutMs = Math.max(0, Math.min(30, Number(e.target.value) || 0)) * 1000
    renderFadeOverlay()
    updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
  }
  document.getElementById('fade-in-curve').onchange = (e) => {
    trimMarkers.fadeInCurve = e.target.value
    renderFadeOverlay()
    updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
  }
  document.getElementById('fade-out-curve').onchange = (e) => {
    trimMarkers.fadeOutCurve = e.target.value
    renderFadeOverlay()
    updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
  }
}

function updateOverlayInfo() {
  const $info = document.getElementById('overlay-info')
  if (!$info || !trimMarkers) return
  if (trimMarkers.overlayStart != null) {
    const len = trimMarkers.overlayEnd - trimMarkers.overlayStart
    $info.textContent = `Zone : ${formatTime(trimMarkers.overlayStart)} → ${formatTime(trimMarkers.overlayEnd)} (${len.toFixed(1)} s)`
  } else {
    $info.textContent = 'Aucune zone posée.'
  }
  const $remove = document.getElementById('btn-overlay-remove')
  if ($remove) $remove.disabled = trimMarkers.overlayStart == null
}

function updateCutList() {
  const $list = document.getElementById('cut-list')
  if (!$list || !trimMarkers) return
  if (!trimMarkers.cuts.length) {
    $list.innerHTML = '<span class="panel-info">Aucune coupe.</span>'
    return
  }
  $list.innerHTML = trimMarkers.cuts.map((c, i) => `
    <div class="cut-row">
      <span>Coupe ${i + 1} : ${formatTime(c.region.start)} → ${formatTime(c.region.end)}
        (${(c.region.end - c.region.start).toFixed(1)} s)</span>
      <button class="btn-ctrl btn-cut-delete" data-cut-id="${c.id}">🗑 Supprimer</button>
    </div>`).join('')
  $list.querySelectorAll('.btn-cut-delete').forEach(el => {
    el.onclick = () => {
      const idx = trimMarkers.cuts.findIndex(c => c.id === el.dataset.cutId)
      if (idx === -1) return
      trimMarkers.cuts[idx].region.remove()
      trimMarkers.cuts.splice(idx, 1)
      updateCutList()
      updateSummary()
    }
  })
}

// Région fraîchement créée à la souris (mode montage) → clampée aux bornes de la zone
// conservée puis suivie comme coupe. Trop petite = geste raté, on la jette.
function adoptCutRegion(region) {
  if (!trimMarkers || !wavesurfer) { region.remove(); return }
  const start = Math.max(trimMarkers.trimStart, Math.min(region.start, trimMarkers.trimEnd))
  const end = Math.min(trimMarkers.trimEnd, Math.max(region.end, start))
  if (end - start < 0.1) { region.remove(); return }
  trimMarkers.cutSeq += 1
  const id = `cut-${trimMarkers.cutSeq}`
  trimMarkers.updating = true
  region.setOptions({ id, start, end, color: CUT_COLOR, content: regionTag('✂ COUPE', '#c62828') })
  trimMarkers.updating = false
  if (region.element) region.element.style.pointerEvents = 'all'
  trimMarkers.cuts.push({ id, region })
  updateCutList()
  updateSummary()
}

// Étiquette posée DANS une région étendue (jingle/coupe) — même contrainte que
// markerLabel : rester à l'intérieur de la piste (overflow hidden du conteneur de scroll).
function regionTag(text, color) {
  const el = document.createElement('div')
  el.style.cssText = `background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:bold;white-space:nowrap;position:absolute;top:2px;left:50%;transform:translateX(-50%);user-select:none;pointer-events:none;`
  el.textContent = text
  return el
}

// ---- Courbe d'automation de volume superposée à la waveform (v1.9) ─────────────
// Portage vanilla JS de VolumeAutomationEditor.vue du site : SVG absolu au-dessus de la
// forme d'onde, gain linéaire par morceaux. Points en timeline ORIGINALE de la waveform,
// remappés (toFinal) au moment de l'envoi comme les cue points. ⚠️ La courbe est mappée
// sur la largeur visible : alignée uniquement à zoom ×1 → zoom verrouillé en mode volume.

const VOL_DB_MAX = 12
const VOL_DB_MIN = -60
const VOL_DB_RANGE = VOL_DB_MAX - VOL_DB_MIN
const VOL_GRIDLINES = [-48, -24, -12, 0, 6]

let volOverlay = null // { host, svg, clearBtn } — recréé à chaque nouvelle piste

function volDbToLinear(db) { return Math.pow(10, db / 20) }

function volumeGainAt(tMs) {
  const pts = [...trimMarkers.volumePoints].sort((a, b) => a.timeMs - b.timeMs)
  if (!pts.length) return 1.0
  if (tMs <= pts[0].timeMs) return volDbToLinear(pts[0].db)
  if (tMs >= pts[pts.length - 1].timeMs) return volDbToLinear(pts[pts.length - 1].db)
  for (let i = 0; i < pts.length - 1; i++) {
    if (tMs >= pts[i].timeMs && tMs < pts[i + 1].timeMs) {
      const frac = (tMs - pts[i].timeMs) / (pts[i + 1].timeMs - pts[i].timeMs)
      return volDbToLinear(pts[i].db) + (volDbToLinear(pts[i + 1].db) - volDbToLinear(pts[i].db)) * frac
    }
  }
  return 1.0
}

// Gain du fondu d'entrée/sortie au temps donné (s) — 1.0 hors zone de fondu. Réutilise
// fadeGainAt/FADE_CURVE_FN (définis plus bas, déclarations hoistées) : même formule que
// le tracé pointillé de renderFadeOverlay, pour que ce qu'on entend corresponde à ce
// qu'on voit.
function fadeGainAtSeconds(tSeconds) {
  if (!trimMarkers) return 1.0
  const fadeInS = trimMarkers.fadeInMs / 1000
  if (fadeInS > 0 && tSeconds < fadeInS) return fadeGainAt(trimMarkers.fadeInCurve, tSeconds / fadeInS)
  const fadeOutS = trimMarkers.fadeOutMs / 1000
  const dur = wavesurfer?.getDuration() || 0
  if (fadeOutS > 0 && tSeconds > dur - fadeOutS) return fadeGainAt(trimMarkers.fadeOutCurve, (dur - tSeconds) / fadeOutS)
  return 1.0
}

// Volume de lecture effectif = slider global (dB, plafonné à 1) × courbe normalisée par
// son max (les gains > 0 dB ne sont pas prévisualisables, volume média plafonné) × fondu
// d'entrée/sortie. Sans ce dernier facteur, on réglait un fondu « à l'aveugle » (symptôme
// signalé : aucun rendu audio avant Enregistrer, contrairement à la courbe de volume).
function updatePreviewVolume(tSeconds) {
  if (!wavesurfer || !trimMarkers) return
  let v = Math.min(1, Math.pow(10, (trimMarkers.volumeDb || 0) / 20))
  if (trimMarkers.volumePoints.length) {
    const maxGain = Math.max(1, ...trimMarkers.volumePoints.map(p => volDbToLinear(p.db)))
    v *= Math.min(1, volumeGainAt(tSeconds * 1000) / maxGain)
  }
  v *= fadeGainAtSeconds(tSeconds)
  wavesurfer.setVolume(Math.max(0, Math.min(1, v)))
}

function ensureVolumeOverlay() {
  if (volOverlay) return volOverlay
  const $wf = document.getElementById('waveform')
  if (!$wf) return null
  const host = document.createElement('div')
  host.className = 'vol-overlay'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'vol-svg')
  host.appendChild(svg)
  const clearBtn = document.createElement('button')
  clearBtn.className = 'vol-clear-btn'
  clearBtn.textContent = 'Effacer la courbe'
  clearBtn.onclick = (e) => {
    e.stopPropagation()
    trimMarkers.volumePoints = []
    renderVolumeCurve()
    renderModePanel()
    updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
  }
  host.appendChild(clearBtn)
  $wf.appendChild(host)
  volOverlay = { host, svg, clearBtn }
  renderVolumeCurve()
  return volOverlay
}

function updateVolumeOverlayVisibility() {
  if (!volOverlay || !trimMarkers) return
  const active = trimMarkers.mode === 'volume'
  // Courbe visible dès qu'il y a des points (informative), interactive en mode volume seul.
  volOverlay.host.style.display = (active || trimMarkers.volumePoints.length) ? '' : 'none'
  volOverlay.host.classList.toggle('vol-locked', !active)
  volOverlay.clearBtn.style.display = active && trimMarkers.volumePoints.length ? '' : 'none'
}

function renderVolumeCurve() {
  if (!volOverlay || !wavesurfer || !trimMarkers) return
  const w = volOverlay.host.clientWidth || 600
  const h = volOverlay.host.clientHeight || 140
  const dur = wavesurfer.getDuration() || 1
  const dbToY = (db) => ((VOL_DB_MAX - db) / VOL_DB_RANGE) * h
  const timeToX = (tMs) => (tMs / (dur * 1000)) * w

  const pts = [...trimMarkers.volumePoints].sort((a, b) => a.timeMs - b.timeMs)
  const curve = []
  if (pts.length) {
    curve.push([0, dbToY(pts[0].db)])
    for (const p of pts) curve.push([timeToX(p.timeMs), dbToY(p.db)])
    curve.push([w, dbToY(pts[pts.length - 1].db)])
  }
  const poly = curve.map(([x, y]) => `${x},${y}`).join(' ')
  const y0 = dbToY(0)

  let inner = ''
  for (const db of VOL_GRIDLINES) {
    inner += `<line x1="0" x2="${w}" y1="${dbToY(db)}" y2="${dbToY(db)}" class="${db === 0 ? 'vol-zero' : 'vol-grid'}" style="pointer-events:none"></line>`
    inner += `<text x="4" y="${dbToY(db) - 2}" class="vol-label" style="pointer-events:none">${db >= 0 ? '+' + db : db}dB</text>`
  }
  if (curve.length >= 2) {
    let fill = `M ${curve[0][0]} ${y0} L ${poly.split(' ').join(' L ')} L ${curve[curve.length - 1][0]} ${y0} Z`
    inner += `<path d="${fill}" class="vol-fill" style="pointer-events:none"></path>`
    inner += `<polyline points="${poly}" class="vol-line" style="pointer-events:none"></polyline>`
    inner += `<polyline points="${poly}" class="vol-hit" data-role="hit"></polyline>`
  } else {
    inner += `<line x1="0" x2="${w}" y1="${y0}" y2="${y0}" class="vol-zero" style="pointer-events:none"></line>`
    inner += `<line x1="0" x2="${w}" y1="${y0}" y2="${y0}" class="vol-hit" data-role="hit"></line>`
  }
  pts.forEach((p) => {
    const i = trimMarkers.volumePoints.indexOf(p)
    inner += `<circle cx="${timeToX(p.timeMs)}" cy="${dbToY(p.db)}" r="6" class="vol-point" data-idx="${i}"></circle>`
  })
  volOverlay.svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  volOverlay.svg.setAttribute('width', w)
  volOverlay.svg.setAttribute('height', h)
  volOverlay.svg.innerHTML = inner

  const svgPoint = (evt) => {
    const r = volOverlay.svg.getBoundingClientRect()
    return { x: evt.clientX - r.left, y: evt.clientY - r.top }
  }
  const yToDb = (y) => Math.max(VOL_DB_MIN, Math.min(VOL_DB_MAX, VOL_DB_MAX - (y / h) * VOL_DB_RANGE))
  const xToTimeMs = (x) => Math.max(0, Math.min(dur * 1000, Math.round((x / w) * dur * 1000)))

  volOverlay.svg.querySelectorAll('[data-role="hit"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const { x, y } = svgPoint(e)
      trimMarkers.volumePoints.push({ timeMs: xToTimeMs(x), db: Math.round(yToDb(y) * 10) / 10 })
      renderVolumeCurve()
      renderModePanel()
      updateVolumeOverlayVisibility()
    })
  })
  volOverlay.svg.querySelectorAll('.vol-point').forEach(el => {
    const idx = Number(el.dataset.idx)
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); deleteVolumePoint(idx) })
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) { deleteVolumePoint(idx); return }
      const onMove = (me) => {
        const { x, y } = svgPoint(me)
        trimMarkers.volumePoints[idx] = { timeMs: xToTimeMs(x), db: Math.round(yToDb(y) * 10) / 10 }
        renderVolumeCurve()
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        renderModePanel()
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  })
}

function deleteVolumePoint(idx) {
  trimMarkers.volumePoints.splice(idx, 1)
  renderVolumeCurve()
  renderModePanel()
  updateVolumeOverlayVisibility()
  updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
}

// ---- Poignées de fondu draggables « façon Pro Tools » (parité site) ───────────
// Superposées à la waveform en mode volume (zoom verrouillé, comme la courbe
// d'automation) : la durée du fondu se règle en glissant la poignée depuis le
// coin haut du début/de la fin de piste. Courbe pointillée + zone ombrée
// redessinées en direct pendant le drag — pas de redessin des barres de la
// waveform elle-même (peaks) : coûteux pour un gain visuel marginal, ce
// ombrage donne le même repère immédiat sans manipuler les données audio.

const FADE_N_SAMPLES = 20
const FADE_MIN_GAP_S = 0.05 // écart minimal entre fin du fondu d'entrée et début du fondu de sortie
const FADE_MAX_S = 30 // même borne que l'attribut max des champs #fade-in-s/#fade-out-s

// Approximations visuelles des courbes ffmpeg (afade) — le rendu réel est fait côté
// serveur avec le même nom de courbe : simple repère visuel, pas besoin de reproduire
// la formule exacte.
const FADE_CURVE_FN = {
  tri: x => x,
  qsin: x => Math.sin(x * Math.PI / 2),
  esin: x => 1 - Math.cos(x * Math.PI / 2),
  exp: x => x * x,
  log: x => Math.log10(1 + 9 * x),
}

function fadeGainAt(curve, x) {
  const fn = FADE_CURVE_FN[curve] || FADE_CURVE_FN.tri
  return Math.max(0, Math.min(1, fn(Math.max(0, Math.min(1, x)))))
}

let fadeOverlay = null // { host, svg } — recréé à chaque nouvelle piste
let fadeDragging = null // 'in' | 'out' | null

function ensureFadeOverlay() {
  if (fadeOverlay) return fadeOverlay
  const $wf = document.getElementById('waveform')
  if (!$wf) return null
  const host = document.createElement('div')
  host.className = 'fade-overlay'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'fade-svg')
  host.appendChild(svg)
  $wf.appendChild(host)
  fadeOverlay = { host, svg }
  renderFadeOverlay()
  return fadeOverlay
}

function updateFadeOverlayVisibility() {
  if (!fadeOverlay || !trimMarkers) return
  fadeOverlay.host.style.display = trimMarkers.mode === 'volume' ? '' : 'none'
}

function renderFadeOverlay() {
  if (!fadeOverlay || !wavesurfer || !trimMarkers) return
  const w = fadeOverlay.host.clientWidth || 600
  const h = fadeOverlay.host.clientHeight || 140
  const dur = wavesurfer.getDuration() || 1
  const durMs = dur * 1000
  const timeToX = (ms) => (ms / durMs) * w
  const poly = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' L ')

  const inEndX = timeToX(trimMarkers.fadeInMs)
  const inPts = []
  for (let i = 0; i <= FADE_N_SAMPLES; i++) {
    const frac = i / FADE_N_SAMPLES
    inPts.push([frac * inEndX, (1 - fadeGainAt(trimMarkers.fadeInCurve, frac)) * h])
  }
  const outStartX = w - timeToX(trimMarkers.fadeOutMs)
  const outPts = []
  for (let i = 0; i <= FADE_N_SAMPLES; i++) {
    const frac = i / FADE_N_SAMPLES
    outPts.push([outStartX + frac * (w - outStartX), (1 - fadeGainAt(trimMarkers.fadeOutCurve, 1 - frac)) * h])
  }

  let inner = ''
  if (inPts.length >= 2) {
    inner += `<path d="M 0,0 L ${poly(inPts)} L ${inEndX},0 Z" class="fade-fill"></path>`
    inner += `<path d="M ${poly(inPts)}" class="fade-dash"></path>`
  }
  if (outPts.length >= 2) {
    inner += `<path d="M ${w},0 L ${poly(outPts)} L ${outStartX},0 Z" class="fade-fill"></path>`
    inner += `<path d="M ${poly(outPts)}" class="fade-dash"></path>`
  }
  inner += `<g class="fade-handle-hit" data-side="in"><circle cx="${inEndX}" cy="0" r="${fadeDragging === 'in' ? 9 : 7}" class="fade-handle${fadeDragging === 'in' ? ' fade-handle-active' : ''}"></circle></g>`
  inner += `<g class="fade-handle-hit" data-side="out"><circle cx="${outStartX}" cy="0" r="${fadeDragging === 'out' ? 9 : 7}" class="fade-handle${fadeDragging === 'out' ? ' fade-handle-active' : ''}"></circle></g>`

  fadeOverlay.svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  fadeOverlay.svg.setAttribute('width', w)
  fadeOverlay.svg.setAttribute('height', h)
  fadeOverlay.svg.innerHTML = inner

  const svgX = (evt) => evt.clientX - fadeOverlay.svg.getBoundingClientRect().left
  const xToTimeMs = (x) => Math.max(0, Math.min(durMs, (x / w) * durMs))

  fadeOverlay.svg.querySelectorAll('.fade-handle-hit').forEach(el => {
    const side = el.dataset.side
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      fadeDragging = side
      renderFadeOverlay()
      const fadeInS0 = trimMarkers.fadeInMs / 1000
      const fadeOutS0 = trimMarkers.fadeOutMs / 1000
      const onMove = (me) => {
        const x = svgX(me)
        if (side === 'in') {
          const maxS = Math.max(0, Math.min(FADE_MAX_S, dur - fadeOutS0 - FADE_MIN_GAP_S))
          trimMarkers.fadeInMs = Math.round(Math.min(maxS, xToTimeMs(x) / 1000) * 1000)
        } else {
          const maxS = Math.max(0, Math.min(FADE_MAX_S, dur - fadeInS0 - FADE_MIN_GAP_S))
          const fromEnd = Math.min(maxS, (durMs - xToTimeMs(x)) / 1000)
          trimMarkers.fadeOutMs = Math.round(fromEnd * 1000)
        }
        renderFadeOverlay()
        syncFadeInputs()
        updatePreviewVolume(wavesurfer?.getCurrentTime() || 0)
      }
      const onUp = () => {
        fadeDragging = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        renderFadeOverlay()
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  })
}

// Synchronise les champs numériques du panneau pendant le drag, sans reconstruire tout
// le panneau (perdrait le focus/l'état des <select> de courbe).
function syncFadeInputs() {
  const $in = document.getElementById('fade-in-s')
  const $out = document.getElementById('fade-out-s')
  if ($in && document.activeElement !== $in) $in.value = (trimMarkers.fadeInMs / 1000).toFixed(1)
  if ($out && document.activeElement !== $out) $out.value = (trimMarkers.fadeOutMs / 1000).toFixed(1)
}

// ---- Zone « jingle intérieur » (overlay backend) ----

async function ensureVocalZones() {
  if (!trimMarkers || trimMarkers.vocalLoading || !editorContext) return
  if (trimMarkers.vocalZones === null) {
    trimMarkers.vocalLoading = true
    renderModePanel()
    try {
      const resp = editorContext.flow === 'cd'
        ? await api('/rip/analyze-vocal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ track_number: editorContext.trackNumber }),
          })
        : await api('/files/analyze-vocal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: editorContext.fileId }),
          })
      trimMarkers.vocalZones = resp.zones || []
    } catch (e) {
      console.warn('[analyze-vocal]', e.message)
      trimMarkers.vocalZones = []
    } finally {
      trimMarkers.vocalLoading = false
    }
  }
  // Pré-remplit la zone avec la meilleure détection tant que l'utilisateur n'a rien posé
  // lui-même (même heuristique « zone centrale la plus longue » que le backend).
  if (!trimMarkers.overlayTouched && trimMarkers.overlayStart == null
      && Array.isArray(trimMarkers.vocalZones) && trimMarkers.vocalZones.length
      && wavesurfer && wavesurfer.getDuration() > 0) {
    applyBestVocalZone(false)
  }
  renderModePanel()
}

function bestVocalZone(zones, durationSeconds) {
  const durMs = Math.max(1, durationSeconds * 1000)
  const central = zones.filter(z => (z.start_ms || 0) > durMs * 0.10 && (z.end_ms || 0) < durMs * 0.90)
  const pool = central.length ? central : zones
  return pool.reduce((best, z) => ((z.duration_ms || 0) > (best?.duration_ms || 0) ? z : best), null)
}

function applyBestVocalZone(markTouched) {
  if (!trimMarkers || !wavesurfer) return
  const zones = trimMarkers.vocalZones || []
  const best = bestVocalZone(zones, wavesurfer.getDuration())
  if (!best) return
  setOverlayZone(best.start_ms / 1000, best.end_ms / 1000)
  if (markTouched) trimMarkers.overlayTouched = true
  renderModePanel()
}

function setOverlayZone(start, end) {
  if (!trimMarkers || !wavesurfer) return
  const s = Math.max(trimMarkers.trimStart, Math.min(start, trimMarkers.trimEnd - 0.2))
  const e = Math.min(trimMarkers.trimEnd, Math.max(end, s + 0.2))
  trimMarkers.overlayStart = s
  trimMarkers.overlayEnd = e
  if (trimMarkers.overlayRegion) {
    trimMarkers.updating = true
    trimMarkers.overlayRegion.setOptions({ start: s, end: e })
    trimMarkers.updating = false
  } else {
    const active = trimMarkers.mode === 'jingle'
    trimMarkers.overlayRegion = trimMarkers.regionsPlugin.addRegion({
      id: 'overlay-zone', start: s, end: e, color: OVERLAY_COLOR,
      drag: active, resize: active, content: regionTag('JINGLE', '#2e7d32'),
    })
    if (trimMarkers.overlayRegion.element) {
      trimMarkers.overlayRegion.element.style.pointerEvents = active ? 'all' : 'none'
    }
  }
  updateOverlayInfo()
}

// Pose manuelle : zone de 8 s centrée sur la position de lecture (ou le milieu de la zone
// conservée si la lecture est au tout début) — utile quand la détection ne propose rien.
function addManualOverlayZone() {
  if (!trimMarkers || !wavesurfer) return
  const span = 8
  let center = wavesurfer.getCurrentTime()
  if (center < trimMarkers.trimStart + 0.5 || center > trimMarkers.trimEnd - 0.5) {
    center = (trimMarkers.trimStart + trimMarkers.trimEnd) / 2
  }
  setOverlayZone(center - span / 2, center + span / 2)
  trimMarkers.overlayTouched = true
  renderModePanel()
}

function removeOverlayZone() {
  if (!trimMarkers) return
  if (trimMarkers.overlayRegion) { trimMarkers.overlayRegion.remove(); trimMarkers.overlayRegion = null }
  trimMarkers.overlayStart = null
  trimMarkers.overlayEnd = null
  trimMarkers.overlayTouched = true
  renderModePanel()
}

// Restaure les cue points/zone jingle déjà confirmés lors d'un passage précédent sur cette
// piste/ce fichier (navigation Précédent) — sans ça, revenir en arrière rouvrait toujours
// l'éditeur à l'état par défaut (signalé : "on ne peut pas revenir en arrière"). `stored` a
// la forme de collectEditPayload() : {cueInSeconds, introSeconds, cueOutSeconds, overlay}
// — positions déjà dans la timeline FINALE. Le fichier local a été réécrit en conséquence
// si des coupes avaient été appliquées (même id, /files/preview ou /rip-preview sert la
// version déjà coupée) : elles s'appliquent donc telles quelles à la waveform rouverte.
// Les outils destructifs (montage/volume/fondus) ne sont volontairement PAS restaurés :
// déjà appliqués au fichier, les rejouer serait trompeur (l'utilisateur les recréerait
// par-dessus un fichier déjà modifié).
function applyStoredCuePoints(stored) {
  if (!stored || !trimMarkers || !wavesurfer) return
  const dur = wavesurfer.getDuration()
  const cueIn = Math.max(0, Math.min(stored.cueInSeconds || 0, dur))
  const introP = Math.max(cueIn, Math.min(stored.introSeconds ?? cueIn, dur))
  const cueOutPos = Math.max(cueIn, Math.min(dur - (stored.cueOutSeconds || 0), dur))
  trimMarkers.cueInPos = cueIn
  trimMarkers.introPos = introP
  trimMarkers.cueOutPos = cueOutPos
  trimMarkers.updating = true
  trimMarkers.cueInRegion?.setOptions({ start: cueIn })
  trimMarkers.introRegion?.setOptions({ start: introP })
  trimMarkers.cueOutRegion?.setOptions({ start: cueOutPos })
  trimMarkers.updating = false
  if (stored.overlay?.enabled && stored.overlay.start != null && stored.overlay.end != null) {
    setOverlayZone(stored.overlay.start, stored.overlay.end)
  }
  // Marque la zone comme "déjà décidée" (posée ou explicitement absente) pour empêcher
  // l'auto-suggestion vocale de l'écraser au premier passage en mode jingle.
  trimMarkers.overlayTouched = true
  renderModePanel()
  updateSummary()
}

// ---- Collecte de l'édition au moment de « Valider et continuer » ----

// Coupes de montage rognées à la zone conservée, triées et fusionnées si chevauchement —
// prêtes pour le payload /trim et pour le remappage des positions.
function sortedCuts() {
  if (!trimMarkers) return []
  const list = trimMarkers.cuts
    .map(c => ({
      start: Math.max(trimMarkers.trimStart, Math.min(c.region.start, trimMarkers.trimEnd)),
      end: Math.max(trimMarkers.trimStart, Math.min(c.region.end, trimMarkers.trimEnd)),
    }))
    .filter(c => c.end - c.start >= 0.05)
    .sort((a, b) => a.start - b.start)
  const merged = []
  for (const c of list) {
    const last = merged[merged.length - 1]
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end)
    else merged.push({ ...c })
  }
  return merged
}

/**
 * État complet de l'éditeur → payload d'édition serveur (/trim, /files/trim) + positions
 * remappées dans la timeline du fichier FINAL (cue points, zone jingle) pour /import.
 * Toute position t de la waveform actuelle est décalée de ce qui est supprimé avant elle.
 */
function collectEditPayload() {
  const dur = wavesurfer.getDuration()
  const hasTrim = trimMarkers.trimStart > 0.05 || trimMarkers.trimEnd < dur - 0.05
  const cuts = sortedCuts()
  const volumeDb = Math.abs(trimMarkers.volumeDb) > 0.01 ? trimMarkers.volumeDb : 0
  const fadeInMs = Math.round(trimMarkers.fadeInMs)
  const fadeOutMs = Math.round(trimMarkers.fadeOutMs)
  const hasVolumeCurve = trimMarkers.volumePoints.length > 0
  const hasEdit = hasTrim || cuts.length > 0 || volumeDb !== 0 || fadeInMs > 0 || fadeOutMs > 0 || hasVolumeCurve

  const toFinal = (t) => {
    const clamped = Math.max(trimMarkers.trimStart, Math.min(t, trimMarkers.trimEnd))
    let f = clamped - trimMarkers.trimStart
    for (const c of cuts) {
      if (c.start >= clamped) break
      f -= Math.min(c.end, clamped) - c.start
    }
    return Math.max(0, f)
  }
  const totalCut = cuts.reduce((s, c) => s + (c.end - c.start), 0)
  const finalDuration = Math.max(0, trimMarkers.trimEnd - trimMarkers.trimStart - totalCut)

  const cueInSeconds = toFinal(trimMarkers.cueInPos)
  const introSeconds = Math.max(cueInSeconds, toFinal(trimMarkers.introPos))
  const cueOutSeconds = Math.max(0, finalDuration - toFinal(trimMarkers.cueOutPos))

  // Zone jingle : la zone affichée (posée ou pré-remplie) est envoyée explicitement,
  // remappée ; retirée par l'utilisateur → enabled:false (bloque l'auto-sélection backend).
  // Jamais vue MAIS fichier réécrit : remappe la meilleure zone détectée côté client (les
  // vocal_zones des métadonnées d'upload deviennent caduques après réécriture, main.js les
  // retire d'ailleurs du meta après /trim). Sinon : rien envoyé, comportement historique.
  const zoneToFinal = (zs, ze) => {
    const s = toFinal(zs)
    const e = toFinal(ze)
    return e - s >= 1 ? { start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 } : null
  }
  let overlay = null
  if (trimMarkers.overlayStart != null) {
    const z = zoneToFinal(trimMarkers.overlayStart, trimMarkers.overlayEnd)
    overlay = z ? { enabled: true, ...z } : { enabled: false }
  } else if (trimMarkers.overlayTouched) {
    overlay = { enabled: false }
  } else if (hasEdit && Array.isArray(trimMarkers.vocalZones) && trimMarkers.vocalZones.length) {
    const best = bestVocalZone(trimMarkers.vocalZones, dur)
    const z = best ? zoneToFinal(best.start_ms / 1000, best.end_ms / 1000) : null
    if (z) overlay = { enabled: true, ...z }
  }

  const editBody = hasEdit ? {
    start_ms: Math.round(trimMarkers.trimStart * 1000),
    end_ms: hasTrim ? Math.round(trimMarkers.trimEnd * 1000) : null,
    cuts: cuts.map(c => ({ start_ms: Math.round(c.start * 1000), end_ms: Math.round(c.end * 1000) })),
    volume_db: volumeDb,
    // Courbe remappée dans la timeline du fichier FINAL, comme les cue points
    volume_points: trimMarkers.volumePoints.map(p => ({
      time_ms: Math.round(toFinal(p.timeMs / 1000) * 1000),
      db: p.db,
    })),
    fade_in_ms: fadeInMs,
    fade_in_curve: trimMarkers.fadeInCurve,
    fade_out_ms: fadeOutMs,
    fade_out_curve: trimMarkers.fadeOutCurve,
  } : null

  return { hasEdit, editBody, cueInSeconds, introSeconds, cueOutSeconds, overlay }
}

// Champs overlay_zone_* du POST /import à partir de l'état collecté (null = rien envoyer).
function overlayImportFields(overlay) {
  if (!overlay) return {}
  if (overlay.enabled === false) return { overlay_zone_enabled: false }
  return { overlay_zone_start_seconds: overlay.start, overlay_zone_end_seconds: overlay.end }
}

async function onConfirmTrack() {
  await advanceTrimming(collectEditPayload())
}

// data = résultat de collectEditPayload(), ou null pour « Passer (garder tel quel) ».
async function advanceTrimming(data) {
  const pending = currentRipState.pendingFiles
  const track = pending[trimIndex]

  if (data?.hasEdit) {
    try {
      await api('/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_number: track.trackNumber, ...data.editBody }),
      })
    } catch (e) {
      alert('Impossible de couper la piste : ' + e.message)
    }
  }
  if (data) {
    localCuePoints[trimIndex] = {
      cueInSeconds: data.cueInSeconds,
      introSeconds: data.introSeconds,
      cueOutSeconds: data.cueOutSeconds,
      overlay: data.overlay,
    }
  }

  const isLast = trimIndex >= pending.length - 1
  if (isLast) {
    if (wavesurfer) { wavesurfer.destroy(); wavesurfer = null }
    $app.innerHTML = '<div class="card"><div class="card-body"><p class="loading">Envoi en cours…</p></div></div>'
    try {
      await api('/rip/confirm', { method: 'POST' })
    } catch (e) {
      alert("Impossible de lancer l'envoi : " + e.message)
    }
    await tick()
    resumePolling() // uploading -> done doit se rafraîchir automatiquement
    return
  }
  trimIndex += 1
  render()
}

// ---- Finalisation (statut 'done') : formulaire métadonnées + envoi vers RadioStation ----
function renderFinalize() {
  const fileIds = currentRipState.fileIds || []
  const metas = currentRipState.filesMetadata || []

  if (!sendResults.length || sendResults.length !== fileIds.length) {
    sendResults = fileIds.map((_, i) => ({
      status: 'pending',
      error: null,
      title: metas[i]?.title || `Track ${i + 1}`,
      artist: metas[i]?.artist || '',
      album: metas[i]?.album || '',
      year: metas[i]?.year || '',
    }))
  }

  const allDone = sendResults.every(r => r.status === 'done')
  const rows = sendResults.map((r, i) => `
    <div class="card">
      <div class="card-header">Piste ${i + 1}${r.status === 'done' ? ' ✅' : r.status === 'error' ? ' ⚠️' : ''}</div>
      <div class="card-body">
        ${r.status === 'error' ? `<div class="error-box">${escapeHtml(r.error)}</div>` : ''}
        <div class="metadata-form">
          <label>Titre <input type="text" data-idx="${i}" class="meta-title" value="${escapeHtml(r.title)}" ${r.status === 'done' ? 'disabled' : ''}></label>
          <label>Artiste <input type="text" data-idx="${i}" class="meta-artist" value="${escapeHtml(r.artist)}" ${r.status === 'done' ? 'disabled' : ''}></label>
          <label>Album <input type="text" data-idx="${i}" class="meta-album" value="${escapeHtml(r.album)}" ${r.status === 'done' ? 'disabled' : ''}></label>
          <label>Année <input type="text" data-idx="${i}" class="meta-year" value="${escapeHtml(String(r.year || ''))}" ${r.status === 'done' ? 'disabled' : ''}></label>
        </div>
        ${r.status === 'done' ? '<div class="success-box">Envoyé vers RadioStation.</div>' :
          `<button class="btn btn-send-track" data-idx="${i}" ${r.status === 'sending' ? 'disabled' : ''}>${r.status === 'sending' ? 'Envoi…' : 'Envoyer cette piste'}</button>`}
      </div>
    </div>`).join('')

  $app.innerHTML = `
    ${rows}
    ${allDone ? `
      <div class="success-box">Toutes les pistes ont été envoyées vers RadioStation.</div>
      <button class="btn" id="btn-new-cd">Importer un autre CD</button>
    ` : `<button class="btn" id="btn-send-all">Tout envoyer</button>`}
  `

  document.querySelectorAll('.meta-title').forEach(el => el.oninput = () => { sendResults[+el.dataset.idx].title = el.value })
  document.querySelectorAll('.meta-artist').forEach(el => el.oninput = () => { sendResults[+el.dataset.idx].artist = el.value })
  document.querySelectorAll('.meta-album').forEach(el => el.oninput = () => { sendResults[+el.dataset.idx].album = el.value })
  document.querySelectorAll('.meta-year').forEach(el => el.oninput = () => { sendResults[+el.dataset.idx].year = el.value })
  document.querySelectorAll('.btn-send-track').forEach(el => {
    el.onclick = () => sendTrack(+el.dataset.idx)
  })
  const btnAll = document.getElementById('btn-send-all')
  if (btnAll) btnAll.onclick = sendAllTracks
  const btnNew = document.getElementById('btn-new-cd')
  if (btnNew) btnNew.onclick = resetAfterDone
}

async function sendTrack(i) {
  const fileIds = currentRipState.fileIds
  const r = sendResults[i]
  r.status = 'sending'
  render()
  try {
    const cue = localCuePoints[i] || { cueInSeconds: 0, cueOutSeconds: 0 }
    await api('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_id: fileIds[i],
        title: r.title,
        artist_name: r.artist || 'Unknown',
        album: r.album || undefined,
        year: parseYear(r.year),
        cue_in_seconds: cue.cueInSeconds,
        intro_seconds: cue.introSeconds || undefined,
        cue_out_seconds: cue.cueOutSeconds,
        ...overlayImportFields(cue.overlay),
      }),
    })
    r.status = 'done'
  } catch (e) {
    r.status = 'error'
    r.error = e.message
  }
  render()
}

async function sendAllTracks() {
  for (let i = 0; i < sendResults.length; i++) {
    if (sendResults[i].status !== 'done') await sendTrack(i)
  }
}

function resetAfterDone() {
  sendResults = []
  trimIndex = 0
  Object.keys(localCuePoints).forEach(k => delete localCuePoints[k])
  init()
}

// ══ Flux "fichiers locaux" hors CD (Phase 4) ═══════════════════════════════════════
// Réutilise les briques waveform/trim/cue déjà en place pour le CD (setupTrimWaveform,
// trimMarkers, updateSummary, onRegionMoved — mêmes ids DOM sum-kept/sum-cuein/sum-cueout/
// time-display, réutilisés tels quels par renderFilesTrimming ci-dessous) plutôt que de les
// dupliquer, conformément au non-objectif du plan (pas de réimplémentation par flux).

function renderFiles() {
  if (filesStep === 'select') return renderFilesSelect()
  if (filesStep === 'editing') return renderFilesTrimming()
  if (filesStep === 'sending') return renderFilesSend()
}

function renderFilesSelect() {
  $app.innerHTML = `
    <div class="card">
      <div class="card-header">Importer des fichiers locaux</div>
      <div class="card-body">
        <p class="hint">Sélectionnez ou glissez-déposez un ou plusieurs fichiers audio (mp3,
        wav, flac, m4a…) — coupe du silence, cue points et analyse
        (BPM/tonalité/loudness/energy) se font ici, avant l'envoi vers RadioStation.</p>
        <div id="files-dropzone" class="dropzone">
          <p>📁 Glissez-déposez vos fichiers ici<br>ou</p>
          <label class="btn" for="files-input">Parcourir…</label>
          <input type="file" id="files-input" accept="audio/*" multiple hidden>
        </div>
        <div id="files-upload-status"></div>
      </div>
      <div class="actions">
        <button class="btn-secondary" id="btn-back-mode">← Changer de mode</button>
      </div>
    </div>`
  document.getElementById('btn-back-mode').onclick = backToModeSelector
  document.getElementById('files-input').onchange = (e) => uploadSelectedFiles(e.target.files)

  const $dropzone = document.getElementById('files-dropzone')
  let dragCounter = 0 // compte les enter/leave imbriqués (survol d'un enfant) sans faux "leave"
  $dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault()
    dragCounter++
    $dropzone.classList.add('dropzone-active')
  })
  $dropzone.addEventListener('dragover', (e) => e.preventDefault())
  $dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault()
    dragCounter = Math.max(0, dragCounter - 1)
    if (dragCounter === 0) $dropzone.classList.remove('dropzone-active')
  })
  $dropzone.addEventListener('drop', (e) => {
    e.preventDefault()
    dragCounter = 0
    $dropzone.classList.remove('dropzone-active')
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg)$/i.test(f.name))
    if (files.length) uploadSelectedFiles(files)
  })
}

async function uploadSelectedFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  const $status = document.getElementById('files-upload-status')
  filesItems = []
  for (let i = 0; i < files.length; i++) {
    if ($status) $status.textContent = `Envoi ${i + 1}/${files.length}…`
    const fd = new FormData()
    fd.append('file', files[i], files[i].name)
    try {
      const up = await api('/files/upload', { method: 'POST', body: fd })
      filesItems.push({
        id: up.file_id,
        name: up.name,
        title: up.title || '',
        artist: up.artist || '',
        album: '',
        year: '',
        durationSeconds: up.duration_seconds,
        cueInSeconds: 0,
        introSeconds: 0,
        cueOutSeconds: 0,
        overlay: null,
        editedOnce: false, // true après un premier "Valider et continuer" (pas "Passer") — cf. bouton Précédent
        bpm: null,
        key: null,
        loudnessLufs: null,
        energy: null,
        startType: null,
        endType: null,
        analyzing: false,
        sendStatus: 'pending',
        sendError: null,
        backendFileId: null,
      })
    } catch (e) {
      alert(`Échec de l'envoi de ${files[i].name} : ` + e.message)
    }
  }
  if (!filesItems.length) { render(); return }
  filesStep = 'editing'
  filesEditingIndex = 0
  render()
}

function renderFilesTrimming() {
  const item = filesItems[filesEditingIndex]
  if (!item) { filesStep = 'select'; render(); return }

  $app.innerHTML = `
    <div class="card">
      <div class="card-header">
        Fichier ${filesEditingIndex + 1} / ${filesItems.length} — ${escapeHtml(item.title || item.name)}
      </div>
      ${editorModeTabsHtml()}
      <div class="waveform-container"><div id="waveform"></div></div>
      <div class="controls-bar">
        <div class="playback-group">
          <button class="btn-ctrl" id="btn-playpause">►</button>
          <button class="btn-ctrl" id="btn-stop">Stop</button>
          <button class="btn-ctrl" id="btn-reset">Tout réinitialiser</button>
        </div>
        <div class="zoom-group">
          <button class="btn-ctrl" id="btn-zoom-out" title="Zoom arrière">➖</button>
          <span class="zoom-level" id="zoom-level">×1</span>
          <button class="btn-ctrl" id="btn-zoom-in" title="Zoom avant (précision des cue points)">➕</button>
          <button class="btn-ctrl" id="btn-zoom-reset" title="Ajuster à la fenêtre">Ajuster</button>
        </div>
        <div class="time-display" id="time-display">00:00.000 / 00:00.000</div>
      </div>
      <div class="summary-row">
        <div class="summary-item"><span class="summary-dot dot-blue"></span> Zone conservée : <strong id="sum-kept">—</strong></div>
        <div class="summary-item">
          <span class="summary-dot dot-cyan"></span> Début (skip) : <strong id="sum-cuein">00:00.000</strong>
          <button class="btn-preview" id="btn-preview-start">🔊 Écouter</button>
        </div>
        <div class="summary-item">
          <span class="summary-dot dot-orange"></span> Intro : <strong id="sum-intro">00:00.000</strong>
        </div>
        <div class="summary-item">
          <span class="summary-dot dot-red"></span> Transition (avant fin) : <strong id="sum-cueout">00:00.000</strong>
          <button class="btn-preview" id="btn-preview-end">🔊 Écouter</button>
        </div>
      </div>
      <div class="summary-row">
        <div class="summary-item">BPM : <strong id="sum-bpm">—</strong></div>
        <div class="summary-item">Tonalité : <strong id="sum-key">—</strong></div>
      </div>
      <div id="mode-panel"></div>
      <div class="actions">
        ${filesEditingIndex > 0 ? '<button class="btn-secondary" id="btn-prev-file">◀ Précédent</button>' : ''}
        <button class="btn-secondary" id="btn-skip-file">Passer (garder tel quel)</button>
        <button class="btn" id="btn-confirm-file">Valider et continuer</button>
      </div>
    </div>`

  editorContext = { flow: 'files', fileId: item.id, initialVocalZones: null }
  setupTrimWaveform(`/files/preview/${item.id}`, () => {
    // Retour arrière (bouton Précédent) sur un fichier déjà validé une fois : restaure les
    // cue points/zone jingle confirmés au lieu de rouvrir à l'état par défaut (signalé :
    // "on ne peut pas revenir en arrière"). Rien à restaurer pour un "Passer" (editedOnce
    // reste false) — l'état par défaut EST le résultat attendu dans ce cas.
    if (item.editedOnce) {
      applyStoredCuePoints({
        cueInSeconds: item.cueInSeconds,
        introSeconds: item.introSeconds,
        cueOutSeconds: item.cueOutSeconds,
        overlay: item.overlay,
      })
    }
    item.analyzing = true
    updateFilesTrimmingBpmKey(item)
    analyzeBpmKey(item)
  })
  wireEditorModeTabs()
  renderModePanel()
  updateFilesTrimmingBpmKey(item)

  if (filesEditingIndex > 0) {
    document.getElementById('btn-prev-file').onclick = () => { filesEditingIndex -= 1; render() }
  }
  document.getElementById('btn-skip-file').onclick = () => advanceFilesTrimming(null)
  document.getElementById('btn-confirm-file').onclick = onConfirmFilesTrack
  document.getElementById('btn-reset').onclick = () => resetCurrentMode()
}

function updateFilesTrimmingBpmKey(item) {
  const $bpm = document.getElementById('sum-bpm')
  const $key = document.getElementById('sum-key')
  if ($bpm) $bpm.textContent = item.analyzing ? '…' : (item.bpm != null ? item.bpm : '—')
  if ($key) $key.textContent = item.analyzing ? '…' : (item.key || '—')
}

// Bouton adaptatif du mode cue points (renderModePanel), réservé au flux fichiers
// (pas d'équivalent /rip/detect-cue côté CD) — fileId pris sur editorContext, pas besoin
// de le faire transiter depuis filesItems.
async function autoDetectCue() {
  try {
    const cue = await api('/files/detect-cue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: editorContext.fileId }),
    })
    if (!trimMarkers || !wavesurfer) return
    const cueIn = Math.max(trimMarkers.trimStart, Math.min(cue.intro_seconds, trimMarkers.trimEnd - 0.1))
    const cueOut = Math.min(trimMarkers.trimEnd, Math.max(trimMarkers.trimEnd - cue.outro_seconds, trimMarkers.trimStart + 0.1))
    trimMarkers.cueInPos = cueIn
    trimMarkers.cueOutPos = cueOut
    trimMarkers.cueInRegion?.setOptions({ start: cueIn })
    trimMarkers.cueOutRegion?.setOptions({ start: cueOut })
    updateSummary()
  } catch (e) {
    alert('Détection automatique impossible : ' + e.message)
  }
}

async function getAubio() {
  if (!aubioModule) aubioModule = await aubioFactory()
  return aubioModule
}

// BPM + tonalité calculés côté webview (aucun round-trip HTTP) sur le buffer déjà décodé
// par WaveSurfer pour le rendu de la waveform — mêmes paramètres qu'audio_analysis.py côté
// backend (aubio pitch -m yinfft -B 4096 -H 2048, plage 60-4000 Hz) pour rester comparable.
async function analyzeBpmKey(item) {
  if (!wavesurfer) return
  try {
    const decoded = wavesurfer.getDecodedData()
    if (!decoded) return
    const channelData = decoded.getChannelData(0)
    const sampleRate = decoded.sampleRate
    const { Tempo, Pitch } = await getAubio()

    const tempoBufSize = 1024, tempoHop = 512
    const tempo = new Tempo(tempoBufSize, tempoHop, sampleRate)
    let bpm = null
    for (let i = 0; i + tempoHop <= channelData.length; i += tempoHop) {
      const beat = tempo.do(channelData.subarray(i, i + tempoHop))
      if (beat) bpm = tempo.getBpm()
    }
    if (bpm != null && bpm >= 40 && bpm <= 250) item.bpm = Math.round(bpm * 10) / 10

    const pitchBufSize = 4096, pitchHop = 2048
    const pitch = new Pitch('yinfft', pitchBufSize, pitchHop, sampleRate)
    const chroma = new Array(12).fill(0)
    let count = 0
    for (let i = 0; i + pitchHop <= channelData.length; i += pitchHop) {
      const freq = pitch.do(channelData.subarray(i, i + pitchHop))
      if (freq < 60 || freq > 4000) continue
      const midi = 69 + 12 * Math.log2(freq / 440)
      const pc = ((Math.round(midi) % 12) + 12) % 12
      chroma[pc] += 1
      count++
    }
    if (count >= 20) item.key = keyFromChroma(chroma)
  } catch (e) {
    console.warn('[analyzeBpmKey]', e.message)
  } finally {
    item.analyzing = false
    updateFilesTrimmingBpmKey(item)
  }
}

async function onConfirmFilesTrack() {
  await advanceFilesTrimming(collectEditPayload())
}

// data = résultat de collectEditPayload(), ou null pour « Passer (garder tel quel) ».
async function advanceFilesTrimming(data) {
  const item = filesItems[filesEditingIndex]

  if (data?.hasEdit) {
    try {
      await api('/files/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: item.id, ...data.editBody }),
      })
    } catch (e) {
      alert('Impossible de couper le fichier : ' + e.message)
    }
  }
  item.cueInSeconds = data ? data.cueInSeconds : 0
  item.introSeconds = data ? data.introSeconds : 0
  item.cueOutSeconds = data ? data.cueOutSeconds : 0
  item.overlay = data ? data.overlay : null
  if (data) item.editedOnce = true // cf. bouton Précédent, ne restaure rien pour un "Passer"

  // Loudness/energy/start-end type ffmpeg côté serveur — après coupe éventuelle, pour que
  // start_type reflète le vrai début audible (cue_in_seconds).
  try {
    const loud = await api('/files/analyze-loudness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: item.id, cue_in_seconds: item.cueInSeconds }),
    })
    item.loudnessLufs = loud.loudness_lufs
    item.energy = loud.energy
    item.startType = loud.start_type
    item.endType = loud.end_type
  } catch (e) {
    console.warn('[analyze-loudness]', e.message)
  }

  const isLast = filesEditingIndex >= filesItems.length - 1
  if (isLast) {
    if (wavesurfer) { wavesurfer.destroy(); wavesurfer = null }
    await finishFilesUpload()
    return
  }
  filesEditingIndex += 1
  render()
}

// Upload groupé des fichiers (originaux ou convertis/coupés) vers le backend, comme
// finishRip() pour le CD — mêmes ids de retour (fileIds/filesMetadata), consommés ensuite
// un par un via /import (proxy déjà générique, inchangé).
async function finishFilesUpload() {
  filesStep = 'sending'
  filesFinishing = true
  render()
  try {
    const result = await api('/files/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: filesItems.map(it => ({ file_id: it.id, title: it.title, artist: it.artist, album: it.album, year: parseYear(it.year) ?? null })),
      }),
    })
    const fileIds = result.file_ids || []
    const metas = result.files_metadata || []
    filesItems.forEach((it, i) => {
      it.backendFileId = fileIds[i] || null
      it.sendStatus = it.backendFileId ? 'pending' : 'error'
      it.sendError = it.backendFileId ? null : 'Échec de l\'envoi vers RadioStation'
      if (!it.title && metas[i]?.title) it.title = metas[i].title
      if (!it.artist && metas[i]?.artist) it.artist = metas[i].artist
    })
  } catch (e) {
    filesItems.forEach(it => { it.sendStatus = 'error'; it.sendError = e.message })
  }
  filesFinishing = false
  render()
}

function renderFilesSend() {
  if (filesFinishing) {
    $app.innerHTML = '<div class="card"><div class="card-body"><p class="loading">Envoi vers RadioStation…</p></div></div>'
    return
  }

  const allDone = filesItems.every(it => it.sendStatus === 'done')
  // Échec du POST /files/finish groupé (ex. réseau) : aucun backendFileId, donc
  // "Envoyer ce fichier" reste désactivé pour tout le monde — sans ce bouton, aucun moyen
  // de réessayer. Les fichiers convertis/coupés ne sont plus supprimés côté serveur sur
  // cet échec (cf. main.js /files/finish), un nouveau POST /files/finish suffit.
  const needsFinishRetry = filesItems.some(it => !it.backendFileId)
  const rows = filesItems.map((it, i) => `
    <div class="card">
      <div class="card-header">${escapeHtml(it.title || it.name)}${it.sendStatus === 'done' ? ' ✅' : it.sendStatus === 'error' ? ' ⚠️' : ''}</div>
      <div class="card-body">
        ${it.sendStatus === 'error' ? `<div class="error-box">${escapeHtml(it.sendError)}</div>` : ''}
        <div class="metadata-form">
          <label>Titre <input type="text" data-idx="${i}" class="fmeta-title" value="${escapeHtml(it.title)}" ${it.sendStatus === 'done' ? 'disabled' : ''}></label>
          <label>Artiste <input type="text" data-idx="${i}" class="fmeta-artist" value="${escapeHtml(it.artist)}" ${it.sendStatus === 'done' ? 'disabled' : ''}></label>
          <label>Album <input type="text" data-idx="${i}" class="fmeta-album" value="${escapeHtml(it.album)}" ${it.sendStatus === 'done' ? 'disabled' : ''}></label>
          <label>Année <input type="text" data-idx="${i}" class="fmeta-year" value="${escapeHtml(String(it.year || ''))}" ${it.sendStatus === 'done' ? 'disabled' : ''}></label>
        </div>
        <p class="hint">BPM : ${it.bpm ?? '—'} · Tonalité : ${it.key || '—'} · Loudness : ${it.loudnessLufs != null ? it.loudnessLufs + ' LUFS' : '—'}</p>
        ${it.sendStatus === 'done' ? '<div class="success-box">Envoyé vers RadioStation.</div>' :
          `<button class="btn btn-send-file" data-idx="${i}" ${(it.sendStatus === 'sending' || !it.backendFileId) ? 'disabled' : ''}>${it.sendStatus === 'sending' ? 'Envoi…' : 'Envoyer ce fichier'}</button>`}
      </div>
    </div>`).join('')

  $app.innerHTML = `
    ${rows}
    ${allDone ? `
      <div class="success-box">Tous les fichiers ont été envoyés vers RadioStation.</div>
      <button class="btn" id="btn-new-files">Importer d'autres fichiers</button>
    ` : needsFinishRetry ? `<button class="btn" id="btn-retry-finish">Réessayer l'envoi vers RadioStation</button>`
      : `<button class="btn" id="btn-send-all-files">Tout envoyer</button>`}
  `

  document.querySelectorAll('.fmeta-title').forEach(el => el.oninput = () => { filesItems[+el.dataset.idx].title = el.value })
  document.querySelectorAll('.fmeta-artist').forEach(el => el.oninput = () => { filesItems[+el.dataset.idx].artist = el.value })
  document.querySelectorAll('.fmeta-album').forEach(el => el.oninput = () => { filesItems[+el.dataset.idx].album = el.value })
  document.querySelectorAll('.fmeta-year').forEach(el => el.oninput = () => { filesItems[+el.dataset.idx].year = el.value })
  document.querySelectorAll('.btn-send-file').forEach(el => { el.onclick = () => sendFileItem(+el.dataset.idx) })
  const btnAll = document.getElementById('btn-send-all-files')
  if (btnAll) btnAll.onclick = sendAllFileItems
  const btnRetryFinish = document.getElementById('btn-retry-finish')
  if (btnRetryFinish) btnRetryFinish.onclick = finishFilesUpload
  const btnNew = document.getElementById('btn-new-files')
  if (btnNew) btnNew.onclick = () => enterFilesMode()
}

async function sendFileItem(i) {
  const it = filesItems[i]
  if (!it.backendFileId) return
  it.sendStatus = 'sending'
  render()
  try {
    await api('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_id: it.backendFileId,
        title: it.title,
        artist_name: it.artist || 'Unknown',
        album: it.album || undefined,
        year: parseYear(it.year),
        cue_in_seconds: it.cueInSeconds,
        intro_seconds: it.introSeconds || undefined,
        cue_out_seconds: it.cueOutSeconds,
        ...overlayImportFields(it.overlay),
        bpm: it.bpm ?? undefined,
        key: it.key ?? undefined,
        loudness_lufs: it.loudnessLufs ?? undefined,
        energy: it.energy ?? undefined,
        start_type: it.startType ?? undefined,
        end_type: it.endType ?? undefined,
      }),
    })
    it.sendStatus = 'done'
  } catch (e) {
    it.sendStatus = 'error'
    it.sendError = e.message
  }
  render()
}

async function sendAllFileItems() {
  for (let i = 0; i < filesItems.length; i++) {
    if (filesItems[i].sendStatus !== 'done') await sendFileItem(i)
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ── Raccourcis clavier de l'éditeur (parité site, v1.8) ─────────────────────────
// Espace = lecture/pause ; en mode cue : I pose DÉBUT, N pose INTRO, O pose TRANSITION
// à la position de lecture. Ignorés pendant la saisie dans un champ.
function setCueMarkerAtPlayhead(kind) {
  if (!trimMarkers || !wavesurfer) return
  const t = wavesurfer.getCurrentTime()
  trimMarkers.updating = true
  if (kind === 'cue-in') {
    trimMarkers.cueInPos = Math.max(trimMarkers.trimStart, Math.min(t, trimMarkers.cueOutPos - 0.1))
    trimMarkers.cueInRegion?.setOptions({ start: trimMarkers.cueInPos })
  } else if (kind === 'intro') {
    trimMarkers.introPos = Math.max(trimMarkers.cueInPos, Math.min(t, trimMarkers.trimEnd))
    trimMarkers.introRegion?.setOptions({ start: trimMarkers.introPos })
  } else if (kind === 'cue-out') {
    trimMarkers.cueOutPos = Math.min(trimMarkers.trimEnd, Math.max(t, trimMarkers.cueInPos + 0.1))
    trimMarkers.cueOutRegion?.setOptions({ start: trimMarkers.cueOutPos })
  }
  trimMarkers.updating = false
  clampCueMarkers()
  updateSummary()
}

document.addEventListener('keydown', (e) => {
  if (!wavesurfer || !trimMarkers) return
  const tag = e.target?.tagName
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
  if (e.code === 'Space') {
    e.preventDefault()
    wavesurfer.playPause()
  } else if (trimMarkers.mode === 'cue') {
    if (e.code === 'KeyI') { e.preventDefault(); setCueMarkerAtPlayhead('cue-in') }
    else if (e.code === 'KeyN') { e.preventDefault(); setCueMarkerAtPlayhead('intro') }
    else if (e.code === 'KeyO') { e.preventDefault(); setCueMarkerAtPlayhead('cue-out') }
  }
})

init()
