// gridmove.js — shared 4-directional GRID movement for the player AND enemies.
//
// Everything moves identically on the crate grid: constant speed, one cardinal
// direction at a time, the perpendicular axis locked to the lane center, with a
// small corner-assist so a near-aligned turn slips into the gap. Movement is
// blocked by walls / soft blocks / the border (map.pointInWall) and by SOLID
// bombs (a freshly-dropped bomb stays passable to whoever is standing on it).
//
// gridMove(ent, wantDir, dt, map, speed) mutates ent.{x,y,dir} and returns the
// resolved direction. `ent` needs {x, y, dir?, radius?}.

const UNIT = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
  left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, none: { x: 0, y: 0 },
};
const PERP = { up: "horizontal", down: "horizontal", left: "vertical", right: "vertical" };
const CORNER_ASSIST = 16; // px window to slip around a pillar into a perpendicular lane

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Live-bomb provider (set by main.js), so the mover treats solid bombs as walls.
let _bombProvider = null;
export function setBombProvider(fn) { _bombProvider = typeof fn === "function" ? fn : null; }

// Is the cell containing world (x,y) blocked? Hard wall / soft block / border
// (map.pointInWall) OR a SOLID bomb sitting in that cell.
export function cellBlocked(x, y, map) {
  if (map && typeof map.pointInWall === "function" && map.pointInWall(x, y)) return true;
  if (_bombProvider) {
    const cs = (map && map.cellSize) || 48;
    const col = Math.floor(x / cs), row = Math.floor(y / cs);
    for (const b of _bombProvider() || []) {
      if (!b || b.exploded || !b.solid) continue;
      if (b.col === col && b.row === row) return true;
    }
  }
  return false;
}

export function gridMove(ent, wantDir, dt, map, speed) {
  const cs = (map && map.cellSize) || 48;
  const half = cs / 2;
  const r = ent.radius || 16;
  const step = speed * dt;
  if (!(wantDir in UNIT)) wantDir = "none";

  const laneCenter = (v) => Math.round((v - half) / cs) * cs + half;
  const forwardCellOpen = (d) => {
    const u = UNIT[d];
    const col = Math.floor(ent.x / cs) + u.x;
    const row = Math.floor(ent.y / cs) + u.y;
    return !cellBlocked((col + 0.5) * cs, (row + 0.5) * cs, map);
  };

  let dir = ent.dir || "none";

  if (wantDir !== "none") {
    if (wantDir === dir) {
      // keep going (handled below)
    } else {
      // Turning: only adopt wantDir if its cell is open; corner-assist nudges the
      // off-axis toward the lane center so a near-aligned turn slips through.
      const perpAxis = PERP[wantDir];
      const onAxisVal = perpAxis === "horizontal" ? ent.x : ent.y;
      const offset = onAxisVal - laneCenter(onAxisVal);
      if (forwardCellOpen(wantDir)) {
        if (Math.abs(offset) <= CORNER_ASSIST) {
          const pull = clamp(-offset, -step, step);
          if (perpAxis === "horizontal") ent.x += pull; else ent.y += pull;
          dir = wantDir;
        } else if (dir === "none") {
          dir = "none"; // too far off-lane to turn; stay put
        }
        // else: keep current dir so we slide toward the gap
      } else if (dir === "none") {
        dir = "none";
      }
    }
  } else {
    dir = "none";
  }

  if (dir !== "none") {
    const u = UNIT[dir];
    // Leading-edge cell test in the travel direction: commit, or clamp flush.
    const edgeX = ent.x + u.x * (half + 0.5) + u.x * step;
    const edgeY = ent.y + u.y * (half + 0.5) + u.y * step;
    if (!cellBlocked(edgeX, edgeY, map)) {
      ent.x += u.x * step;
      ent.y += u.y * step;
    } else {
      if (u.x > 0) ent.x = Math.floor(ent.x / cs) * cs + cs - half;
      else if (u.x < 0) ent.x = Math.floor(ent.x / cs) * cs + half;
      if (u.y > 0) ent.y = Math.floor(ent.y / cs) * cs + cs - half;
      else if (u.y < 0) ent.y = Math.floor(ent.y / cs) * cs + half;
    }
    // Keep the off-axis pinned to the lane center (no diagonal drift).
    if (u.x !== 0) { const lane = laneCenter(ent.y); ent.y += clamp(lane - ent.y, -step, step); }
    else if (u.y !== 0) { const lane = laneCenter(ent.x); ent.x += clamp(lane - ent.x, -step, step); }
  }

  ent.dir = dir;

  // Final sub-pixel cleanup + bounds clamp.
  if (map && typeof map.resolveCircleVsWalls === "function") {
    const res = map.resolveCircleVsWalls(ent.x, ent.y, r);
    if (res) { ent.x = res.x; ent.y = res.y; }
  }
  return dir;
}

export default { gridMove, cellBlocked, setBombProvider };
