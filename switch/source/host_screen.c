// Screen global + the frame pipeline. The game renders in the PS2's 640x448
// video mode (what Screen.getMode() reports), so every draw lands in a
// render-target texture of
// exactly that size — like the PS2's framebuffer and the browser's canvas —
// and one linear-filtered aspect-fit blit per frame scales it to the
// swapchain (pillarboxed 16:9). Rasterizing sprites at game scale first
// keeps NEAREST pixels uniform; SDL_RenderSetLogicalSize would rasterize
// each sprite at the non-integer final scale instead.
#include <stdio.h>

#include "js_host.h"

SDL_Renderer *g_renderer = NULL;
static SDL_Window *window = NULL;
static SDL_Texture *target = NULL;
static Uint64 boot_ticks = 0;

static JSValue frame_cb = JS_UNDEFINED;
static bool have_cb = false;

bool screen_init(void) {
#ifdef __SWITCH__
    // the Switch port sizes the swapchain itself: 1080p docked, 720p handheld
    const int w = 1920, h = 1080;
#else
    const int w = GAME_W * 2, h = GAME_H * 2;
#endif
    window = SDL_CreateWindow("ps2-ryu", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                              w, h, SDL_WINDOW_SHOWN);
    if (!window) {
        fprintf(stderr, "[screen] SDL_CreateWindow: %s\n", SDL_GetError());
        return false;
    }
    g_renderer = SDL_CreateRenderer(window, -1,
                                    SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    if (!g_renderer) {
        fprintf(stderr, "[screen] SDL_CreateRenderer: %s\n", SDL_GetError());
        return false;
    }
    target = SDL_CreateTexture(g_renderer, SDL_PIXELFORMAT_RGBA8888,
                               SDL_TEXTUREACCESS_TARGET, GAME_W, GAME_H);
    if (!target) {
        fprintf(stderr, "[screen] render target: %s\n", SDL_GetError());
        return false;
    }
    SDL_SetTextureScaleMode(target, SDL_ScaleModeLinear);
    SDL_SetTextureBlendMode(target, SDL_BLENDMODE_NONE);
    boot_ticks = SDL_GetPerformanceCounter();
    return true;
}

void screen_shutdown(void) {
    if (target) SDL_DestroyTexture(target);
    if (g_renderer) SDL_DestroyRenderer(g_renderer);
    if (window) SDL_DestroyWindow(window);
    target = NULL;
    g_renderer = NULL;
    window = NULL;
}

void screen_begin_frame(void) {
    SDL_SetRenderTarget(g_renderer, target);
    SDL_SetRenderDrawBlendMode(g_renderer, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(g_renderer, 0, 0, 0, 255);
    SDL_RenderClear(g_renderer);
}

void screen_end_frame(void) {
    SDL_SetRenderTarget(g_renderer, NULL);
    SDL_SetRenderDrawColor(g_renderer, 0, 0, 0, 255);
    SDL_RenderClear(g_renderer);

    // aspect-fit, recomputed per frame so docked/handheld transitions just work
    int ow, oh;
    SDL_GetRendererOutputSize(g_renderer, &ow, &oh);
    float scale = (float)ow / GAME_W;
    float vs = (float)oh / GAME_H;
    if (vs < scale) scale = vs;
    SDL_Rect fit = {
        .w = (int)(GAME_W * scale),
        .h = (int)(GAME_H * scale),
    };
    fit.x = (ow - fit.w) / 2;
    fit.y = (oh - fit.h) / 2;
    SDL_RenderCopy(g_renderer, target, NULL, &fit);
    SDL_RenderPresent(g_renderer);
}

bool screen_has_frame_cb(void) {
    return have_cb;
}

bool screen_call_frame_cb(JSContext *ctx) {
    JSValue r = JS_Call(ctx, frame_cb, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(r)) {
        js_dump_exception(ctx);
        return false;
    }
    JS_FreeValue(ctx, r);
    return true;
}

void screen_free_frame_cb(JSContext *ctx) {
    if (have_cb) JS_FreeValue(ctx, frame_cb);
    frame_cb = JS_UNDEFINED;
    have_cb = false;
}

// Screen.display(cb) — register the per-frame callback; the C main loop
// drives it, the same inversion the browser's runtime.tick() does
static JSValue js_screen_display(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "Screen.display expects a function");
    if (have_cb) JS_FreeValue(ctx, frame_cb);
    frame_cb = JS_DupValue(ctx, argv[0]);
    have_cb = true;
    return JS_UNDEFINED;
}

// Screen.getMode() — the video mode the game lays every screen out
// against (HUD columns, camera width, the integer tile scale)
static JSValue js_screen_get_mode(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    JSValue mode = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, mode, "width", JS_NewInt32(ctx, GAME_W));
    JS_SetPropertyStr(ctx, mode, "height", JS_NewInt32(ctx, GAME_H));
    return mode;
}

static JSValue js_screen_set_vsync(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
#if SDL_VERSION_ATLEAST(2, 0, 18)
    int on = argc > 0 && JS_ToBool(ctx, argv[0]);
    SDL_RenderSetVSync(g_renderer, on);
#else
    (void)ctx;
    (void)argc;
    (void)argv;
#endif
    return JS_UNDEFINED;
}

// microseconds since boot, for prelude.js's Timer (doubles hold µs exactly
// for centuries of uptime; clock.js only ever takes differences)
static JSValue js_now_us(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    double us = (double)(SDL_GetPerformanceCounter() - boot_ticks) * 1e6 /
                (double)SDL_GetPerformanceFrequency();
    return JS_NewFloat64(ctx, us);
}

void host_install_screen(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue screen = JS_NewObject(ctx);
    // no setMode/setParam on purpose: ps2/main.js probes and skips them
    JS_SetPropertyStr(ctx, screen, "getMode",
                      JS_NewCFunction(ctx, js_screen_get_mode, "getMode", 0));
    JS_SetPropertyStr(ctx, screen, "display",
                      JS_NewCFunction(ctx, js_screen_display, "display", 1));
    JS_SetPropertyStr(ctx, screen, "setVSync",
                      JS_NewCFunction(ctx, js_screen_set_vsync, "setVSync", 1));
    JS_SetPropertyStr(ctx, global, "Screen", screen);
    JS_SetPropertyStr(ctx, global, "__nowUs",
                      JS_NewCFunction(ctx, js_now_us, "__nowUs", 0));
    JS_FreeValue(ctx, global);
}
