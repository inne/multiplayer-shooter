// tank.js — Tank state + physics for the top-down 2D tank game (WF1 core).
//
// Responsibilities:
//   - Hold the tank's plain, serializable state (snapshot-friendly for a
//     future host-authoritative netcode workflow — NO networking here).
//   - Drive (W/S) with momentum + exponential friction.
//   - Rotate the BODY (A/D); the TURRET aims at a world point (the mouse).
//   - Per-frame integrate, then collide vs walls via map.resolveCircleVsWalls.
//   - Render: body sprite rotated by bodyAngle + turret sprite rotated by
//     turretAngle, with a procedural-rect fallback when a sprite is missing.
//
// Collision is delegated to the MAP's wall-rect data (deterministic), never to
// sprites — keep it that way for reproducible simulation.

import { drawHealthBar } from "./enemies.js";

// --- Tunables --------------------------------------------------------------
// Slow, momentum-y handling that reads well on a fixed full-arena camera.
export const TANK_CONFIG = {
  RADIUS: 18, // collision circle radius (world px) — matches the ~38px body so
              // shells reliably hit and the tank doesn't clip into walls.
  DRIVE_ACCEL: 430, // forward/back acceleration (px/s^2) — gentle ramp-up
  MAX_SPEED: 360, // speed clamp (px/s) — high top speed so there's momentum to slide
  // Skid handling: low FORWARD friction (momentum carries through turns) + a
  // higher LATERAL grip that bleeds sideways velocity so the tank drifts when you
  // whip it around, then catches. Lower LATERAL_GRIP = looser/icier skids.
  FRICTION: 1.25, // forward (rolling) damping per second — lower = higher real top
                  // speed (terminal ~ DRIVE_ACCEL/FRICTION) and more coasting/slide
  LATERAL_GRIP: 5.0, // sideways damping per second (drift recovery)
  HANDBRAKE_GRIP: 0.3, // lateral damping while handbraking (~free slide)
  HANDBRAKE_FRICTION: 2.8, // forward damping while handbraking (scrub speed)
  BODY_TURN: 3.4, // body rotation rate (rad/s)
  TURRET_TURN: 8.0, // turret slew rate toward aim (rad/s); Infinity = instant
  SPRITE_SCALE: 2.0, // world px per source sprite px (Kenney art ~ 38px wide)
};

// --- Sprite loading (lazy, best-effort; procedural fallback otherwise) -----
// Keyed image cache. A value of `null` means "tried and failed" -> fall back.
const _images = Object.create(null);

// Skin -> sprite keys + a procedural-fallback color.
export const TANK_SKINS = [
  { body: "body_green", turret: "turret_green", color: "#7aa05a", bullet: "shell_green" },
  { body: "body_red", turret: "turret_red", color: "#b0563f", bullet: "shell_red" },
  { body: "body_blue", turret: "turret_blue", color: "#4f7bb0", bullet: "shell_blue" },
  { body: "body_sand", turret: "turret_sand", color: "#c9b178", bullet: "shell_sand" },
  { body: "body_dark", turret: "turret_dark", color: "#555c66", bullet: "shell_dark" },
];

function _spriteUrl(key) {
  // assets live at <root>/assets/tanks/<key>.png; this module is at <root>/js/.
  return new URL(`../assets/tanks/${key}.png`, import.meta.url).href;
}

// Kick off a load if we haven't seen this key. Returns the <img> when ready,
// `null` once a load has failed, or `undefined` while still loading.
function _getImage(key) {
  if (!key) return null;
  if (key in _images) return _images[key];
  _images[key] = undefined; // pending
  if (typeof Image === "undefined") {
    // Non-DOM environment (e.g. node --check / headless sim): no sprites.
    _images[key] = null;
    return null;
  }
  const img = new Image();
  img.onload = () => {
    _images[key] = img;
  };
  img.onerror = () => {
    _images[key] = null;
  };
  img.src = _spriteUrl(key);
  return undefined;
}

/**
 * Allow callers that already loaded sprites (e.g. a shared asset module) to
 * inject them so we don't double-fetch. Map of { key: HTMLImageElement|null }.
 */
export function registerImages(imageMap) {
  if (!imageMap) return;
  for (const k of Object.keys(imageMap)) _images[k] = imageMap[k];
}

// --- Math helpers ----------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Shortest signed angular difference from `a` to `b`, in (-PI, PI].
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// --- State -----------------------------------------------------------------
/**
 * Create a tank. State is plain & serializable (snapshot-friendly).
 *
 * @param {object} opts
 * @param {number} opts.x            world x (px)
 * @param {number} opts.y            world y (px)
 * @param {number} [opts.bodyAngle]  initial body heading (rad, 0 = +X)
 * @param {number} [opts.turretAngle]initial turret heading (rad)
 * @param {string|number} [opts.id]  identity (for snapshots / netcode)
 * @param {number} [opts.skin]       index into TANK_SKINS
 * @param {boolean} [opts.isPlayer]
 */
export function create(opts = {}) {
  const a = opts.bodyAngle ?? 0;
  return {
    id: opts.id ?? null,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    bodyAngle: a, // radians, 0 = facing +X
    turretAngle: opts.turretAngle ?? a,
    vx: 0,
    vy: 0,
    alive: true,
    // --- combat ---
    maxHp: opts.maxHp ?? 3, // hits to destroy (shells deal 1)
    hp: opts.hp ?? opts.maxHp ?? 3,
    // --- presentation / control (kept plain & serializable) ---
    skin: opts.skin ?? 0,
    // Per-color bullet sprite key matching this tank's skin (shells.js renders it).
    bullet: (TANK_SKINS[opts.skin ?? 0] || TANK_SKINS[0]).bullet,
    isPlayer: !!opts.isPlayer,
    radius: opts.radius ?? TANK_CONFIG.RADIUS,
  };
}

/**
 * Integrate one frame of tank physics, then resolve wall collisions.
 *
 * @param {object} tank   a tank from create()
 * @param {object} input  { drive: -1|0|1, turn: -1|0|1, aimX, aimY }
 *    - drive:  +1 forward (W), -1 back (S), 0 idle
 *    - turn:   -1 left (A), +1 right (D), 0 none  (rotates the BODY)
 *    - aimX/aimY: world point the TURRET tracks (the mouse). Optional.
 * @param {number} dt     seconds elapsed
 * @param {object} map    must expose resolveCircleVsWalls(x, y, radius) ->
 *                        {x, y}  (the slide-resolved position). Optional.
 */
export function update(tank, input, dt, map) {
  if (!tank.alive || dt <= 0) {
    // Dead tanks don't move; still keep velocity zeroed so snapshots are clean.
    tank.vx = 0;
    tank.vy = 0;
    return tank;
  }
  const C = TANK_CONFIG;
  const drive = input ? input.drive | 0 : 0;
  const turn = input ? input.turn | 0 : 0;

  // 1) Rotate the body (A/D).
  if (turn) {
    tank.bodyAngle += turn * C.BODY_TURN * dt;
    // Keep angle bounded for tidy snapshots.
    if (tank.bodyAngle > Math.PI) tank.bodyAngle -= Math.PI * 2;
    else if (tank.bodyAngle < -Math.PI) tank.bodyAngle += Math.PI * 2;
  }

  // 2) Apply forward/back thrust along the body heading (momentum).
  if (drive) {
    const ax = Math.cos(tank.bodyAngle) * C.DRIVE_ACCEL * drive;
    const ay = Math.sin(tank.bodyAngle) * C.DRIVE_ACCEL * drive;
    tank.vx += ax * dt;
    tank.vy += ay * dt;
  }

  // 3) Skid model: decompose velocity into FORWARD (along the body heading) and
  // LATERAL (sideways) parts and damp them differently. Low forward friction =
  // momentum carries; higher lateral grip = the sideways slide bleeds off, so a
  // sharp turn at speed makes the tank DRIFT and then recover.
  const hx = Math.cos(tank.bodyAngle);
  const hy = Math.sin(tank.bodyAngle);
  const fwd = tank.vx * hx + tank.vy * hy;          // forward speed (signed)
  const latx = tank.vx - fwd * hx;                  // lateral velocity vector
  const laty = tank.vy - fwd * hy;
  // HANDBRAKE (hold Space): kill lateral grip so the tank breaks loose and
  // slides — whip the body around mid-slide for big drifts — and lightly brake
  // forward so you can scrub speed into a corner. Release to regain grip.
  const handbrake = !!(input && input.handbrake);
  const lateralGrip = handbrake ? C.HANDBRAKE_GRIP : C.LATERAL_GRIP;
  const forwardFric = handbrake ? C.HANDBRAKE_FRICTION : C.FRICTION;
  const fwdDamp = Math.exp(-forwardFric * dt);
  const latDamp = Math.exp(-lateralGrip * dt);
  const fwd2 = fwd * fwdDamp;
  tank.vx = hx * fwd2 + latx * latDamp;
  tank.vy = hy * fwd2 + laty * latDamp;

  // 4) Clamp to max speed.
  const speedSq = tank.vx * tank.vx + tank.vy * tank.vy;
  const maxSq = C.MAX_SPEED * C.MAX_SPEED;
  if (speedSq > maxSq) {
    const s = C.MAX_SPEED / Math.sqrt(speedSq);
    tank.vx *= s;
    tank.vy *= s;
  } else if (speedSq < 0.5) {
    // Snap to rest to avoid endless tiny drift in snapshots.
    tank.vx = 0;
    tank.vy = 0;
  }

  // 5) Integrate position.
  tank.x += tank.vx * dt;
  tank.y += tank.vy * dt;

  // 6) Resolve against walls (circle vs AABB slide) on the wall-rect DATA.
  if (map && typeof map.resolveCircleVsWalls === "function") {
    const r = map.resolveCircleVsWalls(tank.x, tank.y, tank.radius);
    if (r) {
      tank.x = r.x;
      tank.y = r.y;
    }
  }

  // 7) Turret aims at the world point (mouse). Slew toward it (or snap).
  if (input && Number.isFinite(input.aimX) && Number.isFinite(input.aimY)) {
    const target = Math.atan2(input.aimY - tank.y, input.aimX - tank.x);
    if (!Number.isFinite(C.TURRET_TURN) || C.TURRET_TURN === Infinity) {
      tank.turretAngle = target;
    } else {
      const d = angleDelta(tank.turretAngle, target);
      const step = C.TURRET_TURN * dt;
      tank.turretAngle += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
    // Normalize into (-PI, PI] for clean snapshots.
    if (tank.turretAngle > Math.PI) tank.turretAngle -= Math.PI * 2;
    else if (tank.turretAngle < -Math.PI) tank.turretAngle += Math.PI * 2;
  }

  return tank;
}

/** World-space muzzle position + heading, for spawning shells. */
export function muzzle(tank, offset = TANK_CONFIG.RADIUS + 8) {
  return {
    x: tank.x + Math.cos(tank.turretAngle) * offset,
    y: tank.y + Math.sin(tank.turretAngle) * offset,
    angle: tank.turretAngle,
  };
}

// --- Render ----------------------------------------------------------------
// Sprites point "up" (-Y) in the source art; our angle 0 means +X, so we add
// a quarter turn when drawing rotated sprites.
const SPRITE_FACING_OFFSET = Math.PI / 2;

/**
 * Render the tank into a world-transformed context, OR into a raw canvas
 * context using a camera that maps world->screen.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} [cam]  Optional camera. If provided and it exposes a
 *                        worldToScreen(x,y)->{x,y} plus a `scale`, the tank is
 *                        drawn in screen space. If omitted, ctx is assumed to
 *                        already be in world space (scale 1).
 */
export function render(ctx, cam, tank) {
  // Allow flexible arg order: render(ctx, tank) when no camera is used.
  if (tank === undefined && cam && typeof cam === "object" && "bodyAngle" in cam) {
    tank = cam;
    cam = null;
  }
  if (!ctx || !tank) return;

  // Resolve screen position + uniform scale from the camera (if any).
  let sx = tank.x;
  let sy = tank.y;
  let scale = 1;
  if (cam) {
    if (typeof cam.worldToScreen === "function") {
      const p = cam.worldToScreen(tank.x, tank.y);
      sx = p.x;
      sy = p.y;
    } else {
      // {scale, offsetX, offsetY} style camera.
      scale = cam.scale ?? 1;
      sx = tank.x * scale + (cam.offsetX ?? 0);
      sy = tank.y * scale + (cam.offsetY ?? 0);
    }
    if (cam.scale !== undefined) scale = cam.scale;
  }

  const skin = TANK_SKINS[tank.skin] || TANK_SKINS[0];
  const r = (tank.radius || TANK_CONFIG.RADIUS) * scale;

  ctx.save();
  ctx.translate(sx, sy);

  if (!tank.alive) ctx.globalAlpha = 0.35;

  // --- Body ---------------------------------------------------------------
  const bodyImg = _getImage(skin.body);
  ctx.save();
  ctx.rotate(tank.bodyAngle + SPRITE_FACING_OFFSET);
  if (bodyImg) {
    const w = bodyImg.width * TANK_CONFIG.SPRITE_SCALE * scale;
    const h = bodyImg.height * TANK_CONFIG.SPRITE_SCALE * scale;
    ctx.drawImage(bodyImg, -w / 2, -h / 2, w, h);
  } else {
    _drawBodyRect(ctx, r, skin.color);
  }
  ctx.restore();

  // --- Turret -------------------------------------------------------------
  const turretImg = _getImage(skin.turret);
  ctx.save();
  ctx.rotate(tank.turretAngle + SPRITE_FACING_OFFSET);
  if (turretImg) {
    const w = turretImg.width * TANK_CONFIG.SPRITE_SCALE * scale;
    const h = turretImg.height * TANK_CONFIG.SPRITE_SCALE * scale;
    // Turret sprite pivots near its base; nudge so the barrel extends outward.
    ctx.drawImage(turretImg, -w / 2, -h / 2, w, h);
  } else {
    _drawTurretRect(ctx, r, skin.color);
  }
  ctx.restore();

  // Health bar above the tank when damaged (hp < maxHp). Drawn in screen px:
  // ctx is translated to the tank center with a `scale`-sized radius, so size
  // the bar in the same screen units (matches the enemy bars' on-screen look).
  const maxHp = tank.maxHp ?? 1;
  const hp = tank.hp ?? maxHp;
  if (tank.alive && maxHp > 1 && hp < maxHp) {
    const barW = (tank.radius || TANK_CONFIG.RADIUS) * 2.2 * scale;
    drawHealthBar(ctx, barW, -r - 10 * scale, hp, maxHp);
  }

  ctx.restore();
}

// Procedural fallback: a chunky rounded chassis with tread bands.
function _drawBodyRect(ctx, r, color) {
  const w = r * 2;
  const h = r * 1.9;
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fill();
  ctx.stroke();
  // Tread bands (darker) on each side.
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  const band = r * 0.35;
  ctx.fillRect(-w / 2, -h / 2, band, h);
  ctx.fillRect(w / 2 - band, -h / 2, band, h);
}

// Procedural fallback: a small hub + a barrel pointing along +sprite-up.
function _drawTurretRect(ctx, r, color) {
  // Barrel points toward -Y in sprite space (matches SPRITE_FACING_OFFSET).
  const barrelW = r * 0.34;
  const barrelLen = r * 1.5;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(-barrelW / 2, -barrelLen, barrelW, barrelLen);
  // Hub.
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Plain serializable snapshot of a single tank (for the debug harness). */
export function snapshot(tank) {
  return {
    x: tank.x,
    y: tank.y,
    vx: tank.vx,
    vy: tank.vy,
    speed: Math.hypot(tank.vx, tank.vy),
    bodyAngle: tank.bodyAngle,
    turretAngle: tank.turretAngle,
    alive: tank.alive,
    hp: tank.hp,
    maxHp: tank.maxHp,
  };
}
