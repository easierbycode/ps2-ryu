#!/usr/bin/env node
// Fail the web build if anything it emits points at a local file.
//
// The page is served from https://easierbycode.com/ps2-ryu/ (and vendored
// into other hosts), so every URL it ships has to be http(s), data:, blob:,
// or relative. A single local path is enough to break the page in a way that
// only shows up in the browser console:
//
//   Security Error: Content at https://easierbycode.com/ps2-ryu/play/
//   may not load or link to file:///.
//
// Bundlers grow these by accident — an asset resolved with `new URL(path,
// import.meta.url)` inherits the scheme of whatever URL the chunk was loaded
// from, a stray sourceMappingURL keeps a build-machine path, a dependency
// hard-codes one. This runs after `vite build` so the deploy fails here
// rather than in someone's console.
//
// Usage: node scripts/check-web-build.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const dist = process.argv[2] ?? 'dist'
const TEXT = new Set(['.html', '.js', '.css'])

// Schemes an emitted URL may use. Anything else absolute is a local path or
// a browser-internal one and has no business in a deployed page.
const ALLOWED_SCHEMES = new Set(['http', 'https', 'data', 'blob', 'mailto'])

// Local URLs, in every spelling a browser accepts: schemes are
// case-insensitive, and any number of leading slashes parses the same, so
// `file:/tmp/x`, `file:///tmp/x` and `FILE://host/tmp/x` are one URL to the
// URL parser and all three have to be caught.
//
// The slashes and the path character after them are what make it a URL rather
// than a coincidence. Minified code is full of `file:!1` and `File:t(41299)`
// object keys, Phaser's loader config lists the bare scheme string "file://"
// as a prefix it compares against, and its GetURL carries an escaped
// `file:\/\/` inside a regex literal — none of those are loads, and none of
// them reach a path character through unescaped slashes.
const LOCAL_URL = /\b(?:file|chrome|resource):\/+[^/\\\s"'`)|<>][^\s"'`)<>]*/gi

// src="…" / href="…" in the emitted HTML, quoted either way
const HTML_URL_ATTR = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/g

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (TEXT.has(extname(entry))) out.push(path)
  }
  return out
}

let files
try {
  files = walk(dist)
} catch (err) {
  console.error(`[check-web-build] cannot read ${dist}: ${err.message}`)
  process.exit(1)
}

const problems = []

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const where = relative(process.cwd(), file)

  for (const match of source.matchAll(LOCAL_URL)) {
    const context = source.slice(Math.max(0, match.index - 60), match.index + 80)
    problems.push(`${where}: local URL ${match[0]}\n    …${context.replace(/\s+/g, ' ')}…`)
  }

  if (extname(file) !== '.html') continue
  for (const [, , url] of source.matchAll(HTML_URL_ATTR)) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
    // no scheme means relative or root-relative, which is what we want
    if (scheme && !ALLOWED_SCHEMES.has(scheme)) {
      problems.push(`${where}: ${scheme}: URL in a src/href attribute — ${url}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`[check-web-build] ${dist} ships URLs the browser will refuse to load:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`[check-web-build] ${files.length} emitted files, no local URLs`)
