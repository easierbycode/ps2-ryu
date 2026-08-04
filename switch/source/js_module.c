// ES module loading for the game tree. ps2/ imports use cwd-relative bare
// specifiers ("lib/input.js", "screens/game.js") — the same resolution the
// Vite aliases mimic for the browser (vite.config.js) — so the normalizer
// passes them through untouched and the loader roots them at romfs:/game/.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "js_host.h"

static char *dupstr(JSContext *ctx, const char *s) {
    size_t n = strlen(s) + 1;
    char *p = js_malloc(ctx, n);
    if (p) memcpy(p, s, n);
    return p;
}

// whole-file read; romfs is mounted on newlib's VFS so plain stdio works
static char *read_file(const char *path, size_t *plen) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (len < 0) { fclose(f); return NULL; }
    char *buf = malloc((size_t)len + 1);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)len, f) != (size_t)len) {
        fclose(f);
        free(buf);
        return NULL;
    }
    fclose(f);
    buf[len] = '\0';
    *plen = (size_t)len;
    return buf;
}

static char *module_normalize(JSContext *ctx, const char *base, const char *name, void *opaque) {
    (void)opaque;
    if (name[0] != '.') return dupstr(ctx, name); // bare specifier, game-root relative

    // "./x" / "../x" relative to the importing module (unused by ps2/ today)
    char dir[512];
    const char *slash = strrchr(base, '/');
    size_t dlen = slash ? (size_t)(slash - base) : 0;
    if (dlen >= sizeof(dir)) return NULL;
    memcpy(dir, base, dlen);
    dir[dlen] = '\0';

    const char *p = name;
    for (;;) {
        if (!strncmp(p, "./", 2)) {
            p += 2;
        } else if (!strncmp(p, "../", 3)) {
            p += 3;
            char *up = strrchr(dir, '/');
            if (up) *up = '\0';
            else dir[0] = '\0';
        } else {
            break;
        }
    }
    char out[512];
    int n = dir[0] ? snprintf(out, sizeof(out), "%s/%s", dir, p)
                   : snprintf(out, sizeof(out), "%s", p);
    if (n < 0 || (size_t)n >= sizeof(out)) return NULL; // specifier too long
    return dupstr(ctx, out);
}

static JSModuleDef *module_load(JSContext *ctx, const char *name, void *opaque) {
    (void)opaque;
    char path[512];
    snprintf(path, sizeof(path), GAME_ROOT "%s", name);
    size_t len;
    char *buf = read_file(path, &len);
    if (!buf) {
        JS_ThrowReferenceError(ctx, "module not found: %s", path);
        return NULL;
    }
    JSValue v = JS_Eval(ctx, buf, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(buf);
    if (JS_IsException(v)) return NULL;
    JSModuleDef *m = JS_VALUE_GET_PTR(v);
    JS_FreeValue(ctx, v);
    return m;
}

void js_dump_exception(JSContext *ctx) {
    JSValue exc = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exc);
    fprintf(stderr, "[js] uncaught: %s\n", msg ? msg : "(unprintable exception)");
    if (msg) JS_FreeCString(ctx, msg);
    if (JS_IsObject(exc)) {
        JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (!JS_IsException(stack) && !JS_IsUndefined(stack)) {
            const char *s = JS_ToCString(ctx, stack);
            if (s) {
                fprintf(stderr, "%s\n", s);
                JS_FreeCString(ctx, s);
            }
        }
        JS_FreeValue(ctx, stack);
    }
    JS_FreeValue(ctx, exc);
}

// a rejected promise with no handler is a swallowed error — surface it on
// nxlink stdout instead of losing it (module evaluation reports this way too)
static void rejection_tracker(JSContext *ctx, JSValue promise, JSValue reason,
                              bool is_handled, void *opaque) {
    (void)promise;
    (void)opaque;
    if (is_handled) return;
    const char *msg = JS_ToCString(ctx, reason);
    fprintf(stderr, "[js] unhandled rejection: %s\n", msg ? msg : "(unprintable)");
    if (msg) JS_FreeCString(ctx, msg);
}

void js_module_init(JSRuntime *rt) {
    JS_SetModuleLoaderFunc(rt, module_normalize, module_load, NULL);
    JS_SetHostPromiseRejectionTracker(rt, rejection_tracker, NULL);
}

// evaluate a file by full path — prelude as a classic script, main.js as the
// root module (its static imports resolve through the loader above)
bool js_eval_path(JSContext *ctx, const char *path, bool as_module) {
    size_t len;
    char *buf = read_file(path, &len);
    if (!buf) {
        fprintf(stderr, "[js] cannot read %s\n", path);
        return false;
    }
    const char *name = strrchr(path, '/');
    name = name ? name + 1 : path;
    JSValue v = JS_Eval(ctx, buf, len, name,
                        as_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL);
    free(buf);
    if (JS_IsException(v)) {
        js_dump_exception(ctx);
        return false;
    }
    JS_FreeValue(ctx, v);
    // run module-evaluation jobs now so boot errors surface before frame one
    JSContext *pctx;
    while (JS_ExecutePendingJob(JS_GetRuntime(ctx), &pctx) > 0) {}
    return true;
}
