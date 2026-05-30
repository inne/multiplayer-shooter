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
export const ENEMY_CONFIG = {
  RADIUS: 26, // collision circle (world px); matches the bigger drawn UFO
  DRAW_SIZE: 58, // target on-screen UFO size (world px); sprites are ~124px
  HOVER_BOB: 3, // vertical bob amplitude (world px)
  HOVER_RATE: 2.4, // bob cycles/sec (rad/s applied to a sine)
  TURRET_TURN: 3.0, // aim slew rate (rad/s) toward the player
};

// Per-kind behavioural parameters. `bullet` keys a laser sprite for shells.js.
export const ARCHETYPES = {
  beige: {
    sprite: "ufo_beige",
    bullet: "laser_green",
    color: "#d8c9a0",
    hp: 1, // hits to destroy (shells deal 1) — fragile glass cannon
    speed: 0, // stationary
    fireCooldown: 2.3, // seconds between shots
    fireJitter: 0.8, // +/- randomization so a group doesn't volley in sync
    move: "still",
    drops: false,
  },
  green: {
    sprite: "ufo_green",
    spriteDmg: "ufo_green_dmg",
    bullet: "laser_green",
    color: "#7fd86b",
    hp: 2, // tougher roamer
    speed: 55, // gentle wander
    fireCooldown: 2.0,
    fireJitter: 0.7,
    move: "roam",
    drops: false,
  },
  pink: {
    sprite: "ufo_pink",
    bullet: "laser_pink",
    color: "#f06bb0",
    hp: 2, // sturdy seeker
    speed: 95, // chases the player
    fireCooldown: 1.6,
    fireJitter: 0.5,
    move: "seek",
    drops: false,
    shotSpeedScale: 1.45, // "slightly faster shot" (dodge it)
  },
  yellow: {
    sprite: "ufo_yellow",
    bullet: "laser_green",
    color: "#ffd86b",
    hp: 3, // tanky miner
    speed: 60, // roams while mining
    fireCooldown: 2.6,
    fireJitter: 0.9,
    move: "roam",
    drops: true,
    mineCooldown: 3.2, // seconds between mine drops
    mineJitter: 1.0,
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
    const enemy = {
      id: `ufo_${this._nextId++}`,
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
      radius: this.cfg.RADIUS,
      bullet: arch.bullet, // shells.render uses this as the laser sprite key
      // --- AI timers (staggered so a group doesn't act in lockstep) ---
      fireTimer: arch.fireCooldown * (0.4 + 0.6 * r()),
      mineTimer: arch.drops ? arch.mineCooldown * (0.4 + 0.6 * r()) : 0,
      wanderAngle: r() * Math.PI * 2, // current roam heading
      wanderTimer: 0.8 + r() * 1.4, // time until the roamer repicks a heading
      bobPhase: r() * Math.PI * 2, // hover-bob offset (presentation only)
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
      if (this.enemies[i].alive === false) {
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
    const r = this.rng;

    for (const e of this.enemies) {
      if (e.alive === false) continue;
      const arch = ARCHETYPES[e.kind];
      if (!arch) continue;

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

      // --- 3) Fire on a cooldown ------------------------------------------
      e.fireTimer -= dt;
      if (e.fireTimer <= 0) {
        // Reset the cooldown first (so a failed/capped fire still re-arms).
        e.fireTimer =
          arch.fireCooldown + (r() * 2 - 1) * (arch.fireJitter || 0);
        if (targetAlive && shells && typeof shells.fire === "function") {
          this._fire(e, arch, shells);
        }
      }

      // --- 4) Mine drops (yellow) -----------------------------------------
      if (arch.drops) {
        e.mineTimer -= dt;
        if (e.mineTimer <= 0) {
          e.mineTimer =
            arch.mineCooldown + (r() * 2 - 1) * (arch.mineJitter || 0);
          this._dropMine(e, world);
        }
      }
    }
  }

  // Archetype movement. Stationary stays put; roamers wander with periodic
  // heading changes; seekers steer toward the player. All movement is resolved
  // against the map walls (circle-vs-AABB slide) when a map is provided.
  _move(e, arch, dt, player, map, r) {
    const speed = arch.speed || 0;

    if (arch.move === "still" || speed <= 0) {
      e.vx = 0;
      e.vy = 0;
      return;
    }

    if (arch.move === "seek" && player && player.alive !== false) {
      const a = Math.atan2(player.y - e.y, player.x - e.x);
      e.vx = Math.cos(a) * speed;
      e.vy = Math.sin(a) * speed;
    } else {
      // Roam: drift along wanderAngle, repicking a new heading periodically or
      // when we bump a wall (resolved position differs from the integrated one).
      e.wanderTimer -= dt;
      if (e.wanderTimer <= 0) {
        e.wanderTimer = 0.8 + r() * 1.6;
        e.wanderAngle += (r() * 2 - 1) * (Math.PI * 0.6);
      }
      e.vx = Math.cos(e.wanderAngle) * speed;
      e.vy = Math.sin(e.wanderAngle) * speed;
    }

    // Integrate, then slide against walls.
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    if (map && typeof map.resolveCircleVsWalls === "function") {
      const res = map.resolveCircleVsWalls(e.x, e.y, e.radius);
      if (res) {
        const bumped =
          Math.abs(res.x - e.x) > 0.01 || Math.abs(res.y - e.y) > 0.01;
        e.x = res.x;
        e.y = res.y;
        // A roamer that hit a wall turns away from it next.
        if (bumped && arch.move !== "seek") {
          e.wanderAngle += Math.PI * (0.5 + r() * 0.5);
          e.wanderTimer = 0.6 + r() * 1.0;
        }
      }
    }
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
      if (e.alive === false) continue;
      const arch = ARCHETYPES[e.kind] || {};

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

      // Low-hp green roamer shows its battered "dmg" sprite when available.
      const dmgState =
        e.maxHp > 1 && e.hp <= Math.ceil(e.maxHp / 2);
      const img =
        (dmgState && arch.spriteDmg && imgs[arch.spriteDmg]) ||
        (arch.sprite && imgs[arch.sprite]) ||
        (arch.spriteDmg && imgs[arch.spriteDmg]) ||
        null;

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

export default { create, EnemySystem, ENEMY_CONFIG, ARCHETYPES, ENEMY_KINDS, drawHealthBar };
