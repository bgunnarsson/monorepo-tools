import fs from 'node:fs'

export function readPackageJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}

export function writePackageJson(filePath, obj) {
  const json = JSON.stringify(obj, null, 2) + '\n'
  fs.writeFileSync(filePath, json, 'utf8')
}

export function updatePkgVersion(pkg, version) {
  if (!pkg || typeof pkg !== 'object') return
  pkg.version = version
}

function isInternalName(name, scopePrefix) {
  return typeof name === 'string' && name.startsWith(scopePrefix)
}

function patchDeps(deps, scopePrefix, range) {
  if (!deps || typeof deps !== 'object') return false
  let changed = false

  for (const [name, val] of Object.entries(deps)) {
    if (!isInternalName(name, scopePrefix)) continue
    if (val !== range) {
      deps[name] = range
      changed = true
    }
  }

  return changed
}

export function updateInternalDeps(pkg, scopePrefix, range) {
  if (!pkg || typeof pkg !== 'object') return

  patchDeps(pkg.dependencies, scopePrefix, range)
  patchDeps(pkg.devDependencies, scopePrefix, range)
  patchDeps(pkg.peerDependencies, scopePrefix, range)
  patchDeps(pkg.optionalDependencies, scopePrefix, range)
}

function sortObjectKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const k of Object.keys(obj).sort((a, b) => a.localeCompare(b))) out[k] = obj[k]
  return out
}

export function normalizePackageJsonForWrite(pkg) {
  // Keep package.json consistent and merge-friendly.
  // 1) sort dependency blocks
  if (pkg.dependencies) pkg.dependencies = sortObjectKeys(pkg.dependencies)
  if (pkg.devDependencies) pkg.devDependencies = sortObjectKeys(pkg.devDependencies)
  if (pkg.peerDependencies) pkg.peerDependencies = sortObjectKeys(pkg.peerDependencies)
  if (pkg.optionalDependencies) pkg.optionalDependencies = sortObjectKeys(pkg.optionalDependencies)

  // 2) normalize common fields ordering (non-destructive; keeps unknown fields)
  const order = [
    'name',
    'version',
    'private',
    'description',
    'keywords',
    'license',
    'author',
    'repository',
    'homepage',
    'bugs',
    'type',
    'sideEffects',
    'main',
    'module',
    'types',
    'exports',
    'bin',
    'files',
    'scripts',
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'engines',
    'publishConfig',
  ]

  const next = {}
  for (const k of order) {
    if (k in pkg) next[k] = pkg[k]
  }
  for (const k of Object.keys(pkg)) {
    if (!(k in next)) next[k] = pkg[k]
  }

  Object.keys(pkg).forEach((k) => delete pkg[k])
  Object.assign(pkg, next)
}
