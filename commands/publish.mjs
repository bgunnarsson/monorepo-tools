import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

import { DEFAULTS } from '../lib/config.mjs'
import { discoverPackages } from '../lib/discover.mjs'
import { readPackageJson } from '../lib/package-json.mjs'

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[monorepo:publish] ${msg}`)
}

function parseArgs(argv) {
  const args = {
    targets: [...DEFAULTS.targets],
    skipDirs: new Set(DEFAULTS.skipDirs),

    buildOrderFile: 'utility/build-order.mjs',
    scopePrefix: DEFAULTS.scopePrefix,

    // npm registry uses "restricted" for private scoped packages
    access: process.env.NPM_PUBLISH_ACCESS || 'restricted',
    tag: process.env.NPM_PUBLISH_TAG || undefined,

    pnpmCmd: DEFAULTS.pnpmCmd,
    noGitChecks: true,

    // registry-latency coping (real strategy: publish -> poll for visibility)
    betweenMs: 30000,        // 30s between packages
    pollEveryMs: 15000,      // 15s poll interval for registry visibility
    publishTimeoutMs: 15 * 60 * 1000, // 15 minutes max per package

    // if publish fails and version is not visible yet, wait then try publish again
    retryPublishEveryMs: 60000, // 60s between publish attempts while waiting for visibility

    dryRun: false,
  }

  const take = (i) => argv[i + 1]

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--targets') args.targets = take(i).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--skip-dirs') {
      for (const s of take(i).split(',').map((x) => x.trim()).filter(Boolean)) args.skipDirs.add(s)
    } else if (a === '--build-order') args.buildOrderFile = take(i)
    else if (a === '--scope') args.scopePrefix = take(i)
    else if (a === '--access') args.access = take(i)
    else if (a === '--tag') args.tag = take(i)
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--pnpm') args.pnpmCmd = take(i)
    else if (a === '--git-checks') args.noGitChecks = false
    else if (a === '--no-git-checks') args.noGitChecks = true
    else if (a === '--between') args.betweenMs = Number(take(i))
    else if (a === '--poll') args.pollEveryMs = Number(take(i))
    else if (a === '--timeout') args.publishTimeoutMs = Number(take(i))
    else if (a === '--retry-publish') args.retryPublishEveryMs = Number(take(i))
  }

  if (args.access === 'private') args.access = 'restricted'
  if (args.access && !['public', 'restricted'].includes(args.access)) {
    throw new Error(`Invalid --access: ${args.access} (use "public" or "restricted")`)
  }

  const clamp0 = (n) => (Number.isFinite(n) && n >= 0 ? n : 0)
  args.betweenMs = clamp0(args.betweenMs)
  args.pollEveryMs = clamp0(args.pollEveryMs)
  args.publishTimeoutMs = clamp0(args.publishTimeoutMs)
  args.retryPublishEveryMs = clamp0(args.retryPublishEveryMs)

  return args
}

function repoRoot() {
  return process.cwd()
}

function resolveTargets(root, targets) {
  return targets.map((t) => path.resolve(root, t))
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
  for (const p of pkgs) byBase.set(path.basename(p.dir), p)

  const used = new Set()
  const out = []

  for (const name of ORDER) {
    const p = byBase.get(name)
    if (!p) continue
    if (classifyPkg(p, packagesRoot, pluginsRoot) !== 'package') continue
    used.add(p.dir)
    out.push(p)
  }

  const remainingPackages = pkgs
    .filter((p) => !used.has(p.dir) && classifyPkg(p, packagesRoot, pluginsRoot) === 'package')
    .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)))
  for (const p of remainingPackages) {
    used.add(p.dir)
    out.push(p)
  }

  for (const name of PLUGIN_ORDER) {
    const p = byBase.get(name)
    if (!p) continue
    if (classifyPkg(p, packagesRoot, pluginsRoot) !== 'plugin') continue
    used.add(p.dir)
    out.push(p)
  }

  const remainingPlugins = pkgs
    .filter((p) => !used.has(p.dir) && classifyPkg(p, packagesRoot, pluginsRoot) === 'plugin')
    .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)))
  for (const p of remainingPlugins) {
    used.add(p.dir)
    out.push(p)
  }

  const remainingUnknown = pkgs
    .filter((p) => !used.has(p.dir))
    .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)))
  for (const p of remainingUnknown) out.push(p)

  return out
}

function runCmd(cmd, args, { cwd, label }) {
  // let pnpm/npm do its normal auth/OTP prompt if needed
  const env = { ...process.env }
  delete env.NPM_OTP
  delete env.NPM_CONFIG_OTP
  delete env.npm_config_otp

  const res = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: 'inherit',
  })

  const code = res.status ?? (res.error ? 1 : 0)
  if (code !== 0) {
    const err = new Error(`${label}: ${cmd} ${args.join(' ')} failed with exit code ${code} (cwd: ${cwd})`)
    err.code = code
    err.spawnError = res.error
    throw err
  }
}

function versionVisible(pnpmCmd, name, version) {
  const spec = `${name}@${version}`
  const res = spawnSync(pnpmCmd, ['view', spec, 'version'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const out = `${res.stdout || ''}\n${res.stderr || ''}`
  const code = res.status ?? (res.error ? 1 : 0)

  if (code === 0) {
    // stdout is typically the version string
    return out.includes(version)
  }

  // treat 404 as "not visible yet"
  if (/\bE404\b/i.test(out) || /404\s+Not\s+Found/i.test(out) || /is not in the npm registry/i.test(out)) {
    return false
  }

  // unknown failure: do not guess
  const err = new Error(`view failed: ${pnpmCmd} view ${spec} version`)
  err.code = code
  err.output = out
  err.spawnError = res.error
  throw err
}

async function publishAndWaitVisible({
  pnpmCmd,
  publishArgs,
  cwd,
  label,
  name,
  version,
  timeoutMs,
  pollEveryMs,
  retryPublishEveryMs,
}) {
  const start = Date.now()
  let lastPublishAttempt = 0

  for (;;) {
    if (versionVisible(pnpmCmd, name, version)) return

    const elapsed = Date.now() - start
    if (elapsed >= timeoutMs) {
      throw new Error(`${label}: version still not visible in registry after ${Math.ceil(timeoutMs / 60000)} minutes`)
    }

    // try publish, but not on every tight loop
    const now = Date.now()
    if (now - lastPublishAttempt >= retryPublishEveryMs) {
      lastPublishAttempt = now
      try {
        runCmd(pnpmCmd, publishArgs, { cwd, label })
      } catch {
        // ignore: we only care about eventual visibility
      }
    }

    await sleep(pollEveryMs)
  }
}

export async function runPublish(argv) {
  const args = parseArgs(argv)
  const root = repoRoot()

  const targets = resolveTargets(root, args.targets)
  const pkgs = discoverPackages({ targets, skipDirs: args.skipDirs })

  const packagesRoot = pickTarget(targets, path.join('src', 'packages'))
  const pluginsRoot = pickTarget(targets, path.join('src', 'plugins'))

  let ordered = pkgs
  const orderCfg = await loadBuildOrder(root, args.buildOrderFile)
  if (orderCfg) ordered = orderPkgs(pkgs, orderCfg, { packagesRoot, pluginsRoot })

  for (const p of ordered) {
    const rel = path.relative(root, p.dir)
    if (p.private) continue

    const pkgJson = safeReadPkgJson(p.packageJsonPath)
    const name = pkgJson?.name
    const version = pkgJson?.version
    const isScoped = typeof name === 'string' && name.startsWith('@')

    if (typeof name !== 'string' || !name.startsWith(args.scopePrefix)) continue
    if (typeof version !== 'string' || !version) throw new Error(`Missing version in ${rel}/package.json`)

    const publishArgs = ['publish']
    if (args.noGitChecks) publishArgs.push('--no-git-checks')
    if (isScoped && args.access) publishArgs.push('--access', args.access)
    if (args.tag) publishArgs.push('--tag', args.tag)

    if (args.dryRun) {
      log(`dry-run: ${rel} -> pnpm publish`)
      continue
    }

    log(`publish: ${rel}`)

    // If already visible, do nothing (rerun-safe).
    if (versionVisible(args.pnpmCmd, name, version)) {
      log(`skip: already in registry ${name}@${version}`)
      if (args.betweenMs > 0) await sleep(args.betweenMs)
      continue
    }

    // Attempt once normally (keeps OTP/auth prompts intact).
    try {
      runCmd(args.pnpmCmd, publishArgs, { cwd: p.dir, label: `publish (${rel})` })
    } catch {
      // fall through to "publish and wait visible" loop
    }

    // Npm can return 409 even when publish succeeded but metadata isn't visible yet.
    await publishAndWaitVisible({
      pnpmCmd: args.pnpmCmd,
      publishArgs,
      cwd: p.dir,
      label: `publish (${rel})`,
      name,
      version,
      timeoutMs: args.publishTimeoutMs,
      pollEveryMs: args.pollEveryMs,
      retryPublishEveryMs: args.retryPublishEveryMs,
    })

    if (args.betweenMs > 0) await sleep(args.betweenMs)
  }
}
