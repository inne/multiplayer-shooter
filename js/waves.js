// waves.js — escalating wave manager for the top-down tank game.
//
// Owns ONLY the "what to spawn, where, and when" policy for enemy waves. It
// does NOT create enemy entities itself — the host injects a `spawnEnemy(kind,
// x, y)` factory so the actual entity shape (AI, sprites, shell wiring) lives in
// the enemy module. This keeps the wave manager a tiny, deterministic policy
// layer whose state is plain/serializable for later host-authoritative netcode.
//
// Public API:
//   create({ spawnEnemy, getEnemies, getPlayer, spawns, config? }) -> WaveManager
//   wm.update(dt)        -> void   (advances inter-wave timer, starts waves)
//   wm.currentWave()     -> number (1-based; 0 before the first wave starts)
//   wm.enemiesLeft()     -> number (alive enemies remaining this wave)
//   wm.snapshot()        -> { wave, enemiesLeft, state, nextWaveIn }
//   wm.reset()           -> void   (back to pre-wave-1; used on player respawn)
//
// Collaborators (injected via create):
//   spawnEnemy(kind, x, y) : create + register an enemy entity, returns it (or
//                            null). kind is one of KINDS below.
//   getEnemies()           : -> array of live enemy entities ({ alive, ... }).
//   getPlayer()            : -> the player tank ({ x, y, alive }) or null.
//   spawns                 : array of { x, y } spawn points (world px). May also
//                            be a function returning that array.
//
// Plain Canvas 2D project, ES module, no build step, node --check clean.

// Enemy archetypes (kinds), matching the UFO sprites / AI in the enemy module.
export const KINDS = {
  BEIGE: "beige",   // stationary turret
  GREEN: "green",   // roamer
  PINK: "pink",     // seeker
  YELLOW: "yellow", // miner
  XBILL: "xbill",   // ground creature — melee rush (chases + bites on contact, no projectile)
};

export const WAVE_CONFIG = {
  // Seconds to wait after the last enemy dies before the next wave spawns.
  INTER_WAVE_DELAY: 2.0,
  // Small grace period before wave 1 actually spawns (lets the scene settle).
  FIRST_WAVE_DELAY: 0.6,
  // From this wave on, compositions are generated procedurally (blend + grow).
  // Descriptive only — _composition() actually keys off EARLY_WAVES.length
  // (now 6, since xBill was introduced as hand-authored wave 5).
  BLEND_FROM: 6,
  // Hard cap so a runaway wave can never spawn more enemies than spawn points
  // would sanely allow to stack (entities still spread across farthest points).
  MAX_ENEMIES: 24,
};

// Hand-authored escalation for the early waves (the "teaching" curve):
//   1: a couple beige        2: + green
//   3: + pink                4: + yellow
//   5: + xBill (a melee rush of the new ground creature)
// Each entry is an array of kinds; its length is that wave's enemy count.
const EARLY_WAVES = [
  [KINDS.BEIGE, KINDS.BEIGE],                                   // wave 1
  [KINDS.BEIGE, KINDS.BEIGE, KINDS.GREEN],                      // wave 2
  [KINDS.BEIGE, KINDS.BEIGE, KINDS.GREEN, KINDS.PINK],          // wave 3
  [KINDS.BEIGE, KINDS.BEIGE, KINDS.GREEN, KINDS.PINK, KINDS.YELLOW], // wave 4
  [KINDS.BEIGE, KINDS.GREEN, KINDS.XBILL, KINDS.XBILL],         // wave 5: meet the xBills (a melee rush)
];

// Lifecycle states (kept as plain strings for snapshot friendliness).
const STATE = {
  IDLE: "idle",         // before wave 1 (waiting out FIRST_WAVE_DELAY)
  ACTIVE: "active",     // enemies alive, wave in progress
  COOLDOWN: "cooldown", // all dead, counting down to the next wave
};

export class WaveManager {
  constructor(opts = {}) {
    this.spawnEnemy = opts.spawnEnemy || (() => null);
    this.getEnemies = opts.getEnemies || (() => []);
    this.getPlayer = opts.getPlayer || (() => null);
    this._spawns = opts.spawns || [];

    this.cfg = { ...WAVE_CONFIG, ...(opts.config || {}) };

    this.wave = 0;              // 1-based; 0 = not started yet
    this.state = STATE.IDLE;
    this.timer = this.cfg.FIRST_WAVE_DELAY; // countdown for IDLE / COOLDOWN
  }

  // ---- public queries ------------------------------------------------------

  currentWave() {
    return this.wave;
  }

  // Alive enemies remaining in the current wave.
  enemiesLeft() {
    return this._aliveCount();
  }

  // Seconds remaining until the next wave spawns (0 when not waiting).
  nextWaveIn() {
    return this.state === STATE.ACTIVE ? 0 : Math.max(0, this.timer);
  }

  snapshot() {
    return {
      wave: this.wave,
      enemiesLeft: this.enemiesLeft(),
      state: this.state,
      nextWaveIn: round(this.nextWaveIn()),
    };
  }

  // Back to the pre-wave-1 state. Useful when the player respawns / restarts.
  // Does NOT remove existing enemies (the host owns the enemy list); callers
  // that want a clean slate should clear enemies before calling reset().
  reset() {
    this.wave = 0;
    this.state = STATE.IDLE;
    this.timer = this.cfg.FIRST_WAVE_DELAY;
  }

  // ---- update loop ---------------------------------------------------------

  update(dt) {
    if (!(dt > 0)) return;

    switch (this.state) {
      case STATE.IDLE:
        // Grace period before the first wave.
        this.timer -= dt;
        if (this.timer <= 0) this._startNextWave();
        break;

      case STATE.ACTIVE:
        // Wave continues until every spawned enemy is dead.
        if (this._aliveCount() === 0) {
          this.state = STATE.COOLDOWN;
          this.timer = this.cfg.INTER_WAVE_DELAY;
        }
        break;

      case STATE.COOLDOWN:
        this.timer -= dt;
        if (this.timer <= 0) this._startNextWave();
        break;
    }
  }

  // ---- internals -----------------------------------------------------------

  _aliveCount() {
    const list = this.getEnemies() || [];
    let n = 0;
    for (const e of list) if (e && e.alive !== false) n++;
    return n;
  }

  _spawnPoints() {
    const s = typeof this._spawns === "function" ? this._spawns() : this._spawns;
    return Array.isArray(s) ? s : [];
  }

  _startNextWave() {
    this.wave += 1;
    const comp = this._composition(this.wave);
    const points = this._farthestSpawns(comp.length);

    // Subtle difficulty ramp: +1 HP to every enemy each 3 waves cleared.
    const hpBonus = Math.floor((this.wave - 1) / 3);

    for (let i = 0; i < comp.length; i++) {
      // Spread across the farthest spawn points; wrap if a wave has more
      // enemies than spawn points so larger waves still stack at the far side.
      const p = points.length ? points[i % points.length] : { x: 0, y: 0 };
      this.spawnEnemy(comp[i], p.x, p.y, hpBonus);
    }

    this.state = STATE.ACTIVE;
    this.timer = 0;
  }

  // Decide the kinds list for a given 1-based wave number.
  //   waves 1-4: hand-authored EARLY_WAVES.
  //   wave 5+:   blend all four archetypes and grow the count each wave.
  _composition(wave) {
    if (wave >= 1 && wave <= EARLY_WAVES.length) {
      return EARLY_WAVES[wave - 1].slice();
    }
    return this._blendedComposition(wave);
  }

  // Procedural escalation past the early curve. Counts grow with the wave
  // number; the mix is weighted toward the cheaper archetypes but always
  // includes the tougher seeker/miner kinds and a steady trickle of melee
  // xBills. Deterministic for a given wave. (EARLY_WAVES now runs through wave
  // 5, so this branch first fires at wave 6; `over` self-corrects off
  // EARLY_WAVES.length, so the count ramp stays smooth regardless of
  // WAVE_CONFIG.BLEND_FROM.)
  _blendedComposition(wave) {
    // Total enemy count grows roughly linearly past the early curve, capped.
    const over = wave - EARLY_WAVES.length; // >= 1 at the first blended wave
    const total = Math.min(this.cfg.MAX_ENEMIES, 5 + over * 2);

    // Weighted draw order: beige most common, then green/pink/yellow with a
    // couple of melee xBills mixed in. Built by cycling a weighted pattern so
    // the mix is stable and serializable (no RNG -> reproducible for replay).
    const pattern = [
      KINDS.BEIGE,
      KINDS.GREEN,
      KINDS.XBILL,
      KINDS.PINK,
      KINDS.GREEN,
      KINDS.YELLOW,
      KINDS.BEIGE,
      KINDS.XBILL,
      KINDS.PINK,
    ];

    const comp = [];
    for (let i = 0; i < total; i++) {
      // Offset the cycle by the wave so successive waves don't look identical.
      comp.push(pattern[(i + wave) % pattern.length]);
    }
    return comp;
  }

  // Return up to `count` spawn points, ordered FARTHEST-from-the-player first.
  // If the player is missing, fall back to the raw spawn order. Always returns
  // at least one point when any spawns exist (so spawning never silently
  // no-ops on a degenerate map).
  _farthestSpawns(count) {
    const points = this._spawnPoints();
    if (points.length === 0) return [];

    const player = this.getPlayer();
    const ranked = points.slice();

    if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
      ranked.sort((a, b) => dist2(b, player) - dist2(a, player));
    }

    // Take the farthest `count` (at least 1). When a wave needs more enemies
    // than spawn points, the caller wraps over this list.
    const n = Math.max(1, Math.min(count, ranked.length));
    return ranked.slice(0, n);
  }
}

// ---- helpers ---------------------------------------------------------------

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function round(v, dp = 2) {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

// Factory so callers can `create({ ... })` without `new`.
export function create(opts) {
  return new WaveManager(opts);
}

export default { create, WaveManager, WAVE_CONFIG, KINDS };
