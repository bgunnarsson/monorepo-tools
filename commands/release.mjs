import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { DEFAULTS } from '../lib/config.mjs'
import { discoverPackages } from '../lib/discover.mjs'
import {
  readPackageJson,
  writePackageJson,
  normalizePackageJsonForWrite,
  updatePkgVersion,
  updateInternalDeps,
} from '../lib/package-json.mjs'
import { isValidSemver, compareSemver, bumpSemver } from '../lib/semver.mjs'

import { runBuild } from './build.mjs'
import { runPublish } from './publish.mjs'

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[monorepo:release] ${msg}`)
}

function parseArgs(argv) {
  const args = {
    version: undefined,
    bump: undefined, // "patch" | "minor" | "major"
    scopePrefix: DEFAULTS.scopePrefix,

    targets: [...DEFAULTS.targets],
    skipDirs: new Set(DEFAULTS.skipDirs),

    // toggles
    dryRun: false,
    build: true,
    publish: true,
  }

  const take = (i) => argv[i + 1]

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]

    if (a === '--version') args.version = take(i)
    else if (a === '--bump') args.bump = take(i)
    else if (a === '--scope') args.scopePrefix = take(i)

    else if (a === '--targets') args.targets = take(i).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--skip-dirs') {
      for (const s of take(i).split(',').map((x) => x.trim()).filter(Boolean)) args.skipDirs.add(s)
    }

    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--no-build') args.build = false
    else if (a === '--no-publish') args.publish = false
  }

  return args
}

function repoRoot() {
  return process.cwd()
}

function resolveTargets(root, targets) {
  return targets.map((t) => path.resolve(root, t))
}

function readRootVersion(root) {
  const p = path.join(root, 'package.json')
  if (!fs.existsSync(p)) return undefined
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
    return typeof obj.version === 'string' ? obj.version : undefined
  } catch {
    return undefined
  }
}

function highestPackageVersion(pkgs) {
  let best = undefined
  for (const p of pkgs) {
    const v = p.pkg?.version
    if (!isValidSemver(v)) continue
    if (!best) best = v
    else if (compareSemver(v, best) > 0) best = v
  }
  return best
}

function computeNextVersion(args, root, pkgs) {
  const envV = process.env.MONOREPO_VERSION
  const rootV = readRootVersion(root)
  const maxV = highestPackageVersion(pkgs)

  const base = (isValidSemver(rootV) && rootV) || (isValidSemver(maxV) && maxV) || undefined

  if (args.version) {
    if (!isValidSemver(args.version)) throw new Error(`Invalid --version: ${args.version}`)
    return args.version
  }

  if (envV) {
    if (!isValidSemver(envV)) throw new Error(`Invalid MONOREPO_VERSION: ${envV}`)
    return envV
  }

  if (args.bump) {
    if (!base) throw new Error(`--bump requires an existing base version (root/package versions missing)`)
    if (!['patch', 'minor', 'major'].includes(args.bump)) throw new Error(`Invalid --bump: ${args.bump}`)
    return bumpSemver(base, args.bump)
  }

  if (!base) {
    throw new Error(
      `No version source found. Provide --version, MONOREPO_VERSION, or set root package.json version.`,
    )
  }

  return base
}

function writeAllUpdatedPackages({ pkgs, newVersion, scopePrefix, dryRun }) {
  const changed = []

  for (const p of pkgs) {
    const next = structuredClone(p.pkg)
    const before = JSON.stringify(next)

    updatePkgVersion(next, newVersion)

    // IMPORTANT:
    // keep workspace-local deps as workspace protocol so pnpm links locally in dev,
    // and rewrites to real semver in the published tarball.
    updateInternalDeps(next, scopePrefix, `workspace:^`)

    normalizePackageJsonForWrite(next)

    const after = JSON.stringify(next)

    if (before !== after) {
      changed.push({ dir: p.dir, name: next.name, path: p.packageJsonPath })
      if (!dryRun) writePackageJson(p.packageJsonPath, next)
    }
  }

  return changed
}

export async function runRelease(argv) {
  const args = parseArgs(argv)
  const root = repoRoot()

  log(`cwd: ${root}`)
  log(
    `options: ${JSON.stringify(
      {
        version: args.version,
        bump: args.bump,
        scopePrefix: args.scopePrefix,
        build: args.build,
        publish: args.publish,
        dryRun: args.dryRun,
      },
      null,
      0,
    )}`,
  )

  const targets = resolveTargets(root, args.targets)
  log(`scan: ${args.targets.join(', ')}`)

  const pkgs = discoverPackages({
    targets,
    skipDirs: args.skipDirs,
  })

  log(`scan: found ${pkgs.length} package.json files`)
  if (pkgs.length === 0) {
    throw new Error(`No packages found under: ${args.targets.join(', ')}`)
  }

  const newVersion = computeNextVersion(args, root, pkgs)
  log(`version: next=${newVersion}`)

  log('write: updating package.json versions + internal deps')
  const changed = writeAllUpdatedPackages({
    pkgs,
    newVersion,
    scopePrefix: args.scopePrefix,
    dryRun: args.dryRun,
  })
  log(`write: changed ${changed.length}/${pkgs.length} package.json files`)

  if (changed.length > 0) {
    for (const c of changed) {
      log(`write: ${path.relative(root, c.path)} (${c.name})`)
    }
  }

  // Align root version too (if root package.json exists)
  const rootPkgPath = path.join(root, 'package.json')
  if (fs.existsSync(rootPkgPath)) {
    log('write: aligning root package.json version')
    const rootPkg = readPackageJson(rootPkgPath)
    const before = JSON.stringify(rootPkg)

    updatePkgVersion(rootPkg, newVersion)
    normalizePackageJsonForWrite(rootPkg)

    const after = JSON.stringify(rootPkg)
    if (before !== after) {
      if (args.dryRun) log(`dry-run: would write ${path.relative(root, rootPkgPath)}`)
      else {
        writePackageJson(rootPkgPath, rootPkg)
        log(`write: updated ${path.relative(root, rootPkgPath)}`)
      }
    } else {
      log('write: root package.json already aligned')
    }
  } else {
    log('write: no root package.json (skipping root alignment)')
  }

  if (args.build) {
    log('build: start')
    await runBuild(args.dryRun ? ['--dry-run'] : [])
    log('build: done')
  } else {
    log('build: disabled')
  }

  if (args.publish) {
    log('publish: start')
    await runPublish(args.dryRun ? ['--dry-run'] : [])
    log('publish: done')
  } else {
    log('publish: disabled')
  }

  log('done')

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          version: newVersion,
          packagesFound: pkgs.length,
          packageJsonChanged: changed.length,
          targets: args.targets,
        },
        null,
        2,
      ),
    )
  }
}
