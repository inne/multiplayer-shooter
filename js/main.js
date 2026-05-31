// main.js — boot + orchestration for the top-down tank game (WF1 core).
//
// This is the entry ES module. It wires together the three sim modules:
//   - map.js    : data-driven arena (walls, spawns, collision, reflection, render)
//   - tank.js   : tank state + physics + render
//   - shells.js : slow, ricocheting projectile system + kills/explosions
//
// Responsibilities here:
//   - Load assets (sprites) with a procedural fallback.
//   - Build the world (player + wave-spawned UFO enemies + bombs).
//   - Translate input (W/S/A/D + mouse aim + click/space fire) into the
//     per-frame `input` the tank physics consumes.
//   - Run the rAF loop: update sim, then render (map -> shells -> tanks -> fx).
//   - Expose window.__TANK_DEBUG for the automated harness.
//
// No build step, plain HTML5 Canvas 2D, ES modules served directly. The sim
// state is plain & serializable (snapshot-friendly) so a later workflow can
// add host-authoritative networking. NO networking here yet.

import { GameMap } from "./map.js";
import { generateMap } from "./mazegen.js";
import * as Tank from "./tank.js";
import { ShellSystem } from "./shells.js";
import { EnemySystem } from "./enemies.js";
import { WaveManager } from "./waves.js";
import { BombSystem, BOMB_CONFIG } from "./bombs.js";
import { createBlackHole } from "./blackhole.js";
import * as sfx from "./sfx.js";

// ---------------------------------------------------------------------------
// Asset loading (best-effort; missing sprites -> procedural rect fallback).
// CC0 assets only (Kenney Top-down Tanks Redux). The sub-modules also lazy-load
// their own sprites, but loading them centrally lets us inject into tank.js and
// hand the shell sprite to the ShellSystem, avoiding double fetches.
// ---------------------------------------------------------------------------
const ASSET_BASE = "../assets";

const ASSET_PATHS = {
  body_green: `${ASSET_BASE}/tanks/body_green.png`,
  body_red: `${ASSET_BASE}/tanks/body_red.png`,
  body_blue: `${ASSET_BASE}/tanks/body_blue.png`,
  body_sand: `${ASSET_BASE}/tanks/body_sand.png`,
  body_dark: `${ASSET_BASE}/tanks/body_dark.png`,
  turret_green: `${ASSET_BASE}/tanks/turret_green.png`,
  turret_red: `${ASSET_BASE}/tanks/turret_red.png`,
  turret_blue: `${ASSET_BASE}/tanks/turret_blue.png`,
  turret_sand: `${ASSET_BASE}/tanks/turret_sand.png`,
  turret_dark: `${ASSET_BASE}/tanks/turret_dark.png`,
  shell: `${ASSET_BASE}/tanks/shell.png`,
  tracks: `${ASSET_BASE}/tanks/tracks.png`,
  // Per-tank-color bullet sprites (matched to the firing tank's skin).
  shell_green: `${ASSET_BASE}/tanks/shell_green.png`,
  shell_red: `${ASSET_BASE}/tanks/shell_red.png`,
  shell_blue: `${ASSET_BASE}/tanks/shell_blue.png`,
  shell_sand: `${ASSET_BASE}/tanks/shell_sand.png`,
  shell_dark: `${ASSET_BASE}/tanks/shell_dark.png`,
  explosion1: `${ASSET_BASE}/tanks/explosion1.png`,
  explosion2: `${ASSET_BASE}/tanks/explosion2.png`,
  explosion3: `${ASSET_BASE}/tanks/explosion3.png`,
  explosion4: `${ASSET_BASE}/tanks/explosion4.png`,
  explosion5: `${ASSET_BASE}/tanks/explosion5.png`,
  // UFO enemy sprites (CC0 top-down ships ~124px; drawn scaled to ~40px).
  ufo_green: `${ASSET_BASE}/enemies/ufo_green.png`,
  ufo_pink: `${ASSET_BASE}/enemies/ufo_pink.png`,
  ufo_beige: `${ASSET_BASE}/enemies/ufo_beige.png`,
  ufo_yellow: `${ASSET_BASE}/enemies/ufo_yellow.png`,
  // Progressive battle damage (alien-bubble composited over the damaged saucer):
  // 2 stages per color, selected by HP fraction in enemies.render.
  ufo_green_dmg1: `${ASSET_BASE}/enemies/ufo_green_dmg1.png`,
  ufo_green_dmg2: `${ASSET_BASE}/enemies/ufo_green_dmg2.png`,
  ufo_beige_dmg1: `${ASSET_BASE}/enemies/ufo_beige_dmg1.png`,
  ufo_beige_dmg2: `${ASSET_BASE}/enemies/ufo_beige_dmg2.png`,
  ufo_yellow_dmg1: `${ASSET_BASE}/enemies/ufo_yellow_dmg1.png`,
  ufo_yellow_dmg2: `${ASSET_BASE}/enemies/ufo_yellow_dmg2.png`,
  ufo_pink_dmg1: `${ASSET_BASE}/enemies/ufo_pink_dmg1.png`,
  ufo_pink_dmg2: `${ASSET_BASE}/enemies/ufo_pink_dmg2.png`,
  // Laser bolt sprites (38x100) for enemy shots (shells.js bulletKey).
  laser_green: `${ASSET_BASE}/enemies/laser_green.png`,
  laser_pink: `${ASSET_BASE}/enemies/laser_pink.png`,
  // NOTE: assets/enemies/xbill/winme.png (the Windows Me logo) is kept on disk
  // but intentionally NOT loaded — xBill is melee-only for now. Re-add here if a
  // ranged xBill variant is ever wired up.
};

// xBill ground creature: a 6-frame walk loop + 5-frame death anim (transparent
// PNGs, tiny — normalized up by the enemy renderer). These live in the
// enemies/xbill/ subfolder and load through the same loadImage/loadAssets path
// into the shared `images` cache, then are collected into ordered arrays
// (images.xbill_loop / images.xbill_die) for enemies.render — mirroring how the
// whitePuff frames are assembled into images.puff.
const XBILL_WALK_COUNT = 6;
const XBILL_DIE_COUNT = 5;
for (let i = 0; i < XBILL_WALK_COUNT; i++) {
  ASSET_PATHS[`xbill_loop${i}`] = `${ASSET_BASE}/enemies/xbill/xbill_loop${i}.png`;
}
for (let i = 0; i < XBILL_DIE_COUNT; i++) {
  ASSET_PATHS[`xbill_die${i}`] = `${ASSET_BASE}/enemies/xbill/xbill_die${i}.png`;
}

// whitePuff 25-frame smoke sequence (whitePuff00..24, ~381px — scale down).
// Loaded into the shared `images` cache as whitePuff00..24 AND collected into
// PUFF_FRAMES (array) which the bomb system consumes via images.puff.
const PUFF_FRAME_COUNT = 25;
for (let i = 0; i < PUFF_FRAME_COUNT; i++) {
  const key = `whitePuff${String(i).padStart(2, "0")}`;
  ASSET_PATHS[key] = `${ASSET_BASE}/fx/puff/${key}.png`;
}

const EXPLOSION_FRAMES = [
  "explosion1", "explosion2", "explosion3", "explosion4", "explosion5",
];
// SMOKE upgrade: muzzle puffs + explosions now use the whitePuff 25-frame
// sequence (replaces the old single smokeWhite0-5 path) for nicer smoke.
const SMOKE_FRAMES = [];
for (let i = 0; i < PUFF_FRAME_COUNT; i++) {
  SMOKE_FRAMES.push(`whitePuff${String(i).padStart(2, "0")}`);
}

const images = {}; // key -> HTMLImageElement, or null on load failure

function loadImage(key, url) {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") { images[key] = null; resolve(false); return; }
    const img = new Image();
    img.onload = () => { images[key] = img; resolve(true); };
    img.onerror = () => { images[key] = null; resolve(false); };
    img.src = new URL(url, import.meta.url).href;
  });
}

async function loadAssets() {
  const results = await Promise.all(
    Object.entries(ASSET_PATHS).map(([k, u]) => loadImage(k, u).then((ok) => ({ k, ok })))
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.k);
  if (failed.length && typeof console !== "undefined") {
    console.warn("[tank-game] missing sprites (procedural fallback):", failed);
  }
  // Let tank.js reuse the body/turret images we just loaded.
  Tank.registerImages(images);
  // Assemble the ordered whitePuff frame array for the bomb system (imgs.puff).
  images.puff = SMOKE_FRAMES.map((k) => images[k]).filter(Boolean);
  // Assemble the ordered xBill frame arrays for the enemy renderer. Unlike puff
  // these keep null holes (do NOT filter) so frame index stays aligned to the
  // archetype's walkFrames/dieFrames; a missing frame just falls back procedurally.
  images.xbill_loop = [];
  for (let i = 0; i < XBILL_WALK_COUNT; i++) images.xbill_loop.push(images[`xbill_loop${i}`] || null);
  images.xbill_die = [];
  for (let i = 0; i < XBILL_DIE_COUNT; i++) images.xbill_die.push(images[`xbill_die${i}`] || null);
  return images;
}

// Power-up tuning. Crates/enemies sometimes drop a pickup the player drives over:
//   'fire' -> blast Range +1 (bombReach),  'bomb' -> Bomb count +1 (bombMax).
// Both are capped so firepower can't snowball into a kill-box (a known Bomberman
// feel-killer). Drop chances are rolled with Math.random (gameplay flavour; a
// future host-authoritative build would seed this).
const PICKUP = {
  DROP_CHANCE_CRATE: 0.32, // per destroyed crate
  DROP_CHANCE_ENEMY: 0.16, // per killed enemy
  REACH_CAP: 6,            // max blast reach (cells per arm)
  BOMB_CAP: 5,             // max simultaneous bombs
  RADIUS: 20,              // collection radius (world px) around the pickup
};

// ---------------------------------------------------------------------------
// World: player + UFO enemies (waves), shells, bombs, mines, and FX.
// Plain serializable fields only (snapshot-friendly).
// ---------------------------------------------------------------------------
class World {
  constructor(map, shellImages) {
    this.map = map;
    this.time = 0;
    this.god = false; // player invulnerability for the harness

    this.explosions = []; // {x, y, t, life, scale}
    this.smokes = []; // {x, y, t, life} — muzzle puffs on fire
    this.treads = []; // {x, y, angle, t, life} — fading tread marks
    this.shake = 0; // current screen-shake magnitude (world px), decays
    this.hitStop = 0; // seconds of frozen sim left (kill punch)
    this.hitFlash = 0; // red screen flash strength when the PLAYER is hit, decays
    this.pickupFlash = 0; // green screen flash on power-up collect, decays
    this._treadAccum = 0; // throttle tread stamping
    this.gameOver = false; // set when the player tank is destroyed

    // Dropped mines (the enemy MINER pushes records here; bombs.js detonates).
    this.mines = []; // {id, x, y, owner, kind, born, fuse}

    // Player tank only — enemies live in the EnemySystem and are merged into
    // the shell/bomb target lists via getTanks() below.
    this._spawnPlayer();

    // UFO enemies (4 archetypes). They are added to the shell system's target
    // list so the player's shells KILL them, and they fire via shells.fire().
    this.enemies = new EnemySystem({});

    // Slow, ricocheting shells. Friendly fire is real (incl. the owner). The
    // target list is [player, ...aliveEnemies] so player shells kill enemies
    // and enemy shells can hit the player.
    this.shells = new ShellSystem({
      map,
      getTanks: () => this.targets(),
      images: shellImages,
      onKill: (tank) => {
        // Juice: a big shake + a brief hit-stop freeze make kills land.
        this.addShake(11);
        this.hitStop = Math.max(this.hitStop, 0.06);
        this._onTankKilled(tank);
      },
      onHit: (tank) => {
        // Non-lethal hit: small puff already handled in shells; flash + a nudge
        // of shake when it's the PLAYER taking damage so the HP loss reads.
        if (tank && tank.isPlayer) {
          this.hitFlash = 1;
          this.addShake(5);
        }
      },
      onExplosion: (x, y, scale) => this.addExplosion(x, y, scale),
    });

    // Bomberman CROSS-blast bombs. Same merged target list (friendly fire on:
    // the player can blow themselves up).
    this.bombs = new BombSystem({
      map,
      getTanks: () => this.targets(),
      onExplosion: (x, y, scale) => this.addExplosion(x, y, scale),
      onShake: (a) => { this.addShake(a); sfx.playBoom(); }, // dedicated bomb detonation boom
      // Accelerating fuse beep — pitch rises toward detonation (t: 0 -> 1).
      onBeep: (t) => sfx.playBeep(0.9 + t * 0.7),
      // A blast that destroys a tank routes through the SAME path shell kills use,
      // so a bomb kill (including blowing YOURSELF up) ends the game / drops loot.
      onKill: (tank) => {
        this.addShake(11);
        this.hitStop = Math.max(this.hitStop, 0.06);
        this._onTankKilled(tank);
      },
      // NOTE: the WebGL black-hole lens is intentionally NOT wired to the standard
      // bomb — the pinch was too much for it. The capability is kept ready for a
      // future "bigger" bomb: re-enable by passing an onDetonate here that calls
      // this.triggerBlackHole(x, y) (gated on the new bomb type), or call
      // world.triggerBlackHole(x, y) directly from wherever the big bomb detonates.
      // The bombs.js onDetonate hook + World.triggerBlackHole + js/blackhole.js all
      // remain in place; only this wiring is removed.
      // Crate cleared by a blast -> maybe drop a power-up at that cell.
      onBlockDestroyed: (x, y) => this.maybeDropPickup(x, y, PICKUP.DROP_CHANCE_CRATE),
    });

    // Floor power-ups (Bomberman-style): drive over to collect. Persist until
    // picked up. {x, y, kind:'fire'|'bomb', t}.
    this.pickups = [];

    // WebGL "black hole" gravitational-lens overlay (set up at boot once the
    // canvas exists). Stays null/no-op if WebGL is unavailable. Currently only
    // triggered manually (__TANK_DEBUG.blackhole / a future bigger bomb).
    this.blackhole = null;
    this._cam = null; // camera ref, needed to map bomb world coords -> screen px

    // Escalating wave manager. It only decides what/where/when to spawn; the
    // EnemySystem owns the actual entities.
    this.waves = new WaveManager({
      spawnEnemy: (kind, x, y, hpBonus) => this.enemies.spawn(kind, x, y, hpBonus),
      getEnemies: () => this.enemies.getList(),
      getPlayer: () => this.player,
      spawns: this.map.spawns,
    });

    // Per-frame input fed to the player's GRID movement (one cardinal dir).
    this.input = { wantDir: "none" };
    // Held movement-key state -> resolved into wantDir each frame.
    this.keys = { up: false, down: false, left: false, right: false };
    // Order in which keys were pressed, so the most-recent held key wins (feels
    // best for grid movement — tapping a new dir overrides the old).
    this._dirOrder = [];

    // Let tank.js see the live bomb list so the player can stand on / walk off
    // their own freshly-dropped bomb (it solidifies once they step off the cell).
    Tank.setBombProvider(() => this.bombs.bombs);
  }

  // Most-recently-pressed held direction wins; falls back to none.
  _resolveWantDir() {
    for (let i = this._dirOrder.length - 1; i >= 0; i--) {
      const d = this._dirOrder[i];
      if (this.keys[d]) return d;
    }
    return "none";
  }

  _spawnPlayer() {
    const sp = this.map.spawns;
    const player = Tank.create({ id: "player", x: sp[0].x, y: sp[0].y, skin: 0, isPlayer: true });
    // Per-player bomb stats raised by power-ups (start at the global defaults).
    // The BombSystem reads owner.bombMax / owner.bombReach when dropping.
    player.bombReach = BOMB_CONFIG.REACH;
    player.bombMax = BOMB_CONFIG.MAX_PER_OWNER;
    this.player = player;
  }

  // The merged kill-target list: [player, ...alive enemies]. Used by both the
  // shell and bomb systems so projectiles/blasts hit player AND enemies.
  targets() {
    const list = this.enemies ? this.enemies.getList() : [];
    return [this.player, ...list];
  }

  // Called by the shell/bomb onKill hooks when any target dies.
  _onTankKilled(tank) {
    if (!tank) return;
    sfx.playExplosion(); // Chunky Explosion — a tank/enemy blew up

    if (tank.isPlayer) {
      // God mode (harness): revive the player so a stray ricochet/blast during
      // an automated run doesn't end the session.
      if (this.god) { tank.alive = true; return; }
      this.gameOver = true;
    } else {
      // Killed an enemy: small chance to drop a power-up where it died.
      this.maybeDropPickup(tank.x, tank.y, PICKUP.DROP_CHANCE_ENEMY);
    }
  }

  // Roll a `chance` drop of a power-up at world (x, y), snapped to the cell
  // center so it sits neatly on the grid. 'fire' and 'bomb' are equally likely.
  maybeDropPickup(x, y, chance) {
    if (Math.random() >= chance) return;
    const cs = this.map.cellSize || 48;
    const cx = (Math.floor(x / cs) + 0.5) * cs;
    const cy = (Math.floor(y / cs) + 0.5) * cs;
    const kind = Math.random() < 0.5 ? "fire" : "bomb";
    this.pickups.push({ x: cx, y: cy, kind, t: 0 });
  }

  // Collect any pickup the player is standing on; apply its (capped) effect.
  _collectPickups() {
    const p = this.player;
    if (!p || p.alive === false) return;
    const rr = (p.radius || 16) + PICKUP.RADIUS;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      const dx = p.x - pk.x;
      const dy = p.y - pk.y;
      if (dx * dx + dy * dy > rr * rr) continue;
      if (pk.kind === "fire") {
        p.bombReach = Math.min(PICKUP.REACH_CAP, (p.bombReach || BOMB_CONFIG.REACH) + 1);
      } else {
        p.bombMax = Math.min(PICKUP.BOMB_CAP, (p.bombMax || BOMB_CONFIG.MAX_PER_OWNER) + 1);
      }
      this.pickups.splice(i, 1);
      // Feedback: a puff + a small green flash + a nudge of shake.
      this.addSmoke(pk.x, pk.y);
      this.pickupFlash = 1;
      this.addShake(2);
    }
  }

  // Melee contact bite from a ground creature (xBill). Mirrors the shells.js
  // damage convention (subtract hp; alive=false at 0) but routes the lethal case
  // through _onTankKilled so the game-over screen + kill juice still fire — and
  // honors god mode. Non-lethal bites flash the screen + nudge shake like a
  // shell hit. Returns true if the hit landed (target was a live player).
  _onContact(tank, dmg = 1) {
    if (!tank || tank.alive === false || !tank.isPlayer) return false;
    if (this.god) { this.hitFlash = 1; this.addShake(4); return true; }
    if (typeof tank.hp !== "number") tank.hp = tank.maxHp || 1;
    tank.hp -= dmg;
    if (tank.hp <= 0) {
      tank.hp = 0;
      tank.alive = false;
      tank.vx = 0;
      tank.vy = 0;
      this.addExplosion(tank.x, tank.y, 1.4);
      this.addShake(11);
      this.hitStop = Math.max(this.hitStop, 0.06);
      this._onTankKilled(tank);
    } else {
      this.addExplosion(tank.x, tank.y, 0.5);
      this.hitFlash = 1;
      this.addShake(5);
    }
    return true;
  }

  addExplosion(x, y, scale = 1) {
    this.explosions.push({ x, y, t: 0, life: 0.45, scale });
  }

  addSmoke(x, y) {
    this.smokes.push({ x, y, t: 0, life: 0.45 });
  }

  addShake(a) {
    this.shake = Math.min(this.shake + a, 16);
  }

  // Kick off the WebGL black-hole pinch at a WORLD point (the bomb's heart).
  // Converts world -> canvas px via the camera and sizes the lens to the bomb's
  // actual cross reach so the warp roughly matches the visible blast.
  triggerBlackHole(worldX, worldY) {
    if (!this.blackhole || !this._cam) return;
    const cam = this._cam;
    const sx = worldX * cam.scale + cam.offsetX;
    const sy = worldY * cam.scale + cam.offsetY;
    const reach = (this.bombs.cfg.REACH + 1.5) * this.bombs.cellSize * cam.scale;
    this.blackhole.trigger(sx, sy, {
      duration: 0.6,
      radius: Math.max(190, reach),
      strength: 1.0,
    });
  }

  // Drop a bomberman bomb at the player's position (KeyB / right-click).
  dropBomb() {
    if (this.gameOver || !this.player.alive) return false;
    const b = this.bombs.drop(this.player.x, this.player.y, this.player);
    if (b) this.addShake(2);
    return !!b;
  }

  // Full restart: wipe enemies/projectiles/mines/FX and respawn the player at
  // the wave-start state (wave 1). Bound to R on the game-over screen.
  restart() {
    this.enemies.enemies.length = 0;
    this.shells.shells.length = 0;
    this.bombs.bombs.length = 0;
    this.mines.length = 0;
    this.pickups.length = 0;
    this.explosions.length = 0;
    this.smokes.length = 0;
    this.treads.length = 0;
    this.shake = 0;
    this.hitStop = 0;
    this.hitFlash = 0;
    this.pickupFlash = 0;
    this.gameOver = false;
    this._spawnPlayer();
    // Fresh player from _spawnPlayer() starts at full HP; reset explicitly in
    // case a future change reuses the existing player object.
    this.player.hp = this.player.maxHp;
    this.player.alive = true;
    // Rebuild destructible cover so a new run starts with all crates intact.
    if (typeof this.map.resetSoftBlocks === "function") this.map.resetSoftBlocks();
    this.waves.reset();
  }

  update(dt) {
    // Clamp dt so a tab-switch hitch can't tunnel tanks/shells through walls.
    dt = Math.min(dt, 1 / 30);
    this.time += dt;

    // Resolve held keys into a single cardinal movement direction.
    this.input.wantDir = this._resolveWantDir();

    // System order: waves (spawn) -> enemies (AI/fire/mines) -> bombs (fuses)
    // -> player tank -> shells -> FX. The wave manager spawns into the
    // EnemySystem; enemies fire via the shared shell system and drop mines onto
    // world.mines; bombs detonate against the merged target list.
    if (!this.gameOver) {
      this.waves.update(dt);
      this.enemies.update(dt, {
        player: this.player,
        map: this.map,
        shells: this.shells,
        world: this,
        // Melee contact (xBill ground creature): route player damage back
        // through the world so a contact KILL sets gameOver via the same
        // _onTankKilled path shells/bombs use (and respects god mode).
        onContact: (tank, dmg) => this._onContact(tank, dmg),
      });
      this.bombs.update(dt);
      this._updateMines(dt);
    }

    // Player tank physics.
    Tank.update(this.player, this.input, dt, this.map);

    // Collect any power-up the player just drove onto.
    if (!this.gameOver) this._collectPickups();

    this.shells.update(dt);
    // Compact dead enemies AFTER shells/bombs have resolved kills this frame so
    // the wave manager's alive count (and HUD) stay in sync.
    this.enemies.reap();
    this._updateExplosions(dt);
    this._updateSmokes(dt);
    this._updateTreads(dt);
    // Screen-shake decays fast.
    this.shake *= Math.exp(-13 * dt);
    if (this.shake < 0.2) this.shake = 0;
    // Red hit flash decays quickly too.
    if (this.hitFlash > 0) {
      this.hitFlash -= dt * 3;
      if (this.hitFlash < 0) this.hitFlash = 0;
    }
    // Green power-up flash decays.
    if (this.pickupFlash > 0) {
      this.pickupFlash -= dt * 3;
      if (this.pickupFlash < 0) this.pickupFlash = 0;
    }
    // Animate pickups (bob phase).
    for (const pk of this.pickups) pk.t += dt;
  }

  // Mines (dropped by the MINER UFO) arm after a brief delay, then detonate
  // when the player drives close — reusing the bomb system's CROSS blast (a
  // zero-fuse bomb at the mine cell), so the kill/FX path is identical.
  _updateMines(dt) {
    const ARM_DELAY = 0.6;     // seconds before a fresh mine is live
    const TRIGGER = 26;        // proximity radius (world px) to the player center
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      const age = this.enemies.time - m.born; // mine.born is in EnemySystem time
      if (age < ARM_DELAY) continue;
      const dx = this.player.x - m.x;
      const dy = this.player.y - m.y;
      if (this.player.alive && dx * dx + dy * dy <= TRIGGER * TRIGGER) {
        this._detonateMine(m);
        this.mines.splice(i, 1);
      }
    }
  }

  // Detonate a mine via a bomb that explodes immediately. We drop with a unique
  // owner so the player's 2-bomb cap is never consumed by mines, then force the
  // fuse to ~0 so the next bombs.update() pops the cross blast this frame.
  _detonateMine(m) {
    const b = this.bombs.drop(m.x, m.y, { id: `mineblast_${m.id}` });
    if (b) b.fuse = 0;
  }

  _updateTreads(dt) {
    // Stamp fading tread marks under the fast-moving PLAYER tank (throttled).
    // UFO enemies hover, so they don't lay treads.
    this._treadAccum += dt;
    if (this._treadAccum >= 0.05) {
      this._treadAccum = 0;
      const t = this.player;
      if (t.alive && t.vx * t.vx + t.vy * t.vy > 900) { // moving > 30 px/s
        this.treads.push({ x: t.x, y: t.y, angle: t.bodyAngle, t: 0, life: 1.6 });
      }
    }
    for (let i = this.treads.length - 1; i >= 0; i--) {
      const k = this.treads[i];
      k.t += dt;
      if (k.t >= k.life) this.treads.splice(i, 1);
    }
    if (this.treads.length > 240) this.treads.splice(0, this.treads.length - 240);
  }

  _updateExplosions(dt) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.t += dt;
      if (e.t >= e.life) this.explosions.splice(i, 1);
    }
  }

  _updateSmokes(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.t += dt;
      if (s.t >= s.life) this.smokes.splice(i, 1);
    }
  }

  // Serializable view for the harness / future netcode.
  snapshot() {
    return {
      tank: Tank.snapshot(this.player),
      shells: this.shells.shells.map((s) => ({ x: round(s.x), y: round(s.y) })),
      walls: this.map.walls.length,
      // New systems (consumed by the automated harness).
      enemies: this.enemies.snapshot(),
      wave: this.waves.currentWave(),
      enemiesLeft: this.waves.enemiesLeft(),
      bombs: this.bombs.bombs.map((b) => ({ x: round(b.x), y: round(b.y), fuse: round(Math.max(0, b.fuse)) })),
      mines: this.mines.map((m) => ({ x: round(m.x), y: round(m.y) })),
      softLeft: typeof this.map.softAlive === "function" ? this.map.softAlive() : 0,
      pickups: this.pickups.map((p) => ({ x: round(p.x), y: round(p.y), kind: p.kind })),
      bombReach: this.player.bombReach,
      bombMax: this.player.bombMax,
      gameOver: this.gameOver,
      seed: this.map.seed,
    };
  }
}

function round(v, dp = 2) {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

// ---------------------------------------------------------------------------
// Camera: fixed full-arena view. The whole maze fits the canvas via one
// uniform scale (couch-PvP overview). world->screen is a single transform.
// ---------------------------------------------------------------------------
class Camera {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.map = map;
    this.recompute();
  }

  recompute() {
    const sx = this.canvas.width / this.map.width;
    const sy = this.canvas.height / this.map.height;
    this.scale = Math.min(sx, sy);
    this.offsetX = (this.canvas.width - this.map.width * this.scale) / 2;
    this.offsetY = (this.canvas.height - this.map.height * this.scale) / 2;
  }

  // Canvas px -> world coords (maps the mouse to a turret aim point).
  screenToWorld(px, py) {
    return {
      x: (px - this.offsetX) / this.scale,
      y: (py - this.offsetY) / this.scale,
    };
  }
}

// ---------------------------------------------------------------------------
// Renderer: orchestrates the per-module draws in world space, plus FX + HUD.
// ---------------------------------------------------------------------------
function draw(ctx, world, cam) {
  const canvas = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Screen shake: perturb a COPY of the camera for the world-space draws only
  // (HUD stays steady). Random jitter scaled by the current shake magnitude.
  const sh = world.shake || 0;
  const dcam = sh > 0
    ? { scale: cam.scale,
        offsetX: cam.offsetX + (Math.random() * 2 - 1) * sh,
        offsetY: cam.offsetY + (Math.random() * 2 - 1) * sh }
    : cam;

  // map.js and shells.js each set their own world transform internally.
  world.map.render(ctx, dcam);
  drawTreads(ctx, world, dcam); // on the ground, under everything
  drawPickups(ctx, world, dcam); // power-ups sit on the floor
  world.shells.render(ctx, dcam);

  // Enemies (UFO sprites) under the player tank.
  world.enemies.render(ctx, dcam, images);

  // Player tank in world space (tank.render accepts a {scale, offset} camera).
  Tank.render(ctx, dcam, world.player);
  drawPlayerRing(ctx, world.player, dcam);

  // Bombs + dropped mines above tanks, under the explosion FX.
  world.bombs.render(ctx, dcam, images);
  drawMines(ctx, world, dcam);

  drawExplosions(ctx, world, dcam);
  drawSmokes(ctx, world, dcam);

  // HUD in screen space.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawHud(ctx, world);
  if (world.gameOver) drawGameOver(ctx, world);
}

// Floor power-ups: a bobbing rounded badge with a glow + a distinct icon.
//   'fire' (orange, blast star) -> Range +1   ·   'bomb' (dark disc) -> Bomb +1
function drawPickups(ctx, world, cam) {
  if (!world.pickups.length) return;
  ctx.save();
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.offsetX, cam.offsetY);
  for (const p of world.pickups) {
    const bob = Math.sin((p.t || 0) * 3) * 2;          // gentle float
    const pulse = 0.5 + 0.5 * Math.sin((p.t || 0) * 4); // glow throb
    const R = 15;
    ctx.save();
    ctx.translate(p.x, p.y + bob);

    // Soft attention glow.
    ctx.globalAlpha = 0.25 + 0.25 * pulse;
    const glowCol = p.kind === "fire" ? "255,150,40" : "120,200,255";
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.9);
    g.addColorStop(0, `rgba(${glowCol},0.9)`);
    g.addColorStop(1, `rgba(${glowCol},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Badge body.
    ctx.fillStyle = p.kind === "fire" ? "#e8632a" : "#2b3550";
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, R - 3, 0, Math.PI * 2);
    ctx.stroke();

    if (p.kind === "fire") {
      // Blast/range icon: a bright 4-point star burst.
      ctx.fillStyle = "#ffe27a";
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rr = i % 2 === 0 ? R - 4 : (R - 4) * 0.42;
        const fx = Math.cos(a) * rr, fy = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      // Bomb-up icon: a small dark bomb with a lit fuse.
      ctx.fillStyle = "#0e0e12";
      ctx.beginPath();
      ctx.arc(0, 2, R - 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,${140 + Math.floor(100 * pulse)},40,1)`;
      ctx.beginPath();
      ctx.arc(R * 0.32, -R * 0.42, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

// Dropped mines (from the MINER UFO): a small armed disc with a blinking core.
// The bomb system owns blast/detonation; this is purely the resting visual.
function drawMines(ctx, world, cam) {
  if (!world.mines.length) return;
  ctx.save();
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.offsetX, cam.offsetY);
  const blink = 0.5 + 0.5 * Math.sin(world.time * 6);
  for (const m of world.mines) {
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.fillStyle = "#2a2a30";
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `rgba(255,${80 + Math.floor(120 * blink)},40,${0.5 + 0.5 * blink})`;
    ctx.beginPath();
    ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// Game-over overlay: dim the arena + prompt to restart (R).
function drawGameOver(ctx, world) {
  const canvas = ctx.canvas;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ff6b6b";
  ctx.font = "700 48px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillText("GAME OVER", canvas.width / 2, canvas.height / 2 - 24);
  ctx.fillStyle = "#ffd86b";
  ctx.font = "600 18px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillText(`reached WAVE ${world.waves.currentWave()}`, canvas.width / 2, canvas.height / 2 + 16);
  ctx.fillText("press R to restart", canvas.width / 2, canvas.height / 2 + 44);
  ctx.restore();
}

function drawPlayerRing(ctx, player, cam) {
  if (!player.alive) return;
  ctx.save();
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.offsetX, cam.offsetY);
  ctx.translate(player.x, player.y);
  ctx.strokeStyle = "rgba(255,216,107,0.9)";
  ctx.lineWidth = 2 / cam.scale;
  ctx.beginPath();
  ctx.arc(0, 0, (player.radius || 16) + 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawExplosions(ctx, world, cam) {
  ctx.save();
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.offsetX, cam.offsetY);
  const puff = Array.isArray(images.puff) ? images.puff : null;
  for (const e of world.explosions) {
    const frac = e.t / e.life;
    const scale = (e.scale || 1) * (1 + frac * 0.4);
    // SMOKE upgrade: explosions billow using the whitePuff 25-frame sequence,
    // indexed by life fraction. Fall back to the fiery explosion sprites, then
    // a procedural flash, if the puff frames are missing.
    if (puff && puff.length) {
      const idx = Math.min(puff.length - 1, Math.floor(frac * puff.length));
      const img = puff[idx];
      const size = 64 * scale; // whitePuff is ~381px — draw at ~explosion size
      ctx.globalAlpha = 1 - frac * 0.85;
      ctx.drawImage(img, e.x - size / 2, e.y - size / 2, size, size);
      ctx.globalAlpha = 1;
      continue;
    }
    const idx = Math.min(EXPLOSION_FRAMES.length - 1, Math.floor(frac * EXPLOSION_FRAMES.length));
    const img = images[EXPLOSION_FRAMES[idx]];
    if (img) {
      const w = img.width * scale, h = img.height * scale;
      ctx.globalAlpha = 1 - frac * 0.3;
      ctx.drawImage(img, e.x - w / 2, e.y - h / 2, w, h);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = `rgba(255,${Math.floor(180 - frac * 120)},40,${1 - frac})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 22 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawTreads(ctx, world, cam) {
  if (!world.treads.length) return;
  const img = images.tracks;
  ctx.save();
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.offsetX, cam.offsetY);
  for (const k of world.treads) {
    const alpha = 0.5 * (1 - k.t / k.life);
    if (alpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(k.x, k.y);
    ctx.rotate(k.angle + Math.PI / 2); // tracks art points up (-Y)
    if (img) {
      const w = 26, h = w * (img.height / img.width || 1.4);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.fillStyle = "#3a2f24";
      ctx.fillRect(-11, -4, 22, 8);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawSmokes(ctx, world, cam) {
  ctx.save();
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.offsetX, cam.offsetY);
  for (const s of world.smokes) {
    const frac = s.t / s.life;
    const idx = Math.min(SMOKE_FRAMES.length - 1, Math.floor(frac * SMOKE_FRAMES.length));
    const img = images[SMOKE_FRAMES[idx]];
    // A prominent muzzle cloud (like the Kenney promo art): starts ~tank-sized
    // and billows out as it fades.
    const size = 42 + frac * 40;
    ctx.globalAlpha = 0.9 * (1 - frac * 0.85);
    if (img) {
      ctx.drawImage(img, s.x - size / 2, s.y - size / 2, size, size);
    } else {
      ctx.fillStyle = "#f2f2f2";
      ctx.beginPath();
      ctx.arc(s.x, s.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawHud(ctx, world) {
  const liveBombs = world.bombs._liveForOwner(world.player.id);
  const p = world.player;
  const bombMax = p.bombMax ?? world.bombs.cfg.MAX_PER_OWNER;
  const bombsLeft = bombMax - liveBombs;
  const reach = p.bombReach ?? world.bombs.cfg.REACH;
  const maxHp = p.maxHp ?? 1;
  const hp = Math.max(0, p.hp ?? maxHp);
  const lines = [
    `WAVE    ${world.waves.currentWave()}`,
    `ENEMIES ${world.waves.enemiesLeft()}`,
    `BOMBS   ${bombsLeft}/${bombMax}`,
    `REACH   ${reach}`,
    `HP`, // value drawn as boxes alongside this label below
  ];
  const hpLine = lines.length - 1; // HP is the last fixed line
  if (!world.player.alive) lines.push("DESTROYED");
  if (world.god) lines.push("GOD");

  ctx.save();
  ctx.font = "600 14px ui-monospace, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  // Reserve room to the right of the HP label for the heart/box pips.
  const pipW = 14, pipGap = 4, hpLabelW = ctx.measureText("HP").width;
  w = Math.max(w, hpLabelW + 8 + maxHp * (pipW + pipGap));
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(8, 8, w + 20, lines.length * 18 + 12);
  ctx.fillStyle = "#ffd86b";
  lines.forEach((l, i) => ctx.fillText(l, 18, 16 + i * 18));

  // HP pips: filled boxes for current hp, hollow for lost hp.
  const hpRow = 16 + hpLine * 18; // align to the "HP" line wherever it lands
  const px0 = 18 + hpLabelW + 10;
  for (let i = 0; i < maxHp; i++) {
    const bx = px0 + i * (pipW + pipGap);
    const by = hpRow + 1;
    if (i < hp) {
      ctx.fillStyle = "#5ad15a";
      ctx.fillRect(bx, by, pipW, pipW);
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + 0.5, by + 0.5, pipW - 1, pipW - 1);
    }
  }
  ctx.restore();

  // Brief red hit flash overlay (set by World on player damage; decays).
  if (world.hitFlash > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(220,40,40,${Math.min(0.4, world.hitFlash * 0.5)})`;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
  // Brief green flash on power-up collect.
  if (world.pickupFlash > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(80,220,120,${Math.min(0.32, world.pickupFlash * 0.4)})`;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Input wiring.
// ---------------------------------------------------------------------------
function wireInput(world, cam, canvas) {
  // 4-direction GRID movement: WASD / arrows. B or Space drops a bomb.
  const keymap = {
    KeyW: "up", ArrowUp: "up",
    KeyS: "down", ArrowDown: "down",
    KeyA: "left", ArrowLeft: "left",
    KeyD: "right", ArrowRight: "right",
  };

  const press = (dir) => {
    if (!world.keys[dir]) {
      world.keys[dir] = true;
      // Track press order so the most-recent held direction wins.
      const i = world._dirOrder.indexOf(dir);
      if (i >= 0) world._dirOrder.splice(i, 1);
      world._dirOrder.push(dir);
    }
  };

  window.addEventListener("keydown", (e) => {
    if (keymap[e.code]) {
      if (!e.repeat) press(keymap[e.code]);
      e.preventDefault();
      return;
    }
    if (e.repeat) return; // don't re-trigger one-shots while held
    // B or Space drops a bomb (Space is no longer a handbrake).
    if (e.code === "KeyB" || e.code === "Space") { world.dropBomb(); e.preventDefault(); }
    if (e.code === "KeyR" && world.gameOver) { world.restart(); e.preventDefault(); }
  });
  window.addEventListener("keyup", (e) => {
    if (keymap[e.code]) { world.keys[keymap[e.code]] = false; e.preventDefault(); }
  });
}

// ---------------------------------------------------------------------------
// rAF loop.
// ---------------------------------------------------------------------------
function runLoop(world, cam, ctx) {
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;
    // Hit-stop: briefly freeze the sim on a kill for punch (still renders).
    if (world.hitStop > 0) {
      world.hitStop -= Math.min(dt, 1 / 30);
    } else {
      world.update(dt);
    }
    draw(ctx, world, cam);
    // Black-hole lens: after the 2D frame is drawn, warp it on the GPU overlay
    // for the duration of an active blast (no-op otherwise). dt advances even
    // during hit-stop so the pinch keeps animating.
    if (world.blackhole) world.blackhole.update(dt, ctx.canvas);
    syncStatus(world);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Optional DOM status line (index.html ships a #status span) — harmless if absent.
function syncStatus(world) {
  const el = document.getElementById("status");
  if (!el) return;
  const state = world.gameOver ? "DESTROYED" : (world.player.alive ? "alive" : "DESTROYED");
  el.textContent =
    `player: ${state} | wave: ${world.waves.currentWave()} | enemies: ${world.waves.enemiesLeft()} | shells: ${world.shells.shells.length}` +
    (world.god ? " | GOD" : "");
}

// ---------------------------------------------------------------------------
// Debug harness for the automated test harness.
// ---------------------------------------------------------------------------
function exposeDebug(world, cam) {
  const dirMap = { up: "up", down: "down", left: "left", right: "right" };
  // Promote a direction to most-recent so _resolveWantDir picks it.
  const promote = (dir) => {
    const i = world._dirOrder.indexOf(dir);
    if (i >= 0) world._dirOrder.splice(i, 1);
    world._dirOrder.push(dir);
  };
  window.__TANK_DEBUG = {
    snapshot: () => world.snapshot(),
    // Hold a direction ("up"|"down"|"left"|"right") for `ms` milliseconds.
    drive: (dir, ms = 200) => {
      if (!(dir in dirMap)) { console.warn("drive: dir must be up|down|left|right"); return false; }
      world.keys[dir] = true;
      promote(dir);
      setTimeout(() => { world.keys[dir] = false; }, ms);
      return true;
    },
    // Single deterministic movement frame in `dir` for `dt` seconds (harness
    // grid-step alignment / corner-slip checks without waiting on rAF).
    step: (dir = "none", dt = 1 / 60) => {
      const prev = { ...world.input };
      world.input.wantDir = (dir in dirMap) ? dir : "none";
      Tank.update(world.player, world.input, dt, world.map);
      world.input = prev;
      return Tank.snapshot(world.player);
    },
    // Grid query helpers for the harness.
    grid: () => ({
      cols: world.map.cols, rows: world.map.rows, cellSize: world.map.cellSize,
      seed: world.map.seed,
      col: Math.floor(world.player.x / world.map.cellSize),
      row: Math.floor(world.player.y / world.map.cellSize),
    }),
    cellBlocked: (col, row) => {
      const cs = world.map.cellSize;
      return world.map.pointInWall((col + 0.5) * cs, (row + 0.5) * cs);
    },
    // Regenerate the maze in place (fresh fully-connected board) + restart.
    regenMap: (seed) => regenerateMap(world, cam, seed),
    god: (on = true) => { world.god = !!on; return world.god; },
    // Spawn a power-up ("fire"|"bomb") at a world point (defaults near player)
    // for deterministic testing of collection + caps.
    pickup: (kind = "fire", x, y) => {
      const px = Number.isFinite(x) ? x : world.player.x + 40;
      const py = Number.isFinite(y) ? y : world.player.y;
      world.pickups.push({ x: px, y: py, kind: kind === "bomb" ? "bomb" : "fire", t: 0 });
      return { reach: world.player.bombReach, bombMax: world.player.bombMax };
    },
    // Drop a bomberman bomb at the player (or at an explicit world point).
    bomb: (x, y) => {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return !!world.bombs.drop(x, y, world.player);
      }
      return world.dropBomb();
    },
    // Spawn an enemy of `kind` ("beige"|"green"|"pink"|"yellow"|"xbill") for testing.
    spawnEnemy: (kind, x, y) => {
      const sp = world.map.spawns;
      const sx = Number.isFinite(x) ? x : (sp[1] || sp[0]).x;
      const sy = Number.isFinite(y) ? y : (sp[1] || sp[0]).y;
      return world.enemies.spawn(kind, sx, sy);
    },
    restart: () => world.restart(),
    // Fire the black-hole lens directly for visual verification (defaults to the
    // player's position). Returns whether WebGL is available to render it.
    blackhole: (x, y) => {
      const wx = Number.isFinite(x) ? x : world.player.x;
      const wy = Number.isFinite(y) ? y : world.player.y;
      world.triggerBlackHole(wx, wy);
      return !!(world.blackhole && world.blackhole.supported);
    },
    blackholeActive: () => !!(world.blackhole && world.blackhole.active),
    _world: world,
    _cam: cam,
    reset: () => location.reload(),
  };
}

// Build a fresh GENERATED Bomberman map and hot-swap it into the running world
// (used by __TANK_DEBUG.regenMap). Re-points every map-bound system + camera,
// then restarts to respawn the player on the new board.
function regenerateMap(world, cam, seed) {
  const data = generateMap({ seed: Number.isFinite(seed) ? (seed >>> 0) : undefined });
  const map = new GameMap(data);
  world.map = map;
  world.shells.map = map;
  world.bombs.map = map;
  world.enemies.map = map; // EnemySystem reads the map passed in update(), but keep in sync
  world.waves.spawns = map.spawns;
  cam.map = map;
  cam.recompute();
  world.restart();
  return map.seed;
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function boot() {
  const canvas = document.getElementById("game");
  if (!canvas) throw new Error('missing <canvas id="game">');
  const ctx = canvas.getContext("2d");

  await loadAssets();
  // Optional ?map=<name> overrides with a FIXED board assets/maps/<name>.json
  // (e.g. ?map=arena1 / ?map=empty for the harness). Otherwise we GENERATE a
  // fresh, fully-connected Bomberman board. ?seed=<n> seeds the generator.
  let map;
  let mapName = null;
  try {
    const params = new URLSearchParams(location.search);
    const name = params.get("map");
    if (name && /^[a-z0-9_-]+$/i.test(name)) mapName = name;
    var seedParam = params.get("seed");
  } catch (_) { /* ignore */ }

  if (mapName) {
    map = await GameMap.load(`${ASSET_BASE}/maps/${mapName}.json`);
  } else {
    const seed = seedParam != null && /^\d+$/.test(seedParam) ? (Number(seedParam) >>> 0) : undefined;
    const data = generateMap({ seed });
    map = new GameMap(data);
    await GameMap.loadSprites(); // best-effort tile sprites (procedural fallback)
  }

  const world = new World(map, images);
  const cam = new Camera(canvas, map);

  // WebGL black-hole overlay (transient lens on bomb detonation). Safe no-op if
  // WebGL is unavailable. Needs the camera to map bomb world coords -> screen px.
  world._cam = cam;
  world.blackhole = createBlackHole(canvas);

  sfx.init(); // preload explosion/boom samples + bind gesture-resume
  wireInput(world, cam, canvas);
  exposeDebug(world, cam);
  runLoop(world, cam, ctx);

  if (typeof console !== "undefined") {
    console.log("[tank-game] ready. window.__TANK_DEBUG available.");
  }
}

// Only boot in a DOM environment (skip under node --check / unit imports).
if (typeof document !== "undefined" && typeof window !== "undefined") {
  boot().catch((err) => {
    if (typeof console !== "undefined") console.error("[tank-game] boot failed:", err);
    const el = typeof document !== "undefined" && document.getElementById("status");
    if (el) el.textContent = "boot failed: " + err.message;
  });
}
