// Shared declarations for the Switch host. The host implements the same
// AthenaEnv globals src/web/ps2-scene.ts installs in the browser; the ps2/
// game tree is evaluated unmodified out of romfs (staged there by
// scripts/stage-switch-romfs.mjs).
#pragma once

#include <stdbool.h>
#include <SDL2/SDL.h>
#include "quickjs.h"

// game-space framebuffer, the PS2 video mode Screen.getMode() reports
#define GAME_W 640
#define GAME_H 448

// where the staged game tree lives
#ifdef __SWITCH__
#define GAME_ROOT "romfs:/game/"
#define HOST_ROOT "romfs:/host/"
#else
#define GAME_ROOT "romfs/game/"
#define HOST_ROOT "romfs/host/"
#endif

// AthenaEnv color words: r | g<<8 | b<<16 | a<<24, alpha 0-128 (128 = opaque)
static inline Uint8 athena_alpha(Uint32 c) {
    Uint32 a = ((c >> 24) & 0xFF) * 255u / 128u;
    return a > 255 ? 255 : (Uint8)a;
}

extern SDL_Renderer *g_renderer;

// host_screen.c — window/renderer, the 640x448 render target, frame callback
bool screen_init(void);
void screen_shutdown(void);
void screen_begin_frame(void);
void screen_end_frame(void);
void host_install_screen(JSContext *ctx); // Screen global + __nowUs for prelude.js
bool screen_has_frame_cb(void);
bool screen_call_frame_cb(JSContext *ctx); // false = uncaught JS exception (fatal)
void screen_free_frame_cb(JSContext *ctx);

// host_draw.c — Draw.rect, the game's only primitive
void host_install_draw(JSContext *ctx);

// host_image.c — Image class (crop by startx/endx, flip by swapped ends)
void host_install_image(JSContext *ctx);

// host_pads.c — SDL_GameController <-> Pads, sticky 4-slot hot-join, rumble
void host_pads_pump(bool *quit); // drain SDL events + snapshot pad state
void host_pads_shutdown(void);
void host_pads_free_js(JSContext *ctx); // before JS_FreeContext
void host_install_pads(JSContext *ctx);

// host_font.c — Font class over SDL2_ttf, with a cache of rendered runs
bool font_init(void);
void font_shutdown(void);
void host_install_font(JSContext *ctx);

// host_std.c — the `std` module ps2/lib/tiled.js imports to read Tiled maps
void host_install_std(JSContext *ctx);

// js_module.c — ES module loader over romfs + error reporting
void js_module_init(JSRuntime *rt);
bool js_eval_path(JSContext *ctx, const char *path, bool as_module);
void js_dump_exception(JSContext *ctx);
