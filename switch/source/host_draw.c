// Draw.rect(x, y, w, h, color) — the only primitive the game uses
// (HUD bars, screen flashes, perk cards, dim overlays).
#include "js_host.h"

static JSValue js_draw_rect(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    double x = 0, y = 0, w = 0, h = 0;
    uint32_t color = 0x80FFFFFF;
    if (argc >= 4) {
        JS_ToFloat64(ctx, &x, argv[0]);
        JS_ToFloat64(ctx, &y, argv[1]);
        JS_ToFloat64(ctx, &w, argv[2]);
        JS_ToFloat64(ctx, &h, argv[3]);
    }
    if (argc >= 5) JS_ToUint32(ctx, &color, argv[4]);

    SDL_SetRenderDrawBlendMode(g_renderer, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(g_renderer, color & 0xFF, (color >> 8) & 0xFF,
                           (color >> 16) & 0xFF, athena_alpha(color));
    SDL_FRect r = { (float)x, (float)y, (float)w, (float)h };
    SDL_RenderFillRectF(g_renderer, &r);
    return JS_UNDEFINED;
}

void host_install_draw(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue draw = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, draw, "rect", JS_NewCFunction(ctx, js_draw_rect, "rect", 5));
    JS_SetPropertyStr(ctx, global, "Draw", draw);
    JS_FreeValue(ctx, global);
}
