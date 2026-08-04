// Keyboard-backed PadSource for the browser host (adapted from the
// 5velte-ps2 demo). Ryu polls input every frame, but a key tapped and
// released between two frames could still be missed, so each key-down is
// latched as "held" for a short window (~66 ms) to guarantee every tap is
// seen by at least one poll. The game does its own edge detection on top of
// held(), so fresh() simply mirrors held().
//
// Arrows = d-pad (Up = jump, Down = crouch), V = SQUARE (punch),
// Z = CROSS (kick). Shoryuken: forward, down, forward + V.

import Phaser from 'phaser'
import { PAD_BUTTONS } from '5velte-ps2'
import type { PadSource } from '5velte-ps2/phaser'

const MIN_HOLD_MS = 66

export function createKeyboardPads(scene: Phaser.Scene): PadSource {
  const kb = scene.input.keyboard
  if (!kb) throw new Error('ps2-ryu: keyboard plugin unavailable')

  interface Binding {
    mask: number
    key: Phaser.Input.Keyboard.Key
    latchUntil: number
  }

  const bind = (mask: number, keyCode: string): Binding => {
    const key = kb.addKey(keyCode, false)
    const binding: Binding = { mask, key, latchUntil: 0 }
    key.on('down', () => {
      binding.latchUntil = scene.time.now + MIN_HOLD_MS
    })
    return binding
  }

  const bindings: Binding[] = [
    bind(PAD_BUTTONS.UP, 'UP'),
    bind(PAD_BUTTONS.DOWN, 'DOWN'),
    bind(PAD_BUTTONS.LEFT, 'LEFT'),
    bind(PAD_BUTTONS.RIGHT, 'RIGHT'),
    bind(PAD_BUTTONS.CROSS, 'Z'),
    bind(PAD_BUTTONS.CIRCLE, 'X'),
    bind(PAD_BUTTONS.TRIANGLE, 'C'),
    bind(PAD_BUTTONS.SQUARE, 'V'),
    bind(PAD_BUTTONS.START, 'ENTER'),
    bind(PAD_BUTTONS.SELECT, 'SHIFT'),
    bind(PAD_BUTTONS.L1, 'Q'),
    bind(PAD_BUTTONS.R1, 'E'),
  ]

  const held = (mask: number): boolean => {
    const now = scene.time.now
    return bindings.some((b) => (mask & b.mask) !== 0 && (b.key.isDown || now < b.latchUntil))
  }

  return { held, fresh: held }
}
