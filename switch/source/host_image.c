// The Image class — AthenaEnv's crop-rect drawing contract, which all game
// rendering funnels through (ps2/lib/sheet.js): mutate width/height/startx/
// endx/starty/endy/color/filter, then draw(x, y). Flips are expressed as
// swapped start/end pairs; destination size is width/height at draw time
// (natural size is what width/height read as right after construction —
// Pic captures it there).
#include <stdio.h>
#include <SDL2/SDL_image.h>

#include "js_host.h"

typedef struct {
    SDL_Texture *tex;
    int natW, natH;
    double width, height;
    double startx, endx, starty, endy;
    uint32_t color;
    int32_t filter;
} HostImage;

static JSClassID image_class_id;

enum {
    F_WIDTH,
    F_HEIGHT,
    F_STARTX,
    F_ENDX,
    F_STARTY,
    F_ENDY,
    F_COLOR,
    F_FILTER,
};

static void image_finalizer(JSRuntime *rt, JSValue val) {
    (void)rt;
    HostImage *im = JS_GetOpaque(val, image_class_id);
    if (im) {
        if (im->tex) SDL_DestroyTexture(im->tex);
        free(im);
    }
}

static JSClassDef image_class = {
    .class_name = "Image",
    .finalizer = image_finalizer,
};

static JSValue image_get(JSContext *ctx, JSValue this_val, int magic) {
    HostImage *im = JS_GetOpaque2(ctx, this_val, image_class_id);
    if (!im) return JS_EXCEPTION;
    switch (magic) {
    case F_WIDTH: return JS_NewFloat64(ctx, im->width);
    case F_HEIGHT: return JS_NewFloat64(ctx, im->height);
    case F_STARTX: return JS_NewFloat64(ctx, im->startx);
    case F_ENDX: return JS_NewFloat64(ctx, im->endx);
    case F_STARTY: return JS_NewFloat64(ctx, im->starty);
    case F_ENDY: return JS_NewFloat64(ctx, im->endy);
    case F_COLOR: return JS_NewFloat64(ctx, (double)im->color);
    case F_FILTER: return JS_NewInt32(ctx, im->filter);
    }
    return JS_UNDEFINED;
}

static JSValue image_set(JSContext *ctx, JSValue this_val, JSValue val, int magic) {
    HostImage *im = JS_GetOpaque2(ctx, this_val, image_class_id);
    if (!im) return JS_EXCEPTION;
    if (magic == F_COLOR) {
        uint32_t c;
        if (JS_ToUint32(ctx, &c, val)) return JS_EXCEPTION;
        im->color = c;
    } else if (magic == F_FILTER) {
        int32_t f;
        if (JS_ToInt32(ctx, &f, val)) return JS_EXCEPTION;
        im->filter = f;
    } else {
        double d;
        if (JS_ToFloat64(ctx, &d, val)) return JS_EXCEPTION;
        switch (magic) {
        case F_WIDTH: im->width = d; break;
        case F_HEIGHT: im->height = d; break;
        case F_STARTX: im->startx = d; break;
        case F_ENDX: im->endx = d; break;
        case F_STARTY: im->starty = d; break;
        case F_ENDY: im->endy = d; break;
        }
    }
    return JS_UNDEFINED;
}

static JSValue image_draw(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    HostImage *im = JS_GetOpaque2(ctx, this_val, image_class_id);
    if (!im) return JS_EXCEPTION;
    // a zero-sized Image is how AthenaEnv reports art that isn't on the disc;
    // the game checks for it (TransitionManager) rather than being thrown at
    if (!im->tex) return JS_UNDEFINED;

    double x = 0, y = 0;
    if (argc >= 2) {
        JS_ToFloat64(ctx, &x, argv[0]);
        JS_ToFloat64(ctx, &y, argv[1]);
    }
    // draw(x, y, w, h) overrides the destination size for this call only —
    // the title screen blows its 160x112 sheet up to the full 640x448, and
    // the transition tiles scale per frame
    double dw = im->width, dh = im->height;
    if (argc >= 4) {
        JS_ToFloat64(ctx, &dw, argv[2]);
        JS_ToFloat64(ctx, &dh, argv[3]);
    }

    double sx0 = im->startx, sx1 = im->endx;
    double sy0 = im->starty, sy1 = im->endy;
    int flip = SDL_FLIP_NONE;
    if (sx1 < sx0) {
        double t = sx0;
        sx0 = sx1;
        sx1 = t;
        flip |= SDL_FLIP_HORIZONTAL;
    }
    if (sy1 < sy0) {
        double t = sy0;
        sy0 = sy1;
        sy1 = t;
        flip |= SDL_FLIP_VERTICAL;
    }
    SDL_Rect src = { (int)sx0, (int)sy0, (int)(sx1 - sx0), (int)(sy1 - sy0) };
    SDL_FRect dst = { (float)x, (float)y, (float)dw, (float)dh };

    SDL_SetTextureScaleMode(im->tex,
                            im->filter ? SDL_ScaleModeLinear : SDL_ScaleModeNearest);
    uint32_t c = im->color;
    SDL_SetTextureColorMod(im->tex, c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF);
    SDL_SetTextureAlphaMod(im->tex, athena_alpha(c));
    SDL_RenderCopyExF(g_renderer, im->tex, &src, &dst, 0, NULL, (SDL_RendererFlip)flip);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry image_proto_funcs[] = {
    JS_CGETSET_MAGIC_DEF("width", image_get, image_set, F_WIDTH),
    JS_CGETSET_MAGIC_DEF("height", image_get, image_set, F_HEIGHT),
    JS_CGETSET_MAGIC_DEF("startx", image_get, image_set, F_STARTX),
    JS_CGETSET_MAGIC_DEF("endx", image_get, image_set, F_ENDX),
    JS_CGETSET_MAGIC_DEF("starty", image_get, image_set, F_STARTY),
    JS_CGETSET_MAGIC_DEF("endy", image_get, image_set, F_ENDY),
    JS_CGETSET_MAGIC_DEF("color", image_get, image_set, F_COLOR),
    JS_CGETSET_MAGIC_DEF("filter", image_get, image_set, F_FILTER),
    JS_CFUNC_DEF("draw", 2, image_draw),
};

static JSValue image_ctor(JSContext *ctx, JSValue new_target, int argc, JSValue *argv) {
    (void)new_target;
    if (argc < 1) return JS_ThrowTypeError(ctx, "new Image(path) expects a path");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;

    char full[512];
    snprintf(full, sizeof(full), GAME_ROOT "%s", path);
    // AthenaEnv answers a missing file with a zero-sized Image rather than an
    // error, and the game treats that as "no art, skip drawing"
    // (TransitionManager probes .width). Throwing here would escape the frame
    // callback and take the whole app down on the first screen transition.
    SDL_Texture *tex = IMG_LoadTexture(g_renderer, full);
    if (!tex) {
        fprintf(stderr, "[image] %s not loaded (%s) — drawing nothing\n", full, IMG_GetError());
    } else {
        SDL_SetTextureBlendMode(tex, SDL_BLENDMODE_BLEND);
    }
    JS_FreeCString(ctx, path);

    HostImage *im = calloc(1, sizeof(*im));
    if (!im) {
        if (tex) SDL_DestroyTexture(tex);
        return JS_ThrowOutOfMemory(ctx);
    }
    im->tex = tex;
    if (tex) SDL_QueryTexture(tex, NULL, NULL, &im->natW, &im->natH);
    im->width = im->natW;
    im->height = im->natH;
    im->startx = 0;
    im->starty = 0;
    im->endx = im->natW;
    im->endy = im->natH;
    im->color = 0x80FFFFFF; // white, alpha 128 = neutral
    im->filter = 0;         // NEAREST

    JSValue obj = JS_NewObjectClass(ctx, image_class_id);
    if (JS_IsException(obj)) {
        if (tex) SDL_DestroyTexture(tex);
        free(im);
        return obj;
    }
    JS_SetOpaque(obj, im);
    return obj;
}

void host_install_image(JSContext *ctx) {
    JSRuntime *rt = JS_GetRuntime(ctx);
    JS_NewClassID(rt, &image_class_id);
    JS_NewClass(rt, image_class_id, &image_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, image_proto_funcs,
                               sizeof(image_proto_funcs) / sizeof(image_proto_funcs[0]));
    JS_SetClassProto(ctx, image_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, image_ctor, "Image", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "Image", ctor);
    JS_FreeValue(ctx, global);
}
