// Port JS pur de backend/app/services/audio_analysis.py::_key_from_chroma — corrélation
// Krumhansl-Schmuckler appliquée à un histogramme chromatique (12 classes de hauteur).
// Aucune dépendance (mathématiques seules) : ne fait PAS partie d'aubiojs, mais vit dans
// vendor/ pour rester à côté de la logique portée depuis le backend (cf. README.md).
// Retourne la tonalité en notation Camelot (ex: "8A", "8B") ou null si non détectable.

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const CAMELOT_MAJOR = {
  0: '1B', 7: '2B', 2: '3B', 9: '4B', 4: '5B', 11: '6B',
  6: '7B', 1: '8B', 8: '9B', 3: '10B', 10: '11B', 5: '12B',
}
const CAMELOT_MINOR = {
  9: '1A', 4: '2A', 11: '3A', 6: '4A', 1: '5A', 8: '6A',
  3: '7A', 10: '8A', 5: '9A', 0: '10A', 7: '11A', 2: '12A',
}

export function keyFromChroma(chroma) {
  const total = chroma.reduce((a, b) => a + b, 0)
  if (total < 10) return null

  const normalized = chroma.map(c => c / total)
  const meanC = normalized.reduce((a, b) => a + b, 0) / 12

  const pMeanMaj = MAJOR_PROFILE.reduce((a, b) => a + b, 0) / 12
  const pMeanMin = MINOR_PROFILE.reduce((a, b) => a + b, 0) / 12
  const varInput = normalized.reduce((s, v) => s + (v - meanC) ** 2, 0)
  const varMaj = MAJOR_PROFILE.reduce((s, v) => s + (v - pMeanMaj) ** 2, 0)
  const varMin = MINOR_PROFILE.reduce((s, v) => s + (v - pMeanMin) ** 2, 0)
  const denomMajBase = (varInput > 0 && varMaj > 0) ? Math.sqrt(varInput * varMaj) : 0
  const denomMinBase = (varInput > 0 && varMin > 0) ? Math.sqrt(varInput * varMin) : 0

  let bestCorr = -Infinity
  let bestKey = null

  for (let root = 0; root < 12; root++) {
    let numMaj = 0
    let numMin = 0
    for (let i = 0; i < 12; i++) {
      numMaj += (normalized[i] - meanC) * (MAJOR_PROFILE[((i - root) % 12 + 12) % 12] - pMeanMaj)
      numMin += (normalized[i] - meanC) * (MINOR_PROFILE[((i - root) % 12 + 12) % 12] - pMeanMin)
    }
    const corrMajor = denomMajBase > 0 ? numMaj / denomMajBase : 0
    const corrMinor = denomMinBase > 0 ? numMin / denomMinBase : 0

    if (corrMajor > bestCorr) { bestCorr = corrMajor; bestKey = CAMELOT_MAJOR[root] }
    if (corrMinor > bestCorr) { bestCorr = corrMinor; bestKey = CAMELOT_MINOR[root] }
  }

  return bestKey
}
