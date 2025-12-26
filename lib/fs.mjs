import fs from 'node:fs'

export function pathExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

