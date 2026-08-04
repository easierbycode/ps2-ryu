// Pads over SDL_GameController: four sticky slots (P2 stays P2 when P3
// unplugs — same semantics as src/web/pad-source.ts), per-frame button
// snapshots for justPressed, AthenaEnv axis ranges, and DS2-style rumble
// (big = amplitude 0-255, small = on/off; ps2/lib/haptics.js dedupes sends
// and issues an explicit (0,0) stop, so a long rumble duration is correct).
//
// The game polls Pads.getConnected() every frame (ps2/lib/input.js), so
// hot-join needs nothing beyond opening the controller into a free slot.
#include <stdio.h>

#include "js_host.h"

#define MAX_PORTS 4

typedef struct {
    SDL_GameController *gc;
    SDL_JoystickID jid;
    uint32_t btns, old_btns;
    int lx, ly, rx, ry;
} PadSlot;

static PadSlot slots[MAX_PORTS];
static JSValue pad_objs[MAX_PORTS];
static int pad_ports[MAX_PORTS]; // opaque storage for the Pad class
static JSClassID pad_class_id;

// AthenaEnv button masks (the game only combines Pads.X constants, but use
// the real values for parity with the other two hosts)
#define M_SELECT 1u
#define M_L3 2u
#define M_R3 4u
#define M_START 8u
#define M_UP 16u
#define M_RIGHT 32u
#define M_DOWN 64u
#define M_LEFT 128u
#define M_L2 256u
#define M_R2 512u
#define M_L1 1024u
#define M_R1 2048u
#define M_TRIANGLE 4096u
#define M_CIRCLE 8192u
#define M_CROSS 16384u
#define M_SQUARE 32768u

// The game's prompts are positional (bottom face button = fire/confirm =
// CROSS). devkitPro's SDL2 reports Switch-labelled buttons: A is the EAST
// button, B is SOUTH. Desktop SDL uses Xbox layout: A south, B east.
#ifdef __SWITCH__
#define BTN_SOUTH SDL_CONTROLLER_BUTTON_B
#define BTN_EAST SDL_CONTROLLER_BUTTON_A
#define BTN_WEST SDL_CONTROLLER_BUTTON_Y
#define BTN_NORTH SDL_CONTROLLER_BUTTON_X
#else
#define BTN_SOUTH SDL_CONTROLLER_BUTTON_A
#define BTN_EAST SDL_CONTROLLER_BUTTON_B
#define BTN_WEST SDL_CONTROLLER_BUTTON_X
#define BTN_NORTH SDL_CONTROLLER_BUTTON_Y
#endif

#define TRIGGER_ON 16384 // ZL/ZR are digital on Switch and report full-scale

static const struct {
    SDL_GameControllerButton btn;
    uint32_t mask;
} BTN_MAP[] = {
    // buttons map by position, whatever the pad prints on them: A (jump) is
    // the bottom face button and B (run / fireball) the left one
    { BTN_SOUTH, M_CROSS },
    { BTN_EAST, M_CIRCLE },
    { BTN_WEST, M_SQUARE },
    { BTN_NORTH, M_TRIANGLE },
    { SDL_CONTROLLER_BUTTON_START, M_START },
    { SDL_CONTROLLER_BUTTON_BACK, M_SELECT },
    { SDL_CONTROLLER_BUTTON_DPAD_UP, M_UP },
    { SDL_CONTROLLER_BUTTON_DPAD_DOWN, M_DOWN },
    { SDL_CONTROLLER_BUTTON_DPAD_LEFT, M_LEFT },
    { SDL_CONTROLLER_BUTTON_DPAD_RIGHT, M_RIGHT },
    { SDL_CONTROLLER_BUTTON_LEFTSHOULDER, M_L1 },
    { SDL_CONTROLLER_BUTTON_RIGHTSHOULDER, M_R1 },
    { SDL_CONTROLLER_BUTTON_LEFTSTICK, M_L3 },
    { SDL_CONTROLLER_BUTTON_RIGHTSTICK, M_R3 },
};

// SDL -32768..32767 to AthenaEnv's asymmetric -127..128 (raw 0..255 - 127)
static int to_athena_axis(int v) {
    return v < 0 ? v * 127 / 32768 : v * 128 / 32767;
}

static void open_into_free_slot(int device_index) {
    SDL_JoystickID jid = SDL_JoystickGetDeviceInstanceID(device_index);
    for (int i = 0; i < MAX_PORTS; i++)
        if (slots[i].gc && slots[i].jid == jid) return; // already open
    for (int i = 0; i < MAX_PORTS; i++) {
        if (slots[i].gc) continue;
        SDL_GameController *gc = SDL_GameControllerOpen(device_index);
        if (!gc) {
            fprintf(stderr, "[pads] open %d: %s\n", device_index, SDL_GetError());
            return;
        }
        slots[i] = (PadSlot){ .gc = gc, .jid = jid };
        printf("[pads] port %d: %s\n", i, SDL_GameControllerName(gc));
        return;
    }
}

static void close_by_instance(SDL_JoystickID jid) {
    for (int i = 0; i < MAX_PORTS; i++) {
        if (slots[i].gc && slots[i].jid == jid) {
            SDL_GameControllerClose(slots[i].gc);
            slots[i] = (PadSlot){ 0 };
            printf("[pads] port %d: disconnected\n", i);
            return;
        }
    }
}

void host_pads_pump(bool *quit) {
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
        switch (ev.type) {
        case SDL_QUIT:
            *quit = true;
            break;
        case SDL_CONTROLLERDEVICEADDED:
            open_into_free_slot(ev.cdevice.which);
            break;
        case SDL_CONTROLLERDEVICEREMOVED:
            close_by_instance(ev.cdevice.which);
            break;
        }
    }
    for (int i = 0; i < MAX_PORTS; i++) {
        PadSlot *s = &slots[i];
        s->old_btns = s->btns;
        if (!s->gc) {
            s->btns = 0;
            s->lx = s->ly = s->rx = s->ry = 0;
            continue;
        }
        uint32_t b = 0;
        for (size_t m = 0; m < sizeof(BTN_MAP) / sizeof(BTN_MAP[0]); m++)
            if (SDL_GameControllerGetButton(s->gc, BTN_MAP[m].btn)) b |= BTN_MAP[m].mask;
        if (SDL_GameControllerGetAxis(s->gc, SDL_CONTROLLER_AXIS_TRIGGERLEFT) > TRIGGER_ON)
            b |= M_L2;
        if (SDL_GameControllerGetAxis(s->gc, SDL_CONTROLLER_AXIS_TRIGGERRIGHT) > TRIGGER_ON)
            b |= M_R2;
        s->btns = b;
        s->lx = to_athena_axis(SDL_GameControllerGetAxis(s->gc, SDL_CONTROLLER_AXIS_LEFTX));
        s->ly = to_athena_axis(SDL_GameControllerGetAxis(s->gc, SDL_CONTROLLER_AXIS_LEFTY));
        s->rx = to_athena_axis(SDL_GameControllerGetAxis(s->gc, SDL_CONTROLLER_AXIS_RIGHTX));
        s->ry = to_athena_axis(SDL_GameControllerGetAxis(s->gc, SDL_CONTROLLER_AXIS_RIGHTY));
    }
}

void host_pads_shutdown(void) {
    for (int i = 0; i < MAX_PORTS; i++) {
        if (slots[i].gc) SDL_GameControllerClose(slots[i].gc);
        slots[i] = (PadSlot){ 0 };
    }
}

// release the cached pad objects before the runtime is freed
void host_pads_free_js(JSContext *ctx) {
    for (int i = 0; i < MAX_PORTS; i++) {
        JS_FreeValue(ctx, pad_objs[i]);
        pad_objs[i] = JS_UNDEFINED;
    }
}

// --- the JS Pad objects -------------------------------------------------

static JSClassDef pad_class = { .class_name = "Pad" };

static PadSlot *pad_slot(JSValue this_val) {
    int *port = JS_GetOpaque(this_val, pad_class_id);
    return port ? &slots[*port] : NULL;
}

enum { A_LX, A_LY, A_RX, A_RY };

static JSValue pad_get_axis(JSContext *ctx, JSValue this_val, int magic) {
    PadSlot *s = pad_slot(this_val);
    if (!s) return JS_ThrowTypeError(ctx, "not a Pad");
    switch (magic) {
    case A_LX: return JS_NewInt32(ctx, s->lx);
    case A_LY: return JS_NewInt32(ctx, s->ly);
    case A_RX: return JS_NewInt32(ctx, s->rx);
    default: return JS_NewInt32(ctx, s->ry);
    }
}

static JSValue pad_pressed(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    PadSlot *s = pad_slot(this_val);
    uint32_t mask = 0;
    if (argc >= 1) JS_ToUint32(ctx, &mask, argv[0]);
    return JS_NewBool(ctx, s && (s->btns & mask) != 0);
}

static JSValue pad_just_pressed(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    PadSlot *s = pad_slot(this_val);
    uint32_t mask = 0;
    if (argc >= 1) JS_ToUint32(ctx, &mask, argv[0]);
    return JS_NewBool(ctx, s && (s->btns & mask & ~s->old_btns) != 0);
}

static const JSCFunctionListEntry pad_proto_funcs[] = {
    JS_CGETSET_MAGIC_DEF("lx", pad_get_axis, NULL, A_LX),
    JS_CGETSET_MAGIC_DEF("ly", pad_get_axis, NULL, A_LY),
    JS_CGETSET_MAGIC_DEF("rx", pad_get_axis, NULL, A_RX),
    JS_CGETSET_MAGIC_DEF("ry", pad_get_axis, NULL, A_RY),
    JS_CFUNC_DEF("pressed", 1, pad_pressed),
    JS_CFUNC_DEF("justPressed", 1, pad_just_pressed),
};

// --- the Pads global ----------------------------------------------------

static JSValue pads_get(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    int32_t port = 0;
    if (argc >= 1) JS_ToInt32(ctx, &port, argv[0]);
    if (port < 0 || port >= MAX_PORTS) port = 0;
    return JS_DupValue(ctx, pad_objs[port]);
}

static JSValue pads_get_connected(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (int i = 0; i < MAX_PORTS; i++)
        if (slots[i].gc) JS_SetPropertyUint32(ctx, arr, n++, JS_NewInt32(ctx, i));
    return arr;
}

static JSValue pads_rumble(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    (void)this_val;
    int32_t port = 0, big = 0, small = 0;
    if (argc >= 3) {
        JS_ToInt32(ctx, &port, argv[0]);
        JS_ToInt32(ctx, &big, argv[1]);
        JS_ToInt32(ctx, &small, argv[2]);
    }
    if (port < 0 || port >= MAX_PORTS || !slots[port].gc) return JS_UNDEFINED;
    if (big < 0) big = 0;
    if (big > 255) big = 255;
    // 30s outlasts any pulse; haptics.js sends an explicit (0,0) stop
    SDL_GameControllerRumble(slots[port].gc, (Uint16)(big * 257),
                             small ? 0x6000 : 0, 30000);
    return JS_UNDEFINED;
}

static const struct {
    const char *name;
    uint32_t mask;
} PAD_CONSTS[] = {
    { "SELECT", M_SELECT }, { "L3", M_L3 },       { "R3", M_R3 },
    { "START", M_START },   { "UP", M_UP },       { "RIGHT", M_RIGHT },
    { "DOWN", M_DOWN },     { "LEFT", M_LEFT },   { "L2", M_L2 },
    { "R2", M_R2 },         { "L1", M_L1 },       { "R1", M_R1 },
    { "TRIANGLE", M_TRIANGLE }, { "CIRCLE", M_CIRCLE },
    { "CROSS", M_CROSS },   { "SQUARE", M_SQUARE },
};

void host_install_pads(JSContext *ctx) {
    JSRuntime *rt = JS_GetRuntime(ctx);
    JS_NewClassID(rt, &pad_class_id);
    JS_NewClass(rt, pad_class_id, &pad_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, pad_proto_funcs,
                               sizeof(pad_proto_funcs) / sizeof(pad_proto_funcs[0]));
    JS_SetClassProto(ctx, pad_class_id, proto);

    for (int i = 0; i < MAX_PORTS; i++) {
        pad_ports[i] = i;
        pad_objs[i] = JS_NewObjectClass(ctx, pad_class_id);
        JS_SetOpaque(pad_objs[i], &pad_ports[i]);
    }

    JSValue pads = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, pads, "get", JS_NewCFunction(ctx, pads_get, "get", 1));
    JS_SetPropertyStr(ctx, pads, "getConnected",
                      JS_NewCFunction(ctx, pads_get_connected, "getConnected", 0));
    JS_SetPropertyStr(ctx, pads, "rumble", JS_NewCFunction(ctx, pads_rumble, "rumble", 3));
    for (size_t i = 0; i < sizeof(PAD_CONSTS) / sizeof(PAD_CONSTS[0]); i++)
        JS_SetPropertyStr(ctx, pads, PAD_CONSTS[i].name,
                          JS_NewInt32(ctx, (int32_t)PAD_CONSTS[i].mask));

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "Pads", pads);
    JS_FreeValue(ctx, global);
}
