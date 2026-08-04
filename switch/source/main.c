// Ryu PS2 — Nintendo Switch homebrew host.
//
// The third host for the same game bundle: AthenaEnv provides the globals
// on real PS2, src/browser.ts provides them over Phaser in the browser,
// and this app provides them over SDL2 + quickjs-ng on Switch. The bundled
// game (build/main.js) is evaluated unmodified from romfs:/game/ — its
// entry (src/native.ts) detects this callback-style host and registers the
// frame via Screen.display(cb) instead of busy-looping clear/flip.
//
// Dev loop: launch with `nxlink -s switch/ps2-ryu.nro` (hbmenu in
// netloader mode) — stdout, including JS stack traces, streams back here.
#include <stdio.h>
#include <string.h>
#include <SDL2/SDL.h>
#include <SDL2/SDL_image.h>

#ifdef __SWITCH__
#include <switch.h>
#endif

#include "js_host.h"

int main(int argc, char **argv) {
    // the game can read globalThis.__DEBUG; pass --debug through the
    // netloader (nxlink -s ps2-ryu.nro -- --debug) to turn on
    // debug-only extras without rebuilding the game tree
    bool want_debug = false;
    for (int i = 1; i < argc; i++) {
        if (argv[i] && !strcmp(argv[i], "--debug")) want_debug = true;
    }
#ifdef __SWITCH__
    romfsInit();
    socketInitializeDefault();
    nxlinkStdio();
#endif
    printf("[host] ps2-ryu switch host booting\n");

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER) != 0) {
        fprintf(stderr, "[host] SDL_Init: %s\n", SDL_GetError());
        return 1;
    }
    IMG_Init(IMG_INIT_PNG);
    if (!screen_init()) return 1;
    // if SDL2_ttf fails to start the Font global is simply absent; that only
    // costs the HUD its text, so it must not take the whole app down
    bool font_ok = font_init();

    JSRuntime *rt = JS_NewRuntime();
    JS_SetMaxStackSize(rt, 1024 * 1024);
    js_module_init(rt);
    JSContext *ctx = JS_NewContext(rt);

    host_install_screen(ctx);
    host_install_draw(ctx);
    host_install_image(ctx);
    host_install_pads(ctx);
    host_install_std(ctx);
    if (font_ok) host_install_font(ctx);
    {
        JSValue global = JS_GetGlobalObject(ctx);
        JS_SetPropertyStr(ctx, global, "__DEBUG", JS_NewBool(ctx, want_debug));
        JS_FreeValue(ctx, global);
    }

    bool ok = js_eval_path(ctx, HOST_ROOT "prelude.js", false) &&
              js_eval_path(ctx, GAME_ROOT "main.js", true);
    if (!ok) fprintf(stderr, "[host] boot failed — see trace above\n");

    bool quit = !ok;
    while (!quit
#ifdef __SWITCH__
           && appletMainLoop()
#endif
    ) {
        host_pads_pump(&quit);
        screen_begin_frame();
        // a JS exception here is fatal by design: stop cleanly with the
        // trace on nxlink instead of re-running a broken frame forever
        if (screen_has_frame_cb() && !screen_call_frame_cb(ctx)) quit = true;
        JSContext *pctx;
        while (JS_ExecutePendingJob(rt, &pctx) > 0) {}
        screen_end_frame();
    }

    printf("[host] shutting down\n");
    screen_free_frame_cb(ctx);
    host_pads_free_js(ctx);
    host_pads_shutdown();
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    font_shutdown();
    screen_shutdown();
    IMG_Quit();
    SDL_Quit();
#ifdef __SWITCH__
    socketExit();
    romfsExit();
#endif
    return ok ? 0 : 1;
}
