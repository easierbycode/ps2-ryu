// Build a bootable PS2 ISO of PS2-Ryu.
//
// 1. Runs the native build (scripts/build-native.mjs) to produce build/.
// 2. Hands build/ to the vendored pure-Deno ISO9660 writer
//    (scripts/build-athena-iso.ts), which emits SYSTEM.CNF + ATHA_000.01
//    (the boot ELF) and copies the rest (main.js, athena.ini,
//    background.png, frames/) into the image.
//
// Requires: deno on PATH. CI (.github/workflows/deploy.yml) invokes the
// writer directly with SOURCE_DATE_EPOCH pinned for a reproducible image.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNative } from './build-native.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptsDir, '..')
const isoScript = join(scriptsDir, 'build-athena-iso.ts')

const buildDir = await buildNative()
const outIso = join(repoRoot, 'ps2-ryu.iso')

console.log(`[build-iso] packaging ${buildDir} -> ${outIso}`)
const res = spawnSync(
  'deno',
  ['run', '--allow-read', '--allow-write', '--allow-env', isoScript, buildDir, outIso, 'athena.elf'],
  { stdio: 'inherit' },
)

if (res.error) {
  console.error('[build-iso] failed to launch deno — is it installed and on PATH?', res.error)
  process.exit(1)
}
process.exit(res.status ?? 1)
