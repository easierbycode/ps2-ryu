// Native PS2 build: bundle src/native.ts (which pulls in the 5velte-ps2
// native adapter + the shared game module) into a single build/main.js that
// AthenaEnv runs, then copy the boot ELF, athena.ini, and runtime assets
// alongside it. The result — build/ — is what the ISO builder packages.

import { build } from 'esbuild'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptsDir, '..')
const buildDir = join(repoRoot, 'build')

// Copied into build/ verbatim (names preserved for AthenaEnv):
//  - athena.elf : the AthenaEnv interpreter (renamed to the PS2 boot name by the ISO builder)
//  - athena.ini : default_script = "main.js" (the bundle below)
//  - background.png : the stage backdrop
const ASSET_FILES = ['athena.elf', 'athena.ini', 'background.png']
const ASSET_DIRS = ['frames'] // the Ryu sprite frames

export async function buildNative() {
  rmSync(buildDir, { recursive: true, force: true })
  mkdirSync(buildDir, { recursive: true })

  await build({
    entryPoints: [join(repoRoot, 'src', 'native.ts')],
    outfile: join(buildDir, 'main.js'),
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: ['es2020'],
    legalComments: 'none',
    logLevel: 'info',
  })

  for (const f of ASSET_FILES) {
    const src = join(repoRoot, f)
    if (!existsSync(src)) {
      throw new Error(`[build-native] missing required asset '${f}' at repo root`)
    }
    copyFileSync(src, join(buildDir, f))
  }
  for (const d of ASSET_DIRS) {
    const src = join(repoRoot, d)
    // Fail loudly like ASSET_FILES: an absent or empty sprite dir would produce
    // an ISO that renders no Ryu on hardware, which the build must not hide.
    if (!existsSync(src) || readdirSync(src).length === 0) {
      throw new Error(`[build-native] missing or empty required asset dir '${d}/' at repo root`)
    }
    cpSync(src, join(buildDir, d), { recursive: true })
  }

  console.log(
    `[build-native] build/ ready — main.js + ${ASSET_FILES.join(', ')} + ${ASSET_DIRS.map((d) => d + '/').join(', ')}`,
  )
  return buildDir
}

// Run when invoked directly (`node scripts/build-native.mjs`), but stay quiet
// when imported by build-iso.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildNative().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
