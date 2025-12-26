import process from 'node:process'

export const DEFAULTS = {
  scopePrefix: '@bgunnarsson/galdur-',

  targets: ['src/packages', 'src/plugins'],

  skipDirs: [
    'node_modules',
    'dist',
    'build',
    '.git',
    '.turbo',
    '.next',
    '.cache',
    'coverage',
    '.pnpm-store',
  ],

  // existing scripts you already have (keep the filenames you already use)
  housekeepingScript: 'housekeeping.mjs',
  buildScript: 'build.mjs',
  publishScript: 'publish.mjs',

  nodeCmd: process.execPath, // current node
  pnpmCmd: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  npmCmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
}

