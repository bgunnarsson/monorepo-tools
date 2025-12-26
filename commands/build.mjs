import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { DEFAULTS } from '../lib/config.mjs'
import { discoverPackages } from '../lib/discover.mjs'
import { run } from '../lib/exec.mjs'
import { readPackageJson } from '../lib/package-json.mjs'

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[monorepo:build] ${msg}`)
}

function parseArgs(argv) {
  const args = {
    targets: [...DEFAULTS.targets],
    skipDirs: new Set(DEFAULTS.skipDirs),

    // if repo root has build.mjs, prefer it
    buildScript: DEFAULTS.buildScript,

    // build order config (repo local)
    buildOrderFile: 'utility/build-order.mjs',

    // fallback package script name
    pkgScript: 'build',

    // tooling
    nodeCmd: DEFAULTS.nodeCmd,
    pnpmCmd: DEFAULTS.pnpmCmd,
    npmCmd: DEFAULTS.npmCmd,

    dryRun: false,
    preferRootScript: true,
  }

  const take = (i) => argv[i + 1]

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--targets') args.targets = take(i).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--skip-dirs') {
      for (const s of take(i).split(',').map((x) => x.trim()).filter(Boolean)) args.skipDirs.add(s)
    } else if (a === '--script') args.pkgScript = take(i)
    else if (a === '--build-script') args.buildScript = take(i)
    else if (a === '--build-order') args.buildOrderFile = take(i)
    else if (a === '--no-root') args.preferRootScript = false
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--pnpm') args.pnpmCmd = take(i)
    else if (a === '--npm') args.npmCmd = take(i)
    else if (a === '--node') args.nodeCmd = take(i)
  }

  return args
}

function repoRoot() {
  return process.cwd()
}

function resolveTargets(root, targets) {
  return targets.map((t) => path.resolve(root, t))
}

function detectPm(root, pnpmCmd, npmCmd) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return { pm: 'pnpm', cmd: pnpmCmd }
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return { pm: 'npm', cmd: npmCmd }
  return { pm: 'pnpm', cmd: pnpmCmd }
}

function runNodeScript({ root, nodeCmd, scriptPath, label, dryRun }) {
  if (dryRun) {
    log(`dry-run: would run node ${path.relative(root, scriptPath)}`)
    return
  }
  log(`run: node ${path.relative(root, scriptPath)}`)
  run(nodeCmd, [scriptPath], { cwd: root, label })
}

function safeReadPkgJson(p) {
  try {
    return readPackageJson(p)
  } catch {
    return null
  }
}

function pickTarget(targets, suffix) {
  const normSuffix = path.normalize(suffix)
  for (const t of targets) {
    if (path.normalize(t).endsWith(normSuffix)) return t
  }
  return null
}

function classifyPkg(p, packagesRoot, pluginsRoot) {
  const dirNorm = path.normalize(p.dir)
  const isUnder = (root) => root && (dirNorm === root || dirNorm.startsWith(root + path.sep))

  if (isUnder(packagesRoot)) return 'package'
  if (isUnder(pluginsRoot)) return 'plugin'
  return 'unknown'
}

async function loadBuildOrder(root, relPath) {
  const abs = path.resolve(root, relPath)
  if (!fs.existsSync(abs)) return null

  const modUrl = pathToFileURL(abs).href
  const mod = await import(modUrl)

  const ORDER = Array.isArray(mod.ORDER) ? mod.ORDER : []
  const PLUGIN_ORDER = Array.isArray(mod.PLUGIN_ORDER) ? mod.PLUGIN_ORDER : []

  return { abs, ORDER, PLUGIN_ORDER }
}

function orderPkgs(pkgs, { ORDER, PLUGIN_ORDER }, { packagesRoot, pluginsRoot }) {
  const byBase = new Map()
  for (const p of pkgs) {
    byBase.set(path.basename(p.dir), p)
  }

  const used = new Set()
  const out = []

  // packages first
  for (const name of ORDER) {
    const p = byBase.get(name)
    if (!p) continue
    if (classifyPkg(p, packagesRoot, pluginsRoot) !== 'package') continue
    used.add(p.dir)
    out.push(p)
  }

  // then any remaining packages (stable deterministic)
  const remainingPackages = pkgs
    .filter((p) => !used.has(p.dir) && classifyPkg(p, packagesRoot, pluginsRoot) === 'package')
    .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)))
  for (const p of remainingPackages) {
    used.add(p.dir)
    out.push(p)
  }

  // plugins next
  for (const name of PLUGIN_ORDER) {
    const p = byBase.get(name)
    if (!p) continue
    if (classifyPkg(p, packagesRoot, pluginsRoot) !== 'plugin') continue
    used.add(p.dir)
    out.push(p)
  }

  // then any remaining plugins
  const remainingPlugins = pkgs
    .filter((p) => !used.has(p.dir) && classifyPkg(p, packagesRoot, pluginsRoot) === 'plugin')
    .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)))
  for (const p of remainingPlugins) {
    used.add(p.dir)
    out.push(p)
  }

  // anything else at the end
  const remainingUnknown = pkgs
    .filter((p) => !used.has(p.dir))
    .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)))
  for (const p of remainingUnknown) out.push(p)

  return out
}

export async function runBuild(argv) {
  const args = parseArgs(argv)
  const root = repoRoot()

  log(`cwd: ${root}`)

  const rootBuild = path.resolve(root, args.buildScript)
  if (args.preferRootScript && fs.existsSync(rootBuild)) {
    runNodeScript({ root, nodeCmd: args.nodeCmd, scriptPath: rootBuild, label: 'build', dryRun: args.dryRun })
    return
  }

  // Fallback: discover packages and run their scripts sequentially (in build order if provided)
  const targets = resolveTargets(root, args.targets)
  const pkgs = discoverPackages({ targets, skipDirs: args.skipDirs })

  const packagesRoot = pickTarget(targets, path.join('src', 'packages'))
  const pluginsRoot = pickTarget(targets, path.join('src', 'plugins'))

  let ordered = pkgs
  const orderCfg = await loadBuildOrder(root, args.buildOrderFile)
  if (orderCfg) {
    log(`order: ${path.relative(root, orderCfg.abs)}`)
    ordered = orderPkgs(pkgs, orderCfg, { packagesRoot, pluginsRoot })
  } else {
    log(`order: missing ${args.buildOrderFile} (using discovery order)`)
  }

  const { pm, cmd } = detectPm(root, args.pnpmCmd, args.npmCmd)
  log(`pm: ${pm}`)

  for (const p of ordered) {
    if (p.private) {
      log(`skip: private ${path.relative(root, p.dir)}`)
      continue
    }

    const pkgJson = safeReadPkgJson(p.packageJsonPath)
    if (!pkgJson?.scripts || typeof pkgJson.scripts[args.pkgScript] !== 'string') {
      log(`skip: no script "${args.pkgScript}" ${path.relative(root, p.dir)}`)
      continue
    }

    const rel = path.relative(root, p.dir)
    if (args.dryRun) {
      log(`dry-run: would build ${rel}`)
      continue
    }

    log(`build: ${rel}`)
    run(cmd, ['run', args.pkgScript], { cwd: p.dir, label: `build (${rel})` })
  }
}
