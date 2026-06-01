// tank.js — PLAYER state + 4-direction GRID movement for the Bomberman build.
//
// Responsibilities:
//   - Hold the player's plain, serializable state (snapshot-friendly).
//   - Move on a grid at a CONSTANT speed in one of 4 cardinal directions, with
//     lane-snapping + corner-assist so a near-miss turn slides into the gap.
//   - Collide vs walls + soft blocks (via map.pointInWall / resolveCircleVsWalls)
//     and vs OTHER players' dropped bombs — but you can stand on the bomb you
//     just dropped until you step off its cell (walk-off-own-bomb).
//   - Render a single facing sprite (or a procedural rounded square + face dot).
//
// Collision is delegated to the MAP's wall-rect data (deterministic) and to the
// bomb list (via a registered provider) — never to sprites.
//
// The module's PUBLIC SURFACE is preserved so main.js/enemies.js/waves.js keep
// working: create / update / render / snapshot / registerImages / muzzle /
// TANK_CONFIG / TANK_SKINS. `muzzle` is now unused (no shooting) but exported.

import { drawHealthBar } from "./enemies.js";
import { gridMove, setBombProvider as _gmSetBombProvider } from "./gridmove.js";

// --- Tunables --------------------------------------------------------------
export const TANK_CONFIG = {
  RADIUS: 18,        // collision circle radius (world px)
  SPEED: 150,        // constant grid speed (px/s)
  CORNER_ASSIST: 16, // px window to slip around a pillar into a perpendicular lane
  SPRITE_SCALE: 2.0, // world px per source sprite px (retained for render)
};

// --- Sprite loading (lazy, best-effort; procedural fallback otherwise) -----
const _images = Object.create(null);

// Skin -> procedural-fallback color (+ legacy keys kept so registerImages and
// any external reference stay shape-stable).
export const TANK_SKINS = [
  { body: "body_green", turret: "turret_green", color: "#7aa05a", bullet: "shell_green" },
  { body: "body_red", turret: "turret_red", color: "#b0563f", bullet: "shell_red" },
  { body: "body_blue", turret: "turret_blue", color: "#4f7bb0", bullet: "shell_blue" },
  { body: "body_sand", turret: "turret_sand", color: "#c9b178", bullet: "shell_sand" },
  { body: "body_dark", turret: "turret_dark", color: "#555c66", bullet: "shell_dark" },
];

// Optional per-facing player frames ({down,up,left,right}: HTMLImageElement|
// HTMLCanvasElement) injected by main.js when the sprite sheet is sliced.
let _playerFrames = null;

export function registerPlayerFrames(frames) {
  _playerFrames = frames || null;
}

/**
 * Allow callers that already loaded sprites to inject them (avoids double
 * fetch). Map of { key: HTMLImageElement|null }.
 */
export function registerImages(imageMap) {
  if (!imageMap) return;
  for (const k of Object.keys(imageMap)) _images[k] = imageMap[k];
}

// --- Bomb provider (walk-off-own-bomb) -------------------------------------
// main.js registers a getter for the live bomb list once. A bomb's cell is
// treated as SOLID for movement only when `b.solid` is true (bombs.js flips
// this the first frame the owner's center leaves the bomb cell), so the owner
// can stand on / walk off the bomb they just dropped.
let _bombProvider = null;
export function setBombProvider(fn) {
  _bombProvider = typeof fn === "function" ? fn : null;
  _gmSetBombProvider(fn); // the shared grid mover does the actual bomb-collision
}

// --- Math helpers ----------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

const UNIT = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  none: { x: 0, y: 0 },
};
const FACE_ANGLE = {
  up: -Math.PI / 2,
  down: Math.PI / 2,
  left: Math.PI,
  right: 0,
};
const PERPENDICULAR = {
  up: "horizontal",
  down: "horizontal",
  left: "vertical",
  right: "vertical",
};

// --- State -----------------------------------------------------------------
/**
 * Create the player tank. State is plain & serializable.
 */
export function create(opts = {}) {
  return {
    id: opts.id ?? null,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    // dir: the active movement direction; facing: last non-none dir (for sprite).
    dir: "none",
    facing: opts.facing ?? "down",
    // Legacy angle fields kept present so tread/snapshot code never NaNs.
    bodyAngle: FACE_ANGLE[opts.facing ?? "down"],
    turretAngle: FACE_ANGLE[opts.facing ?? "down"],
    vx: 0,
    vy: 0,
    alive: true,
    maxHp: opts.maxHp ?? 3,
    hp: opts.hp ?? opts.maxHp ?? 3,
    skin: opts.skin ?? 0,
    bullet: (TANK_SKINS[opts.skin ?? 0] || TANK_SKINS[0]).bullet,
    isPlayer: !!opts.isPlayer,
    radius: opts.radius ?? TANK_CONFIG.RADIUS,
  };
}

// Is the cell containing world point (x,y) blocked for the player? Blocked by
// hard walls, soft blocks, border (all via map.pointInWall) OR a SOLID bomb.
function cellBlocked(x, y, map, tank) {
  if (map && typeof map.pointInWall === "function" && map.pointInWall(x, y)) {
    return true;
  }
  if (_bombProvider) {
    const cs = (map && map.cellSize) || 48;
    const col = Math.floor(x / cs);
    const row = Math.floor(y / cs);
    const bombs = _bombProvider() || [];
    for (const b of bombs) {
      if (!b || b.exploded) continue;
      if (!b.solid) continue; // own freshly-dropped bomb stays passable
      if (b.col === col && b.row === row) return true;
    }
  }
  return false;
}

/**
 * Integrate one frame of GRID movement, then resolve wall collisions.
 *
 * @param {object} tank   from create()
 * @param {object} input  { wantDir: 'up'|'down'|'left'|'right'|'none' }
 * @param {number} dt     seconds elapsed
 * @param {object} map    exposes cellSize, pointInWall, resolveCircleVsWalls
 */
export function update(tank, input, dt, map) {
  if (!tank.alive || dt <= 0) {
    tank.vx = 0;
    tank.vy = 0;
    tank.dir = "none";
    return tank;
  }

  const oldX = tank.x;
  const oldY = tank.y;

  let wantDir = (input && input.wantDir) || "none";

  // Shared grid mover (identical for player + enemies).
  const dir = gridMove(tank, wantDir, dt, map, TANK_CONFIG.SPEED);

  // Velocity (per-frame delta / dt) for tread-stamping + snapshot speed.
  tank.vx = (tank.x - oldX) / dt;
  tank.vy = (tank.y - oldY) / dt;

  // Facing + legacy angles (treads/snapshot stay shape-stable).
  if (dir !== "none") tank.facing = dir;
  tank.bodyAngle = FACE_ANGLE[tank.facing] ?? 0;
  tank.turretAngle = tank.bodyAngle;

  return tank;
}

/** World-space muzzle (unused — no shooting — but kept exported). */
export function muzzle(tank, offset = TANK_CONFIG.RADIUS + 8) {
  const a = tank.turretAngle ?? tank.bodyAngle ?? 0;
  return {
    x: tank.x + Math.cos(a) * offset,
    y: tank.y + Math.sin(a) * offset,
    angle: a,
  };
}

// --- Render ----------------------------------------------------------------
/**
 * Render the player into a world-transformed context, or into a raw context
 * with a {scale, offsetX, offsetY} (or worldToScreen) camera.
 */
export function render(ctx, cam, tank) {
  if (tank === undefined && cam && typeof cam === "object" && ("dir" in cam || "facing" in cam)) {
    tank = cam;
    cam = null;
  }
  if (!ctx || !tank) return;

  let sx = tank.x;
  let sy = tank.y;
  let scale = 1;
  if (cam) {
    if (typeof cam.worldToScreen === "function") {
      const p = cam.worldToScreen(tank.x, tank.y);
      sx = p.x;
      sy = p.y;
    } else {
      scale = cam.scale ?? 1;
      sx = tank.x * scale + (cam.offsetX ?? 0);
      sy = tank.y * scale + (cam.offsetY ?? 0);
    }
    if (cam.scale !== undefined) scale = cam.scale;
  }

  const skin = TANK_SKINS[tank.skin] || TANK_SKINS[0];
  const r = (tank.radius || TANK_CONFIG.RADIUS) * scale;
  const facing = tank.facing || "down";

  ctx.save();
  ctx.translate(sx, sy);
  if (!tank.alive) ctx.globalAlpha = 0.35;

  const frame = _playerFrames && _playerFrames[facing];
  if (frame) {
    const w = r * 2.2;
    const h = r * 2.2;
    ctx.drawImage(frame, -w / 2, -h / 2, w, h);
  } else {
    _drawPlayerProc(ctx, r, skin.color, facing);
  }

  const maxHp = tank.maxHp ?? 1;
  const hp = tank.hp ?? maxHp;
  if (tank.alive && maxHp > 1 && hp < maxHp) {
    const barW = (tank.radius || TANK_CONFIG.RADIUS) * 2.2 * scale;
    drawHealthBar(ctx, barW, -r - 10 * scale, hp, maxHp);
  }

  ctx.restore();
}

// Procedural player: a rounded square in the skin color with a face dot that
// points in the facing direction.
function _drawPlayerProc(ctx, r, color, facing) {
  const s = r * 1.8;
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = Math.max(1, r * 0.14);
  const rad = r * 0.4;
  _roundRect(ctx, -s / 2, -s / 2, s, s, rad);
  ctx.fill();
  ctx.stroke();
  // Lighter helmet band.
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  _roundRect(ctx, -s / 2, -s / 2, s, s * 0.42, rad);
  ctx.fill();
  // Face dot in the facing direction.
  const u = UNIT[facing] || UNIT.down;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.beginPath();
  ctx.arc(u.x * r * 0.5, u.y * r * 0.5, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

function _roundRect(ctx, x, y, w, h, rad) {
  const rr = Math.min(rad, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Plain serializable snapshot of the player. */
export function snapshot(tank) {
  return {
    x: tank.x,
    y: tank.y,
    vx: tank.vx,
    vy: tank.vy,
    speed: Math.hypot(tank.vx, tank.vy),
    dir: tank.dir,
    facing: tank.facing,
    bodyAngle: tank.bodyAngle,
    turretAngle: tank.turretAngle,
    alive: tank.alive,
    hp: tank.hp,
    maxHp: tank.maxHp,
  };
}
