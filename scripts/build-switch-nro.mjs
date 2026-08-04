#!/usr/bin/env node
// Build switch/ps2-ryu.nro. Tries, in order: a local devkitPro
// (DEVKITPRO set and make on PATH), an MSYS2 install with devkitPro pacman
// packages (C:\msys64\opt\devkitpro), then Docker via the devkitpro/devkita64
// image with the SDL2 portlibs layered on top (switch/builder.Dockerfile,
// built once and cached as ps2-ryu-switch-builder).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'ps2-ryu-switch-builder'
const MSYS_BASH = 'C:\\msys64\\usr\\bin\\bash.exe'
const MSYS_DKP = 'C:\\msys64\\opt\\devkitpro'

const has = (cmd, args = ['--version']) =>
  spawnSync(cmd, args, { stdio: 'ignore', shell: false }).status === 0

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })

const msysPath = (p) => '/' + p.replaceAll('\\', '/').replace(':', '')

if (process.env.DEVKITPRO && has('make')) {
  run('make', ['-C', 'switch'])
} else if (process.platform === 'win32' && existsSync(MSYS_BASH) && existsSync(MSYS_DKP)) {
  run(
    MSYS_BASH,
    ['-lc', `export DEVKITPRO=/opt/devkitpro; cd ${msysPath(join(root, 'switch'))} && make`],
    { env: { ...process.env, MSYSTEM: 'MSYS', CHERE_INVOKING: '1' } }
  )
} else if (has('docker')) {
  const inspect = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' })
  if (inspect.status !== 0) {
    console.log(`building ${IMAGE} image (one-time)...`)
    run('docker', ['build', '-t', IMAGE, '-f', 'switch/builder.Dockerfile', 'switch'])
  }
  run('docker', ['run', '--rm', '-v', `${root}:/work`, '-w', '/work/switch', IMAGE, 'make'])
} else {
  console.error(
    'No devkitPro toolchain found. Either install devkitPro (with switch-dev\n' +
      'and the SDL2 portlibs) so DEVKITPRO and make are available, or install\n' +
      'Docker so the build can run in the devkitpro/devkita64 image.'
  )
  process.exit(1)
}
