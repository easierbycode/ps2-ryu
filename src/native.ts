// Native AthenaEnv entry point. esbuild bundles this to a single build/main.js
// that AthenaEnv (athena.elf) runs on real PS2 hardware / emulators. The game
// module (src/ryu) is identical to the one the browser host runs.

import { createNativeRuntime, runNativeLoop } from '5velte-ps2/native'
import { createGame } from './ryu/index.ts'

// Reassert the video mode before rendering. Recent AthenaEnv builds boot the
// GS such that a script which never calls Screen.setMode() renders the
// interlaced 640x448 framebuffer as alternating black scanlines (the fix the
// original main.js carried). createNativeRuntime wraps Screen but doesn't
// expose setMode, so poke the real AthenaEnv global directly.
const nativeScreen = (
  globalThis as unknown as { Screen?: { getMode(): unknown; setMode(mode: unknown): void } }
).Screen
if (nativeScreen && typeof nativeScreen.setMode === 'function') {
  nativeScreen.setMode(nativeScreen.getMode())
}

// The same bundle boots on two native hosts:
//  - Real AthenaEnv (PS2/emulator): Screen has clear()/flip(), and the script
//    owns the main loop — runNativeLoop busy-loops rt.tick() forever.
//  - The Switch homebrew host (switch/): the C main loop owns the frame — it
//    clears/presents around a JS callback registered with Screen.display(cb),
//    so main.js must register and return. That host has no Screen.clear/flip
//    and its Pads are pumped from C (pads have no update()), so shim both
//    before the runtime captures them.
type NativeScreenSurface = {
  display(cb: () => void): void
  clear?(color?: unknown): void
  flip?(): void
}
type NativePadsSurface = { get(port?: number): Record<string, unknown> }
const g = globalThis as unknown as { Screen: NativeScreenSurface; Pads: NativePadsSurface }
const callbackStyleHost = typeof g.Screen.flip !== 'function'

if (callbackStyleHost) {
  g.Screen.clear = () => {}
  g.Screen.flip = () => {}
  const origGet = g.Pads.get.bind(g.Pads)
  g.Pads.get = (port = 0) => {
    const pad = origGet(port)
    if (typeof pad.update !== 'function') pad.update = () => {}
    return pad
  }
}

const rt = createNativeRuntime()
rt.Screen.setVSync(true)
createGame(rt)
if (callbackStyleHost) {
  g.Screen.display(() => rt.tick())
} else {
  runNativeLoop(rt)
}
