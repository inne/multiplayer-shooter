# Tank Game — WF1 (Single-Player Core)

Top-down 2D tank game. Plain HTML5 Canvas 2D, ES modules, **no build step**,
no three.js, no CDN/importmap.

## Run

ES modules + `fetch` need an HTTP origin (not `file://`). Serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Controls (Bomberman)

- **WASD / arrows** — move on the grid (constant speed, 4 directions, with
  lane-snap + corner assist)
- **B / Space** — drop a bomb (cross blast; you can stand on your own bomb until
  you step off its cell, then it solidifies)
- **R** — restart (regenerates a fresh board)

The board is **generated** each run: a classic Bomberman pillar lattice + a
Bernoulli soft-block (crate) fill, with cleared spawn pockets and a flood-fill
connectivity guarantee. Add `?map=arena1` (or `?map=empty`) to load a fixed
board, or `?seed=<n>` to pin the generated layout. Bombs are the player's only
offense; enemies threaten via contact/mines (enemy lasers are gated off — see
`ENEMY_FIRE` in `js/enemies.js`).

## Layout

The fixed full-arena camera scales the whole maze to fit the canvas (good
couch-PvP overview). Collision is computed on the wall-rect **data**
(deterministic circle/AABB resolution + shell/wall reflection), never on
sprites.

- `index.html` — full-window `<canvas id="game">` + entry `<script type="module" src="./js/main.js">`
- `js/main.js` — boot, asset loading, input, rAF loop, camera, FX/HUD, debug harness
- `js/map.js` — `GameMap`: loads `arena1.json`, wall AABBs + spawns, collision + reflection, floor/wall render
- `js/tank.js` — tank state + physics (drive/turn/turret aim) + render
- `js/shells.js` — `ShellSystem`: slow ricocheting shells, kills + explosions
- `assets/tanks/`, `assets/tiles/` — Kenney "Top-down Tanks Redux" (CC0)
- `assets/maps/arena1.json` — validated symmetric, fully-connected maze (20×14, cell 48)

> Note: a `src/` folder from an earlier draft also exists. The live game is the
> `js/` module set referenced by `index.html`; `src/` is not loaded.

## State / netcode readiness (WF1)

All sim state is plain, serializable fields (snapshot-friendly). There is **no
networking yet** — that comes in a later workflow. The design keeps physics
deterministic against the wall data so host-authoritative replay drops in
cleanly.

## Debug harness

`window.__TANK_DEBUG`:

- `snapshot()` → `{ tank:{x,y,dir,facing,...}, bombs:[...], softLeft, seed, ... }`
- `drive(dir, ms)` — hold `dir` (`up|down|left|right`) for `ms` (default 200)
- `step(dir, dt)` — advance ONE movement frame deterministically (grid tests)
- `grid()` → `{ cols, rows, cellSize, seed, col, row }`
- `cellBlocked(col, row)` → bool (hard wall / soft block / border)
- `bomb(x?, y?)` — drop a bomb (at the player, or an explicit world point)
- `regenMap(seed?)` — generate a fresh fully-connected board + restart
- `god(on)` — toggle player invulnerability

## Assets

Most art is from Kenney's [Top-down Tanks Redux](https://kenney.nl/assets/top-down-tanks-redux),
licensed **CC0** (public domain). No attribution required. Missing sprites fall
back to procedural rectangles.

`assets/tiles/bomb_party.png` is a Bomberman-style sprite sheet by **Rachel J.
Morris / Moosader** (OpenGameArt), licensed **CC-BY 3.0** — attribution
required. It is bundled as optional polish; the live tiles default to the CC0
Kenney 48px tiles (grass floor, metal wall, wooden crate) with procedural
fallbacks, so the game renders even if every PNG is missing.

### Maps

`assets/maps/bomberman/level00..23.json` are authored Bomberman levels imported
from **[timnicolas/bomberman-assets](https://github.com/timnicolas/bomberman-assets)**
(`maps/`), converted at load time by `map.js` (`bombermanToMapData`). ⚠️ That
repo ships **no license file**, so these layouts are not explicitly licensed for
redistribution — they're included here as fan-game content with credit to the
author; remove them if that matters for your use. The procedural generator
(`js/mazegen.js`, `?map=maze`) remains as a fully-original fallback.
