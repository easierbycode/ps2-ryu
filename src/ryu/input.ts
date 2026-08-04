// Pad input for the Ryu port.
//
// main.js did edge detection with the `oldPad = pad; pad = Pads.get()`
// idiom. That does not survive the port: under the 5velte-ps2 shim a pad's
// pressed() reads the *live* host state, so `oldPad` and `pad` would report
// the same thing and every edge would read false. The portable pattern
// (identical to src/ps2-sp/input.ts) is to hold one pad, call update() once
// per frame, and snapshot the held mask so isPressed can compare against the
// previous frame. This runs the same on the browser host and on real
// AthenaEnv hardware.

import { PAD_BUTTONS } from '5velte-ps2'
import type { PS2Pad, PS2Runtime } from '5velte-ps2'

const MASKS: number[] = Object.values(PAD_BUTTONS)

export interface RyuInput {
  /** snapshot the pad; call once at the top of each frame */
  update(): void
  /** is the button held this frame? */
  isDown(mask: number): boolean
  /** did the button go down this frame? (rising edge) */
  isPressed(mask: number): boolean
}

export function createInput(rt: PS2Runtime): RyuInput {
  const pad: PS2Pad = rt.Pads.get()
  let held: Record<number, boolean> = {}
  let prev: Record<number, boolean> = {}

  return {
    update(): void {
      pad.update()
      prev = held
      held = {}
      for (const mask of MASKS) {
        held[mask] = pad.pressed(mask)
      }
    },
    isDown(mask: number): boolean {
      return held[mask] === true
    },
    isPressed(mask: number): boolean {
      return held[mask] === true && prev[mask] !== true
    },
  }
}
