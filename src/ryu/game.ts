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

const { UP, DOWN, LEFT, RIGHT, SQUARE, TRIANGLE, CROSS, CIRCLE, L1, L2, R1, R2 } = PAD_BUTTONS

// Six-button layout, by pad position (classic console Street Fighter):
//   punches LP/MP/HP = left face / top face / R1  (SQUARE / TRIANGLE / R1)
//   kicks   LK/MK/HK = bottom face / right face / R2  (CROSS / CIRCLE / R2)
//   L1 = all three punches at once, L2 = all three kicks
// The browser host translates SNES-style pads onto these masks (src/gamepad.ts).
type Strength = 'light' | 'medium' | 'heavy'
type PunchPress = Strength | 'super'

// Extra active frames a normal gains per button strength
const EXTRA_FRAMES: Record<Strength, number> = { light: 0, medium: 6, heavy: 12 }

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
  // Attack animations hold their last frame (loop=false): medium/heavy
  // presses extend the active window past one animation cycle, and a
  // shoryuken hangs in the air longer than its 8 frames.
  const lightPunchAnim = new Animation(rt, [frame(4), frame(5), frame(6)], 15, false)
  const lightKickAnim = new Animation(rt, [frame(7), frame(8), frame(9)], 15, false)
  const shoryukenAnim = new Animation(
    rt,
    [frame(10), frame(11), frame(12), frame(13), frame(14), frame(15), frame(16), frame(17)],
    12,
    false,
  )
  // Frames 16-17 are landing poses with the ground shadow baked into the
  // art, so the animation holds at the last airborne pose (frame 15) until
  // Ryu touches down, then plays them as a short landing recovery.
  const SHORYUKEN_LAST_AIR_FRAME = 5
  const SHORYUKEN_LANDING_FRAMES = 14
  const crouchLightKickAnim = new Animation(
    rt,
    [frame(18), frame(19), frame(20), frame(21), frame(18)],
    15,
    false,
  )
  const crouchLightPunchAnim = new Animation(rt, [frame(22), frame(23), frame(24)], 15, false)
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
  let attackAge = 0 // frames since the current normal started (chord grace)
  let attackIsPunch = false
  let isCrouching = false
  let currentAnimation: Animation = idleAnim

  // Shoryuken launch velocity per punch strength — medium is the original's
  // jumpForce * 1.2; light stays close to the ground, heavy sells the hit.
  const SHORYUKEN_VELOCITY: Record<Strength, number> = {
    light: jumpForce * 0.85,
    medium: jumpForce * 1.2,
    heavy: jumpForce * 1.4,
  }

  // While set, the attack lasts until Ryu lands instead of counting frames,
  // and a super chains its next rep on each landing.
  interface ShoryukenState {
    reps: Strength[]
    rep: number
    isSuper: boolean
  }
  let shoryu: ShoryukenState | null = null

  // World-space snapshots of the super's recent poses, drawn as translucent
  // shadow frames behind Ryu.
  interface TrailEntry {
    x: number
    y: number
    frame: number
    facingLeft: boolean
  }
  let trail: TrailEntry[] = []

  // Input buffering for special moves
  interface BufferedInput {
    input: 'down' | 'left' | 'right' | 'punch'
    strength?: PunchPress
    time: number
  }
  let inputBuffer: BufferedInput[] = []
  let bufferTimer = 0

  // Attack buttons newly pressed this frame (set by updateInputBuffer)
  let pendingPunch: PunchPress | null = null
  let pendingKick: Strength | null = null

  // Strongest punch newly pressed this frame. L1 is the three-punch macro;
  // pressing all three punch buttons together counts the same.
  function readPunchPress(): PunchPress | null {
    const newPunch = input.isPressed(SQUARE) || input.isPressed(TRIANGLE) || input.isPressed(R1)
    if (
      input.isPressed(L1) ||
      (newPunch && input.isDown(SQUARE) && input.isDown(TRIANGLE) && input.isDown(R1))
    ) {
      return 'super'
    }
    if (input.isPressed(R1)) return 'heavy'
    if (input.isPressed(TRIANGLE)) return 'medium'
    if (input.isPressed(SQUARE)) return 'light'
    return null
  }

  // L2 (all three kicks) has no super attached, so it lands as a heavy kick.
  function readKickPress(): Strength | null {
    if (input.isPressed(L2) || input.isPressed(R2)) return 'heavy'
    if (input.isPressed(CIRCLE)) return 'medium'
    if (input.isPressed(CROSS)) return 'light'
    return null
  }

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
    pendingPunch = readPunchPress()
    pendingKick = readKickPress()
    if (pendingPunch) inputBuffer.push({ input: 'punch', strength: pendingPunch, time: bufferTimer })

    // Remove old inputs (older than 30 frames)
    inputBuffer = inputBuffer.filter((item) => bufferTimer - item.time < 30)
  }

  // Forward, down, forward + punch. Returns the strength of the punch that
  // completed the motion (which decides the shoryuken's height), or null.
  function checkShoryuken(): PunchPress | null {
    if (inputBuffer.length < 4) return null

    const recent = inputBuffer.slice(-4)
    const forwardDir = facingLeft ? 'left' : 'right'

    let hasFirstForward = false
    let hasDown = false
    let hasSecondForward = false
    let punch: PunchPress | null = null

    for (let i = 0; i < recent.length; i++) {
      if (!hasFirstForward && recent[i].input === forwardDir) {
        hasFirstForward = true
      } else if (hasFirstForward && !hasDown && recent[i].input === 'down') {
        hasDown = true
      } else if (hasDown && !hasSecondForward && recent[i].input === forwardDir) {
        hasSecondForward = true
      } else if (hasSecondForward && recent[i].input === 'punch') {
        punch = recent[i].strength ?? 'light'
      }
    }

    return hasFirstForward && hasDown && hasSecondForward ? punch : null
  }

  function performAttack(anim: Animation, frames: number, isPunch: boolean): void {
    isAttacking = true
    attackFrames = frames
    attackAge = 0
    attackIsPunch = isPunch
    currentAnimation = anim
    currentAnimation.reset()
  }

  function launchShoryuken(strength: Strength): void {
    currentAnimation = shoryukenAnim
    currentAnimation.reset()
    velY = SHORYUKEN_VELOCITY[strength]
    isGrounded = false
  }

  // A shoryuken rises and falls in place: horizontal velocity is zeroed here
  // and the isAttacking early-return in handleInput keeps it zero, so the
  // move never changes Ryu's horizontal position. It ends when he lands
  // (applyPhysics), not on a frame countdown.
  function performShoryuken(strength: Strength): void {
    isAttacking = true
    attackFrames = 0
    shoryu = { reps: [strength], rep: 0, isSuper: false }
    velX = 0
    launchShoryuken(strength)
    inputBuffer = []
  }

  // Super version (all three punches, or the L1 macro): two low shoryukens
  // chained into a normal-height one, with shadow frames trailing behind.
  function performSuperShoryuken(): void {
    isAttacking = true
    attackFrames = 0
    shoryu = { reps: ['light', 'light', 'medium'], rep: 0, isSuper: true }
    velX = 0
    trail = []
    launchShoryuken('light')
    inputBuffer = []
  }

  function handleInput(): void {
    if (isAttacking) {
      // Shoryukens end on landing (applyPhysics); other attacks count down.
      if (!shoryu) {
        // A human "all three punches" chord usually staggers across a frame
        // or two, so the first button lands as a normal punch before the
        // chord completes — upgrade a just-started punch into the super.
        if (attackIsPunch && attackAge < 5 && isGrounded && pendingPunch === 'super') {
          performSuperShoryuken()
          return
        }
        attackAge++
        attackFrames--
        if (attackFrames <= 0) {
          isAttacking = false
          currentAnimation = idleAnim
          currentAnimation.reset()
        }
      }
      return
    }

    isCrouching = input.isDown(DOWN) && isGrounded

    if (isGrounded) {
      // Three punches at once fire the super outright, motion or not
      if (pendingPunch === 'super') {
        performSuperShoryuken()
        return
      }
      const motion = checkShoryuken()
      if (motion === 'super') {
        performSuperShoryuken()
        return
      }
      if (motion) {
        performShoryuken(motion)
        return
      }
    }

    // Crouching attacks
    if (isCrouching) {
      if (pendingPunch && pendingPunch !== 'super') {
        performAttack(crouchLightPunchAnim, 18 + EXTRA_FRAMES[pendingPunch], true)
        return
      }
      if (pendingKick) {
        performAttack(crouchLightKickAnim, 30 + EXTRA_FRAMES[pendingKick], false)
        return
      }

      currentAnimation = crouchAnim
      velX = 0
      return
    }

    // Standing attacks
    if (pendingPunch && pendingPunch !== 'super' && isGrounded) {
      performAttack(lightPunchAnim, 18 + EXTRA_FRAMES[pendingPunch], true)
      return
    }

    if (pendingKick && isGrounded) {
      performAttack(lightKickAnim, 18 + EXTRA_FRAMES[pendingKick], false)
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

        // A super chains its next rep the moment the previous one lands
        if (shoryu && shoryu.rep < shoryu.reps.length - 1) {
          shoryu.rep++
          launchShoryuken(shoryu.reps[shoryu.rep])
          return
        }

        velY = 0
        isGrounded = true
        if (shoryu) {
          // Touched down: release the animation into the landing frames and
          // count them out as recovery before returning to idle.
          shoryu = null
          attackIsPunch = false
          attackAge = 0
          attackFrames = SHORYUKEN_LANDING_FRAMES
        } else if (!isAttacking) {
          currentAnimation = idleAnim
          currentAnimation.reset()
        }
      }
    }
  }

  // Shadow frames: ghosts of the super's recent poses, oldest faintest,
  // tinted blue like the classic super-combo trail.
  const TRAIL_STEP = 3
  const TRAIL_COLORS = [
    rt.Color.new(90, 110, 255, 56),
    rt.Color.new(90, 110, 255, 38),
    rt.Color.new(90, 110, 255, 22),
  ]

  function drawTrail(): void {
    for (let g = TRAIL_COLORS.length; g >= 1; g--) {
      const entry = trail[trail.length - 1 - g * TRAIL_STEP]
      if (!entry) continue
      const gx = (entry.facingLeft ? entry.x - FLIP_OFFSET : entry.x) - cameraX
      shoryukenAnim.drawFrame(
        entry.frame,
        gx,
        entry.y - cameraY,
        entry.facingLeft,
        TRAIL_COLORS[g - 1],
      )
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

    if (shoryu?.isSuper) {
      trail.push({ x: posX, y: posY, frame: shoryukenAnim.frameIndex, facingLeft })
      if (trail.length > 16) trail.shift()
    } else if (trail.length > 0) {
      // let leftover shadows evaporate once the super ends
      trail.splice(0, 2)
    }
    if (trail.length > 0) drawTrail()

    const drawX = facingLeft ? posX - cameraX - FLIP_OFFSET : posX - cameraX
    // shoryu is only set while airborne (cleared on touchdown above), so
    // this keeps the landing frames from showing mid-air.
    currentAnimation.draw(
      drawX,
      posY - cameraY,
      facingLeft,
      shoryu ? SHORYUKEN_LAST_AIR_FRAME : undefined,
    )

    bufferTimer++
  })

  return { rt }
}
