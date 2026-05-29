// enemies.js — spawning, AI, damage, death
//
// Owns: state.enemies, state.wave, state.enemiesRemaining.
// Talks to the rest of the game only through:
//   - exported functions (initEnemies/update/applyDamage/getEnemyMeshes/resetEnemies)
//   - the shared `state` object (read player/colliders, write enemy fields)
//   - the §2.1 event queue (pushes enemyDeath / playerHurt / waveStart / waveCleared)
//   - player.damagePlayer() for the ONLY legal way to hurt the player
//
// All Three.js objects come from the single importmapped 'three'.

import * as THREE from 'three';
import { ENEMY_HALF, ARENA_HALF } from './scene.js';
import * as scene from './scene.js';
import { damagePlayer } from './player.js';

// ---- toon / cel-shaded look (ADDITIVE, purely visual) ---------------------
// Cartoon enemies use MeshToonMaterial with a tiny stepped gradient ramp plus a
// thin inverted-hull outline. SELF-CONTAINED CC0 character models (KayKit
// Skeletons pack — all textures embedded in the .glb, zero external 404s) are
// loaded asynchronously, re-skinned with toon materials, and animated via an
// AnimationMixer when the rigged clips exist. If an asset is absent or fails to
// load we keep the procedural humanoid that buildEnemyMesh() returns
// synchronously. None of this touches AI, networking, or the host/client
// snapshot fields — buildEnemyMesh() still returns immediately with
// userData.body set, and the flash/death-fade paths keep working on whatever
// meshes end up in the group. Per-mesh animation state lives on
// root.userData.anim so update()/interpolateEnemies() can advance the mixer and
// crossfade Idle/Run/Attack/Hit/Death without altering any sim field.

// Self-contained variant models (KayKit Skeletons, CC0). Each is a fully
// embedded GLB (verified: `strings *.glb | grep -iE '\.png|\.jpg|\.bin'` prints
// nothing). Spawns round-robin through these for visual variety. If a file is
// missing/unparseable its slot resolves to null and that enemy keeps the
// procedural humanoid — every variant has an independent fallback.
const CHAR_MODEL_VARIANTS = [
  'assets/enemies/Skeleton_Warrior.glb',
  'assets/enemies/Skeleton_Rogue.glb',
  'assets/enemies/Skeleton_Mage.glb',
  'assets/enemies/Skeleton_Minion.glb',
];

// Animation clip-name candidates per logical state (first match in the GLB's
// clip list wins). These cover the KayKit Skeletons naming; if none match the
// mixer simply isn't driven for that state and the model rests in bind pose.
const CLIP_CANDIDATES = {
  idle:   ['Idle', 'Idle_Combat', 'Idle_B', 'Unarmed_Idle'],
  run:    ['Running_A', 'Running_B', 'Running_C', 'Walking_A', 'Walking_B'],
  attack: ['1H_Melee_Attack_Chop', '2H_Melee_Attack_Chop', 'Unarmed_Melee_Attack_Punch_A', 'Spellcast_Shoot'],
  hit:    ['Hit_A', 'Hit_B', 'Block_Hit'],
  death:  ['Death_A', 'Death_B', 'Death_C_Skeletons'],
};

const OUTLINE_COLOR   = 0x12100e;   // near-black outline for the toon edge
const OUTLINE_SCALE   = 0.04;       // inverted-hull thickness (relative grow)

// Lazily built shared resources so we never allocate per enemy.
let _toonRamp = null;       // THREE.DataTexture used as gradientMap
let _gltfLoaderPromise = null; // resolves to a GLTFLoader instance (or null)
// One cached load promise per variant index; each resolves to a loaded
// { scene, animations } gltf (or null on failure). Templates are cloned
// per-enemy with SkeletonUtils so each enemy gets an independent skinned rig.
const _variantPromises = [];
const _variantTried = [];   // per-variant 'off' marker after a decisive failure
let _skeletonUtilsPromise = null; // resolves to the SkeletonUtils module (or null)
let _spawnVariantCursor = 0;      // round-robin index for spawned enemies

// A 4-step grayscale ramp -> hard cartoon bands when used as a toon gradientMap.
function toonRamp() {
  if (_toonRamp) return _toonRamp;
  const steps = new Uint8Array([60, 130, 200, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _toonRamp = tex;
  return _toonRamp;
}

// MeshToonMaterial keeps `emissive`/`emissiveIntensity` (used by the hit flash)
// and `transparent`/`opacity` (used by the death fade), so both existing paths
// keep working unchanged after the material swap.
function toonMat(color, opts = {}) {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: toonRamp(),
    transparent: true,
    opacity: 1,
    emissive: opts.emissive !== undefined ? opts.emissive : 0x000000,
    emissiveIntensity: opts.emissiveIntensity !== undefined ? opts.emissiveIntensity : 0,
  });
}

// Build a thin dark inverted-hull outline for a mesh's geometry. BackSide +
// slight grow gives a cheap cartoon edge that needs no post-processing, so the
// single-pass scene.render() path is preserved.
function addOutline(mesh) {
  if (!mesh || !mesh.geometry) return;
  // A plain Mesh child of a SkinnedMesh would render in bind pose (detached from
  // the bones), so skip the inverted-hull on skinned geometry — the toon bands +
  // bloom still carry the cartoon look there. Boxy procedural parts keep it.
  if (mesh.isSkinnedMesh) return;
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({
      color: OUTLINE_COLOR,
      side: THREE.BackSide,
      transparent: true,
      opacity: 1,
    }),
  );
  outline.scale.multiplyScalar(1 + OUTLINE_SCALE);
  // Tag so the flash() guard skips outlines (they have no emissive) and so the
  // death-fade traversal still fades them along with the body.
  outline.userData.isOutline = true;
  mesh.add(outline);
}

// Resolve a GLTFLoader once (addon import via the importmap). Returns null if
// the addon can't be imported so callers fall back to the procedural mesh.
function getGltfLoader() {
  if (_gltfLoaderPromise) return _gltfLoaderPromise;
  _gltfLoaderPromise = import('three/addons/loaders/GLTFLoader.js')
    .then((m) => new m.GLTFLoader())
    .catch(() => null);
  return _gltfLoaderPromise;
}

// Resolve SkeletonUtils once. Needed to clone a SkinnedMesh hierarchy so each
// enemy gets its own bones/mixer (Object3D.clone() shares the skeleton and
// breaks per-instance animation). Returns null if the addon can't be imported,
// in which case the caller falls back to the procedural mesh.
function getSkeletonUtils() {
  if (_skeletonUtilsPromise) return _skeletonUtilsPromise;
  _skeletonUtilsPromise = import('three/addons/utils/SkeletonUtils.js')
    .catch(() => null);
  return _skeletonUtilsPromise;
}

// Load (once per variant) a self-contained CC0 toon character model. Resolves to
// a template { scene, animations } gltf, or null on any failure (missing file,
// bad parse). The scene/animations are cloned per enemy by upgradeToCharModel.
function loadCharVariant(index) {
  if (_variantPromises[index]) return _variantPromises[index];
  const path = CHAR_MODEL_VARIANTS[index];
  if (!path) { _variantPromises[index] = Promise.resolve(null); return _variantPromises[index]; }
  _variantPromises[index] = getGltfLoader().then((loader) => {
    if (!loader) return null;
    return new Promise((resolve) => {
      loader.load(
        path,
        (gltf) => resolve(
          gltf && gltf.scene
            ? { scene: gltf.scene, animations: gltf.animations || [] }
            : null,
        ),
        undefined,
        () => resolve(null),
      );
    });
  }).catch(() => null);
  return _variantPromises[index];
}

// Pick the first clip whose name matches any candidate for a logical state.
function findClip(animations, candidates) {
  if (!animations || !animations.length) return null;
  for (const name of candidates) {
    const clip = animations.find((a) => a.name === name);
    if (clip) return clip;
  }
  return null;
}

// ---- tunables -------------------------------------------------------------
const ATTACK_RANGE     = 1.6;   // distance (m) within which an enemy can melee
const ENEMY_DAMAGE     = 10;    // damage per melee hit
const ENEMY_SPEED      = 3.0;   // base chase speed (m/s); scaled mildly per wave
const ATTACK_COOLDOWN  = 1.0;   // seconds between melee hits from one enemy
const ENEMY_MAX_HEALTH = 100;
const SEPARATION_RADIUS = 1.2;  // enemies push apart inside this radius
const SEPARATION_FORCE  = 6.0;  // how hard they push (m/s contribution)
const WAVE_DELAY       = 2.0;   // seconds of breather between cleared and next wave
const DYING_TIME       = 0.6;   // seconds of death animation before removal
const ENEMY_HEAD_Y     = 1.55;  // local y (m) of head center for headshot tests
const SPAWN_STAGGER    = 0.18;  // seconds between individual spawns within a wave

const waveSize = (w) => 3 + 2 * w;

// Score scales with wave so later, tougher waves feel rewarding.
const scoreForWave = (w) => 100 + 25 * (w - 1);

// ---- module-scoped temporaries (no per-frame allocation) ------------------
const _toPlayer = new THREE.Vector3();
const _desired  = new THREE.Vector3();
const _sep      = new THREE.Vector3();
const _delta    = new THREE.Vector3();
const _next     = new THREE.Vector3();

let _nextId = 1;          // monotonically increasing enemy id
let _spawnPoints = null;  // cached scene.spawnPoints()
let _waveTimer = 0;       // counts down the inter-wave delay
let _spawnQueue = [];     // pending spawns for the current wave (staggered)
let _spawnTimer = 0;      // countdown to next staggered spawn

// Simulation mode: 'sp' (single-player) | 'host' (authoritative) | 'client'.
// In 'client' mode the authoritative update() no-ops and enemies are driven
// purely by host snapshots (applyEnemySnapshot + interpolateEnemies).
let _simMode = 'sp';

// Bob phase counter for client-side interpolated enemies (purely cosmetic).
const _BOB_RATE = 6;

// ===========================================================================
// Lifecycle
// ===========================================================================

export function initEnemies(state) {
  // Wipe anything left over (defensive — main calls this once at boot).
  removeAllMeshes(state);
  state.enemies = [];
  state.wave = 0;
  state.enemiesRemaining = 0;

  _nextId = 1;
  _waveTimer = 0;
  _spawnQueue = [];
  _spawnTimer = 0;
  _spawnPoints = scene.spawnPoints();
}

export function resetEnemies(state) {
  removeAllMeshes(state);
  state.enemies.length = 0;
  state.wave = 0;
  state.enemiesRemaining = 0;

  _nextId = 1;
  _waveTimer = 0;
  _spawnQueue.length = 0;
  _spawnTimer = 0;
  // spawn points are static; keep cache but refresh in case scene rebuilt.
  _spawnPoints = scene.spawnPoints();
}

function removeAllMeshes(state) {
  if (!state.enemies) return;
  for (const e of state.enemies) {
    if (e.mesh && e.mesh.parent) e.mesh.parent.remove(e.mesh);
    disposeMesh(e.mesh);
  }
}

// ===========================================================================
// Per-frame update
// ===========================================================================

export function update(state, dt) {
  // CLIENT mode: enemies are host-authoritative; never run local AI/sim here
  // even if main.js calls update() defensively.
  if (_simMode === 'client') return;
  if (state.phase !== 'playing') return;

  // --- drain any staggered spawns queued for the active wave ---
  if (_spawnQueue.length > 0) {
    _spawnTimer -= dt;
    while (_spawnTimer <= 0 && _spawnQueue.length > 0) {
      const spawn = _spawnQueue.shift();
      spawnEnemy(state, spawn.point, spawn.wave);
      _spawnTimer += SPAWN_STAGGER;
    }
  }

  // --- wave management ---
  // A wave is "in progress" while any enemy is alive OR still queued to spawn.
  const liveCount = countLive(state);
  if (liveCount === 0 && _spawnQueue.length === 0) {
    // Breather between waves, then queue the next one.
    _waveTimer -= dt;
    if (_waveTimer <= 0) {
      startNextWave(state);
    }
  }

  // --- per-enemy simulation ---
  const player = state.player;
  for (let i = state.enemies.length - 1; i >= 0; i--) {
    const e = state.enemies[i];

    if (e.state === 'dying') {
      // Trigger the skeletal death clip once (if present), then run the existing
      // transform fade which guarantees removal regardless of clip availability.
      if (!e._deathTriggered) { driveEnemyAnim(e, 0, 'idle', 'death'); e._deathTriggered = true; }
      else driveEnemyAnim(e, dt, 'idle');
      animateDeath(e, dt);
      if (e.state === 'dead') {
        if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
        disposeMesh(e.mesh);
        state.enemies.splice(i, 1);
      }
      continue;
    }

    if (!e.alive) continue;

    // ----- steering: chase the player -----
    _toPlayer.set(
      player.position.x - e.position.x,
      0,
      player.position.z - e.position.z,
    );
    const distToPlayer = _toPlayer.length();

    _desired.set(0, 0, 0);
    if (distToPlayer > 0.0001) {
      _desired.copy(_toPlayer).multiplyScalar(1 / distToPlayer); // normalized dir
    }
    _desired.multiplyScalar(e.speed);

    // ----- separation: avoid stacking on top of other enemies -----
    accumulateSeparation(state, e, _sep);
    _desired.add(_sep);

    // Set planar velocity from steering (enemies stay on the ground, y=0).
    e.velocity.x = _desired.x;
    e.velocity.z = _desired.z;
    e.velocity.y = 0;

    // ----- attack vs chase state -----
    let animTrigger = null;
    if (distToPlayer <= ATTACK_RANGE && player.alive) {
      e.state = 'attacking';
      // Stop pushing into the player while meleeing so they don't shove him.
      e.velocity.x *= 0.15;
      e.velocity.z *= 0.15;

      if (state.time - e.lastAttackTime >= ATTACK_COOLDOWN) {
        e.lastAttackTime = state.time;
        damagePlayer(state, ENEMY_DAMAGE);                 // ONLY legal damage path
        state.events.push({ type: 'playerHurt', amount: ENEMY_DAMAGE });
        // little lunge for visual punch
        e.mesh.position.y = 0.08;
        animTrigger = 'attack';                            // play the melee swing
      }
    } else {
      e.state = 'chasing';
    }

    // ----- integrate + collide -----
    integrateAndCollide(state, e, dt);

    // ----- sync mesh + face the player -----
    e.mesh.position.x = e.position.x;
    e.mesh.position.z = e.position.z;
    // ease the lunge bob back down
    e.mesh.position.y += (0 - e.mesh.position.y) * Math.min(1, dt * 10);

    if (distToPlayer > 0.0001) {
      // Face toward the player (yaw only). atan2 over (dx, dz) gives a yaw
      // where 0 == looking toward -Z, matching the project's yaw convention.
      const yaw = Math.atan2(_toPlayer.x, _toPlayer.z);
      e.mesh.rotation.y = yaw;
    }

    // Drive the skeletal animation when a model is loaded: Run while chasing,
    // Idle while attacking, one-shot the melee swing on a hit. When no mixer
    // exists this is a cheap no-op and the procedural bob below carries the life.
    const desiredLoop = (e.state === 'chasing' && distToPlayer > 0.0001) ? 'run' : 'idle';
    driveEnemyAnim(e, dt, desiredLoop, animTrigger);

    // subtle idle/run bob for life. When a skeletal clip is playing it already
    // animates the body, so damp the procedural bob to avoid double motion.
    e.bob += dt * (6 + e.speed);
    const hasAnim = e.mesh.userData.anim && e.mesh.userData.anim.mixer;
    const bobAmt = (e.state === 'chasing' ? 0.06 : 0.02) * (hasAnim ? 0.25 : 1);
    e.body.position.y = e.bodyBaseY + Math.abs(Math.sin(e.bob)) * bobAmt;
  }

  // Keep the public counter honest: alive (not dying/dead) enemies remaining.
  const remaining = countLive(state) + _spawnQueue.length;
  if (remaining !== state.enemiesRemaining) {
    state.enemiesRemaining = remaining;
    if (remaining === 0 && state.wave > 0) {
      state.events.push({ type: 'waveCleared', wave: state.wave });
      _waveTimer = WAVE_DELAY; // start the breather before next wave
    }
  }
}

// ===========================================================================
// Client snapshot-apply mode (host-authoritative multiplayer)
//
// On a CLIENT, main.js does NOT call update(). Instead it feeds host snapshots
// in via applyEnemySnapshot() (on snapshot arrival) and smooths motion every
// frame with interpolateEnemies(). No AI, no damage, no spawning happens here.
// Client enemy records reuse the same {id, mesh, body, state, health} fields as
// the host sim plus interpolation fields {prevPos, targetPos, prevYaw,
// targetYaw, lastT, bob, dieTimer} so getEnemyMeshes / disposeMesh / animateDeath
// all keep working unchanged.
// ===========================================================================

// Set/clear the simulation mode. 'host'|'sp' run the authoritative sim as today;
// 'client' makes update() a no-op and switches to snapshot apply.
export function setSimMode(state, mode) {
  _simMode = (mode === 'host' || mode === 'client') ? mode : 'sp';
}

// CLIENT-ONLY. Diff a snapshot's enemy array against state.enemies by id and set
// up interpolation targets. enemyList = [{ id, pos:[x,y,z], yaw, state, hp, max }].
// renderTime is the host time the snapshot represents; stored per-record so the
// frame-by-frame interpolator can position between the two most recent samples.
export function applyEnemySnapshot(state, enemyList, renderTime) {
  if (!state.enemies) state.enemies = [];
  const list = enemyList || [];

  // Build a quick lookup of incoming ids for the removal pass.
  const seen = new Set();
  for (const s of list) seen.add(s.id);

  // --- new + existing ---
  for (const s of list) {
    const px = s.pos[0], py = s.pos[1], pz = s.pos[2];
    let e = findEnemy(state, s.id);

    if (!e) {
      // New enemy id: build a mesh and a client-side record.
      const mesh = buildEnemyMesh();
      mesh.position.set(px, py, pz);
      mesh.rotation.y = s.yaw || 0;
      state.scene.add(mesh);

      // Tag for parity with the host (raycasts are non-authoritative on a client
      // but keep the same userData so any shared code paths resolve ids/headshots).
      mesh.userData.enemyId = s.id;
      mesh.userData.headY = ENEMY_HEAD_Y;
      mesh.traverse((o) => {
        o.userData.enemyId = s.id;
        o.userData.headY = ENEMY_HEAD_Y;
      });

      const body = mesh.userData.body;
      e = {
        id: s.id,
        mesh,
        body,
        bodyBaseY: body.position.y,
        position: new THREE.Vector3(px, py, pz),
        velocity: new THREE.Vector3(0, 0, 0),
        health: s.hp,
        maxHealth: s.max,
        alive: s.state !== 'dying' && s.state !== 'dead',
        state: s.state || 'chasing',
        headY: ENEMY_HEAD_Y,
        scoreValue: 0,
        speed: ENEMY_SPEED,
        bob: Math.random() * Math.PI * 2,
        dieTimer: 0,
        // interpolation fields
        prevPos: new THREE.Vector3(px, py, pz),
        targetPos: new THREE.Vector3(px, py, pz),
        prevYaw: s.yaw || 0,
        targetYaw: s.yaw || 0,
        prevT: renderTime,
        lastT: renderTime,
      };
      state.enemies.push(e);
    } else {
      // Existing enemy: shift current target -> prev, set new target.
      e.prevPos.copy(e.targetPos);
      e.prevYaw = e.targetYaw;
      e.prevT = e.lastT;

      e.targetPos.set(px, py, pz);
      e.targetYaw = s.yaw || 0;
      e.lastT = renderTime;

      e.health = s.hp;
      e.maxHealth = s.max;
      e.state = s.state || e.state;
      e.alive = s.state !== 'dying' && s.state !== 'dead';
    }
  }

  // --- removals: present locally but absent from snapshot ---
  for (let i = state.enemies.length - 1; i >= 0; i--) {
    const e = state.enemies[i];
    if (seen.has(e.id)) continue;

    if (e.state === 'dying') {
      // Let the local death animation finish; interpolateEnemies will remove it
      // once animateDeath flips it to 'dead'. Mark it so we don't keep chasing.
      e.alive = false;
    } else {
      // Gone without a death animation (out of range, despawned): drop now.
      if (e.mesh && e.mesh.parent) e.mesh.parent.remove(e.mesh);
      disposeMesh(e.mesh);
      state.enemies.splice(i, 1);
    }
  }
}

// CLIENT-ONLY. Per-frame visual update: lerp each enemy mesh from prev->target
// at renderTime (now - INTERP_DELAY), plus the existing bob and dying animation.
// No AI, no damage, no spawn logic.
export function interpolateEnemies(state, renderTime) {
  if (!state.enemies) return;

  for (let i = state.enemies.length - 1; i >= 0; i--) {
    const e = state.enemies[i];

    // Dying bodies: run the existing death animation to completion, then remove.
    if (e.state === 'dying') {
      // dieTimer advances by real elapsed time between snapshots/frames; derive
      // dt from renderTime delta, clamped so a long stall doesn't snap it shut.
      const dt = (e._lastRender !== undefined)
        ? Math.max(0, Math.min(0.1, renderTime - e._lastRender))
        : 0;
      e._lastRender = renderTime;
      if (!e._deathTriggered) { driveEnemyAnim(e, 0, 'idle', 'death'); e._deathTriggered = true; }
      else driveEnemyAnim(e, dt, 'idle');
      animateDeath(e, dt);
      if (e.state === 'dead') {
        if (e.mesh && e.mesh.parent) e.mesh.parent.remove(e.mesh);
        disposeMesh(e.mesh);
        state.enemies.splice(i, 1);
      }
      continue;
    }

    // Real elapsed time since last visual frame, clamped, for the mixer clock.
    const animDt = (e._lastRender !== undefined)
      ? Math.max(0, Math.min(0.1, renderTime - e._lastRender))
      : 0;
    e._lastRender = renderTime;

    // Interpolation factor between the two most recent samples.
    const span = e.lastT - e.prevT;
    let t = span > 1e-6 ? (renderTime - e.prevT) / span : 1;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    // Lerp position.
    const x = e.prevPos.x + (e.targetPos.x - e.prevPos.x) * t;
    const y = e.prevPos.y + (e.targetPos.y - e.prevPos.y) * t;
    const z = e.prevPos.z + (e.targetPos.z - e.prevPos.z) * t;
    e.position.set(x, y, z);
    e.mesh.position.x = x;
    e.mesh.position.z = z;
    // ease any residual lunge bob on the root back to ground.
    e.mesh.position.y += (y - e.mesh.position.y) * Math.min(1, 0.2);

    // Lerp yaw via shortest-arc interpolation.
    e.mesh.rotation.y = lerpAngle(e.prevYaw, e.targetYaw, t);

    // Drive the skeletal animation from the snapshot state: Run when the enemy
    // is moving/chasing, Idle otherwise, one-shot the swing when attacking.
    const moving = (e.targetPos.x - e.prevPos.x) ** 2 + (e.targetPos.z - e.prevPos.z) ** 2;
    const desiredLoop = (e.state === 'attacking') ? 'idle' : (moving > 1e-4 ? 'run' : 'idle');
    // Edge-detect the attack state so we fire the one-shot once per attack.
    let trigger = null;
    if (e.state === 'attacking' && e._wasAttacking !== true) trigger = 'attack';
    e._wasAttacking = (e.state === 'attacking');
    driveEnemyAnim(e, animDt, desiredLoop, trigger);

    // Subtle idle/run bob for life (cosmetic, advanced by interp progress so it
    // doesn't require a separate dt clock). Damped when a skeletal clip plays.
    e.bob += (moving > 1e-4 ? 0.18 : 0.06);
    const hasAnim = e.mesh.userData.anim && e.mesh.userData.anim.mixer;
    const bobAmt = (e.state === 'attacking' ? 0.02 : 0.06) * (hasAnim ? 0.25 : 1);
    e.body.position.y = e.bodyBaseY + Math.abs(Math.sin(e.bob)) * bobAmt;
  }
}

// Shortest-arc angle interpolation (radians).
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Count enemies that are still genuinely alive (chasing/attacking).
function countLive(state) {
  let n = 0;
  for (const e of state.enemies) if (e.alive) n++;
  return n;
}

// ===========================================================================
// Wave spawning
// ===========================================================================

function startNextWave(state) {
  state.wave += 1;
  const w = state.wave;
  const count = waveSize(w);

  // Queue staggered spawns spread across the perimeter spawn points so they
  // trickle in instead of popping in one frame.
  _spawnQueue = [];
  const points = _spawnPoints && _spawnPoints.length ? _spawnPoints : fallbackSpawnPoints();
  for (let i = 0; i < count; i++) {
    const point = points[i % points.length];
    _spawnQueue.push({ point, wave: w });
  }
  _spawnTimer = 0; // first spawn happens next update tick

  state.enemiesRemaining = count;
  state.events.push({ type: 'waveStart', wave: w, count });
}

// Defensive fallback if scene.spawnPoints() ever returns nothing.
function fallbackSpawnPoints() {
  const r = ARENA_HALF - 4;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  return pts;
}

function spawnEnemy(state, point, wave) {
  // Mild per-wave scaling so later waves bite harder.
  const speed = ENEMY_SPEED + Math.min(2.5, (wave - 1) * 0.18);
  const maxHealth = ENEMY_MAX_HEALTH + (wave - 1) * 15;

  const mesh = buildEnemyMesh();
  // Jitter spawn slightly around the point so co-located spawns don't overlap.
  const jx = (Math.random() - 0.5) * 2.5;
  const jz = (Math.random() - 0.5) * 2.5;
  const px = clampInArena(point.x + jx);
  const pz = clampInArena(point.z + jz);

  mesh.position.set(px, 0, pz);
  state.scene.add(mesh);

  const id = _nextId++;
  // Tag the mesh (and bubble the id onto children via traversal) so raycasts
  // with `recursive=true` resolve back to this enemy and can test headshots.
  mesh.userData.enemyId = id;
  mesh.userData.headY = ENEMY_HEAD_Y;
  mesh.traverse((o) => {
    o.userData.enemyId = id;
    o.userData.headY = ENEMY_HEAD_Y;
  });

  const enemy = {
    id,
    mesh,
    body: mesh.userData.body,       // inner group used for bob animation
    bodyBaseY: mesh.userData.body.position.y,
    position: new THREE.Vector3(px, 0, pz),
    velocity: new THREE.Vector3(0, 0, 0),
    health: maxHealth,
    maxHealth,
    alive: true,
    state: 'chasing',
    lastAttackTime: -Infinity,
    scoreValue: scoreForWave(wave),
    headY: ENEMY_HEAD_Y,
    // animation/internal
    speed,
    bob: Math.random() * Math.PI * 2,
    dieTimer: 0,
  };

  state.enemies.push(enemy);
}

// ===========================================================================
// Damage / death
// ===========================================================================

export function applyDamage(state, enemyId, amount, hitPoint) {
  const e = findEnemy(state, enemyId);
  if (!e || !e.alive) return false;

  e.health -= amount;
  // brief hit flash
  flash(e);

  if (e.health <= 0) {
    e.health = 0;
    e.alive = false;
    e.state = 'dying';
    e.dieTimer = 0;

    // enemiesRemaining is recomputed in update(), but decrement here too so a
    // same-frame query (e.g. weapons chaining) sees the right value.
    if (state.enemiesRemaining > 0) state.enemiesRemaining -= 1;

    state.events.push({
      type: 'enemyDeath',
      enemyId: e.id,
      scoreValue: e.scoreValue,
      position: e.position.clone(),
    });

    if (state.enemiesRemaining === 0) {
      state.events.push({ type: 'waveCleared', wave: state.wave });
      _waveTimer = WAVE_DELAY;
    }
    return true; // died this call
  }
  return false;
}

export function getEnemyMeshes(state) {
  // Only alive enemies are targetable; dying/dead bodies don't take hits.
  const list = [];
  for (const e of state.enemies) {
    if (e.alive) list.push(e.mesh);
  }
  return list;
}

function findEnemy(state, id) {
  for (const e of state.enemies) if (e.id === id) return e;
  return null;
}

// ===========================================================================
// Physics: integration + AABB collision against static colliders
// ===========================================================================

function integrateAndCollide(state, e, dt) {
  // Move one axis at a time so we can resolve penetration cleanly (no tunneling
  // at dt<=0.05 with these speeds).
  // ---- X axis ----
  _next.copy(e.position);
  _next.x += e.velocity.x * dt;
  resolveAxis(state, _next, 'x');
  e.position.x = _next.x;

  // ---- Z axis ----
  _next.copy(e.position);
  _next.z += e.velocity.z * dt;
  resolveAxis(state, _next, 'z');
  e.position.z = _next.z;

  // Enemies are grounded; keep feet at y=0 always.
  e.position.y = 0;

  // Arena safety clamp.
  e.position.x = clampInArena(e.position.x);
  e.position.z = clampInArena(e.position.z);
}

// Resolve the enemy AABB (centered at feet pos, half = ENEMY_HALF) against every
// static collider on a single horizontal axis, pushing it out of overlaps.
function resolveAxis(state, pos, axis) {
  const colliders = state.colliders;
  if (!colliders) return;

  const hx = ENEMY_HALF.x;
  const hy = ENEMY_HALF.y;
  const hz = ENEMY_HALF.z;

  // Enemy AABB (feet at pos.y, body extends up by 2*hy).
  const minX = pos.x - hx, maxX = pos.x + hx;
  const minY = pos.y,       maxY = pos.y + 2 * hy;
  const minZ = pos.z - hz, maxZ = pos.z + hz;

  for (const c of colliders) {
    // Skip the ground slab (top at y=0): enemies never penetrate it horizontally.
    if (c.max.y <= 0.0001) continue;

    // Overlap test on all 3 axes.
    if (maxX <= c.min.x || minX >= c.max.x) continue;
    if (maxY <= c.min.y || minY >= c.max.y) continue;
    if (maxZ <= c.min.z || minZ >= c.max.z) continue;

    // Penetration along the requested axis; push out the smaller side.
    if (axis === 'x') {
      const penLeft  = maxX - c.min.x;  // push toward -x
      const penRight = c.max.x - minX;  // push toward +x
      if (penLeft < penRight) pos.x -= penLeft;
      else pos.x += penRight;
    } else {
      const penNear = maxZ - c.min.z;   // push toward -z
      const penFar  = c.max.z - minZ;   // push toward +z
      if (penNear < penFar) pos.z -= penNear;
      else pos.z += penFar;
    }
  }
}

// Boids-style separation: sum of pushes away from nearby enemies.
function accumulateSeparation(state, self, out) {
  out.set(0, 0, 0);
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const other = enemies[i];
    if (other === self || !other.alive) continue;
    _delta.set(self.position.x - other.position.x, 0, self.position.z - other.position.z);
    const d = _delta.length();
    if (d > 0.0001 && d < SEPARATION_RADIUS) {
      // Closer => stronger push (inverse falloff).
      const strength = (1 - d / SEPARATION_RADIUS) * SEPARATION_FORCE;
      _delta.multiplyScalar(strength / d);
      out.add(_delta);
    }
  }
  return out;
}

function clampInArena(v) {
  const lim = ARENA_HALF - 1.5; // keep clear of perimeter walls
  return Math.max(-lim, Math.min(lim, v));
}

// ===========================================================================
// Death animation
// ===========================================================================

function animateDeath(e, dt) {
  e.dieTimer += dt;
  const t = Math.min(1, e.dieTimer / DYING_TIME);

  // Fall over (rotate forward about local X) and sink/shrink while fading.
  e.mesh.rotation.x = -t * (Math.PI / 2) * 0.95;
  const s = 1 - 0.35 * t;
  e.mesh.scale.set(s, s, s);
  e.mesh.position.y = -0.5 * t;

  setOpacity(e.mesh, 1 - t);

  if (t >= 1) {
    e.state = 'dead';
  }
}

// ===========================================================================
// Mesh construction (procedural primitives only)
// ===========================================================================

export function buildEnemyMesh(variantIndex) {
  // Root group sits at feet (y=0). An inner `body` group holds the actual
  // primitives so we can bob the body without disturbing the feet origin.
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Cel-shaded cartoon materials (toon gradient ramp + emissive/opacity intact).
  const skin = toonMat(0xd6502f);
  const dark = toonMat(0x3a1410);
  const eyeMat = toonMat(0xffe24a, { emissive: 0xffaa00, emissiveIntensity: 1.4 });

  // Torso (capsule-ish: a box trunk).
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.45), skin);
  torso.position.y = 1.0;
  torso.castShadow = true;
  addOutline(torso);
  body.add(torso);

  // Hips / legs block.
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.4), dark);
  legs.position.y = 0.4;
  legs.castShadow = true;
  addOutline(legs);
  body.add(legs);

  // Head (centered near ENEMY_HEAD_Y so headshot math lines up).
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), skin);
  head.position.y = ENEMY_HEAD_Y;
  head.castShadow = true;
  addOutline(head);
  body.add(head);

  // Glowing eyes face -Z??? The mesh faces the player via yaw; place eyes on +Z
  // side... actually the model's "front" should match the facing yaw. Using
  // atan2(dx,dz) yaw, local +Z points toward the player, so eyes go on +Z.
  const eyeGeo = new THREE.SphereGeometry(0.05, 8, 6);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.1, ENEMY_HEAD_Y + 0.03, 0.24);
  eyeR.position.set(0.1, ENEMY_HEAD_Y + 0.03, 0.24);
  body.add(eyeL, eyeR);

  // Arms (simple boxes), angled slightly forward for a "reaching" look.
  const armGeo = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  const armL = new THREE.Mesh(armGeo, skin);
  const armR = new THREE.Mesh(armGeo, skin);
  armL.position.set(-0.46, 1.05, 0.12);
  armR.position.set(0.46, 1.05, 0.12);
  armL.rotation.x = -0.5;
  armR.rotation.x = -0.5;
  armL.castShadow = true;
  armR.castShadow = true;
  addOutline(armL);
  addOutline(armR);
  body.add(armL, armR);

  root.userData.body = body;

  // Kick off the async CC0 toon-model upgrade. The procedural humanoid above is
  // already returned and rendering; if/when the model resolves we re-skin it
  // with the same toon materials, wire an AnimationMixer, and swap it into
  // `body`, preserving the feet origin, bob target, headshot height, flash, and
  // death-fade behavior. On any failure the procedural mesh simply stays. This
  // never blocks the game loop. A round-robin variant index gives visual
  // variety across spawns; pass an explicit index for deterministic choice.
  const variant = (typeof variantIndex === 'number')
    ? ((variantIndex % CHAR_MODEL_VARIANTS.length) + CHAR_MODEL_VARIANTS.length) % CHAR_MODEL_VARIANTS.length
    : (_spawnVariantCursor++ % CHAR_MODEL_VARIANTS.length);
  upgradeToCharModel(root, body, variant);

  return root;
}

// Swap the procedural primitives inside `body` for a toon-shaded CC0 character
// model once it loads, and (if the GLB ships clips) wire an AnimationMixer.
// Purely cosmetic: keeps root userData.body, re-applies the enemy id/headY tags
// so the flash()/raycast paths still match, stores the mixer + clip actions on
// root.userData.anim for the per-frame driver, and leaves every sim field
// untouched (the enemy record already cached body/bodyBaseY before this runs).
function upgradeToCharModel(root, body, variantIndex) {
  if (_variantTried[variantIndex] === 'off') return; // this variant failed before
  Promise.all([loadCharVariant(variantIndex), getSkeletonUtils()])
    .then(([template, skelUtils]) => {
      if (!template || !template.scene) { _variantTried[variantIndex] = 'off'; return; }
      // Root may have been disposed/removed before the model arrived.
      if (!root || !body || root.userData.body !== body) return;

      // Clone with SkeletonUtils when available so each enemy gets an
      // independent skeleton (required for per-instance skinned animation).
      // Fall back to a plain deep clone for non-skinned models.
      let model;
      try {
        model = (skelUtils && skelUtils.clone)
          ? skelUtils.clone(template.scene)
          : template.scene.clone(true);
      } catch (_) {
        return;
      }
      if (!model) return;

      // Re-skin every mesh with toon materials so the model matches the look.
      // skinning:true preserves SkinnedMesh deformation under MeshToonMaterial.
      model.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          const src = o.material && o.material.color
            ? o.material.color.getHex() : 0xcfd2d6;
          const mat = toonMat(src);
          // Copy the embedded atlas so the model keeps its baked colors.
          if (o.material && o.material.map) mat.map = o.material.map;
          o.material = mat;
          o.castShadow = true;
          o.frustumCulled = false; // skinned bounds can mislead the culler
          // Mark as a shared-template mesh so disposeMesh() leaves its
          // (reference-shared) geometry + embedded atlas intact for other clones.
          o.userData.sharedAsset = true;
          // Inverted-hull outline for non-skinned parts; addOutline() skips
          // SkinnedMesh (a static hull would detach from the bones), so skinned
          // bodies rely on the toon bands for their cartoon edge instead.
          addOutline(o);
        }
      });

      // Normalize to ~1.8m tall standing on the feet origin (y=0), matching the
      // procedural humanoid so headshot height and bob still line up. Orient so
      // the model faces +Z (the project yaw convention used by the AI facing
      // code): KayKit characters already face -Z, so rotate 180° about Y, then
      // measure the box AFTER rotation for a correct recenter.
      model.rotation.y = Math.PI;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const h = size.y || 1;
      const targetH = 1.8;
      const s = targetH / h;
      model.scale.setScalar(s);
      // Recenter on the feet origin and zero any horizontal offset so the model
      // stands centered over the AABB collider used by the sim.
      const center = new THREE.Vector3();
      box.getCenter(center);
      model.position.set(-center.x * s, -box.min.y * s, -center.z * s);

      // Replace the procedural primitives but preserve any non-mesh children.
      for (let i = body.children.length - 1; i >= 0; i--) {
        const c = body.children[i];
        body.remove(c);
        disposeMesh(c);
      }
      body.add(model);

      // Re-tag with the enemy id so raycasts (host) and the flash() emissive
      // guard resolve correctly on the new meshes. The id was written onto the
      // root in spawnEnemy/applyEnemySnapshot; propagate down the fresh subtree.
      const enemyId = root.userData.enemyId;
      const headY = root.userData.headY !== undefined ? root.userData.headY : ENEMY_HEAD_Y;
      model.traverse((o) => {
        if (enemyId !== undefined) o.userData.enemyId = enemyId;
        o.userData.headY = headY;
      });

      // ---- AnimationMixer wiring (only if the GLB shipped usable clips) ----
      setupAnim(root, model, template.animations);
    })
    .catch(() => {});
}

// Build the AnimationMixer + clip actions for a freshly-swapped model and stash
// the controller on root.userData.anim. The per-frame driver (driveEnemyAnim,
// called from update()/interpolateEnemies()) advances it and crossfades states.
// If no clips match, root.userData.anim stays undefined and the model just rests
// in bind pose — fully procedural-safe.
function setupAnim(root, model, animations) {
  if (!animations || !animations.length) return;
  let mixer;
  try {
    mixer = new THREE.AnimationMixer(model);
  } catch (_) {
    return;
  }

  const actions = {};
  for (const key of Object.keys(CLIP_CANDIDATES)) {
    const clip = findClip(animations, CLIP_CANDIDATES[key]);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    if (key === 'attack' || key === 'hit' || key === 'death') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions[key] = action;
  }

  // Pick a sensible default looping state.
  let current = null;
  if (actions.idle) { actions.idle.play(); current = 'idle'; }
  else if (actions.run) { actions.run.play(); current = 'run'; }

  root.userData.anim = {
    mixer,
    actions,
    current,        // currently-playing looping base state ('idle'|'run'|null)
    oneShot: null,  // a transient LoopOnce action ('attack'|'hit'|'death')
  };
}

// Per-frame animation driver. Advances the mixer and crossfades between Idle and
// Run based on the enemy's locomotion, plays a one-shot Attack on melee, and
// Death when dying. Cosmetic only: never reads/writes sim-authoritative fields.
// `desiredLoop` is 'idle' or 'run'; `trigger` is optional ('attack'|'hit'|'death').
function driveEnemyAnim(e, dt, desiredLoop, trigger) {
  const anim = e.mesh && e.mesh.userData && e.mesh.userData.anim;
  if (!anim || !anim.mixer) return;
  const { mixer, actions } = anim;

  // Fire a one-shot if requested and available, fading the looping base out.
  if (trigger && actions[trigger]) {
    const a = actions[trigger];
    a.reset();
    a.fadeIn(0.08);
    a.play();
    anim.oneShot = trigger;
  }

  // While no transient one-shot owns the body, crossfade the looping base state.
  if (!anim.oneShot) {
    const want = (desiredLoop === 'run' && actions.run) ? 'run'
      : (actions.idle ? 'idle' : (actions.run ? 'run' : null));
    if (want && want !== anim.current) {
      const next = actions[want];
      const prev = anim.current ? actions[anim.current] : null;
      next.reset();
      next.fadeIn(0.18);
      next.play();
      if (prev) prev.fadeOut(0.18);
      anim.current = want;
    }
  } else {
    // Clear the one-shot latch once it has finished so the base resumes.
    const a = actions[anim.oneShot];
    if (a && !a.isRunning()) {
      // For death, leave it clamped on the final pose (handled by clampWhenFinished).
      if (anim.oneShot !== 'death') {
        a.fadeOut(0.12);
        const base = anim.current ? actions[anim.current] : (actions.idle || actions.run);
        if (base) { base.reset(); base.fadeIn(0.12); base.play(); anim.current = base === actions.run ? 'run' : 'idle'; }
      }
      anim.oneShot = null;
    }
  }

  mixer.update(dt);
}

// Walk a mesh tree and set opacity across all standard materials (death fade).
function setOpacity(obj, opacity) {
  obj.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.transparent = true;
        m.opacity = opacity;
      }
    }
  });
}

// Quick red hit flash via emissive pulse on the body materials.
function flash(e) {
  e.mesh.traverse((o) => {
    if (o.isMesh && o.material && o.material.emissive && o.userData.enemyId !== undefined) {
      // Only pulse the skin/dark mats, not the (already-emissive) eyes.
      if (o.material.emissiveIntensity === undefined || o.material.emissiveIntensity < 1) {
        o.material.emissive.setHex(0xff3322);
        o.material.emissiveIntensity = 0.9;
        // Decay handled lazily on next frames via a microtask-free timer.
        setTimeout(() => {
          if (o.material) {
            o.material.emissiveIntensity = 0;
            o.material.emissive.setHex(0x000000);
          }
        }, 70);
      }
    }
  });
}

// Exported wrapper so the client-apply path can dispose enemy meshes it built
// via buildEnemyMesh() without reaching into module internals. Thin pass-through
// to the existing private disposeMesh — no logic change.
export function disposeEnemyMesh(mesh) {
  disposeMesh(mesh);
}

// Free GPU resources for a removed enemy.
function disposeMesh(obj) {
  if (!obj) return;
  // Stop any AnimationMixer so its actions/clip references can be GC'd. The
  // mixer is stashed on the enemy root's userData by setupAnim().
  if (obj.userData && obj.userData.anim && obj.userData.anim.mixer) {
    try { obj.userData.anim.mixer.stopAllAction(); } catch (_) { /* noop */ }
    obj.userData.anim = null;
  }
  obj.traverse((o) => {
    if (o.isMesh) {
      // SkeletonUtils.clone() shares geometry across every clone of a variant
      // template, so disposing a dying enemy's geometry would corrupt the others
      // still alive. Skip geometry/map disposal on cloned-model meshes (tagged
      // sharedAsset); the per-session template keeps them alive. Procedural
      // primitives own unique geometry and are disposed normally.
      if (o.userData && o.userData.sharedAsset) {
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m.dispose(); // material is per-clone (toonMat), map is shared & left intact
        }
        return;
      }
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    }
  });
}
