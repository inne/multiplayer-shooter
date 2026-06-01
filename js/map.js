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
// Bomberman look: green floor + stone-ish hard walls/pillars + wooden crates
// for the destructible soft blocks. All are full 48px tiles (no slicing).
const SPRITE_PATHS = {
  floor: `${ASSET_BASE}/tiles/floor_grass.png`,
  wall: `${ASSET_BASE}/tiles/wall_metal.png`,
  crate: `${ASSET_BASE}/tiles/wall_crate.png`, // destructible soft-block cover
};

// Loaded HTMLImageElements keyed by SPRITE_PATHS keys; null if load failed.
const sprites = {
  floor: null,
  wall: null,
  crate: null,
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
    // Generator seed (when built via mazegen.generateMap) — preserved so the
    // HUD/harness can report it and a fixed board can be reproduced.
    this.seed = data.seed ?? null;
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

    // Destructible "soft" cover blocks (crates). Per-cell and NOT merged — each
    // is destroyed independently by a bomb blast. data.soft is a list of [col,row]
    // cells (or {col,row}). They block movement + shells like walls UNTIL cleared.
    this.softBlocks = buildSoftBlocks(data.soft || [], this.cellSize);

    // VOID cells (out-of-play area, e.g. the '.' tiles in the Bomberman maps):
    // SOLID/impassable but NOT drawn — the dark page background shows through, so
    // non-rectangular level shapes read cleanly instead of as a slab of wall.
    this.voidCells = new Set();
    this.voidRects = [];
    for (const v of data.voids || []) {
      const c = Array.isArray(v) ? v[0] : v.col;
      const r = Array.isArray(v) ? v[1] : v.row;
      this.voidCells.add(c + "," + r);
      this.voidRects.push({ x: c * this.cellSize, y: r * this.cellSize, w: this.cellSize, h: this.cellSize });
    }
    // Enemy spawn cells parsed from a level (informational; the wave manager uses
    // map.spawns for positions). Kept for future "exact level enemies".
    this.enemyCells = data.enemyCells || [];

    // Combined SOLID list (hard walls + void cells + currently-alive soft blocks)
    // that every collision/reflection query runs against. Rebuilt whenever a soft
    // block is destroyed or reset, so the hot per-frame queries iterate one array.
    this._rebuildSolids();
  }

  // Recompute the combined solids array (hard walls + voids + alive soft blocks).
  _rebuildSolids() {
    const solids = this.walls.slice();
    for (const v of this.voidRects || []) solids.push(v);
    for (const b of this.softBlocks) if (b.alive) solids.push(b);
    this.solids = solids;
  }

  // Return the alive soft block whose cell contains (x, y), or null.
  softBlockAt(x, y) {
    for (const b of this.softBlocks) {
      if (b.alive && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        return b;
      }
    }
    return null;
  }

  // Destroy a soft block (mark cleared + rebuild solids). Returns true if it was
  // alive. The blast that destroys it lights that cell (handled in bombs.js).
  destroySoftBlock(b) {
    if (!b || !b.alive) return false;
    b.alive = false;
    this._rebuildSolids();
    return true;
  }

  // Restore all soft blocks (used on player restart / new run).
  resetSoftBlocks() {
    let changed = false;
    for (const b of this.softBlocks) if (!b.alive) { b.alive = true; changed = true; }
    if (changed) this._rebuildSolids();
    return changed;
  }

  // Count of soft blocks still standing (harness / HUD convenience).
  softAlive() {
    let n = 0;
    for (const b of this.softBlocks) if (b.alive) n++;
    return n;
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

  // Fetch + parse a timnicolas/bomberman-assets level (2-layer char grid +
  // objects legend) and build a GameMap from it. opts.cellSize / opts.rng.
  static async loadLevel(url, opts = {}) {
    const res = await fetch(new URL(url, import.meta.url));
    if (!res.ok) throw new Error(`map: failed to load ${url} (${res.status})`);
    const raw = await res.json();
    const map = new GameMap(bombermanToMapData(raw, opts));
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
    for (const w of this.solids) {
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

    for (const w of this.solids) {
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
    for (const w of this.solids) {
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
    this._drawSoftBlocks(ctx);

    ctx.restore();
  }

  // Destructible crate cover (only the still-standing ones). Drawn after the
  // hard walls so it reads as a distinct, clearly breakable layer.
  _drawSoftBlocks(ctx) {
    const cs = this.cellSize;
    const crate = sprites.crate;
    for (const b of this.softBlocks) {
      if (!b.alive) continue;
      if (crate) {
        ctx.drawImage(crate, b.x, b.y, cs, cs);
      } else {
        // Procedural crate: wooden box with a plank cross + lighter border.
        ctx.fillStyle = "#b9802f";
        ctx.fillRect(b.x + 2, b.y + 2, cs - 4, cs - 4);
        ctx.strokeStyle = "#7a5012";
        ctx.lineWidth = 3;
        ctx.strokeRect(b.x + 3, b.y + 3, cs - 6, cs - 6);
        ctx.beginPath();
        ctx.moveTo(b.x + 3, b.y + 3); ctx.lineTo(b.x + cs - 3, b.y + cs - 3);
        ctx.moveTo(b.x + cs - 3, b.y + 3); ctx.lineTo(b.x + 3, b.y + cs - 3);
        ctx.stroke();
      }
    }
  }

  _drawFloor(ctx) {
    const cs = this.cellSize;
    const floor = sprites.floor;
    const voids = this.voidCells && this.voidCells.size > 0 ? this.voidCells : null;
    if (floor) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (voids && voids.has(c + "," + r)) continue; // leave void dark
          ctx.drawImage(floor, c * cs, r * cs, cs, cs);
        }
      }
    } else {
      ctx.fillStyle = "#caa86a";
      ctx.fillRect(0, 0, this.width, this.height);
      if (voids) {
        ctx.fillStyle = "#0c0e11";
        for (let r = 0; r < this.rows; r++)
          for (let c = 0; c < this.cols; c++)
            if (voids.has(c + "," + r)) ctx.fillRect(c * cs, r * cs, cs, cs);
      }
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

// Build per-cell destructible soft blocks from raw [col,row] / {col,row} cells.
// One AABB per cell (never merged — each is destroyed independently), tagged
// with its grid coords and an `alive` flag.
function buildSoftBlocks(raw, cellSize) {
  const blocks = [];
  for (const s of raw) {
    let c, r;
    if (Array.isArray(s)) {
      [c, r] = s;
    } else if (s && typeof s === "object") {
      c = s.col ?? s.c ?? 0;
      r = s.row ?? s.r ?? 0;
    } else {
      continue;
    }
    blocks.push({
      col: c,
      row: r,
      x: c * cellSize,
      y: r * cellSize,
      w: cellSize,
      h: cellSize,
      alive: true,
    });
  }
  return blocks;
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

// ---------------------------------------------------------------------------
// Bomberman-level importer
// ---------------------------------------------------------------------------
// Convert a timnicolas/bomberman-assets map into our GameMap `data` shape.
// The source has an `objects` legend mapping meanings -> single chars, and a
// `map` array of rows, each { "0": <layer0 string>, "1": <layer1 string> }:
//   layer 0 = the AUTHORED layout (walls, player, enemies, fixed crispy blocks,
//             safe zones, and '.' void outside the play area)
//   layer 1 = a template marking where destructible BLOCKS may randomly generate
//             (at `wallGenPercent`), on otherwise-empty cells.
// We map enemy markers to our existing archetypes and emit spawn points (player
// first, then enemy cells, padded with the open cells farthest from the player so
// the wave manager never spawns on top of the player on sparse maps).
export function bombermanToMapData(raw, opts = {}) {
  const cs = opts.cellSize || 48;
  const cols = raw.width;
  const rows = raw.height;
  const L = raw.objects || {};
  const WALL = L.wall || "w", OUT = L.outside || ".", CRISPY = L.crispy || "c",
        BLOCK = L.block || "b", PLAYER = L.player || "p", EMPTY = L.empty || " ";
  const enemyKinds = {
    [L.enemyBasic]: "beige", [L.enemyWithEye]: "green", [L.enemyFollow]: "pink",
    [L.enemyFly]: "green", [L.enemyCrispy]: "yellow", [L.enemyFrog]: "xbill",
  };
  const gen = (raw.wallGenPercent || 0) / 100;
  const rng = opts.rng || Math.random;

  const walls = [], soft = [], voids = [], enemyCells = [], openCells = [];
  let player = null;
  for (let r = 0; r < rows; r++) {
    const row = (raw.map && raw.map[r]) || {};
    const l0 = row["0"] || "", l1 = row["1"] || "";
    for (let c = 0; c < cols; c++) {
      const ch0 = l0[c] != null ? l0[c] : OUT;
      const ch1 = l1[c];
      if (ch0 === WALL) { walls.push([c, r]); continue; }
      if (ch0 === OUT) { voids.push([c, r]); continue; }
      if (ch0 === CRISPY || ch0 === BLOCK) { soft.push([c, r]); continue; }
      // Floor-ish cell (empty / safe / flag / end / player / enemy).
      if (ch0 === PLAYER) player = { c, r };
      else if (enemyKinds[ch0]) enemyCells.push({ c, r, kind: enemyKinds[ch0] });
      else openCells.push({ c, r });
      // Random destructible from the layer-1 template — only on PLAIN empty cells
      // (keeps player/enemy/safe pockets clear), at the map's wallGenPercent.
      if (ch1 === BLOCK && ch0 === EMPTY && rng() < gen) soft.push([c, r]);
    }
  }
  if (!player) player = openCells[0] || enemyCells[0] || { c: 1, r: 1 };

  const px = player.c, py = player.r;
  const far = openCells.slice().sort(
    (a, b) => ((b.c - px) ** 2 + (b.r - py) ** 2) - ((a.c - px) ** 2 + (a.r - py) ** 2)
  ).slice(0, 6);
  const seen = new Set([px + "," + py]);
  const spawnPts = [];
  for (const p of [...enemyCells, ...far]) {
    const k = p.c + "," + p.r;
    if (seen.has(k)) continue;
    seen.add(k);
    spawnPts.push(p);
  }
  const toWorld = (c, r) => ({ x: (c + 0.5) * cs, y: (r + 0.5) * cs });
  const spawns = [toWorld(px, py), ...spawnPts.map((p) => toWorld(p.c, p.r))];

  return {
    name: raw.name || "bomberman",
    cols, rows, cellSize: cs, walls, soft, voids, spawns,
    enemyCells: enemyCells.map((e) => ({ ...e })),
  };
}

export default GameMap;
