#!/usr/bin/env node
import process from 'node:process'

function die(msg, code = 1) {
  if (msg) console.error(msg)
  process.exit(code)
}

function usage() {
  die(
    [
      'bgunnarsson-monorepo <command> [options]',
      '',
      'Commands:',
      '  release        Update versions, then build + publish (no install)',
      '  build          Build all packages/plugins',
      '  housekeeping   Remove dist/node_modules recursively (or run root housekeeping.mjs if present)',
      '',
      'Examples:',
      '  bgunnarsson-monorepo release --bump patch',
      '  bgunnarsson-monorepo build',
      '  bgunnarsson-monorepo housekeeping',
    ].join('\n'),
    1,
  )
}

const argv = process.argv.slice(2)
const cmd = argv.shift()

if (!cmd || cmd === '-h' || cmd === '--help') usage()

try {
  if (cmd === 'release') {
    const { runRelease } = await import('../commands/release.mjs')
    await runRelease(argv)
  } else if (cmd === 'build') {
    const { runBuild } = await import('../commands/build.mjs')
    await runBuild(argv)
  } else if (cmd === 'housekeeping') {
    const { runHousekeeping } = await import('../commands/housekeeping.mjs')
    await runHousekeeping(argv)
  } else {
    usage()
  }
} catch (e) {
  die(e?.stack || e?.message || String(e), 1)
}
