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

    // npm uses "restricted" for private scoped packages
    access: process.env.NPM_PUBLISH_ACCESS || 'restricted',
    tag: process.env.NPM_PUBLISH_TAG || undefined,

    // If provided => non-interactive (CI). If omitted => pnpm will prompt (OTP/device auth) via TTY.
    otp: process.env.NPM_OTP || process.env.NPM_CONFIG_OTP || undefined,

    pnpmCmd: DEFAULTS.pnpmCmd,
    noGitChecks: true,

    // 409 handling
    retry: 12,
    retryDelayMs: 5000,
    retryMaxDelayMs: 60000,

    // throttle between publishes
    betweenMs: 2000,

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
    else if (a === '--otp') args.otp = take(i)
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--pnpm') args.pnpmCmd = take(i)
    else if (a === '--git-checks') args.noGitChecks = false
    else if (a === '--no-git-checks') args.noGitChecks = true
    else if (a === '--retry') args.retry = Number(take(i))
    else if (a === '--retry-delay') args.retryDelayMs = Number(take(i))
    else if (a === '--retry-max-delay') args.retryMaxDelayMs = Number(take(i))
    else if (a === '--between') args.betweenMs = Number(take(i))
  }

  if (args.access === 'private') args.access = 'restricted'
  if (args.access && !['public', 'restricted'].includes(args.access)) {
    throw new Error(`Invalid --access: ${args.access} (use "public" or "restricted")`)
  }

  if (!Number.isFinite(args.retry) || args.retry < 0) args.retry = 0
  if (!Number.isFinite(args.retryDelayMs) || args.retryDelayMs < 0) args.retryDelayMs = 0
  if (!Number.isFinite(args.retryMaxDelayMs) || args.retryMaxDelayMs < 0) args.retryMaxDelayMs = 0
  if (!Number.isFinite(args.betweenMs) || args.betweenMs < 0) args.betweenMs = 0

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
  // stdin MUST be inherit so pnpm/npm can prompt (OTP / device auth)
  // stdout/stderr piped so we can parse 409 and still mirror output
  const res = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  const out = `${res.stdout || ''}\n${res.stderr || ''}`

  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)

  const code = res.status ?? (res.error ? 1 : 0)
  if (code !== 0) {
    const err = new Error(`${label}: ${cmd} ${args.join(' ')} failed with exit code ${code} (cwd: ${cwd})`)
    err.code = code
    err.output = out
    err.spawnError = res.error
    throw err
  }

  return out
}

function is409FromOutput(s) {
  return (
    /(^|\b)E409(\b|$)/i.test(s) ||
    /409\s+Conflict/i.test(s) ||
    /Failed to save packument/i.test(s) ||
    /previous package has not been fully processed/i.test(s)
  )
}

function isNotFoundFromOutput(s) {
  return /(^|\b)E404(\b|$)/i.test(s) || /404\s+Not\s+Found/i.test(s) || /is not in the npm registry/i.test(s)
}

function isAlreadyPublishedFromOutput(s) {
  return (
    /cannot publish over the previously published versions/i.test(s) ||
    /You cannot publish over the previously published versions/i.test(s) ||
    /previously published/i.test(s) ||
    /cannot modify pre-existing version/i.test(s)
  )
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function nextDelayMs(baseMs, attempt, maxMs) {
  const raw = baseMs * Math.pow(2, Math.max(0, attempt - 1))
  return clamp(Math.floor(raw), 0, maxMs)
}

function hasPublishedVersion(pnpmCmd, spec) {
  const args = ['view', spec, 'version']
  const res = spawnSync(pnpmCmd, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const out = `${res.stdout || ''}\n${res.stderr || ''}`
  const code = res.status ?? (res.error ? 1 : 0)

  if (code === 0) return true
  if (isNotFoundFromOutput(out)) return false

  const err = new Error(`view: ${pnpmCmd} ${args.join(' ')} failed (cannot determine published status)`)
  err.code = code
  err.output = out
  err.spawnError = res.error
  throw err
}

async function publishOne({ pnpmCmd, publishArgs, cwd, label, spec, retries, baseDelayMs, maxDelayMs }) {
  let attempt = 0

  for (;;) {
    try {
      runCmd(pnpmCmd, publishArgs, { cwd, label })
      return
    } catch (e) {
      const out = String(e?.output || '')

      // If publish actually landed, treat as success and continue.
      if (isAlreadyPublishedFromOutput(out)) return

      // 409: registry conflict/processing. Back off and verify.
      if (is409FromOutput(out)) {
        attempt++
        if (attempt > retries) throw e

        const delay = nextDelayMs(baseDelayMs, attempt, maxDelayMs)
        log(`retry: 409 ${label} (attempt ${attempt}/${retries}) wait ${delay}ms`)
        await sleep(delay)

        // If the version became visible while we waited, stop retrying.
        if (hasPublishedVersion(pnpmCmd, spec)) return

        continue
      }

      throw e
    }
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

    const spec = `${name}@${version}`

    // idempotent reruns
    if (hasPublishedVersion(args.pnpmCmd, spec)) {
      log(`skip: already published ${spec}`)
      continue
    }

    const publishArgs = ['publish']

    if (args.noGitChecks) publishArgs.push('--no-git-checks')
    if (isScoped && args.access) publishArgs.push('--access', args.access)
    if (args.tag) publishArgs.push('--tag', args.tag)
    if (args.otp) publishArgs.push('--otp', args.otp)

    if (args.dryRun) {
      log(`dry-run: publish ${rel} (${spec})`)
      continue
    }

    log(`publish: ${rel}`)

    await publishOne({
      pnpmCmd: args.pnpmCmd,
      publishArgs,
      cwd: p.dir,
      label: `publish (${rel})`,
      spec,
      retries: args.retry,
      baseDelayMs: args.retryDelayMs,
      maxDelayMs: args.retryMaxDelayMs,
    })

    // confirm after publish attempt; this catches "publish succeeded but client got 409" cases
    if (hasPublishedVersion(args.pnpmCmd, spec)) {
      log(`ok: ${spec}`)
    } else {
      throw new Error(`publish: registry did not show ${spec} after publish attempt`)
    }

    if (args.betweenMs > 0) await sleep(args.betweenMs)
  }
}
