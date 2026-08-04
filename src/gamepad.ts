// Browser Gamepad API → PS2 button masks, shared by the play page (as a
// PadSource merged with the keyboard) and the landing page (menu navigation
// and the logo's shoryuken easter egg).
//
// Physical buttons are read at the standard-mapping indices
// (https://w3c.github.io/gamepad/#remapping) and translated onto the game's
// six-button layout. Face buttons land the same everywhere; the shoulder /
// trigger rows swap between SNES-style pads and everything else:
//
//                SNES-style pad        other pads
//   LP           left face (Y)         left face
//   MP           top face (X)          top face
//   HP           R2                    R (R1)
//   LK           bottom face (B)       bottom face
//   MK           right face (A)        right face
//   HK           R                     R2
//   all punches  L2                    L (L1)
//   all kicks    L                     L2
//
// SNES-style pads are recognised by name (8BitDo SN30 / SNES / Super
// Famicom receivers and the like); pads that don't report a "standard"
// mapping are still read at the standard indices as a best effort.

import type { PadSource } from '5velte-ps2/phaser'

// The PS2 SIO pad bit layout (identical to PAD_BUTTONS in 5velte-ps2).
// Declared locally — it's immutable hardware fact — so the landing page,
// which only needs these masks, doesn't have to pull in the whole runtime.
export const PS2_MASKS = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  L2: 0x0100,
  R2: 0x0200,
  L1: 0x0400,
  R1: 0x0800,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
} as const

const { UP, DOWN, LEFT, RIGHT, SQUARE, TRIANGLE, CROSS, CIRCLE, L1, L2, R1, R2, START, SELECT } =
  PS2_MASKS

// Standard-mapping button indices
const BOTTOM = 0
const RIGHT_FACE = 1
const LEFT_FACE = 2
const TOP = 3
const L_SHOULDER = 4
const R_SHOULDER = 5
const L_TRIGGER = 6
const R_TRIGGER = 7
const SELECT_BTN = 8
const START_BTN = 9
const DPAD_UP = 12
const DPAD_DOWN = 13
const DPAD_LEFT = 14
const DPAD_RIGHT = 15

const SNES_ID = /snes|sfc|super\s*famicom|superfam|sn30|sf30/i

export const isSnesPad = (id: string): boolean => SNES_ID.test(id)

type ButtonMap = Array<[physicalIndex: number, mask: number]>

const COMMON_MAP: ButtonMap = [
  [LEFT_FACE, SQUARE], // LP
  [TOP, TRIANGLE], // MP
  [BOTTOM, CROSS], // LK
  [RIGHT_FACE, CIRCLE], // MK
  [DPAD_UP, UP],
  [DPAD_DOWN, DOWN],
  [DPAD_LEFT, LEFT],
  [DPAD_RIGHT, RIGHT],
  [START_BTN, START],
  [SELECT_BTN, SELECT],
]

const SNES_MAP: ButtonMap = [
  ...COMMON_MAP,
  [R_TRIGGER, R1], // HP = R2
  [R_SHOULDER, R2], // HK = R
  [L_TRIGGER, L1], // all punches = L2
  [L_SHOULDER, L2], // all kicks = L
]

const OTHER_MAP: ButtonMap = [
  ...COMMON_MAP,
  [R_SHOULDER, R1], // HP = R
  [R_TRIGGER, R2], // HK = R2
  [L_SHOULDER, L1], // all punches = L
  [L_TRIGGER, L2], // all kicks = L2
]

const AXIS_THRESHOLD = 0.5

export interface GamepadSnapshot {
  connected: boolean
  snes: boolean
  /** OR of the PS2 masks currently held */
  buttons: number
}

const NO_PAD: GamepadSnapshot = { connected: false, snes: false, buttons: 0 }

/** Read the first connected gamepad as a PS2 button mask. */
export function readGamepad(): GamepadSnapshot {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return NO_PAD
  }
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue
    const snes = isSnesPad(gp.id)
    let buttons = 0
    for (const [index, mask] of snes ? SNES_MAP : OTHER_MAP) {
      if (gp.buttons[index]?.pressed) buttons |= mask
    }
    // the left stick doubles as the d-pad
    const lx = gp.axes[0] ?? 0
    const ly = gp.axes[1] ?? 0
    if (lx < -AXIS_THRESHOLD) buttons |= LEFT
    if (lx > AXIS_THRESHOLD) buttons |= RIGHT
    if (ly < -AXIS_THRESHOLD) buttons |= UP
    if (ly > AXIS_THRESHOLD) buttons |= DOWN
    return { connected: true, snes, buttons }
  }
  return NO_PAD
}

/** PadSource over the first connected browser gamepad (play page host). */
export function createGamepadPads(): PadSource {
  const held = (mask: number): boolean => (readGamepad().buttons & mask) !== 0
  return { held, fresh: held }
}

/** Combine PadSources — a button counts as held if any source holds it. */
export function mergePadSources(...sources: PadSource[]): PadSource {
  return {
    held: (mask) => sources.some((s) => s.held(mask)),
    fresh: (mask) => sources.some((s) => s.fresh(mask)),
  }
}
