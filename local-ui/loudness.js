// Mesure LUFS intégré (BS.1770-4, K-weighting + gating absolu/relatif) et pic sample dBFS,
// calculés sur un AudioBuffer déjà décodé par wavesurfer (aucun round-trip serveur).
//
// Port vanille IDENTIQUE (mêmes formules) du module TS du site :
// frontend/src/utils/loudness.ts — garder les deux synchronisés en cas de correction.
//
// Coefficients de filtre K-weighting paramétriques (formules pyloudnorm/ffmpeg ebur128,
// bilinear transform d'un prototype analogique) — valables à TOUT sampleRate.

function highShelfCoeffs(sampleRate) {
  const G = 3.999843853973347
  const fc = 1681.974450955533
  const Q = 0.7071752369554196
  const K = Math.tan((Math.PI * fc) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a0 = 1.0 + K / Q + K * K
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2.0 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2.0 * (K * K - 1.0)) / a0,
    a2: (1.0 - K / Q + K * K) / a0,
  }
}

function highPassCoeffs(sampleRate) {
  const fc = 38.13547087602444
  const Q = 0.5003270373238773
  const K = Math.tan((Math.PI * fc) / sampleRate)
  const a0 = 1.0 + K / Q + K * K
  return {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: (2.0 * (K * K - 1.0)) / a0,
    a2: (1.0 - K / Q + K * K) / a0,
  }
}

function applyBiquad(input, c) {
  const out = new Float32Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let n = 0; n < input.length; n++) {
    const x0 = input[n]
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    out[n] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

function kWeight(channel, sampleRate) {
  return applyBiquad(applyBiquad(channel, highShelfCoeffs(sampleRate)), highPassCoeffs(sampleRate))
}

// LUFS intégré (BS.1770-4) sur un AudioBuffer décodé. Blocs de 400 ms / recouvrement 75 %,
// gate absolu -70 LUFS puis gate relatif -10 LU. `null` si trop court ou silence total.
export function integratedLufs(buffer) {
  const sampleRate = buffer.sampleRate
  const nChannels = buffer.numberOfChannels
  const filtered = []
  for (let ch = 0; ch < nChannels; ch++) {
    filtered.push(kWeight(buffer.getChannelData(ch), sampleRate))
  }

  const blockSize = Math.round(0.4 * sampleRate)
  const stepSize = Math.round(0.1 * sampleRate)
  const length = buffer.length
  if (length < blockSize) return null

  const blockPower = []
  for (let start = 0; start + blockSize <= length; start += stepSize) {
    let sumSquares = 0
    for (let ch = 0; ch < nChannels; ch++) {
      const data = filtered[ch]
      let s = 0
      for (let i = start; i < start + blockSize; i++) s += data[i] * data[i]
      sumSquares += s / blockSize
    }
    blockPower.push(sumSquares)
  }
  if (!blockPower.length) return null

  const ABS_THRESHOLD = Math.pow(10, (-70 + 0.691) / 10)
  const gatedAbs = blockPower.filter((z) => z > ABS_THRESHOLD)
  if (!gatedAbs.length) return null

  const meanAbs = gatedAbs.reduce((a, b) => a + b, 0) / gatedAbs.length
  const relThreshold = meanAbs * Math.pow(10, -10 / 10)
  const gatedRel = gatedAbs.filter((z) => z > relThreshold)
  if (!gatedRel.length) return null

  const meanRel = gatedRel.reduce((a, b) => a + b, 0) / gatedRel.length
  return -0.691 + 10 * Math.log10(meanRel)
}

// Pic sample (pas de true-peak oversamplé, marge -1 dB assumée) en dBFS, tous canaux.
export function peakDbfs(buffer) {
  let peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i])
      if (a > peak) peak = a
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}
