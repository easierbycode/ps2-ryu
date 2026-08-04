// Landing-page logic: the .logo Ryu idles through his stance frames, and a
// connected gamepad drives both the download menu (d-pad to move, bottom
// face button to select) and a small easter egg — enter the shoryuken input
// (forward, down, forward + punch) and the logo performs the move in place,
// rising with the punch's strength; all three punches (or the macro
// shoulder) fire the super: two low shoryukens into a normal one with
// shadow frames trailing behind.
//
// The sprite only ever moves vertically (translateY), so the page layout
// never shifts. Everything steps at a fixed 60 Hz inside rAF; the loop and
// input are exposed on window.ryuLogo so the page can be driven headlessly
// (the in-app preview keeps tabs hidden, where rAF never fires).

import { PS2_MASKS, readGamepad } from './gamepad.ts'

const { UP, DOWN, LEFT, RIGHT, SQUARE, TRIANGLE, CROSS, L1, R1 } = PS2_MASKS

const frameUrls = import.meta.glob('../frames/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const frame = (i: number): string => {
  const name = `frame_${String(i).padStart(3, '0')}.png`
  const hit = Object.entries(frameUrls).find(([path]) => path.endsWith(name))
  if (!hit) throw new Error(`ps2-ryu menu: missing ${name}`)
  return hit[1]
}

// Same frame ranges the game uses (src/ryu/game.ts)
const IDLE_FRAMES = [0, 1, 2, 3].map(frame)
const SHORYUKEN_FRAMES = [10, 11, 12, 13, 14, 15, 16, 17].map(frame)
const IDLE_STEPS_PER_FRAME = 10 // 6 fps at 60 Hz
const SHORYU_STEPS_PER_FRAME = 5 // 12 fps
// The last two shoryuken frames are landing poses with the ground shadow
// baked into the art — held back until the sprite touches down.
const SHORYU_LAST_AIR_FRAME = 5
const LANDING_STEPS = 14

// Logo-space physics (CSS pixels per 60 Hz step, y up is negative)
const GRAVITY = 0.6
type Strength = 'light' | 'medium' | 'heavy'
type PunchPress = Strength | 'super'
const LAUNCH_VELOCITY: Record<Strength, number> = { light: -10.5, medium: -13, heavy: -15.5 }
const SUPER_REPS: Strength[] = ['light', 'light', 'medium']

const GHOST_AGES = [5, 10, 15]
const GHOST_OPACITY = [0.4, 0.25, 0.14]

interface BufferedInput {
  input: 'down' | 'left' | 'right' | 'punch'
  strength?: PunchPress
  time: number
}

function boot(): void {
  const stage = document.querySelector<HTMLElement>('.logo')
  if (!stage) return

  // --- sprite elements -----------------------------------------------------
  // Ghosts sit behind the main sprite (inserted first, painted first).
  const ghosts = GHOST_AGES.map(() => {
    const img = document.createElement('img')
    img.className = 'ryu-sprite ryu-ghost'
    img.alt = ''
    img.style.display = 'none'
    stage.appendChild(img)
    return img
  })
  const ryu = document.createElement('img')
  ryu.className = 'ryu-sprite'
  ryu.alt = 'Ryu'
  ryu.src = IDLE_FRAMES[0]
  stage.appendChild(ryu)

  // swap out the static logo once the first idle frame is in
  ryu.decode?.().catch(() => {}) // best effort; onload below is the signal
  ryu.addEventListener(
    'load',
    () => stage.querySelector<HTMLElement>('.logo-fallback')?.remove(),
    { once: true },
  )

  // --- animation / move state ---------------------------------------------
  type Mode = 'idle' | 'shoryuken' | 'landing'
  let mode: Mode = 'idle'
  let clock = 0
  let y = 0
  let velY = 0
  let reps: Strength[] = []
  let rep = 0
  let isSuper = false
  let history: Array<{ y: number; frame: number }> = []

  function launch(strength: Strength): void {
    mode = 'shoryuken'
    clock = 0
    velY = LAUNCH_VELOCITY[strength]
  }

  function performShoryuken(strength: Strength): void {
    reps = [strength]
    rep = 0
    isSuper = false
    history = []
    launch(strength)
  }

  function performSuper(): void {
    reps = SUPER_REPS
    rep = 0
    isSuper = true
    history = []
    launch(SUPER_REPS[0])
  }

  function currentFrame(): number {
    if (mode === 'idle') {
      return Math.floor(clock / IDLE_STEPS_PER_FRAME) % IDLE_FRAMES.length
    }
    if (mode === 'landing') {
      return Math.min(
        SHORYU_LAST_AIR_FRAME + 1 + Math.floor(clock / SHORYU_STEPS_PER_FRAME),
        SHORYUKEN_FRAMES.length - 1,
      )
    }
    // hold the last airborne pose while in the air, like the game's
    // shoryukenAnim — the landing frames play once y is back to 0
    return Math.min(Math.floor(clock / SHORYU_STEPS_PER_FRAME), SHORYU_LAST_AIR_FRAME)
  }

  // --- menu ----------------------------------------------------------------
  const menuButtons = (): HTMLAnchorElement[] =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('.buttons a.btn[href]'))
  let selected = 0
  let padSeen = false

  function paintSelection(): void {
    menuButtons().forEach((el, i) => {
      el.classList.toggle('pad-selected', padSeen && i === selected)
    })
  }

  function moveSelection(delta: number): void {
    const count = menuButtons().length
    if (count === 0) return
    selected = (selected + delta + count) % count
    paintSelection()
  }

  // --- input ---------------------------------------------------------------
  let prevButtons = 0
  let buttonOverride: number | null = null // test hook
  let inputBuffer: BufferedInput[] = []
  let stepCount = 0

  const pressed = (now: number, mask: number): boolean =>
    (now & mask) !== 0 && (prevButtons & mask) === 0
  const held = (now: number, mask: number): boolean => (now & mask) !== 0

  function readPunchPress(now: number): PunchPress | null {
    const newPunch =
      pressed(now, SQUARE) || pressed(now, TRIANGLE) || pressed(now, R1)
    if (
      pressed(now, L1) ||
      (newPunch && held(now, SQUARE) && held(now, TRIANGLE) && held(now, R1))
    ) {
      return 'super'
    }
    if (pressed(now, R1)) return 'heavy'
    if (pressed(now, TRIANGLE)) return 'medium'
    if (pressed(now, SQUARE)) return 'light'
    return null
  }

  // forward, down, forward + punch — same matcher as the game, tried with
  // both directions as "forward" since the logo has no facing to speak of
  function checkShoryuken(): PunchPress | null {
    if (inputBuffer.length < 4) return null
    const recent = inputBuffer.slice(-4)

    for (const forwardDir of ['right', 'left'] as const) {
      let hasFirstForward = false
      let hasDown = false
      let hasSecondForward = false
      let punch: PunchPress | null = null

      for (const entry of recent) {
        if (!hasFirstForward && entry.input === forwardDir) {
          hasFirstForward = true
        } else if (hasFirstForward && !hasDown && entry.input === 'down') {
          hasDown = true
        } else if (hasDown && !hasSecondForward && entry.input === forwardDir) {
          hasSecondForward = true
        } else if (hasSecondForward && entry.input === 'punch') {
          punch = entry.strength ?? 'light'
        }
      }

      if (hasFirstForward && hasDown && hasSecondForward && punch) return punch
    }
    return null
  }

  function handleInput(): void {
    const pad = readGamepad()
    const now = buttonOverride ?? (pad.connected ? pad.buttons : 0)
    if ((pad.connected || buttonOverride !== null) && !padSeen) {
      // Browsers only expose a pad after its first button press, so that
      // press is usually still down on the first connected poll. Seed the
      // edge detector with it — it reveals the selection cursor but must
      // not click a download link or move the cursor sight-unseen.
      padSeen = true
      paintSelection()
      prevButtons = now
      stepCount++
      return
    }

    // menu navigation
    if (pressed(now, UP)) moveSelection(-1)
    if (pressed(now, DOWN)) moveSelection(1)
    if (pressed(now, CROSS)) {
      const target = menuButtons()[selected]
      if (padSeen && target) target.click()
    }

    // special-move buffer
    if (pressed(now, DOWN)) inputBuffer.push({ input: 'down', time: stepCount })
    if (pressed(now, LEFT)) inputBuffer.push({ input: 'left', time: stepCount })
    if (pressed(now, RIGHT)) inputBuffer.push({ input: 'right', time: stepCount })
    const punch = readPunchPress(now)
    if (punch) inputBuffer.push({ input: 'punch', strength: punch, time: stepCount })
    inputBuffer = inputBuffer.filter((e) => stepCount - e.time < 30)

    if (mode === 'idle') {
      if (punch === 'super') {
        performSuper()
      } else {
        const motion = checkShoryuken()
        if (motion === 'super') performSuper()
        else if (motion) performShoryuken(motion)
      }
    }

    prevButtons = now
    stepCount++
  }

  // --- per-step update -----------------------------------------------------
  function step(): void {
    handleInput()
    clock++

    if (mode === 'shoryuken') {
      velY += GRAVITY
      y += velY
      if (y >= 0) {
        y = 0
        if (rep < reps.length - 1) {
          rep++
          launch(reps[rep])
        } else {
          // touched down — play the landing frames before going idle
          mode = 'landing'
          clock = 0
          velY = 0
          isSuper = false
        }
      }
    } else if (mode === 'landing' && clock >= LANDING_STEPS) {
      mode = 'idle'
      clock = 0
    }

    if (mode === 'shoryuken' && isSuper) {
      history.push({ y, frame: currentFrame() })
      if (history.length > 20) history.shift()
    } else if (history.length > 0) {
      history.splice(0, 2)
    }

    render()
  }

  let lastFrame = -1
  let lastMode: Mode = 'idle'
  const ghostFrames = GHOST_AGES.map(() => -1)

  function render(): void {
    const fi = currentFrame()
    if (fi !== lastFrame || mode !== lastMode) {
      ryu.src = mode === 'idle' ? IDLE_FRAMES[fi] : SHORYUKEN_FRAMES[fi]
      lastFrame = fi
      lastMode = mode
    }
    ryu.style.transform = `translateX(-50%) translateY(${y}px)`

    ghosts.forEach((img, g) => {
      const entry = history[history.length - 1 - GHOST_AGES[g]]
      if (!entry) {
        img.style.display = 'none'
        return
      }
      img.style.display = ''
      img.style.opacity = String(GHOST_OPACITY[g])
      // compare frame indices, not img.src — the src getter resolves to an
      // absolute URL, which never equals the bundler's relative asset path
      if (ghostFrames[g] !== entry.frame) {
        img.src = SHORYUKEN_FRAMES[entry.frame]
        ghostFrames[g] = entry.frame
      }
      img.style.transform = `translateX(-50%) translateY(${entry.y}px)`
    })
  }

  // --- 60 Hz loop ----------------------------------------------------------
  const STEP_MS = 1000 / 60
  let acc = 0
  let last: number | null = null

  function tick(ts: number): void {
    if (last !== null) {
      acc += ts - last
      let steps = 0
      while (acc >= STEP_MS && steps < 4) {
        step()
        acc -= STEP_MS
        steps++
      }
      if (acc >= STEP_MS) acc = 0 // long tab-away; drop the backlog
    }
    last = ts
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // headless driving for tests / the in-app preview (rAF needs a visible tab)
  ;(window as unknown as Record<string, unknown>).ryuLogo = {
    step(n = 1): void {
      for (let i = 0; i < n; i++) step()
    },
    setButtons(mask: number | null): void {
      buttonOverride = mask
    },
    state(): Record<string, unknown> {
      return { mode, y, rep, isSuper, selected, padSeen, ghosts: history.length }
    },
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
