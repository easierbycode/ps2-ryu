# PS2-Ryu

A Street Fighter–style AthenaEnv demo — walk, jump, crouch, punch, kick, and a
shoryuken motion input — built on
[5velte-ps2](https://github.com/easierbycode/svelte-ps2) (the AthenaEnv v4
compatibility layer). **One game module, three targets:**

- **Real PS2 / PCSX2 / Play!** — [`src/native.ts`](src/native.ts) is bundled by
  esbuild into a single `main.js` that AthenaEnv (athena.elf) runs, packaged
  with the assets into a bootable ISO9660 image.
- **Browser** — the same game module ([`src/ryu/`](src/ryu/)) runs on Phaser 4
  via 5velte-ps2's host: [`src/browser.ts`](src/browser.ts) mounts the scene at
  [`play/`](play/).
- **Nintendo Switch (homebrew)** — the same native bundle a third time, on
  [quickjs-ng](https://github.com/quickjs-ng/quickjs) + SDL2 via the native
  host in [`switch/`](switch/): ~1.5k lines of C (devkitPro/libnx) implement
  the AthenaEnv globals and evaluate the bundle out of romfs, producing a
  `.nro` for hbmenu on CFW (Atmosphère). See
  [Nintendo Switch build](#nintendo-switch-build).

Download page + browser build + ISO deploy to
**<https://easierbycode.com/ps2-ryu/>** on every push to `main`
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)), which also
pokes the [CMG launcher](https://github.com/easierbycode/cmg) so its
PlayStation 2 screen picks up the new web build and disc image.

The NRO is the only artifact built against a third-party package server
(pkg.devkitpro.org, which 403s often enough to matter), so it can't hold the
release hostage: if that job fails the site still publishes, the download
page swaps its Switch button for a note
([`scripts/disable-switch-download.mjs`](scripts/disable-switch-download.mjs)),
and the run goes red so the outage stays visible.

## Run

```sh
npm install
npm run dev          # browser build at http://localhost:5173/play/
npm run build        # production build (base /ps2-ryu/)
npm run iso          # deno-powered ISO9660 writer -> ps2-ryu.iso
npm run nro          # Switch homebrew build -> switch/ps2-ryu.nro
```

The ISO boots in PCSX2, in the CMG launcher's PlayStation 2 screen (the
Play! WASM emulator), and on softmodded hardware (OPL / DVD-R). The ISO step
and the deploy workflow need [Deno](https://deno.com) on `PATH`; the
ISO9660 writer is vendored at
[`scripts/build-athena-iso.ts`](scripts/build-athena-iso.ts) — no mkisofs
needed. Clone with `--recurse-submodules` — quickjs-ng is vendored at
`switch/vendor/quickjs`.

## Controls

Classic six-button layout:

| | PS2 pad | Keyboard |
| --- | --- | --- |
| move | d-pad ←→ | arrow keys |
| jump | d-pad UP | ↑ |
| crouch | d-pad DOWN | ↓ |
| punch (light / medium / heavy) | SQUARE / TRIANGLE / R1 | V / C / E |
| kick (light / medium / heavy) | CROSS / CIRCLE / R2 | Z / X / R |
| all three punches | L1 | Q |
| all three kicks | L2 | A |
| shoryuken | → ↓ → any punch | → ↓ → V/C/E |
| super shoryuken | all three punches (or L1) | Q (or V+C+E) |

The shoryuken rises with the strength of the punch that fired it and never
moves Ryu horizontally. The super chains two low shoryukens into a
normal-height one, with shadow frames trailing behind.

Face buttons map **by position on every pad**, whatever the labels print:
light punch is always the left face button, light kick always the bottom
one. Every host does its own positional mapping — the PS2's own layout, the
browser's keyboard bindings ([`src/pads.ts`](src/pads.ts)), the browser
Gamepad API ([`src/gamepad.ts`](src/gamepad.ts)), and the face/shoulder/
trigger table in [`switch/source/host_pads.c`](switch/source/host_pads.c),
which has to undo devkitPro SDL2's Nintendo labelling.

The shoulder/trigger row is the one place pads differ. SNES-style pads
(detected by name — SNES / Super Famicom / 8BitDo SN30 receivers) put heavy
punch on **R2** and heavy kick on **R**, with **L2** = all punches and
**L** = all kicks; every other pad gets heavy punch on **R**, heavy kick on
**R2**, **L** = all punches, **L2** = all kicks.

## Layout

- `src/ryu/` — the game, written only against the 5velte-ps2 `PS2Runtime`
  surface so it runs unchanged on every host. `createGame(rt)` registers the
  per-frame callback; the host drives it with `rt.tick()`.
  - `animation.ts` — frame animation (2× draw, crop-swap flips, tinted
    ghost frames for the super's trail)
  - `input.ts` — per-frame pad snapshot with rising-edge detection
  - `game.ts` — physics, camera, six-button combat, the shoryuken input
    buffer, and the super's shadow trail
- `src/browser.ts` + `src/pads.ts` + `src/gamepad.ts` + `play/index.html` —
  the Phaser browser host; `gamepad.ts` maps the browser Gamepad API
  (including SNES-style pads) onto PS2 button masks and is merged with the
  keyboard bindings.
- `index.html` at the root is the download page, driven by `src/menu.ts`:
  the Ryu logo idles through his stance frames, a connected gamepad picks
  the download buttons (bottom face button selects), and the shoryuken
  input on the logo is left as an exercise for the visitor.
- `src/native.ts` — the native entry (esbuild bundles it to `build/main.js`).
  It serves both native hosts: on real AthenaEnv it busy-loops
  `Screen.clear()` / `Screen.flip()`, and on the Switch host (which drives
  the frame from C) it detects the callback-style `Screen`, shims the
  missing pieces, and registers the frame via `Screen.display(cb)`.
- `switch/` — the Switch homebrew host (C, devkitPro/libnx + SDL2 +
  quickjs-ng).
- `scripts/` — the build pipeline: `build-native.mjs` (esbuild bundle +
  asset copy into `build/`), `build-athena-iso.ts` (pure-Deno ISO9660
  writer), `build-iso.mjs` (native build → ISO), `stage-switch-romfs.mjs`
  (native build → `switch/romfs/`), `build-switch-nro.mjs` (devkitPro /
  MSYS2 / Docker), `disable-switch-download.mjs` (deploy fallback).

## Browser build

`play/` hosts a single Phaser scene. Assets live at the repo root
(`background.png`, `frames/`) so the native ISO build can bundle them; the
browser host resolves them to URLs via `import.meta.glob` and registers each
through `textures.addImage` with a native `<img>` decode, sidestepping a
Phaser 4.2.1 loader stall when a large batch of small same-origin PNGs
completes in one tick.

The production build serves from `/ps2-ryu/` (GitHub Pages); override the
mount point with `BASE_PATH` (the CMG launcher vendors the build under
`/games/ps2-ryu/`).

## Nintendo Switch build

`npm run nro` stages the native bundle into `switch/romfs/`
([`scripts/stage-switch-romfs.mjs`](scripts/stage-switch-romfs.mjs) — the
esbuild `main.js` plus `background.png` and `frames/`, layout preserved) and
compiles the host, trying in order: a `DEVKITPRO` env with `make` on PATH, an
MSYS2 install with the devkitPro pacman packages at `C:\msys64` (`pacman -S
pkgconf switch-dev switch-sdl2 switch-sdl2_image switch-sdl2_ttf` after
adding the [devkitPro repos](https://devkitpro.org/wiki/devkitPro_pacman)),
then Docker (`devkitpro/devkita64` + portlibs,
[`switch/builder.Dockerfile`](switch/builder.Dockerfile), cached after the
first run). Clone with `--recurse-submodules` — quickjs-ng is vendored at
`switch/vendor/quickjs`.

Dev loop against real hardware: hbmenu → **Y** (netloader), then

```sh
nxlink -s switch/ps2-ryu.nro
```

streams stdout — including JS stack traces — back over WiFi. For a PC-free
install copy the NRO to `sd:/switch/ps2-ryu.nro`.

CI builds the NRO on every push
([.github/workflows/switch.yml](.github/workflows/switch.yml)) and the
deploy publishes it on the download page next to the ISO.

## Assets

`background.png` and `frames/frame_000.png … frame_035.png` live at the repo
root. The browser host resolves them through Vite; the native build copies
them into `build/` for the ISO and the Switch romfs. `ryu_sheet.png`,
`split.py`, and `resize.py` are the source sheet and the tooling that sliced
it into frames.
