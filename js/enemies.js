// enemies.js — UFO enemy entities + the 4 Wii-Tanks-style archetypes for the
// top-down 2D tank game.
//
// The four archetypes (all UFOs):
//   * beige  = STATIONARY: aims at the player, fires a slow bouncing shot.
//   * green  = ROAMER:     wanders slowly + aims + fires.
//   * pink   = SEEKER:     drives toward the player + fires a faster shot.
//   * yellow = MINER:      roams + periodically DROPS A MINE + fires.
//
// Integration with the existing systems (no changes needed there):
//   - Each enemy is a plain, serializable object shaped like a tank target:
//       { id, x, y, vx, vy, angle, turretAngle, alive, kind, radius, bullet,
//         isPlayer:false, ... }
//     `turretAngle` is kept equal to `angle` so the EXISTING shells.fire(enemy)
//     spawns from the muzzle in the aim direction and reuses the slow-
//     projectile + wall-reflection + kill code. The shot carries bulletKey so
//     shells.render draws it with a laser sprite (laser_green / laser_pink).
//   - Enemies are meant to be added to the shell system's target list (via the
//     world's getTanks()) so the PLAYER's shells kill them too.
//   - Mines are pushed onto an injected world.mines list (the bomb/FX system
//     owns detonation + rendering); we only spawn the mine record here.
//
// Plain Canvas 2D, ES module, no build step. Procedural fallback if a sprite is
// missing. State stays plain/serializable for later host-authoritative netcode.

// ---------------------------------------------------------------------------
// Tunables (per archetype). Speeds are slow on purpose — slow projectiles are
// netcode-friendly and read well on the fixed full-arena camera.
// ---------------------------------------------------------------------------
// Bomberman build: DISABLE enemy ranged fire so bombs are the player's only
// offense and enemies threaten only via contact/mines. The whole shell-fire
// path stays intact (shells.js + ShellSystem are still wired) — flip this to
// `true` to re-enable enemy lasers for difficulty.
const ENEMY_FIRE = false;

export const ENEMY_CONFIG = {
  RADIUS: 18, // collision circle (world px); MUST fit the 48px Bomberman lanes
  DRAW_SIZE: 44, // on-screen UFO size (world px) — cell-sized so it navigates corridors
  HOVER_BOB: 3, // vertical bob amplitude (world px)
  HOVER_RATE: 2.4, // bob cycles/sec (rad/s applied to a sine)
  TURRET_TURN: 3.0, // aim slew rate (rad/s) toward the player
  // --- xBill ground-creature tunables (used by the "ground" class branch) ---
  XBILL_DRAW: 48, // on-screen HEIGHT (world px); cell-sized pixel-art
  XBILL_RADIUS: 16, // collision circle (fits the 48px lanes)
  XBILL_CONTACT_RANGE: 24, // center-distance (world px) at which a contact bite lands on the player
  MINE_CAP: 3, // max live mines per miner (they only clear on player proximity)
};

// Total on-screen time of the xBill death animation (dieFrames / dieFps) plus a
// tiny hold tail so the last frame is visible before reap() removes it. Computed
// from the archetype below; reap() and update() both gate on this.
export const XBILL_DIE_TIME = 5 / 12 + 0.05; // ~0.47s

// Per-kind behavioural parameters. `bullet` keys a laser sprite for shells.js.
export const ARCHETYPES = {
  beige: {
    sprite: "ufo_beige",
    spriteDmg1: "ufo_beige_dmg1",
    spriteDmg2: "ufo_beige_dmg2",
    bullet: "laser_green",
    color: "#d8c9a0",
    hp: 1, // 1-hit (Bomberman norm)
    speed: 50, // random walker (the classic "Ballom")
    fireCooldown: 2.3, // (unused while ENEMY_FIRE is off)
    fireJitter: 0.8,
    move: "roam",
    drops: false,
  },
  green: {
    sprite: "ufo_green",
    spriteDmg1: "ufo_green_dmg1",
    spriteDmg2: "ufo_green_dmg2",
    bullet: "laser_green",
    color: "#7fd86b",
    hp: 2,
    speed: 70, // roams, then CHARGES down a clear row/column (Bomberman "WithEye")
    fireCooldown: 2.0,
    fireJitter: 0.7,
    move: "charge",
    drops: false,
  },
  pink: {
    sprite: "ufo_pink",
    spriteDmg1: "ufo_pink_dmg1",
    spriteDmg2: "ufo_pink_dmg2",
    bullet: "laser_pink",
    color: "#f06bb0",
    hp: 2,
    speed: 85, // BFS pathfinding hunter (Bomberman "Follow")
    fireCooldown: 1.6,
    fireJitter: 0.5,
    move: "chase",
    drops: false,
    shotSpeedScale: 1.45,
  },
  yellow: {
    sprite: "ufo_yellow",
    spriteDmg1: "ufo_yellow_dmg1",
    spriteDmg2: "ufo_yellow_dmg2",
    bullet: "laser_green",
    color: "#ffd86b",
    hp: 3, // tanky roamer (no longer drops mines — Bomberman enemies don't bomb)
    speed: 55,
    fireCooldown: 2.6,
    fireJitter: 0.9,
    move: "roam",
    drops: false,
  },
  // xBill — a GROUND creature (not a UFO). It scuttles toward the player and
  // BITES on body contact — pure MELEE, no projectile. The `class: "ground"` tag
  // makes the spawn/move/render/death-clock code branch away from the UFO
  // presentation (no hover bob, no backing disc, no rotate-to-face; walk-cycle +
  // play-once death anim).
  xbill: {
    class: "ground", // discriminator: ground creature (handled specially)
    walkFrames: [
      "xbill_loop0", "xbill_loop1", "xbill_loop2",
      "xbill_loop3", "xbill_loop4", "xbill_loop5",
    ], // 6-frame walk loop (keys match main.js images.xbill_loop order)
    dieFrames: [
      "xbill_die0", "xbill_die1", "xbill_die2", "xbill_die3", "xbill_die4",
    ], // 5-frame death anim, played ONCE on death
    color: "#cfd2d6", // procedural fallback fill (light grey mascot)
    hp: 2, // fragile swarmer
    speed: 78, // BFS hunter that bites on contact
    move: "chase", // pathfinds to the player, routing around crates
    drops: false,
    contactDamage: 1, // melee bite damage on body contact (its ONLY attack)
    contactCooldown: 0.9, // seconds between contact bites (per-enemy timer)
    walkFps: 10, // walk-loop animation rate
    dieFps: 12, // death-anim rate (5 frames -> ~0.42s on screen)
    // NOTE: intentionally NO `bullet`/`fireCooldown` — xBill is melee-only. The
    // Windows Me logo projectile art is kept at assets/enemies/xbill/winme.png
    // (unused) in case we want a ranged variant later.
  },
};

export const ENEMY_KINDS = Object.keys(ARCHETYPES);

// ---------------------------------------------------------------------------
// Math helpers (local; deterministic).
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------
// Shared HEALTH BAR: a thin floating bar centered at local (0, cy), `width`
// world px wide, drawn in the CURRENT (already translated) transform. Dark
// backing + a fill colored green->yellow->red by hp/maxHp. Exported so the
// player tank renders an identical bar.
// ---------------------------------------------------------------------------
export function drawHealthBar(ctx, width, cy, hp, maxHp) {
  const frac = clamp(maxHp > 0 ? hp / maxHp : 0, 0, 1);
  const w = width;
  const h = Math.max(3, width * 0.09);
  const x = -w / 2;
  // Fill color: red < 0.34, yellow < 0.67, else green.
  const fill = frac > 0.66 ? "#5ad15a" : frac > 0.33 ? "#f0c64b" : "#e0533f";

  ctx.save();
  // Dark backing (slightly inset border for contrast on any floor).
  ctx.fillStyle = "rgba(10,12,18,0.78)";
  ctx.fillRect(x - 1, cy - 1, w + 2, h + 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x, cy, w, h);
  // Health fill.
  ctx.fillStyle = fill;
  ctx.fillRect(x, cy, w * frac, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// EnemySystem — owns the live enemy list, per-frame AI, firing, and render.
//
// Collaborators are injected per-update via the ctxObj so the system itself
// stays free of hard module references (snapshot/replay friendly):
//   ctxObj.player : the player tank ({ x, y, alive }) — the AI target.
//   ctxObj.map    : GameMap (resolveCircleVsWalls / pointInWall) — optional.
//   ctxObj.shells : the ShellSystem; enemies fire via shells.fire(enemy).
//   ctxObj.world  : the world; mines are pushed onto world.mines.
// ---------------------------------------------------------------------------
export class EnemySystem {
  constructor(opts = {}) {
    this.cfg = { ...ENEMY_CONFIG, ...(opts.config || {}) };
    this.enemies = []; // live enemy objects (plain serializable)
    this.time = 0; // accumulated sim time (seconds)
    this._nextId = 1;
    // Deterministic-ish RNG seed hook (Math.random by default; swappable later).
    this.rng = opts.rng || Math.random;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  // Spawn one enemy of `kind` at world (x, y). Returns the new enemy object
  // (added to the list), or null for an unknown kind. `hpBonus` (optional) is a
  // small additive HP ramp from the wave manager (subtle difficulty scaling).
  spawn(kind, x, y, hpBonus = 0) {
    const arch = ARCHETYPES[kind];
    if (!arch) {
      if (typeof console !== "undefined") {
        console.warn("[enemies] unknown kind:", kind);
      }
      return null;
    }
    const r = this.rng;
    const maxHp = Math.max(1, (arch.hp || 1) + (hpBonus | 0));
    const isGround = arch.class === "ground";
    const enemy = {
      id: `${isGround ? "xbill" : "ufo"}_${this._nextId++}`,
      kind,
      x,
      y,
      vx: 0,
      vy: 0,
      angle: 0, // aim heading (rad, 0 = +X)
      turretAngle: 0, // mirrors `angle` so shells.fire uses our aim direction
      alive: true,
      isPlayer: false,
      // --- combat HP (shells deal 1; _applyDamage in shells.js subtracts) ---
      maxHp,
      hp: maxHp,
      // Ground creatures use a smaller collision circle than the bulky UFOs.
      radius: isGround ? this.cfg.XBILL_RADIUS : this.cfg.RADIUS,
      bullet: arch.bullet, // shells.render uses this as the laser sprite key
      // --- AI timers (staggered so a group doesn't act in lockstep) ---
      fireTimer: arch.fireCooldown ? arch.fireCooldown * (0.4 + 0.6 * r()) : 0,
      mineTimer: arch.drops ? arch.mineCooldown * (0.4 + 0.6 * r()) : 0,
      wanderAngle: r() * Math.PI * 2, // current roam heading
      wanderTimer: 0.8 + r() * 1.4, // time until the roamer repicks a heading
      bobPhase: r() * Math.PI * 2, // hover-bob offset (presentation only)
      // --- ground-creature (xBill) fields ---
      // animPhase desyncs the walk loop across a pack so they don't step in
      // lockstep. contactTimer gates melee bites. faceLeft flips the sprite by
      // horizontal travel direction. dieClock is intentionally LEFT UNDEFINED
      // here so update() edge-detects death (alive===false) and seeds it.
      animPhase: isGround ? r() * (arch.walkFrames.length / (arch.walkFps || 10)) : 0,
      contactTimer: 0,
      faceLeft: false,
    };
    this.enemies.push(enemy);
    return enemy;
  }

  // Remove dead enemies from the live list. Returns the count removed. The
  // shell system marks enemy.alive = false on a kill (same as tanks); call this
  // each frame (or after) to compact the list.
  reap() {
    let removed = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.alive !== false) continue;
      const arch = ARCHETYPES[e.kind];
      const isGround = arch && arch.class === "ground";
      // UFOs are reaped the instant they die (unchanged). A dying ground
      // creature lingers until its death animation has fully played so the die
      // frames are visible; the clock is advanced in update() while alive===false.
      const doneDying = isGround
        ? (e.dieClock !== undefined && e.dieClock >= XBILL_DIE_TIME)
        : true;
      if (doneDying) {
        this.enemies.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Per-frame AI: move + aim at the player + fire on a cooldown. Yellow drops
  // mines. dt in seconds; ctxObj supplies the collaborators (see class doc).
  // -------------------------------------------------------------------------
  update(dt, ctxObj = {}) {
    if (!(dt > 0)) return;
    this.time += dt;

    const player = ctxObj.player || null;
    const map = ctxObj.map || null;
    const shells = ctxObj.shells || null;
    const world = ctxObj.world || null;
    const onContact = typeof ctxObj.onContact === "function" ? ctxObj.onContact : null;
    const r = this.rng;

    for (const e of this.enemies) {
      const arch = ARCHETYPES[e.kind];
      if (!arch) continue;
      const isGround = arch.class === "ground";

      // Ground creatures (xBill) run a death STATE MACHINE driven purely by
      // OBSERVING alive===false — so it fires identically for a shell kill, a
      // bomb-cross kill, or test code setting alive=false. A dying xBill is
      // inert: advance its death clock and skip ALL AI (no seek/contact/aim).
      if (isGround && e.alive === false) {
        if (e.dieClock === undefined) e.dieClock = 0; // transition edge
        e.dieClock += dt;
        continue;
      }

      // Non-ground dead enemies (UFOs) are skipped and reaped immediately.
      if (e.alive === false) continue;

      const targetAlive = player && player.alive !== false;

      // --- 1) Aim at the player (slew the turret/aim toward them) ----------
      if (targetAlive) {
        const want = Math.atan2(player.y - e.y, player.x - e.x);
        const d = angleDelta(e.angle, want);
        const step = this.cfg.TURRET_TURN * dt;
        e.angle += Math.abs(d) <= step ? d : Math.sign(d) * step;
        // Normalize for tidy snapshots.
        if (e.angle > Math.PI) e.angle -= Math.PI * 2;
        else if (e.angle < -Math.PI) e.angle += Math.PI * 2;
      }
      // shells.fire reads turretAngle — keep it in lockstep with our aim.
      e.turretAngle = e.angle;

      // --- 2) Movement by archetype ---------------------------------------
      this._move(e, arch, dt, player, map, r);

      // Ground creatures face their horizontal travel direction (sprite flip).
      if (isGround && Math.abs(e.vx) > 1) e.faceLeft = e.vx < 0;

      // --- 3) Fire on a cooldown (RANGED kinds only) ----------------------
      // Guarded so a kind with no `bullet`/`fireCooldown` (xBill) never spawns a
      // shot — it's contact-only.
      if (ENEMY_FIRE && arch.bullet && arch.fireCooldown) {
        e.fireTimer -= dt;
        if (e.fireTimer <= 0) {
          // Reset the cooldown first (so a failed/capped fire still re-arms).
          e.fireTimer =
            arch.fireCooldown + (r() * 2 - 1) * (arch.fireJitter || 0);
          if (targetAlive && shells && typeof shells.fire === "function") {
            this._fire(e, arch, shells);
          }
        }
      }

      // --- 4) Melee contact bite (ground creatures: xBill) ----------------
      // No projectile — damages the player on body contact, gated by a per-enemy
      // cooldown so it bites rhythmically rather than draining hp every frame.
      if (isGround && arch.contactDamage) {
        if (e.contactTimer > 0) e.contactTimer -= dt;
        if (targetAlive && e.contactTimer <= 0) {
          const range = this.cfg.XBILL_CONTACT_RANGE;
          if (dist2(e.x, e.y, player.x, player.y) <= range * range) {
            e.contactTimer = arch.contactCooldown || 0.9;
            if (onContact) onContact(player, arch.contactDamage);
          }
        }
      }

      // --- 5) Mine drops (yellow) -----------------------------------------
      // Capped per miner so the arena doesn't fill up with mines: mines only
      // clear on player proximity, so without a cap a roaming miner litters the
      // map. A miner re-arms once some of its mines have been triggered/cleared.
      if (arch.drops) {
        e.mineTimer -= dt;
        if (e.mineTimer <= 0) {
          e.mineTimer =
            arch.mineCooldown + (r() * 2 - 1) * (arch.mineJitter || 0);
          const cap = arch.maxMines || this.cfg.MINE_CAP || 3;
          const live = world && Array.isArray(world.mines)
            ? world.mines.reduce((n, m) => n + (m.owner === e.id ? 1 : 0), 0)
            : 0;
          if (live < cap) this._dropMine(e, world);
        }
      }
    }
  }

  // Archetype movement. Move types:
  //   "still"  — stationary.
  //   "roam"   — random walk; repick heading periodically / on wall bump.
  //   "charge" — roam until the player is on the same row/column with a clear
  //              line of sight, then RUSH straight at them (Bomberman "WithEye").
  //   "chase"  — BFS shortest-path to the player's tile, routing AROUND crates
  //              and walls; steer toward the next waypoint (Bomberman "Follow").
  // All movement is integrated then slid against the map (circle-vs-AABB).
  _move(e, arch, dt, player, map, r) {
    const speed = arch.speed || 0;
    const move = arch.move;
    if (move === "still" || speed <= 0) { e.vx = 0; e.vy = 0; return; }
    const targetAlive = player && player.alive !== false;

    if (move === "chase" && targetAlive && map) {
      // Re-path on a throttle (cheap + slightly forgiving, like EnemyFollow).
      e.chaseTimer = (e.chaseTimer || 0) - dt;
      if (e.chaseTimer <= 0 || !e.chaseTarget) {
        e.chaseTimer = 0.45 + r() * 0.4;
        e.chaseTarget = this._bfsNext(e, player, map);
      }
      const t = e.chaseTarget;
      if (t) {
        const a = Math.atan2(t.y - e.y, t.x - e.x);
        e.vx = Math.cos(a) * speed;
        e.vy = Math.sin(a) * speed;
      } else {
        this._roamVel(e, dt, r, speed);
      }
    } else if (move === "charge" && targetAlive && map && this._hasLoS(e, player, map)) {
      const a = Math.atan2(player.y - e.y, player.x - e.x);
      e.vx = Math.cos(a) * speed * 1.3; // charge faster than its roam
      e.vy = Math.sin(a) * speed * 1.3;
    } else {
      this._roamVel(e, dt, r, speed);
    }

    // Integrate, then slide against walls.
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (map && typeof map.resolveCircleVsWalls === "function") {
      const res = map.resolveCircleVsWalls(e.x, e.y, e.radius);
      if (res) {
        const bumped = Math.abs(res.x - e.x) > 0.01 || Math.abs(res.y - e.y) > 0.01;
        e.x = res.x;
        e.y = res.y;
        if (bumped) {
          // A chaser that bumps forces an immediate re-path; a roamer turns away.
          if (move === "chase") { e.chaseTimer = 0; }
          else {
            e.wanderAngle += Math.PI * (0.5 + r() * 0.5);
            e.wanderTimer = 0.6 + r() * 1.0;
          }
        }
      }
    }
  }

  // Random-walk velocity (shared by roam + chase/charge fallbacks).
  _roamVel(e, dt, r, speed) {
    e.wanderTimer -= dt;
    if (e.wanderTimer <= 0) {
      e.wanderTimer = 0.8 + r() * 1.6;
      e.wanderAngle += (r() * 2 - 1) * (Math.PI * 0.6);
    }
    e.vx = Math.cos(e.wanderAngle) * speed;
    e.vy = Math.sin(e.wanderAngle) * speed;
  }

  // Clear line of sight to the player along a shared row OR column (no solid
  // cell between). Returns true if the player is visible down a straight lane.
  _hasLoS(e, player, map) {
    if (!map || !map.cellSize) return false;
    const cs = map.cellSize;
    const ec = Math.floor(e.x / cs), er = Math.floor(e.y / cs);
    const pc = Math.floor(player.x / cs), pr = Math.floor(player.y / cs);
    if (ec === pc) {
      for (let row = Math.min(er, pr) + 1; row < Math.max(er, pr); row++)
        if (map.pointInWall((ec + 0.5) * cs, (row + 0.5) * cs)) return false;
      return er !== pr;
    }
    if (er === pr) {
      for (let col = Math.min(ec, pc) + 1; col < Math.max(ec, pc); col++)
        if (map.pointInWall((col + 0.5) * cs, (er + 0.5) * cs)) return false;
      return ec !== pc;
    }
    return false;
  }

  // BFS shortest path from the enemy's tile to the player's tile over WALKABLE
  // cells (a cell is walkable if its center isn't a wall/void/soft block — so
  // chasers route around crates, never through them). Returns the WORLD center
  // of the next step toward the player, or null if unreachable.
  _bfsNext(e, player, map) {
    if (!map || !map.cellSize || !map.cols) return null;
    const cs = map.cellSize, cols = map.cols, rows = map.rows;
    const sc = Math.floor(e.x / cs), sr = Math.floor(e.y / cs);
    const tc = Math.floor(player.x / cs), tr = Math.floor(player.y / cs);
    if (sc === tc && sr === tr) return { x: player.x, y: player.y };
    const walk = (c, r) =>
      c >= 0 && r >= 0 && c < cols && r < rows && !map.pointInWall((c + 0.5) * cs, (r + 0.5) * cs);
    const key = (c, r) => r * cols + c;
    const prev = new Map();
    const seen = new Set([key(sc, sr)]);
    const q = [[sc, sr]];
    let qi = 0, found = false;
    while (qi < q.length) {
      const [c, r] = q[qi++];
      if (c === tc && r === tr) { found = true; break; }
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr, k = key(nc, nr);
        if (seen.has(k) || !walk(nc, nr)) continue;
        seen.add(k); prev.set(k, [c, r]); q.push([nc, nr]);
      }
    }
    if (!found) return null;
    // Walk back from target to the cell adjacent to the start = our next step.
    let cur = [tc, tr], step = cur;
    while (cur) {
      const p = prev.get(key(cur[0], cur[1]));
      if (!p) break;
      if (p[0] === sc && p[1] === sr) { step = cur; break; }
      cur = p;
    }
    return { x: (step[0] + 0.5) * cs, y: (step[1] + 0.5) * cs };
  }

  // Fire via the EXISTING shell system. shells.fire(enemy) reads enemy.id
  // (owner), enemy.turretAngle (direction) and enemy.bullet (sprite). For the
  // pink seeker we speed the spawned shot up a touch so it's harder to dodge —
  // we only scale the velocity vector, leaving all collision/reflection intact.
  _fire(e, arch, shells) {
    const shot = shells.fire(e);
    if (shot && arch.shotSpeedScale && arch.shotSpeedScale !== 1) {
      shot.vx *= arch.shotSpeedScale;
      shot.vy *= arch.shotSpeedScale;
    }
    return shot;
  }

  // Drop a mine at the enemy's feet onto the injected world.mines list. We only
  // create the plain mine record; the bomb/FX system owns the fuse, blast and
  // rendering. Kept serializable (x, y, owner, born) for snapshots/netcode.
  _dropMine(e, world) {
    if (!world) return null;
    if (!Array.isArray(world.mines)) world.mines = [];
    const mine = {
      id: `mine_${e.id}_${Math.round(this.time * 1000)}`,
      x: e.x,
      y: e.y,
      owner: e.id,
      kind: "mine",
      born: this.time,
      fuse: null, // proximity/timed detonation is owned by the bomb system
    };
    world.mines.push(mine);
    return mine;
  }

  // -------------------------------------------------------------------------
  // Rendering: UFO sprites scaled to ~DRAW_SIZE, rotated to FACE THE PLAYER
  // (via enemy.angle), with a gentle hover bob. cam maps world->screen via a
  // single uniform scale: screenX = world.x * cam.scale + cam.offsetX (the
  // project's fixed full-arena camera). We draw in world units after setting
  // the transform once, matching map.js / shells.js.
  // -------------------------------------------------------------------------
  render(ctx, cam, images) {
    if (!ctx) return;
    const scale = (cam && cam.scale) || 1;
    const ox = (cam && cam.offsetX) || 0;
    const oy = (cam && cam.offsetY) || 0;
    const imgs = images || {};

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    for (const e of this.enemies) {
      const arch = ARCHETYPES[e.kind] || {};

      // GROUND creatures (xBill) get their own upright walk/death rendering and,
      // crucially, KEEP rendering while dying (alive===false) so their death
      // frames play. UFOs still vanish the instant they die.
      if (arch.class === "ground") {
        this._renderGround(ctx, e, arch, imgs);
        continue;
      }

      if (e.alive === false) continue;

      // Hover bob: a small sinusoidal vertical offset (presentation only —
      // does NOT affect e.y / collision, which stay authoritative).
      const bob =
        Math.sin(this.time * this.cfg.HOVER_RATE + (e.bobPhase || 0)) *
        this.cfg.HOVER_BOB;

      ctx.save();
      ctx.translate(e.x, e.y + bob);

      // Soft contact shadow on the ground (under the hovering craft).
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(0, -bob + 3, this.cfg.DRAW_SIZE * 0.42, this.cfg.DRAW_SIZE * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Contrast backing: a dark disc + bright rim so a beige craft pops off the
      // sand floor (the UFO sprites otherwise blend in). Drawn under the ship.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, this.cfg.DRAW_SIZE * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(18,22,32,0.45)";
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.stroke();
      ctx.restore();

      // UFOs stay HEAD-UP (a saucer has no "front"): do NOT rotate to face the
      // player — only the hover bob above moves them. Their shots still aim via
      // e.angle in the shell system; the body just hovers upright.

      // Progressive battle damage by HP fraction: >2/3 pristine, >1/3 lightly
      // battered (dmg1), else heavily battered (dmg2). Falls back gracefully if a
      // stage sprite is missing. Only multi-HP craft can show damage.
      const frac = e.maxHp > 0 ? e.hp / e.maxHp : 1;
      let key = arch.sprite;
      if (e.maxHp > 1) {
        if (frac <= 1 / 3 && arch.spriteDmg2 && imgs[arch.spriteDmg2]) {
          key = arch.spriteDmg2;
        } else if (frac <= 2 / 3 && arch.spriteDmg1 && imgs[arch.spriteDmg1]) {
          key = arch.spriteDmg1;
        }
      }
      const img = imgs[key] || (arch.sprite && imgs[arch.sprite]) || null;

      const size = this.cfg.DRAW_SIZE;
      if (img) {
        // Preserve the source aspect ratio, normalizing on the larger side to
        // ~size (the UFO sprites are roughly square ~124px).
        const iw = img.width || size;
        const ih = img.height || size;
        const k = size / Math.max(iw, ih);
        const dw = iw * k;
        const dh = ih * k;
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      } else {
        this._drawUfoFallback(ctx, size, arch.color || "#b0b0c0");
      }

      // Health bar above the craft when damaged (hp < maxHp). Thin bar ~DRAW_SIZE
      // wide, dark backing + a fill colored green->yellow->red by hp fraction.
      if (e.maxHp > 1 && e.hp < e.maxHp) {
        drawHealthBar(ctx, this.cfg.DRAW_SIZE, -size * 0.5 - 8, e.hp, e.maxHp);
      }

      ctx.restore();
    }

    ctx.restore();
  }

  // Render a GROUND creature (xBill). Unlike the UFOs this is UPRIGHT (no
  // rotate-to-face), has NO hover bob and NO dark backing disc — only a flat
  // soft ground shadow for contrast on the sand. While alive it cycles its walk
  // loop; while dying (alive===false) it plays the death frames ONCE off the
  // per-enemy death clock, clamped at the last frame so it holds before reap().
  _renderGround(ctx, e, arch, imgs) {
    const dying = e.alive === false;
    const size = this.cfg.XBILL_DRAW;

    // Frame selection. Prefer the ordered arrays main.js assembles
    // (imgs.xbill_loop / imgs.xbill_die); fall back to the keyed cache so the
    // renderer works even if only the flat keys are present.
    let img = null;
    if (dying) {
      const n = arch.dieFrames.length;
      const idx = Math.min(n - 1, Math.floor((e.dieClock || 0) * (arch.dieFps || 12)));
      img = (imgs.xbill_die && imgs.xbill_die[idx]) || imgs[arch.dieFrames[idx]] || null;
    } else {
      const n = arch.walkFrames.length;
      const idx = Math.floor((this.time + (e.animPhase || 0)) * (arch.walkFps || 10)) % n;
      img = (imgs.xbill_loop && imgs.xbill_loop[idx]) || imgs[arch.walkFrames[idx]] || null;
    }

    ctx.save();
    ctx.translate(e.x, e.y);

    // Flat ground shadow (low alpha) — grounds the creature and adds contrast.
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, size * 0.34, size * 0.4, size * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Optional horizontal flip by travel direction (the ONLY orientation change).
    if (e.faceLeft) ctx.scale(-1, 1);

    if (img) {
      // The walk + death frames are all uniform 25x38, so normalizing on the
      // larger side keeps a constant scale (no jump when the death anim starts).
      const iw = img.width || size;
      const ih = img.height || size;
      const k = size / Math.max(iw, ih);
      const dw = iw * k;
      const dh = ih * k;
      // Tiny pixel-art upscaled ~2x: disable smoothing so it stays crisp/blocky
      // (the rest of the game keeps smoothing on for the hi-res UFO/tank sprites).
      const prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      ctx.imageSmoothingEnabled = prevSmooth;
    } else {
      this._drawXbillFallback(ctx, size, arch.color || "#cfd2d6");
    }

    // Health bar above it when damaged (suppressed at maxHp 1 by the guard).
    // Hidden while dying so it doesn't hover over the death animation.
    if (!dying && e.maxHp > 1 && e.hp < e.maxHp) {
      // Undo any flip so the bar isn't mirrored.
      if (e.faceLeft) ctx.scale(-1, 1);
      drawHealthBar(ctx, size, -size * 0.5 - 6, e.hp, e.maxHp);
    }

    ctx.restore();
  }

  // Procedural xBill: a rounded grey body with little legs + two eyes, used when
  // a sprite frame is missing. Drawn upright (no facing rotation), like the art.
  _drawXbillFallback(ctx, size, color) {
    const r = size * 0.4;
    // Legs (a few short stubs under the body).
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = Math.max(1.5, size * 0.05);
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      const lx = i * r * 0.45;
      ctx.beginPath();
      ctx.moveTo(lx, r * 0.4);
      ctx.lineTo(lx + Math.sign(i) * r * 0.18, r * 0.78);
      ctx.stroke();
    }
    // Body.
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = Math.max(1.5, size * 0.05);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Eyes.
    ctx.fillStyle = "#1a1a20";
    ctx.beginPath();
    ctx.arc(-r * 0.32, -r * 0.18, r * 0.16, 0, Math.PI * 2);
    ctx.arc(r * 0.32, -r * 0.18, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  // Procedural UFO: a domed saucer pointing "up" (-Y) so it lines up with the
  // sprite facing convention. Used only when the sprite is missing.
  _drawUfoFallback(ctx, size, color) {
    const r = size / 2;
    // Saucer body (ellipse).
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Glass dome (toward the "front"/-Y).
    ctx.fillStyle = "rgba(180,220,255,0.85)";
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.18, r * 0.45, r * 0.4, 0, Math.PI, 0);
    ctx.fill();
    // Nose marker so the facing direction is legible.
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.arc(0, -r * 0.5, r * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  // -------------------------------------------------------------------------
  // Accessors / serialization
  // -------------------------------------------------------------------------

  // The live enemy list (the SAME array the shell system should treat as kill
  // targets). Callers concat this with the player to build getTanks().
  getList() {
    return this.enemies;
  }

  aliveCount() {
    let n = 0;
    for (const e of this.enemies) if (e.alive !== false) n++;
    return n;
  }

  // Plain serializable view for the debug harness / future netcode.
  snapshot() {
    return this.enemies.map((e) => ({
      x: round(e.x),
      y: round(e.y),
      alive: e.alive !== false,
      kind: e.kind,
      hp: e.hp,
      maxHp: e.maxHp,
    }));
  }
}

function round(v, dp = 2) {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

// Factory so callers can `create({ ... })` without `new`.
export function create(opts) {
  return new EnemySystem(opts);
}

export default { create, EnemySystem, ENEMY_CONFIG, ARCHETYPES, ENEMY_KINDS, XBILL_DIE_TIME, drawHealthBar };
