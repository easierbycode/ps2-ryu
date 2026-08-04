// Browser host: boots Phaser 4, loads the background and the Ryu frame PNGs,
// builds the 5velte-ps2 runtime over the Phaser host, and runs the game. The
// same game module (src/ryu) runs unchanged on native AthenaEnv via
// src/native.ts.
//
// Assets live at the repo root (background.png, frames/) so the native ISO
// build can bundle them; here Vite resolves them to URLs via `?url` imports
// (works in both `vite dev` and `vite build`). We decode each image with a
// native <img> and register it through textures.addImage rather than Phaser's
// file loader — the game needs every texture present before the first frame,
// and this avoids a loader stall Phaser 4.2.1 hits when a large batch of small
// same-origin PNGs completes in one tick.
//
// Every asset URL here has to be a plain build-time string. `new URL(path,
// import.meta.url)` resolves against whatever URL the chunk itself was loaded
// from, so a host that serves the bundle from anything but http(s) rewrites
// every asset into that scheme — a page served over https then asks for
// file:// URLs and the browser refuses the load ("Content at … may not load
// or link to file:///"). A `?url` import bakes the final path in instead,
// leaving nothing to resolve at runtime; scripts/check-web-build.mjs fails
// the build if one creeps back in.

import Phaser from 'phaser'
import { createRuntime, type PS2Runtime } from '5velte-ps2'
import { createPhaserHost, registerCanvasBitmapFont, type PhaserFontConfig } from '5velte-ps2/phaser'
import { createGame, BACKGROUND_FILE } from './ryu/index.ts'
import { createKeyboardPads } from './pads.ts'
import { createGamepadPads, mergePadSources } from './gamepad.ts'
import bgUrl from '../background.png?url'

const frameModules = import.meta.glob('../frames/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

// Athena asset path ("frames/frame_000.png" / "background.png") -> bundler URL
const ASSETS: Record<string, string> = { [BACKGROUND_FILE]: bgUrl }
for (const [path, url] of Object.entries(frameModules)) {
  ASSETS[`frames/${path.split('/').pop()}`] = url
}

function loadImageInto(scene: Phaser.Scene, key: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (scene.textures.exists(key)) return resolve()
    const img = new Image()
    img.onload = () => {
      scene.textures.addImage(key, img)
      resolve()
    }
    img.onerror = () => reject(new Error(`ps2-ryu: failed to load ${url}`))
    img.src = url
  })
}

class RyuScene extends Phaser.Scene {
  rt: PS2Runtime | null = null

  create(): void {
    Promise.all(Object.entries(ASSETS).map(([key, url]) => loadImageInto(this, key, url)))
      .then(() => this.boot())
      .catch((err) => console.error('[ps2-ryu] asset load failed:', err))
  }

  boot(): void {
    registerCanvasBitmapFont(this, 'ps2font', { fontSize: 12 })

    const { host } = createPhaserHost({
      scene: this,
      // keyboard and any connected browser gamepad both drive the PS2 pad
      pads: mergePadSources(createKeyboardPads(this), createGamepadPads()),
      // texture keys are the Athena asset paths themselves
      resolveTexture: (path) => path,
      resolveFont: (): PhaserFontConfig => ({ key: 'ps2font', scale: 1 }),
    })

    const rt = createRuntime(host)
    createGame(rt)
    this.rt = rt
    ;(window as unknown as Record<string, unknown>).ps2 = { rt }
  }

  update(): void {
    // no-op until boot() finishes loading textures and sets rt
    this.rt?.tick()
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  width: 640,
  height: 448,
  parent: 'app',
  backgroundColor: '#000000',
  pixelArt: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: RyuScene,
})
