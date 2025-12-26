import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { DEFAULTS } from '../lib/config.mjs'
import { run } from '../lib/exec.mjs'

function logRemove(msg) {
  // eslint-disable-next-line no-console
  console.log(msg)
}

function parseArgs(argv) {
  const args = {
    housekeepingScript: DEFAULTS.housekeepingScript,

    remove: new Set(['node_modules', 'dist']),
    skipDirs: new Set(DEFAULTS.skipDirs),

    nodeCmd: DEFAULTS.nodeCmd,

    dryRun: false,
    preferRootScript: true,
  }

  const take = (i) => argv[i + 1]

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remove') args.remove = new Set(take(i).split(',').map((s) => s.trim()).filter(Boolean))
    else if (a === '--skip-dirs') {
      for (const s of take(i).split(',').map((x) => x.trim()).filter(Boolean)) args.skipDirs.add(s)
    } else if (a === '--housekeeping-script') args.housekeepingScript = take(i)
    else if (a === '--no-root') args.preferRootScript = false
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--node') args.nodeCmd = take(i)
  }

  return args
}

function repoRoot() {
  return process.cwd()
}

async function removeFoldersRecursive(dir, { remove, skipDirs, dryRun }) {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const name = entry.name
    if (skipDirs.has(name) && !remove.has(name)) continue

    const fullPath = path.join(dir, name)

    if (remove.has(name)) {
      logRemove(fullPath)
      if (!dryRun) {
        await fs.promises.rm(fullPath, { recursive: true, force: true })
      }
      continue
    }

    await removeFoldersRecursive(fullPath, { remove, skipDirs, dryRun })
  }
}

export async function runHousekeeping(argv) {
  const args = parseArgs(argv)
  const root = repoRoot()

  const rootScript = path.resolve(root, args.housekeepingScript)

  if (args.preferRootScript && fs.existsSync(rootScript)) {
    if (!args.dryRun) run(args.nodeCmd, [rootScript], { cwd: root, label: 'housekeeping' })
    return
  }

  await removeFoldersRecursive(root, { remove: args.remove, skipDirs: args.skipDirs, dryRun: args.dryRun })
}
