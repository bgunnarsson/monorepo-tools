import fs from 'node:fs'
import path from 'node:path'

import { readPackageJson } from './package-json.mjs'

function shouldSkipDirName(name, skipDirs) {
  return skipDirs.has(name)
}

function walk(startDir, skipDirs, out) {
  let entries
  try {
    entries = fs.readdirSync(startDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const name = ent.name
    if (shouldSkipDirName(name, skipDirs)) continue

    const dir = path.join(startDir, name)
    const pj = path.join(dir, 'package.json')

    if (fs.existsSync(pj) && fs.statSync(pj).isFile()) {
      try {
        const pkg = readPackageJson(pj)
        out.push({
          dir,
          packageJsonPath: pj,
          pkg,
          name: pkg?.name,
          private: Boolean(pkg?.private),
          version: pkg?.version,
        })
      } catch {
        // ignore invalid package.json; keep scan going
      }
      // keep walking; nested packages are allowed
    }

    walk(dir, skipDirs, out)
  }
}

export function discoverPackages({ targets, skipDirs }) {
  const out = []
  for (const t of targets) {
    if (!fs.existsSync(t)) continue
    walk(t, skipDirs, out)
  }

  // stable order for determinism (helps debugging)
  out.sort((a, b) => a.dir.localeCompare(b.dir))
  return out
}

