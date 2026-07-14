// RadioStation Import Studio — interface locale embarquée (Phase 2b « interface embarquée »)
//
// Servie directement par main.js (127.0.0.1:19847) — aucune dépendance réseau au site
// RadioStation pour l'interface elle-même : détection CD, rip, coupe du silence et cue points
// tournent entièrement en local (main.js). Seul l'envoi final (POST /import, proxié par
// main.js vers le vrai backend avec le jeton d'appareil déjà appairé) touche le réseau.
import WaveSurfer from './vendor/wavesurfer.esm.js'
import RegionsPlugin from './vendor/regions.esm.js'

const $app = document.getElementById('app')
const $pairingIndicator = document.getElementById('pairing-indicator')
const $vocalToggle = document.getElementById('vocal-toggle')

let settings = {}
let currentRipState = null
let cdStatus = null
let pollTimer = null

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

// ---- HTTP ----
async function api(path, opts = {}) {
  const res = await fetch(path, opts)
  let json = {}
  try { json = await res.json() } catch { /* réponse vide */ }
  if (!res.ok) throw new Error(json.error || json.detail || `HTTP ${res.status}`)
  return json
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
  if (!settings.server_url || !settings.device_token) {
    stopPolling()
    localView = 'not-paired'
    render()
    return
  }
  localView = 'boot'
  await tick()
  resumePolling()
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
    </div>`
  const btn = document.getElementById('btn-toc')
  if (btn) btn.onclick = openTrackSelection
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
      body: JSON.stringify({ track_numbers: selected.map(t => t.number) }),
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
        <button class="btn" id="btn-back-idle">Retour</button>
      </div>
    </div>`
  document.getElementById('btn-back-idle').onclick = init
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
      <div class="waveform-container"><div id="waveform"></div></div>
      <div class="controls-bar">
        <div class="playback-group">
          <button class="btn-ctrl" id="btn-playpause">►</button>
          <button class="btn-ctrl" id="btn-stop">Stop</button>
          <button class="btn-ctrl" id="btn-reset">Tout réinitialiser</button>
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
          <span class="summary-dot dot-red"></span> Transition (avant fin) : <strong id="sum-cueout">00:00.000</strong>
          <button class="btn-preview" id="btn-preview-end">🔊 Écouter</button>
        </div>
      </div>
      <p class="hint" style="padding:12px 24px;">
        <strong>Zone bleue</strong> : glissez les bords pour couper le silence/déchet — coupe
        définitive, avant l'envoi. <strong>DÉBUT</strong> (cyan) / <strong>TRANSITION</strong>
        (rouge) : cue points, ni l'un ni l'autre n'est obligatoire, affinables après import.
      </p>
      <div class="actions">
        <button class="btn-secondary" id="btn-skip-track">Passer (garder tel quel)</button>
        <button class="btn" id="btn-confirm-track">Valider et continuer</button>
      </div>
    </div>`

  setupTrimWaveform(track.trackNumber)

  document.getElementById('btn-skip-track').onclick = () => advanceTrimming(null, null, 0, 0)
  document.getElementById('btn-confirm-track').onclick = onConfirmTrack
  document.getElementById('btn-reset').onclick = () => trimMarkers?.resetToFull()
}

let trimMarkers = null // { trimStart, trimEnd, cueInPos, cueOutPos, keepRegion, cueInRegion, cueOutRegion }

function setupTrimWaveform(trackNumber) {
  if (wavesurfer) { wavesurfer.destroy(); wavesurfer = null }
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
    url: `/rip-preview/${trackNumber}`,
  })

  trimMarkers = {
    trimStart: 0, trimEnd: 0, cueInPos: 0, cueOutPos: 0,
    keepRegion: null, cueInRegion: null, cueOutRegion: null, updating: false,
  }

  wavesurfer.on('ready', () => {
    const dur = wavesurfer.getDuration()
    trimMarkers.trimStart = 0
    trimMarkers.trimEnd = dur
    trimMarkers.cueInPos = 0
    trimMarkers.cueOutPos = dur
    trimMarkers.keepRegion = regions.addRegion({ id: 'trim-keep', start: 0, end: dur, color: 'rgba(74,144,226,0.15)', drag: true, resize: true })
    trimMarkers.cueInRegion = regions.addRegion({ id: 'cue-in', start: 0, color: 'rgba(33,150,243,0.9)', drag: true, resize: false, content: markerLabel('DÉBUT', '#2196f3') })
    trimMarkers.cueOutRegion = regions.addRegion({ id: 'cue-out', start: dur, color: 'rgba(244,67,54,0.9)', drag: true, resize: false, content: markerLabel('TRANSITION', '#f44336') })
    updateSummary()
  })

  wavesurfer.on('timeupdate', (t) => {
    document.getElementById('time-display').textContent = `${formatTime(t)} / ${formatTime(wavesurfer.getDuration())}`
  })

  regions.on('region-updated', onRegionMoved)
  regions.on('region-update', onRegionMoved)

  document.getElementById('btn-playpause').onclick = () => wavesurfer.playPause()
  document.getElementById('btn-stop').onclick = () => wavesurfer.stop()
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

function markerLabel(text, color) {
  const el = document.createElement('div')
  el.style.cssText = `background:${color};color:#fff;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:bold;white-space:nowrap;cursor:ew-resize;position:absolute;top:-22px;left:50%;transform:translateX(-50%);user-select:none;`
  el.textContent = text
  return el
}

function onRegionMoved(region) {
  if (!trimMarkers || trimMarkers.updating) return
  const dur = wavesurfer.getDuration()

  if (region.id === 'trim-keep') {
    const start = Math.max(0, Math.min(region.start, dur - 0.2))
    const end = Math.max(start + 0.2, Math.min(region.end, dur))
    trimMarkers.trimStart = start
    trimMarkers.trimEnd = end
    if (Math.abs(region.start - start) > 0.01 || Math.abs(region.end - end) > 0.01) {
      trimMarkers.updating = true
      region.setOptions({ start, end })
      trimMarkers.updating = false
    }
    clampCueMarkers()
  } else if (region.id === 'cue-in') {
    const clamped = Math.max(trimMarkers.trimStart, Math.min(region.start, trimMarkers.cueOutPos - 0.1))
    trimMarkers.cueInPos = clamped
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
}

function updateSummary() {
  if (!trimMarkers) return
  const kept = Math.max(0, trimMarkers.trimEnd - trimMarkers.trimStart)
  const cueIn = Math.max(0, trimMarkers.cueInPos - trimMarkers.trimStart)
  const cueOut = Math.max(0, trimMarkers.trimEnd - trimMarkers.cueOutPos)
  const $kept = document.getElementById('sum-kept')
  const $in = document.getElementById('sum-cuein')
  const $out = document.getElementById('sum-cueout')
  if ($kept) $kept.textContent = formatTime(kept)
  if ($in) $in.textContent = formatTime(cueIn)
  if ($out) $out.textContent = formatTime(cueOut)
}

async function onConfirmTrack() {
  const pending = currentRipState.pendingFiles
  const track = pending[trimIndex]
  const hasTrim = trimMarkers.trimStart > 0.05 || trimMarkers.trimEnd < wavesurfer.getDuration() - 0.05
  const startMs = Math.round(trimMarkers.trimStart * 1000)
  const endMs = hasTrim ? Math.round(trimMarkers.trimEnd * 1000) : null
  const cueInSeconds = Math.max(0, trimMarkers.cueInPos - trimMarkers.trimStart)
  const cueOutSeconds = Math.max(0, trimMarkers.trimEnd - trimMarkers.cueOutPos)
  await advanceTrimming(startMs, endMs, cueInSeconds, cueOutSeconds)
}

async function advanceTrimming(startMs, endMs, cueInSeconds, cueOutSeconds) {
  const pending = currentRipState.pendingFiles
  const track = pending[trimIndex]

  if (endMs != null) {
    try {
      await api('/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_number: track.trackNumber, start_ms: startMs, end_ms: endMs }),
      })
    } catch (e) {
      alert('Impossible de couper la piste : ' + e.message)
    }
  }
  if (cueInSeconds > 0 || cueOutSeconds > 0) {
    localCuePoints[trimIndex] = { cueInSeconds, cueOutSeconds }
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
        year: r.year ? Number(r.year) : undefined,
        cue_in_seconds: cue.cueInSeconds,
        cue_out_seconds: cue.cueOutSeconds,
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

init()
