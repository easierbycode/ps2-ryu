// The Font class — AthenaEnv's TTF text API, which the HUD and the level
// editor draw through (ps2/screens/GameScreen.js):
//   const f = new Font("assets/fonts/mania.ttf")
//   f.scale = 1.0; f.color = Color.new(...)
//   f.print(x, y, text[, color]); f.getTextSize(text) -> { width, height }
//
// SDL2_ttf rasterizes; glyph runs are cached per (font, string) because the
// HUD re-prints the same handful of strings every frame and re-rendering
// them would burn the frame budget. White is baked into the texture and the
// requested color rides in as a color/alpha mod, so one cache entry serves
// every tint.
#include <stdio.h>
#include <string.h>
#include <SDL2/SDL_ttf.h>

#include "js_host.h"

// AthenaEnv reports no point size of its own; 24px matches the 24px HUD row
// pitch the game lays out against (and the browser host's FONT_SIZE).
#define FONT_PT 24
#define CACHE_SLOTS 64
#define CACHE_TEXT_MAX 64

typedef struct {
    TTF_Font *font;
    char text[CACHE_TEXT_MAX];
    SDL_Texture *tex;
    int w, h;
    uint64_t used; // for LRU eviction
} GlyphRun;

typedef struct {
    TTF_Font *font;
    double scale;
    uint32_t color;
    bool has_color;
} HostFont;

static JSClassID font_class_id;
static GlyphRun cache[CACHE_SLOTS];
static uint64_t cache_clock = 0;
static bool ttf_ready = false;

bool font_init(void) {
    if (TTF_Init() != 0) {
        fprintf(stderr, "[font] TTF_Init: %s\n", TTF_GetError());
        return false;
    }
    ttf_ready = true;
    return true;
}

static void cache_drop(GlyphRun *slot) {
    if (slot->tex) SDL_DestroyTexture(slot->tex);
    memset(slot, 0, sizeof(*slot));
}

void font_shutdown(void) {
    for (int i = 0; i < CACHE_SLOTS; i++) cache_drop(&cache[i]);
    if (ttf_ready) TTF_Quit();
    ttf_ready = false;
}

// Drop every cached run belonging to a font that is going away, so its
// textures don't outlive it in the cache.
static void cache_forget_font(TTF_Font *font) {
    for (int i = 0; i < CACHE_SLOTS; i++) {
        if (cache[i].font == font) cache_drop(&cache[i]);
    }
}

// Rasterize (or reuse) `text` in white; returns NULL if it cannot be drawn.
static GlyphRun *glyph_run(TTF_Font *font, const char *text) {
    if (!text[0]) return NULL;

    GlyphRun *victim = &cache[0];
    for (int i = 0; i < CACHE_SLOTS; i++) {
        GlyphRun *slot = &cache[i];
        if (slot->tex && slot->font == font && !strcmp(slot->text, text)) {
            slot->used = ++cache_clock;
            return slot;
        }
        if (!slot->tex) victim = slot;
        else if (victim->tex && slot->used < victim->used) victim = slot;
    }

    SDL_Color white = { 255, 255, 255, 255 };
    SDL_Surface *surf = TTF_RenderUTF8_Blended(font, text, white);
    if (!surf) return NULL;
    SDL_Texture *tex = SDL_CreateTextureFromSurface(g_renderer, surf);
    int w = surf->w, h = surf->h;
    SDL_FreeSurface(surf);
    if (!tex) return NULL;
    SDL_SetTextureBlendMode(tex, SDL_BLENDMODE_BLEND);

    cache_drop(victim);
    victim->font = font;
    victim->tex = tex;
    victim->w = w;
    victim->h = h;
    victim->used = ++cache_clock;
    snprintf(victim->text, sizeof(victim->text), "%s", text);
    return victim;
}

static void font_finalizer(JSRuntime *rt, JSValue val) {
    (void)rt;
    HostFont *f = JS_GetOpaque(val, font_class_id);
    if (f) {
        if (f->font) {
            cache_forget_font(f->font);
            TTF_CloseFont(f->font);
        }
        free(f);
    }
}

static JSClassDef font_class = {
    .class_name = "Font",
    .finalizer = font_finalizer,
};

enum { F_SCALE, F_COLOR };

static JSValue font_get(JSContext *ctx, JSValue this_val, int magic) {
    HostFont *f = JS_GetOpaque2(ctx, this_val, font_class_id);
    if (!f) return JS_EXCEPTION;
    if (magic == F_SCALE) return JS_NewFloat64(ctx, f->scale);
    return f->has_color ? JS_NewFloat64(ctx, (double)f->color) : JS_UNDEFINED;
}

static JSValue font_set(JSContext *ctx, JSValue this_val, JSValue val, int magic) {
    HostFont *f = JS_GetOpaque2(ctx, this_val, font_class_id);
    if (!f) return JS_EXCEPTION;
    if (magic == F_SCALE) {
        double d;
        if (JS_ToFloat64(ctx, &d, val)) return JS_EXCEPTION;
        f->scale = d;
    } else {
        if (JS_IsUndefined(val) || JS_IsNull(val)) {
            f->has_color = false;
        } else {
            uint32_t c;
            if (JS_ToUint32(ctx, &c, val)) return JS_EXCEPTION;
            f->color = c;
            f->has_color = true;
        }
    }
    return JS_UNDEFINED;
}

static JSValue font_print(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    HostFont *f = JS_GetOpaque2(ctx, this_val, font_class_id);
    if (!f) return JS_EXCEPTION;
    if (argc < 3) return JS_ThrowTypeError(ctx, "Font.print expects (x, y, text)");

    double x = 0, y = 0;
    JS_ToFloat64(ctx, &x, argv[0]);
    JS_ToFloat64(ctx, &y, argv[1]);
    const char *text = JS_ToCString(ctx, argv[2]);
    if (!text) return JS_EXCEPTION;

    GlyphRun *run = glyph_run(f->font, text);
    JS_FreeCString(ctx, text);
    if (!run) return JS_UNDEFINED;

    // an explicit print color wins over the instance's font.color
    uint32_t color = 0x80FFFFFF;
    if (argc >= 4 && !JS_IsUndefined(argv[3])) {
        if (JS_ToUint32(ctx, &color, argv[3])) return JS_EXCEPTION;
    } else if (f->has_color) {
        color = f->color;
    }
    SDL_SetTextureColorMod(run->tex, color & 0xFF, (color >> 8) & 0xFF, (color >> 16) & 0xFF);
    SDL_SetTextureAlphaMod(run->tex, athena_alpha(color));

    SDL_FRect dst = {
        (float)x, (float)y,
        (float)(run->w * f->scale), (float)(run->h * f->scale),
    };
    SDL_RenderCopyF(g_renderer, run->tex, NULL, &dst);
    return JS_UNDEFINED;
}

static JSValue font_get_text_size(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    HostFont *f = JS_GetOpaque2(ctx, this_val, font_class_id);
    if (!f) return JS_EXCEPTION;
    const char *text = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    int w = 0, h = 0;
    if (text) {
        TTF_SizeUTF8(f->font, text, &w, &h);
        JS_FreeCString(ctx, text);
    }
    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "width", JS_NewFloat64(ctx, w * f->scale));
    JS_SetPropertyStr(ctx, out, "height", JS_NewFloat64(ctx, h * f->scale));
    return out;
}

static const JSCFunctionListEntry font_proto_funcs[] = {
    JS_CGETSET_MAGIC_DEF("scale", font_get, font_set, F_SCALE),
    JS_CGETSET_MAGIC_DEF("color", font_get, font_set, F_COLOR),
    JS_CFUNC_DEF("print", 3, font_print),
    JS_CFUNC_DEF("getTextSize", 1, font_get_text_size),
};

static JSValue font_ctor(JSContext *ctx, JSValue new_target, int argc, JSValue *argv) {
    (void)new_target;
    if (argc < 1) return JS_ThrowTypeError(ctx, "new Font(path) expects a path");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;

    char full[512];
    snprintf(full, sizeof(full), GAME_ROOT "%s", path);
    TTF_Font *ttf = TTF_OpenFont(full, FONT_PT);
    if (!ttf) {
        JSValue e = JS_ThrowReferenceError(ctx, "Font load failed: %s (%s)", full, TTF_GetError());
        JS_FreeCString(ctx, path);
        return e;
    }
    JS_FreeCString(ctx, path);

    HostFont *f = calloc(1, sizeof(*f));
    if (!f) {
        TTF_CloseFont(ttf);
        return JS_ThrowOutOfMemory(ctx);
    }
    f->font = ttf;
    f->scale = 1.0;

    JSValue obj = JS_NewObjectClass(ctx, font_class_id);
    if (JS_IsException(obj)) {
        TTF_CloseFont(ttf);
        free(f);
        return obj;
    }
    JS_SetOpaque(obj, f);
    return obj;
}

void host_install_font(JSContext *ctx) {
    JSRuntime *rt = JS_GetRuntime(ctx);
    JS_NewClassID(rt, &font_class_id);
    JS_NewClass(rt, font_class_id, &font_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, font_proto_funcs,
                               sizeof(font_proto_funcs) / sizeof(font_proto_funcs[0]));
    JS_SetClassProto(ctx, font_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, font_ctor, "Font", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "Font", ctor);
    JS_FreeValue(ctx, global);
}
