// Explicitly (re)apply the video mode before rendering.
//
// Recent AthenaEnv builds boot the GS with Field = GS_FIELD and the boot-time
// init_graphics() path skips the display-offset and flip-function setup that
// Screen.setMode() performs. A script that never calls setMode() (older
// AthenaEnv let you skip it) then renders the 640x448 interlaced framebuffer as
// alternating black scanlines. Every AthenaEnv example calls setMode at
// startup; mirroring that runs the full display setup and fixes the artifact.
const videoMode = Screen.getMode();
Screen.setMode(videoMode);

Screen.setVSync(true);

const SCREEN_WIDTH = 640;
const SCREEN_HEIGHT = 448;
const GROUND_Y = 190;

const WORLD_WIDTH = SCREEN_WIDTH * 1.2;
const WORLD_HEIGHT = SCREEN_HEIGHT;

const background = new Image("background.png");
background.width = WORLD_WIDTH;
background.height = WORLD_HEIGHT;

// Ryu offset
const FLIP_OFFSET = 60;  // Adjust this value until it looks right

// Camera
let cameraX = 0;
let cameraY = 0;

class Animation {
    constructor(frames, fps) {
        this.frames = frames.map(f => {
            const img = new Image(f);
            img.width *= 2;
            img.height *= 2;
            return img;
        });
        this.fps = 1000000 / fps;
        this.timer = Timer.new();
        this.frame = 0;
    }

    draw(x, y, flipH = false) {
        if (Timer.getTime(this.timer) >= this.fps) {
            this.frame = (this.frame + 1) % this.frames.length;
            Timer.setTime(this.timer, 1);
        }

        const img = this.frames[this.frame];

        if (flipH) {
            img.startx = img.width;
            img.endx = 0;
        } else {
            img.startx = 0;
            img.endx = img.width;
        }

        img.draw(x, y);
    }

    reset() {
        this.frame = 0;
        Timer.setTime(this.timer, 1);
    }
}

// Correct animations (32 frames total)
const idleAnim = new Animation([
    "frames/frame_000.png",
    "frames/frame_001.png",
    "frames/frame_002.png",
    "frames/frame_003.png"
], 6);

const crouchAnim = new Animation([
    "frames/frame_018.png"  // Use first crouch kick frame as crouch pose
], 6);

const lightPunchAnim = new Animation([
    "frames/frame_004.png",
    "frames/frame_005.png",
    "frames/frame_006.png"
], 15);

const lightKickAnim = new Animation([
    "frames/frame_007.png",
    "frames/frame_008.png",
    "frames/frame_009.png"
], 15);

const shoryukenAnim = new Animation([
    "frames/frame_010.png",
    "frames/frame_011.png",
    "frames/frame_012.png",
    "frames/frame_013.png",
    "frames/frame_014.png",
    "frames/frame_015.png",
    "frames/frame_016.png",
    "frames/frame_017.png"
], 12);

const crouchLightKickAnim = new Animation([
    "frames/frame_018.png",
    "frames/frame_019.png",
    "frames/frame_020.png",
    "frames/frame_021.png",
    "frames/frame_018.png"  // Repeats frame 18 at end
], 15);

const crouchLightPunchAnim = new Animation([
    "frames/frame_022.png",
    "frames/frame_023.png",
    "frames/frame_024.png"
], 15);

const jumpAnim = new Animation([
    "frames/frame_025.png",
    "frames/frame_026.png",
    "frames/frame_027.png",
    "frames/frame_028.png",
    "frames/frame_029.png",
    "frames/frame_030.png",
    "frames/frame_031.png"
], 10);

// Player state
let posX = 250;
let posY = GROUND_Y;
let velY = 0;
let velX = 0;
const gravity = 0.5;
const jumpForce = -12;
const moveSpeed = 4;
let isGrounded = true;
let facingLeft = false;

// Combat state
let isAttacking = false;
let attackFrames = 0;
let isCrouching = false;
let currentAnimation = idleAnim;

// Input buffering for special moves
let inputBuffer = [];
const BUFFER_SIZE = 10;
let bufferTimer = 0;

let pad = Pads.get();
let oldPad = pad;

// Main game loop
while (true) {
    Screen.clear();

    // Background
    drawBackground();

    // Update
    oldPad = pad;
    pad = Pads.get();

    updateInputBuffer();
    handleInput();
    applyPhysics();
    updateCamera();

    // Draw Ryu
    const drawX = facingLeft ? (posX - cameraX - FLIP_OFFSET) : (posX - cameraX);
    currentAnimation.draw(drawX, posY - cameraY, facingLeft);

    Screen.flip();

    bufferTimer++;
}

function drawBackground() {
    background.draw(-cameraX, -cameraY);
}

function updateCamera() {
    // Follow player horizontally
    cameraX = posX - SCREEN_WIDTH / 2;

    // Follow player vertically if they jump above the screen's vertical midpoint
    const cameraLockY = WORLD_HEIGHT - SCREEN_HEIGHT;
    if (posY - cameraLockY < SCREEN_HEIGHT / 2) {
        cameraY = posY - SCREEN_HEIGHT / 2;
    } else {
        cameraY = cameraLockY;
    }

    // Clamp camera to world boundaries
    cameraX = Math.max(0, Math.min(cameraX, WORLD_WIDTH - SCREEN_WIDTH));
    cameraY = Math.max(0, Math.min(cameraY, WORLD_HEIGHT - SCREEN_HEIGHT));
}

function updateInputBuffer() {
    if (!oldPad.pressed(Pads.DOWN) && pad.pressed(Pads.DOWN)) {
        inputBuffer.push({ input: 'down', time: bufferTimer });
    }
    if (!oldPad.pressed(Pads.LEFT) && pad.pressed(Pads.LEFT)) {
        inputBuffer.push({ input: 'left', time: bufferTimer });
    }
    if (!oldPad.pressed(Pads.RIGHT) && pad.pressed(Pads.RIGHT)) {
        inputBuffer.push({ input: 'right', time: bufferTimer });
    }
    if (!oldPad.pressed(Pads.SQUARE) && pad.pressed(Pads.SQUARE)) {
        inputBuffer.push({ input: 'punch', time: bufferTimer });
    }

    // Remove old inputs (older than 30 frames)
    inputBuffer = inputBuffer.filter(item => bufferTimer - item.time < 30);
}

function checkShoryuken() {
    if (inputBuffer.length < 4) return false;

    const recent = inputBuffer.slice(-4);
    const forwardDir = facingLeft ? 'left' : 'right';

    let hasFirstForward = false;
    let hasDown = false;
    let hasSecondForward = false;
    let hasPunch = false;

    for (let i = 0; i < recent.length; i++) {
        if (!hasFirstForward && recent[i].input === forwardDir) {
            hasFirstForward = true;
        } else if (hasFirstForward && !hasDown && recent[i].input === 'down') {
            hasDown = true;
        } else if (hasDown && !hasSecondForward && recent[i].input === forwardDir) {
            hasSecondForward = true;
        } else if (hasSecondForward && recent[i].input === 'punch') {
            hasPunch = true;
        }
    }

    return hasFirstForward && hasDown && hasSecondForward && hasPunch;
}

function handleInput() {
    if (isAttacking) {
        attackFrames--;
        if (attackFrames <= 0) {
            isAttacking = false;
            currentAnimation = idleAnim;
            currentAnimation.reset();
        }
        return;
    }

    isCrouching = pad.pressed(Pads.DOWN) && isGrounded;

    if (checkShoryuken() && isGrounded) {
        performShoryuken();
        return;
    }

    // Crouching attacks
    if (isCrouching) {
        if (!oldPad.pressed(Pads.SQUARE) && pad.pressed(Pads.SQUARE)) {
            performAttack(crouchLightPunchAnim, 18);
            return;
        }
        if (!oldPad.pressed(Pads.CROSS) && pad.pressed(Pads.CROSS)) {
            performAttack(crouchLightKickAnim, 30);
            return;
        }

        currentAnimation = crouchAnim;
        velX = 0;
        return;
    }

    // Standing attacks
    if (!oldPad.pressed(Pads.SQUARE) && pad.pressed(Pads.SQUARE) && isGrounded) {
        performAttack(lightPunchAnim, 18);
        return;
    }

    if (!oldPad.pressed(Pads.CROSS) && pad.pressed(Pads.CROSS) && isGrounded) {
        performAttack(lightKickAnim, 18);
        return;
    }

    // Jumping
    if (!oldPad.pressed(Pads.UP) && pad.pressed(Pads.UP) && isGrounded) {
        velY = jumpForce;
        isGrounded = false;
        currentAnimation = jumpAnim;
        currentAnimation.reset();
    }

    // Horizontal movement
    velX = 0;
    if (pad.pressed(Pads.LEFT)) {
        velX = -moveSpeed;
        facingLeft = true;
        if (isGrounded && !isAttacking) {
            currentAnimation = idleAnim;
        }
    } else if (pad.pressed(Pads.RIGHT)) {
        velX = moveSpeed;
        facingLeft = false;
        if (isGrounded && !isAttacking) {
            currentAnimation = idleAnim;
        }
    } else if (isGrounded && !isAttacking) {
        currentAnimation = idleAnim;
    }
}

function performAttack(anim, frames) {
    isAttacking = true;
    attackFrames = frames;
    currentAnimation = anim;
    currentAnimation.reset();
}

function performShoryuken() {
    isAttacking = true;
    attackFrames = 48;
    currentAnimation = shoryukenAnim;
    currentAnimation.reset();

    velY = jumpForce * 1.2;
    isGrounded = false;

    inputBuffer = [];
}

function applyPhysics() {
    posX += velX;
    posX = Math.max(30, Math.min(WORLD_WIDTH - 30, posX));

    if (!isGrounded) {
        velY += gravity;
        posY += velY;

        if (posY >= GROUND_Y) {
            posY = GROUND_Y;
            velY = 0;
            isGrounded = true;
            if (!isAttacking) {
                currentAnimation = idleAnim;
                currentAnimation.reset();
            }
        }
    }
}