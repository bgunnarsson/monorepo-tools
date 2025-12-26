function toInt(s) {
  const n = Number.parseInt(String(s), 10)
  return Number.isFinite(n) ? n : NaN
}

export function isValidSemver(v) {
  if (typeof v !== 'string') return false
  // minimal: x.y.z with optional -prerelease / +build
  return /^\d+\.\d+\.\d+([\-+].+)?$/.test(v)
}

export function parseSemver(v) {
  if (!isValidSemver(v)) return null
  const core = v.split('-')[0].split('+')[0]
  const [M, m, p] = core.split('.')
  const major = toInt(M)
  const minor = toInt(m)
  const patch = toInt(p)
  if (![major, minor, patch].every(Number.isFinite)) return null
  return { major, minor, patch }
}

export function compareSemver(a, b) {
  const A = parseSemver(a)
  const B = parseSemver(b)
  if (!A || !B) throw new Error(`compareSemver requires valid versions: ${a}, ${b}`)
  if (A.major !== B.major) return A.major - B.major
  if (A.minor !== B.minor) return A.minor - B.minor
  return A.patch - B.patch
}

export function bumpSemver(v, which) {
  const s = parseSemver(v)
  if (!s) throw new Error(`Invalid version: ${v}`)
  if (which === 'major') return `${s.major + 1}.0.0`
  if (which === 'minor') return `${s.major}.${s.minor + 1}.0`
  if (which === 'patch') return `${s.major}.${s.minor}.${s.patch + 1}`
  throw new Error(`Invalid bump: ${which}`)
}

