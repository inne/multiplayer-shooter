// map.js — data-driven arena map for the top-down tank game (WF1).
//
// Loads a baked JSON map (assets/maps/arena1.json) and exposes:
//   - wall rectangles in WORLD units (AABBs: {x, y, w, h})
//   - spawn points (world pixel coords)
//   - arena bounds (width/height in world units)
//   - collision helpers:
//       pointInWall(x, y)              -> boolean
//       resolveCircleVsWalls(x, y, r)  -> {x, y} (axis-separated slide)
//       reflectShell(shell)            -> mutates shell, flips velocity on hit axis
//   - render(ctx, cam) — draws floor tiles + walls (sprites if present, else rects)
//
// Everything here is DETERMINISTIC and computed against the wall-rect DATA,
// never against sprites — this keeps physics reproducible for the future
// host-authoritative netcode (WF2+). State is plain serializable fields so
// snapshots stay trivial.

// ---------------------------------------------------------------------------
// Asset loading (best-effort: missing sprites fall back to procedural rects).
// CC0 assets only (Kenney Top-down Tanks Redux).
// ---------------------------------------------------------------------------

const ASSET_BASE = "../assets";

// key -> relative url (resolved against this module's URL so it works from /js/)
const SPRITE_PATHS = {
  floor: `${ASSET_BASE}/tiles/floor_sand.png`,
  wall: `${ASSET_BASE}/tiles/wall_sandbag.png`,
};

// Loaded HTMLImageElements keyed by SPRITE_PATHS keys; null if load failed.
const sprites = {
  floor: null,
  wall: null,
};

function loadSprite(key, url) {
  return new Promise((resolve) => {
    // Guard for non-browser (node --check / unit) environments.
    if (typeof Image === "undefined") {
      sprites[key] = null;
      resolve({ key, ok: false });
      return;
    }
    const img = new Image();
    img.onload = () => {
      sprites[key] = img;
      resolve({ key, ok: true });
    };
    img.onerror = () => {
      sprites[key] = null;
      resolve({ key, ok: false });
    };
    img.src = new URL(url, import.meta.url).href;
  });
}

// ---------------------------------------------------------------------------
// GameMap — holds normalized wall AABBs, spawns and bounds, plus physics.
// ---------------------------------------------------------------------------

export class GameMap {
  constructor(data) {
    this.name = data.name || "untitled";
    this.cols = data.cols;
    this.rows = data.rows;
    this.cellSize = data.cellSize;

    // Arena bounds in world units.
    this.width = this.cols * this.cellSize;
    this.height = this.rows * this.cellSize;
    // Bounds object kept as a plain field for convenience / snapshots.
    this.bounds = { x: 0, y: 0, w: this.width, h: this.height };

    // Spawn points (world pixel centers). Plain {x, y} copies.
    this.spawns = (data.spawns || []).map((s) => ({ x: s.x, y: s.y }));

    // Wall rectangles in WORLD units: {x, y, w, h}.
    // Accepts either [col, row] cells, [col, row, wCells, hCells] rects,
    // or {col,row,w?,h?} objects. Adjacent single cells are merged into
    // larger rects (row-runs) so collision/reflection has fewer, cleaner
    // edges — purely an optimization; results are identical.
    this.walls = mergeCells(normalizeWalls(data.walls || [], this.cellSize));
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  // Fetch + parse the JSON map, then kick off (best-effort) sprite loading.
  static async load(url = `${ASSET_BASE}/maps/arena1.json`) {
    const res = await fetch(new URL(url, import.meta.url));
    if (!res.ok) {
      throw new Error(`map: failed to load ${url} (${res.status})`);
    }
    const data = await res.json();
    const map = new GameMap(data);
    await GameMap.loadSprites();
    return map;
  }

  // Loads floor/wall sprites. Safe to call repeatedly; failures are non-fatal.
  static async loadSprites() {
    const results = await Promise.all(
      Object.entries(SPRITE_PATHS).map(([k, u]) => loadSprite(k, u))
    );
    const missing = results.filter((r) => !r.ok).map((r) => r.key);
    if (missing.length && typeof console !== "undefined") {
      console.warn("[map] sprites missing (procedural fallback):", missing);
    }
    return sprites;
  }

  // -------------------------------------------------------------------------
  // Collision helpers (deterministic, operate on wall-rect data only)
  // -------------------------------------------------------------------------

  // True if a point lies inside any wall rect (or outside arena bounds).
  pointInWall(x, y) {
    if (x < 0 || y < 0 || x > this.width || y > this.height) return true;
    for (const w of this.walls) {
      if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) {
        return true;
      }
    }
    return false;
  }

  // Resolve a circle (cx, cy, r) against all wall AABBs with axis-separated
  // sliding, then clamp to arena bounds. Returns a corrected {x, y}. Pure
  // function of its inputs — does not mutate map state.
  resolveCircleVsWalls(cx, cy, r) {
    let px = cx;
    let py = cy;

    for (const w of this.walls) {
      const closestX = clamp(px, w.x, w.x + w.w);
      const closestY = clamp(py, w.y, w.y + w.h);
      const dx = px - closestX;
      const dy = py - closestY;
      const distSq = dx * dx + dy * dy;

      if (distSq < r * r) {
        if (distSq > 1e-9) {
          // Push out along the shortest separation axis (smooth sliding).
          const dist = Math.sqrt(distSq);
          const overlap = r - dist;
          px += (dx / dist) * overlap;
          py += (dy / dist) * overlap;
        } else {
          // Center is inside the rect: eject along the nearest edge.
          const left = px - w.x;
          const right = w.x + w.w - px;
          const top = py - w.y;
          const bottom = w.y + w.h - py;
          const m = Math.min(left, right, top, bottom);
          if (m === left) px = w.x - r;
          else if (m === right) px = w.x + w.w + r;
          else if (m === top) py = w.y - r;
          else py = w.y + w.h + r;
        }
      }
    }

    // Keep the circle inside the arena bounds.
    px = clamp(px, r, this.width - r);
    py = clamp(py, r, this.height - r);
    return { x: px, y: py };
  }

  // Reflect a shell off walls and arena bounds: flips the velocity component
  // on the hit axis and nudges the shell out of the surface. Mutates the
  // shell in place and returns true if a bounce happened.
  //
  // shell: { x, y, vx, vy, bounces, ... }
  reflectShell(shell) {
    const r = shell.r != null ? shell.r : SHELL_RADIUS;
    let bounced = false;

    // Walls (the arena border cells are walls too, so this covers bounds).
    // For each overlapping rect, flip the velocity on the axis with the
    // SMALLEST penetration (the face actually struck). Velocity is flipped
    // only when the shell is moving INTO that face, which prevents a second
    // overlapping rect from undoing the first flip in the same frame.
    for (const w of this.walls) {
      const closestX = clamp(shell.x, w.x, w.x + w.w);
      const closestY = clamp(shell.y, w.y, w.y + w.h);
      const dx = shell.x - closestX;
      const dy = shell.y - closestY;
      const distSq = dx * dx + dy * dy;
      if (distSq >= r * r) continue;

      // Per-axis penetration depth. Infinity means the shell's center is
      // within the rect's span on that axis (not the struck face).
      const penX =
        shell.x < w.x ? r - (w.x - shell.x)
        : shell.x > w.x + w.w ? r - (shell.x - (w.x + w.w))
        : Infinity;
      const penY =
        shell.y < w.y ? r - (w.y - shell.y)
        : shell.y > w.y + w.h ? r - (shell.y - (w.y + w.h))
        : Infinity;

      // hitX / hitY: is the shell moving toward this face?
      const fromLeft = shell.x < w.x; // shell left of rect -> left face
      const fromTop = shell.y < w.y;

      if (penX === Infinity && penY === Infinity) {
        // Center is tunneled inside the rect. Eject back the way the shell
        // came (opposite its velocity) on its dominant axis of travel, so a
        // fast shell never gets pushed deeper / out the far side.
        const ax = Math.abs(shell.vx);
        const ay = Math.abs(shell.vy);
        if (ax >= ay && ax > 0) {
          // Travelling mostly horizontally -> eject on X, flip vx.
          shell.x = shell.vx > 0 ? w.x - r : w.x + w.w + r;
          shell.vx = -shell.vx;
        } else if (ay > 0) {
          // Travelling mostly vertically -> eject on Y, flip vy.
          shell.y = shell.vy > 0 ? w.y - r : w.y + w.h + r;
          shell.vy = -shell.vy;
        } else {
          // No velocity: fall back to the shallowest face (no flip needed).
          const left = shell.x - w.x;
          const right = w.x + w.w - shell.x;
          const top = shell.y - w.y;
          const bottom = w.y + w.h - shell.y;
          const mm = Math.min(left, right, top, bottom);
          if (mm === left) shell.x = w.x - r;
          else if (mm === right) shell.x = w.x + w.w + r;
          else if (mm === top) shell.y = w.y - r;
          else shell.y = w.y + w.h + r;
        }
        bounced = true;
        continue;
      }

      // Choose the struck axis = smaller penetration. (Corner: penX==penY.)
      if (penX <= penY) {
        shell.x = fromLeft ? w.x - r : w.x + w.w + r;
        if ((fromLeft && shell.vx > 0) || (!fromLeft && shell.vx < 0)) {
          shell.vx = -shell.vx;
        }
        bounced = true;
      }
      if (penY <= penX) {
        shell.y = fromTop ? w.y - r : w.y + w.h + r;
        if ((fromTop && shell.vy > 0) || (!fromTop && shell.vy < 0)) {
          shell.vy = -shell.vy;
        }
        bounced = true;
      }
    }

    // Safety net: keep the shell inside the arena (reposition only, never an
    // extra flip — the border walls above already handled the reflection).
    if (shell.x < r) shell.x = r;
    else if (shell.x > this.width - r) shell.x = this.width - r;
    if (shell.y < r) shell.y = r;
    else if (shell.y > this.height - r) shell.y = this.height - r;

    if (bounced && typeof shell.bounces === "number") shell.bounces += 1;
    return bounced;
  }

  // -------------------------------------------------------------------------
  // Rendering: floor tiles + walls. Draws in WORLD units; the camera maps
  // world -> screen via a single uniform scale + offset (full-arena view).
  //
  // cam: { scale, offsetX, offsetY }  (offsets default to 0)
  // -------------------------------------------------------------------------
  render(ctx, cam) {
    const scale = (cam && cam.scale) || 1;
    const ox = (cam && cam.offsetX) || 0;
    const oy = (cam && cam.offsetY) || 0;

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    this._drawFloor(ctx);
    this._drawWalls(ctx);

    ctx.restore();
  }

  _drawFloor(ctx) {
    const cs = this.cellSize;
    const floor = sprites.floor;
    if (floor) {
      for (let y = 0; y < this.height; y += cs) {
        for (let x = 0; x < this.width; x += cs) {
          ctx.drawImage(floor, x, y, cs, cs);
        }
      }
    } else {
      ctx.fillStyle = "#caa86a";
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  _drawWalls(ctx) {
    const wall = sprites.wall;
    const cs = this.cellSize;
    for (const w of this.walls) {
      if (wall) {
        // Tile the wall sprite across the (possibly merged) rect.
        for (let y = w.y; y < w.y + w.h; y += cs) {
          for (let x = w.x; x < w.x + w.w; x += cs) {
            ctx.drawImage(wall, x, y, cs, cs);
          }
        }
      } else {
        ctx.fillStyle = "#6b5536";
        ctx.fillRect(w.x, w.y, w.w, w.h);
        ctx.strokeStyle = "#4a3a24";
        ctx.lineWidth = 2;
        ctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

// Default shell radius used by reflectShell when shell.r is absent.
export const SHELL_RADIUS = 4;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Convert raw "walls" entries into world-unit AABBs {x, y, w, h}.
function normalizeWalls(raw, cellSize) {
  const rects = [];
  for (const w of raw) {
    let c, r, wc, hc;
    if (Array.isArray(w)) {
      [c, r, wc = 1, hc = 1] = w;
    } else if (w && typeof w === "object") {
      c = w.col ?? w.c ?? 0;
      r = w.row ?? w.r ?? 0;
      wc = w.w ?? 1;
      hc = w.h ?? 1;
    } else {
      continue;
    }
    rects.push({
      x: c * cellSize,
      y: r * cellSize,
      w: wc * cellSize,
      h: hc * cellSize,
    });
  }
  return rects;
}

// Merge unit cells that sit on the same row into horizontal runs, reducing
// the wall count for cheaper, cleaner collision. Deterministic; produces the
// same coverage as the input. Only merges 1x1 cells (leaves explicit rects).
function mergeCells(rects) {
  const units = [];
  const others = [];
  for (const w of rects) {
    if (w.w > 0 && w.h > 0 && Number.isFinite(w.x) && Number.isFinite(w.y)) {
      units.push(w);
    } else {
      others.push(w);
    }
  }

  // Group by (y, h) and sort by x so adjacent cells become contiguous.
  units.sort((a, b) => a.y - b.y || a.h - b.h || a.x - b.x);

  const merged = [];
  let cur = null;
  for (const w of units) {
    if (
      cur &&
      cur.y === w.y &&
      cur.h === w.h &&
      Math.abs(cur.x + cur.w - w.x) < 1e-6
    ) {
      cur.w += w.w; // extend the current run
    } else {
      cur = { x: w.x, y: w.y, w: w.w, h: w.h };
      merged.push(cur);
    }
  }

  return merged.concat(others);
}

export default GameMap;
