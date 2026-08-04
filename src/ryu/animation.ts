// Frame animation, ported from main.js's Animation class onto the
// 5velte-ps2 PS2Runtime surface (runs on the Phaser browser host and on
// native AthenaEnv unchanged).
//
// Each frame is drawn at 2x. The original mutated `img.width *= 2` and then
// flipped with `startx = img.width` — i.e. the (already doubled) display
// width. That happens to work on Athena but is wrong under the shim's
// documented model, where startx/endx are *source-texture* pixels and
// width/height are the destination size (see src/core/image.ts). Here the
// crop is kept in natural texture pixels and the 2x scale is applied via the
// explicit draw(x, y, w, h) size, so it renders correctly on both hosts.

import type { PS2ColorValue, PS2ImageInstance, PS2Runtime } from '5velte-ps2'

const SCALE = 2

interface Frame {
  img: PS2ImageInstance
  w: number
  h: number
}

export class Animation {
  private rt: PS2Runtime
  private frames: Frame[]
  private fps: number
  private timer: ReturnType<PS2Runtime['Timer']['new']>
  private frame = 0
  private loop: boolean

  // loop=false holds the last frame instead of wrapping — for attack
  // animations whose active window outlasts one cycle (a heavy punch runs
  // 30 game frames over a 3-frame animation).
  constructor(rt: PS2Runtime, paths: string[], fps: number, loop = true) {
    this.rt = rt
    this.loop = loop
    this.frames = paths.map((p) => {
      const img = new rt.Image(p)
      // Crisp pixel art on both hosts. AthenaEnv's Image defaults to NEAREST
      // (which the original inherited); the native adapter otherwise forces
      // LINEAR, blurring the 2x-upscaled frames on real hardware.
      img.filter = rt.NEAREST
      return { img, w: img.width, h: img.height }
    })
    // AthenaEnv Timer is microsecond-based; store the per-frame period in us.
    this.fps = 1_000_000 / fps
    this.timer = rt.Timer.new()
  }

  // holdFrame caps how far a non-looping animation may advance — for frames
  // that must wait on game state (the shoryuken's landing frames show a
  // ground shadow, so they stay held back until Ryu actually lands).
  draw(x: number, y: number, flipH = false, holdFrame?: number): void {
    if (this.rt.Timer.getTime(this.timer) >= this.fps) {
      this.frame = this.loop
        ? (this.frame + 1) % this.frames.length
        : Math.min(this.frame + 1, this.frames.length - 1)
      this.rt.Timer.setTime(this.timer, 1)
    }
    if (holdFrame !== undefined && this.frame > holdFrame) this.frame = holdFrame

    this.drawFrame(this.frame, x, y, flipH)
  }

  /** index of the frame draw() would render this tick */
  get frameIndex(): number {
    return this.frame
  }

  /**
   * Draw a specific frame without advancing the clock, optionally modulated
   * by an Athena color word (used for the super's trailing shadow frames).
   * The image's color is restored to neutral afterwards so pooled draws of
   * the same frame later in the frame aren't tinted.
   */
  drawFrame(index: number, x: number, y: number, flipH = false, color?: PS2ColorValue): void {
    const { img, w, h } = this.frames[index % this.frames.length]

    // Vertical crop is always full-frame; a horizontal flip swaps the edges.
    img.starty = 0
    img.endy = h
    if (flipH) {
      img.startx = w
      img.endx = 0
    } else {
      img.startx = 0
      img.endx = w
    }

    if (color !== undefined) img.color = color
    img.draw(x, y, w * SCALE, h * SCALE)
    if (color !== undefined) img.color = this.rt.Color.new(255, 255, 255, 128)
  }

  reset(): void {
    this.frame = 0
    this.rt.Timer.setTime(this.timer, 1)
  }
}
