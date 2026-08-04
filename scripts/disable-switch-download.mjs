#!/usr/bin/env node
// Turn the download page's Switch button into an inert note when the NRO
// isn't in the build.
//
// The NRO is the one artifact this repo can't build on its own: it needs
// devkitPro's package server, which has taken whole deploys down before
// (403 on the pacman databases). deploy.yml publishes without it rather
// than blocking, so the page must not offer a link that 404s.
//
// Usage: node scripts/disable-switch-download.mjs <distDir>
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = process.argv[2] ?? 'dist'
const page = join(dist, 'index.html')
const nro = join(dist, 'ps2-ryu.nro')

if (existsSync(nro)) {
  console.log('[switch-dl] NRO present — download page left alone')
  process.exit(0)
}

const html = readFileSync(page, 'utf8')
// the anchor as index.html writes it, from `<a class="btn btn-switch"` to its
// closing tag; kept as one regex so a changed label can't silently no-op
const button = /<a class="btn btn-switch"[\s\S]*?<\/a>/
if (!button.test(html)) {
  console.error('[switch-dl] could not find the Switch button in ' + page)
  process.exit(1)
}

const replacement = `<span class="btn btn-switch btn-unavailable">
          SWITCH NRO UNAVAILABLE
          <span class="hint">this build could not reach devkitPro — try the ISO or the browser build</span>
        </span>`

writeFileSync(page, html.replace(button, replacement))
console.log('[switch-dl] no NRO in ' + dist + ' — Switch button disabled on the download page')
