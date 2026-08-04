#!/usr/bin/env node
// Stage the native game build into switch/romfs for the NRO build.
//
// Runs the same native build the PS2 ISO packages (scripts/build-native.mjs:
// esbuild bundles src/native.ts to build/main.js and copies the assets), then
// mirrors build/ into romfs — everything the ISO carries except
// athena.elf/athena.ini (PS2-only boot files). The directory layout is kept
// byte-for-byte because every asset path in the game resolves against it:
// "background.png", "frames/frame_000.png".
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNative } from './build-native.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'switch', 'romfs')

// PS2-only boot files the NRO has no use for
const OMIT = new Set(['athena.elf', 'athena.ini'])

const buildDir = await buildNative()

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'game'), { recursive: true })
mkdirSync(join(out, 'host'), { recursive: true })

let staged = 0
for (const name of readdirSync(buildDir)) {
  if (OMIT.has(name)) continue
  const from = join(buildDir, name)
  if (statSync(from).isDirectory()) {
    cpSync(from, join(out, 'game', name), { recursive: true })
  } else {
    copyFileSync(from, join(out, 'game', name))
  }
  staged++
}

// the host's own JS half (Color/Timer/console), evaluated before main.js
copyFileSync(join(root, 'switch', 'source', 'prelude.js'), join(out, 'host', 'prelude.js'))

console.log(`staged switch/romfs: ${staged} game entr${staged === 1 ? 'y' : 'ies'} + host prelude`)
