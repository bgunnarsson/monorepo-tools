import { spawnSync } from 'node:child_process'

export function run(cmd, args, { cwd, label } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })

  if (res.error) throw res.error
  const code = res.status ?? 1
  if (code !== 0) {
    const where = cwd ? ` (cwd: ${cwd})` : ''
    const what = label ? `${label}: ` : ''
    throw new Error(`${what}${cmd} ${args.join(' ')} failed with exit code ${code}${where}`)
  }
}

