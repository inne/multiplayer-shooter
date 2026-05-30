# Tank Game — WF1 (Single-Player Core)

Top-down 2D tank game. Plain HTML5 Canvas 2D, ES modules, **no build step**,
no three.js, no CDN/importmap.

## Run

ES modules + `fetch` need an HTTP origin (not `file://`). Serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Controls

- **W / S** — drive forward / back (momentum + friction)
- **A / D** — rotate the tank **body**
- **Mouse** — the **turret** aims at the cursor
- **Left-click / Space** — fire

Shells are **slow** and **reflect off walls** (flip the velocity component on
the hit axis). This slowness is deliberate: it reads well on the fixed
full-arena camera and suits the future host-authoritative netcode. Shells kill
any tank they touch — **including the owner** (friendly fire is real). Shoot the
3 stationary dummy tanks.

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

- `snapshot()` → `{ tank:{x,y,bodyAngle,turretAngle,alive}, shells:[{x,y}], walls:N, dummies:[{x,y,alive}] }`
- `fire()`
- `drive(dir, ms)` — `dir` in `up|down|left|right`, held for `ms` (default 200)
- `aim(worldX, worldY)`
- `god(on)` — toggle player invulnerability

## Assets

All art is from Kenney's [Top-down Tanks Redux](https://kenney.nl/assets/top-down-tanks-redux),
licensed **CC0** (public domain). No attribution required. Missing sprites fall
back to procedural rectangles.
