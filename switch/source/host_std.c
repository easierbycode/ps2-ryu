// QuickJS's `std` module, as the game expects it on a real PS2.
//
// ps2/lib/tiled.js does `import * as std from "std"` to read the Tiled maps,
// so the host registers a native module under that exact specifier — the
// browser build aliases the same import to src/web/std-module.ts. Paths are
// game-relative, like every other asset path, and resolve inside romfs.
//
// romfs is read-only, so std.open(path, "w") accepts the writes the level
// editor makes and drops them with a warning rather than failing the frame;
// the editor is a development tool that lives on the PS2 and browser builds.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "js_host.h"

static JSValue js_std_load_file(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    const char *rel = JS_ToCString(ctx, argv[0]);
    if (!rel) return JS_EXCEPTION;

    char full[512];
    snprintf(full, sizeof(full), GAME_ROOT "%s", rel);
    JS_FreeCString(ctx, rel);

    FILE *f = fopen(full, "rb");
    if (!f) return JS_NULL;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (len < 0) {
        fclose(f);
        return JS_NULL;
    }
    char *buf = malloc((size_t)len + 1);
    if (!buf) {
        fclose(f);
        return JS_ThrowOutOfMemory(ctx);
    }
    size_t got = fread(buf, 1, (size_t)len, f);
    fclose(f);
    buf[got] = '\0';
    JSValue out = JS_NewStringLen(ctx, buf, got);
    free(buf);
    return out;
}

// Writes are accepted and dropped: nothing under romfs can be rewritten, and
// the caller (the level editor) only needs the calls not to throw.
static JSValue js_file_puts(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)ctx;
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_UNDEFINED;
}

static JSValue js_file_close(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)argc;
    (void)argv;
    JSValue path = JS_GetPropertyStr(ctx, this_val, "__path");
    const char *p = JS_ToCString(ctx, path);
    fprintf(stderr, "[std] discarded write to %s — romfs is read-only\n", p ? p : "(?)");
    if (p) JS_FreeCString(ctx, p);
    JS_FreeValue(ctx, path);
    return JS_UNDEFINED;
}

static JSValue js_std_open(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "std.open expects a path");
    JSValue file = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, file, "__path", JS_DupValue(ctx, argv[0]));
    JS_SetPropertyStr(ctx, file, "puts", JS_NewCFunction(ctx, js_file_puts, "puts", 1));
    JS_SetPropertyStr(ctx, file, "close", JS_NewCFunction(ctx, js_file_close, "close", 0));
    return file;
}

// console.log/warn/error, wired up by prelude.js. quickjs-ng only ships
// those through quickjs-libc, which this host does not link, and a game
// that logs on a dead `console` would take the frame down with it.
static JSValue js_print(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        fprintf(stderr, "%s%s", i ? " " : "", s ? s : "(unprintable)");
        if (s) JS_FreeCString(ctx, s);
    }
    fputc('\n', stderr);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry std_exports[] = {
    JS_CFUNC_DEF("loadFile", 1, js_std_load_file),
    JS_CFUNC_DEF("open", 2, js_std_open),
};

static int std_module_init(JSContext *ctx, JSModuleDef *m) {
    return JS_SetModuleExportList(ctx, m, std_exports,
                                  sizeof(std_exports) / sizeof(std_exports[0]));
}

void host_install_std(JSContext *ctx) {
    JSModuleDef *m = JS_NewCModule(ctx, "std", std_module_init);
    if (!m) return;
    JS_AddModuleExportList(ctx, m, std_exports,
                           sizeof(std_exports) / sizeof(std_exports[0]));

    // AthenaEnv also exposes std as a global; the browser host installs one
    // too, so anything reaching for globalThis.std finds the same functions
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue std = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, std, std_exports,
                               sizeof(std_exports) / sizeof(std_exports[0]));
    JS_SetPropertyStr(ctx, global, "std", std);
    JS_SetPropertyStr(ctx, global, "__print", JS_NewCFunction(ctx, js_print, "__print", 1));
    JS_FreeValue(ctx, global);
}
