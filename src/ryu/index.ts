// PS2-Ryu game module — host-agnostic, built only on the 5velte-ps2
// PS2Runtime surface. Pass any runtime (the Phaser browser host or the
// native AthenaEnv adapter) to createGame and drive it with runtime.tick().

export { createGame, BACKGROUND_FILE } from './game.ts'
export type { RyuGame } from './game.ts'
export { Animation } from './animation.ts'
export { createInput } from './input.ts'
export type { RyuInput } from './input.ts'
