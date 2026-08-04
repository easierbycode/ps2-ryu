// The PS2-Ryu demo, ported from the original AthenaEnv main.js onto the
// 5velte-ps2 PS2Runtime surface. createGame(rt) builds the animations and
// state and registers the per-frame callback via rt.Screen.display(); the
// host (Phaser in the browser, native AthenaEnv on PS2) drives it with
// rt.tick(). All gameplay constants and logic mirror the original — the only
// structural changes are input edge detection (see input.ts) and image flip
// coordinates (see animation.ts).

import { PAD_BUTTONS } from '5velte-ps2'
import type { PS2ImageInstance, PS2Runtime } from '5velte-ps2'
import { Animation } from './animation.ts'
import { createInput } from './input.ts'

// Background asset the browser host must preload; frames are pulled by the
// Animation constructors below (frames/frame_000.png … frame_031.png).
export const BACKGROUND_FILE = 'background.png'

const SCREEN_WIDTH = 640
const SCREEN_HEIGHT = 448
const GROUND_Y = 190

const WORLD_WIDTH = SCREEN_WIDTH * 1.2
const WORLD_HEIGHT = SCREEN_HEIGHT

// Ryu offset — how far to shift the sprite when facing left (flipping around
// the top-left origin), tuned by eye in the original.
const FLIP_OFFSET = 60

const { UP, DOWN, LEFT, RIGHT, SQUARE, CROSS } = PAD_BUTTONS

const frame = (i: number): string => `frames/frame_${String(i).padStart(3, '0')}.png`

export interface RyuGame {
  rt: PS2Runtime
}

export function createGame(rt: PS2Runtime): RyuGame {
  const input = createInput(rt)

  // Background scaled to the world size. NEAREST matches AthenaEnv's own Image
  // default (which the original relied on); without it the native adapter would
  // force LINEAR and soften the upscaled art.
  const background: PS2ImageInstance = new rt.Image(BACKGROUND_FILE)
  background.filter = rt.NEAREST
  background.width = WORLD_WIDTH
  background.height = WORLD_HEIGHT

  // Camera
  let cameraX = 0
  let cameraY = 0

  // Animations (32 source frames total)
  const idleAnim = new Animation(rt, [frame(0), frame(1), frame(2), frame(3)], 6)
  const crouchAnim = new Animation(rt, [frame(18)], 6) // first crouch-kick frame as the crouch pose
  const lightPunchAnim = new Animation(rt, [frame(4), frame(5), frame(6)], 15)
  const lightKickAnim = new Animation(rt, [frame(7), frame(8), frame(9)], 15)
  const shoryukenAnim = new Animation(
    rt,
    [frame(10), frame(11), frame(12), frame(13), frame(14), frame(15), frame(16), frame(17)],
    12,
  )
  const crouchLightKickAnim = new Animation(
    rt,
    [frame(18), frame(19), frame(20), frame(21), frame(18)],
    15,
  )
  const crouchLightPunchAnim = new Animation(rt, [frame(22), frame(23), frame(24)], 15)
  const jumpAnim = new Animation(
    rt,
    [frame(25), frame(26), frame(27), frame(28), frame(29), frame(30), frame(31)],
    10,
  )

  // Player state
  let posX = 250
  let posY = GROUND_Y
  let velY = 0
  let velX = 0
  const gravity = 0.5
  const jumpForce = -12
  const moveSpeed = 4
  let isGrounded = true
  let facingLeft = false

  // Combat state
  let isAttacking = false
  let attackFrames = 0
  let isCrouching = false
  let currentAnimation: Animation = idleAnim

  // Input buffering for special moves
  interface BufferedInput {
    input: 'down' | 'left' | 'right' | 'punch'
    time: number
  }
  let inputBuffer: BufferedInput[] = []
  let bufferTimer = 0

  function drawBackground(): void {
    background.draw(-cameraX, -cameraY)
  }

  function updateCamera(): void {
    // Follow player horizontally
    cameraX = posX - SCREEN_WIDTH / 2

    // Follow player vertically if they jump above the screen's vertical midpoint
    const cameraLockY = WORLD_HEIGHT - SCREEN_HEIGHT
    if (posY - cameraLockY < SCREEN_HEIGHT / 2) {
      cameraY = posY - SCREEN_HEIGHT / 2
    } else {
      cameraY = cameraLockY
    }

    // Clamp camera to world boundaries
    cameraX = Math.max(0, Math.min(cameraX, WORLD_WIDTH - SCREEN_WIDTH))
    cameraY = Math.max(0, Math.min(cameraY, WORLD_HEIGHT - SCREEN_HEIGHT))
  }

  function updateInputBuffer(): void {
    if (input.isPressed(DOWN)) inputBuffer.push({ input: 'down', time: bufferTimer })
    if (input.isPressed(LEFT)) inputBuffer.push({ input: 'left', time: bufferTimer })
    if (input.isPressed(RIGHT)) inputBuffer.push({ input: 'right', time: bufferTimer })
    if (input.isPressed(SQUARE)) inputBuffer.push({ input: 'punch', time: bufferTimer })

    // Remove old inputs (older than 30 frames)
    inputBuffer = inputBuffer.filter((item) => bufferTimer - item.time < 30)
  }

  function checkShoryuken(): boolean {
    if (inputBuffer.length < 4) return false

    const recent = inputBuffer.slice(-4)
    const forwardDir = facingLeft ? 'left' : 'right'

    let hasFirstForward = false
    let hasDown = false
    let hasSecondForward = false
    let hasPunch = false

    for (let i = 0; i < recent.length; i++) {
      if (!hasFirstForward && recent[i].input === forwardDir) {
        hasFirstForward = true
      } else if (hasFirstForward && !hasDown && recent[i].input === 'down') {
        hasDown = true
      } else if (hasDown && !hasSecondForward && recent[i].input === forwardDir) {
        hasSecondForward = true
      } else if (hasSecondForward && recent[i].input === 'punch') {
        hasPunch = true
      }
    }

    return hasFirstForward && hasDown && hasSecondForward && hasPunch
  }

  function performAttack(anim: Animation, frames: number): void {
    isAttacking = true
    attackFrames = frames
    currentAnimation = anim
    currentAnimation.reset()
  }

  function performShoryuken(): void {
    isAttacking = true
    attackFrames = 48
    currentAnimation = shoryukenAnim
    currentAnimation.reset()

    velY = jumpForce * 1.2
    isGrounded = false

    inputBuffer = []
  }

  function handleInput(): void {
    if (isAttacking) {
      attackFrames--
      if (attackFrames <= 0) {
        isAttacking = false
        currentAnimation = idleAnim
        currentAnimation.reset()
      }
      return
    }

    isCrouching = input.isDown(DOWN) && isGrounded

    if (checkShoryuken() && isGrounded) {
      performShoryuken()
      return
    }

    // Crouching attacks
    if (isCrouching) {
      if (input.isPressed(SQUARE)) {
        performAttack(crouchLightPunchAnim, 18)
        return
      }
      if (input.isPressed(CROSS)) {
        performAttack(crouchLightKickAnim, 30)
        return
      }

      currentAnimation = crouchAnim
      velX = 0
      return
    }

    // Standing attacks
    if (input.isPressed(SQUARE) && isGrounded) {
      performAttack(lightPunchAnim, 18)
      return
    }

    if (input.isPressed(CROSS) && isGrounded) {
      performAttack(lightKickAnim, 18)
      return
    }

    // Jumping
    if (input.isPressed(UP) && isGrounded) {
      velY = jumpForce
      isGrounded = false
      currentAnimation = jumpAnim
      currentAnimation.reset()
    }

    // Horizontal movement
    velX = 0
    if (input.isDown(LEFT)) {
      velX = -moveSpeed
      facingLeft = true
      if (isGrounded && !isAttacking) {
        currentAnimation = idleAnim
      }
    } else if (input.isDown(RIGHT)) {
      velX = moveSpeed
      facingLeft = false
      if (isGrounded && !isAttacking) {
        currentAnimation = idleAnim
      }
    } else if (isGrounded && !isAttacking) {
      currentAnimation = idleAnim
    }
  }

  function applyPhysics(): void {
    posX += velX
    posX = Math.max(30, Math.min(WORLD_WIDTH - 30, posX))

    if (!isGrounded) {
      velY += gravity
      posY += velY

      if (posY >= GROUND_Y) {
        posY = GROUND_Y
        velY = 0
        isGrounded = true
        if (!isAttacking) {
          currentAnimation = idleAnim
          currentAnimation.reset()
        }
      }
    }
  }

  // The host clears and flips around this callback (host.beginFrame /
  // endFrame in the browser, Screen.clear / flip on native), so the body only
  // updates and draws — no manual clear()/flip() like the original loop.
  rt.Screen.display(() => {
    input.update()

    // Draw the background first — using the previous frame's camera — mirroring
    // the original main.js loop, which drew it at the top before the update/
    // updateCamera step. (Also keeps Z-order: background behind Ryu.)
    drawBackground()

    updateInputBuffer()
    handleInput()
    applyPhysics()
    updateCamera()

    const drawX = facingLeft ? posX - cameraX - FLIP_OFFSET : posX - cameraX
    currentAnimation.draw(drawX, posY - cameraY, facingLeft)

    bufferTimer++
  })

  return { rt }
}
