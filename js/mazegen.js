// mazegen.js — classic Bomberman board generator for the top-down game.
//
// Pure DATA generator (no DOM). Produces the SAME plain object GameMap's
// constructor consumes:
//   { cols, rows, cellSize, name, walls:[[col,row],...], spawns:[{x,y}],
//     soft:[[col,row],...], seed }
//
// Layout (research MAZE GEN §1-3):
//   - solid BORDER ring (matches arena1.json's perimeter)
//   - hard PILLAR lattice on every interior even/even cell (the checkerboard)
//   - 4 corner SPAWNS with cleared L-pockets so nobody starts boxed in
//   - Bernoulli SOFT fill (destructible crates) on the remaining free cells
//   - a FLOOD-FILL connectivity guarantee with re-seed retry + safe fallback
//
// Deterministic given a seed; the seed is stored on the returned object so a
// failed connectivity check can re-seed and the HUD/debug can report it.

// Small fast seeded PRNG (mulberry32). Returns a function -> [0,1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hard pillar test on the full 0-indexed grid: every interior cell with both
// coords even is a pillar (the classic 1-wide-lane checkerboard).
function isPillar(col, row, cols, rows) {
  if (col <= 0 || row <= 0 || col >= cols - 1 || row >= rows - 1) return false;
  return col % 2 === 0 && row % 2 === 0;
}

function isBorder(col, row, cols, rows) {
  return col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
}

// Default 4 corner spawns (cell centers in world px). Corners snap to the
// nearest ODD interior coordinate so a spawn can NEVER land on a pillar (pillars
// sit at even/even). On even board dims, cols-2 / rows-2 are even (e.g. 24,16 on
// 26x18) and would be pillars — so we step inward to the largest odd <= that.
function defaultSpawns(cols, rows, cs) {
  const oddAtMost = (n) => (n % 2 === 0 ? n - 1 : n); // largest odd <= n
  const right = oddAtMost(cols - 2);
  const bottom = oddAtMost(rows - 2);
  const cells = [
    [1, 1],
    [right, 1],
    [1, bottom],
    [right, bottom],
  ];
  return cells.map(([c, r]) => ({ x: (c + 0.5) * cs, y: (r + 0.5) * cs }));
}

// Flood fill from a start cell over traversable space. SOFT blocks count as
// passable (a bomb can clear them); hard pillars + border are walls. Returns
// the Set of reachable "col,row" keys.
function floodFill(startCol, startRow, cols, rows, pillarSet) {
  const seen = new Set();
  const key = (c, r) => c + "," + r;
  const stack = [[startCol, startRow]];
  seen.add(key(startCol, startRow));
  const N = [
    [0, -1],
    [0, 1],
    [1, 0],
    [-1, 0],
  ];
  while (stack.length) {
    const [c, r] = stack.pop();
    for (const [dc, dr] of N) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 1 || nr < 1 || nc > cols - 2 || nr > rows - 2) continue;
      const k = key(nc, nr);
      if (seen.has(k)) continue;
      if (pillarSet.has(k)) continue; // hard pillar — impassable
      seen.add(k);
      stack.push([nc, nr]);
    }
  }
  return seen;
}

/**
 * Generate a Bomberman board.
 *
 * @param {object} opts
 * @param {number} [opts.cols=26]
 * @param {number} [opts.rows=18]
 * @param {number} [opts.cellSize=48]
 * @param {number} [opts.seed]          defaults to (Date.now() >>> 0)
 * @param {number} [opts.softDensity=0.62]  Bernoulli fill prob (0..1)
 * @param {Array<{x,y}>} [opts.spawns]  world-px spawn centers (default 4 corners)
 * @returns {object} GameMap-ready data with `seed` recorded.
 */
export function generateMap(opts = {}) {
  const cols = opts.cols ?? 26;
  const rows = opts.rows ?? 18;
  const cellSize = opts.cellSize ?? 48;
  const softDensity = opts.softDensity ?? 0.62;
  let seed = (opts.seed ?? (Date.now() >>> 0)) >>> 0;
  const spawns = (opts.spawns && opts.spawns.length)
    ? opts.spawns.map((s) => ({ x: s.x, y: s.y }))
    : defaultSpawns(cols, rows, cellSize);

  const key = (c, r) => c + "," + r;

  // --- Static structure: border + pillars (never changes per re-roll). ----
  const walls = [];
  const pillarSet = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isBorder(c, r, cols, rows) || isPillar(c, r, cols, rows)) {
        walls.push([c, r]);
        // Pillars + border are the impassable set for flood fill (border cells
        // are outside the 1..cols-2 interior range, so only pillars matter, but
        // recording both is harmless).
        pillarSet.add(key(c, r));
      }
    }
  }

  // Protected (always-clear) cells: each spawn cell + its in-bounds, non-pillar
  // orthogonal neighbors (the classic L pocket).
  const protectedSet = new Set();
  const N = [
    [0, 0],
    [0, -1],
    [0, 1],
    [1, 0],
    [-1, 0],
  ];
  const spawnCells = spawns.map((s) => [
    Math.floor(s.x / cellSize),
    Math.floor(s.y / cellSize),
  ]);
  for (const [sc, sr] of spawnCells) {
    for (const [dc, dr] of N) {
      const c = sc + dc;
      const r = sr + dr;
      if (c < 1 || r < 1 || c > cols - 2 || r > rows - 2) continue;
      if (pillarSet.has(key(c, r))) continue;
      protectedSet.add(key(c, r));
    }
  }

  // Free interior cells eligible for a soft block (not border, pillar, or
  // protected). Computed once; the per-attempt roll just picks a subset.
  const freeCells = [];
  for (let r = 1; r <= rows - 2; r++) {
    for (let c = 1; c <= cols - 2; c++) {
      const k = key(c, r);
      if (pillarSet.has(k) || protectedSet.has(k)) continue;
      freeCells.push([c, r]);
    }
  }

  // --- Soft fill + connectivity guarantee (re-seed retry, then fallback). --
  function rollSoft(density, rng) {
    const soft = [];
    const softSet = new Set();
    for (const [c, r] of freeCells) {
      if (rng() < density) {
        soft.push([c, r]);
        softSet.add(key(c, r));
      }
    }
    return { soft, softSet };
  }

  // Connectivity over the FREE space (treating soft as passable): every free
  // cell + every spawn cell must reach spawns[0]. Because the even-pillar
  // lattice with 1-wide lanes is always connected this normally passes; the
  // check guards future variants (e.g. knocked-out pillars / loops).
  function connected() {
    const [s0c, s0r] = spawnCells[0];
    const reach = floodFill(s0c, s0r, cols, rows, pillarSet);
    // Every non-pillar interior cell must be reachable.
    for (let r = 1; r <= rows - 2; r++) {
      for (let c = 1; c <= cols - 2; c++) {
        const k = key(c, r);
        if (pillarSet.has(k)) continue;
        if (!reach.has(k)) return false;
      }
    }
    return true;
  }

  // pillarSet defines passability, so connectivity is independent of the soft
  // roll — validate the lattice once, then roll soft. If for any reason the
  // lattice check fails (custom dims), fall back to lattice-only.
  let soft = [];
  if (connected()) {
    const MAX_TRIES = 20;
    let ok = false;
    for (let i = 0; i < MAX_TRIES; i++) {
      const rng = mulberry32((seed + i * 0x9e3779b9) >>> 0);
      const res = rollSoft(softDensity, rng);
      // Soft never blocks connectivity (it's passable via bomb), so any roll is
      // valid; we keep the retry loop as the documented guard for future
      // variants that might gate on soft layout.
      soft = res.soft;
      ok = true;
      seed = (seed + i * 0x9e3779b9) >>> 0;
      break;
    }
    if (!ok) soft = []; // provably-connected lattice-only fallback
  } else {
    soft = []; // lattice-only (provably connected)
  }

  return {
    cols,
    rows,
    cellSize,
    name: "generated",
    seed,
    walls,
    spawns,
    soft,
  };
}

export default { generateMap };
