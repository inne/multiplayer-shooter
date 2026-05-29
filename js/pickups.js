// pickups.js — host-authoritative ammo + weapon pickups.
//
// Owns: state.pickups (the rendered record list). Mirrors enemies.js's contract:
//   - exported functions only (initPickups/setSimMode/resetPickups/loadForMap/
//     update/applyPickupSnapshot/getActiveForSnapshot/buildPickupMesh/
//     animatePickups/setRemotePositions)
//   - the shared `state` object (read player position/time/scene, never mutate
//     weapon internals)
//   - the §2.1 event queue: pushes { type:'pickup', pickupId, kind, payload, pid }
//     on contact. main.js maps that event to the actual grant (weapons.addReserve /
//     weapons.giveWeapon) so this module never reaches into weapon internals.
//
// HOST/SP own _pickups (spawn + contact + respawn). CLIENTS never spawn/own; they
// render purely from snapshots via applyPickupSnapshot. No imports of
// enemies/player/net/weapons — this stays a dumb subsystem driven by main.js,
// exactly like scene.js.
//
// All Three.js objects come from the single importmapped 'three'. Pickup prop
// models load asynchronously via GLTFLoader with a procedural cartoon fallback,
// so the game runs identically with an empty assets/ folder.

import * as THREE from 'three';
// GLTFLoader is imported DYNAMICALLY (see ensureLoader), mirroring
// enemies.js/weapons.js. A static `import { GLTFLoader }` would couple a
// loader-CDN hiccup to all of main.js (which statically imports this module),
// turning a recoverable "procedural-only" degrade into a black screen. The
// dynamic import isolates any addon failure to the procedural fallback path.

// ---- tunables -------------------------------------------------------------
const AMMO_RESPAWN_DELAY   = 15;   // seconds before an ammo pad refills
const WEAPON_RESPAWN_DELAY = 25;   // seconds before a weapon pad refills
const CONTACT_RADIUS       = 1.2;  // XZ contact distance (m)
const CONTACT_Y            = 2.0;  // must be roughly at floor level (feet y)
const AMMO_GRANT           = 30;   // reserve rounds granted by a generic ammo box
const BOB_HEIGHT           = 0.18; // floating bob amplitude (m)
const BOB_RATE             = 2.2;  // bob radians/sec
const SPIN_RATE            = 1.1;  // spin radians/sec
const FLOAT_BASE_Y         = 0.9;  // resting center height of the floating prop

// kind <-> compact-int mapping for the snapshot wire format.
const KIND_AMMO = 0;
const KIND_WEAPON = 1;

// Weapon-name <-> compact-int mapping for the snapshot wire format. Additive: any
// unknown index decodes to 'rifle' and any unknown name encodes to 0, so a peer on
// a newer/older arsenal table degrades gracefully rather than crashing.
const WEAPON_NAMES = ['rifle', 'pistol', 'shotgun'];
function wnToIndex(name) {
  const i = WEAPON_NAMES.indexOf(name);
  return i < 0 ? 0 : i;
}
function indexToWn(i) {
  return WEAPON_NAMES[i] || 'rifle';
}

// ---- asset keys -> file paths (procedural fallback on ANY load error) -----
// Each entry has a procedural fallback in buildPickupMesh, so a failed/absent
// download degrades to the cartoon primitive without blocking the loop.
// Switched from the Kenney Blaster Kit crates (assets/models/*.glb) to these
// self-contained CC0 kit GLBs: the Kenney crates reference an EXTERNAL
// Textures/colormap.png ("uri":"Textures/colormap.png"), which 404s at runtime
// (no Textures/ dir is served). These KayKit/Quaternius props embed their
// textures/colors in the .glb (verified: `strings <glb> | grep '"uri":".*png"'`
// prints nothing), so there are zero external asset 404s. Procedural fallbacks
// in buildProceduralProp still cover any load failure.
const MODEL_PATHS = {
  ammo: 'assets/kit/kaykit_box_small.glb',
  weapon: 'assets/kit/quaternius_crate.glb',
};

// ---- module-scoped temporaries (no per-frame allocation) ------------------
const _toPad = new THREE.Vector3();

// ---- module state ---------------------------------------------------------
// _pickups: authoritative on host/SP; a pure render mirror on clients.
//   { id, kind:'ammo'|'weapon', payload, pos:THREE.Vector3,
//     active:bool, respawnAt:number, mesh:THREE.Group|null, bob:number }
let _pickups = [];
let _nextId = 1;
let _spawnAccum = 0;          // reserved spawn cadence accumulator (host/SP)
let _simMode = 'sp';          // 'sp' | 'host' | 'client'
let _pads = [];               // active map's spawn pads: { x, z, kind, payload }
let _remotePositions = null;  // host: Map(pid -> [x,y,z]) of client positions

// Cache of loaded GLTF scenes per kind (shared prototype, cloned per mesh).
const _modelCache = { ammo: null, weapon: null };
const _modelTried = { ammo: false, weapon: false };
const _pendingCbs = { ammo: null, weapon: null };
let _loaderPromise = null;     // Promise<GLTFLoader|null>, resolved once.

// Shared toon gradient map (3-step ramp) for the procedural fallback meshes.
let _gradientMap = null;

// ===========================================================================
// Lifecycle
// ===========================================================================

export function initPickups(state) {
  removeAllMeshes(state);
  _pickups = [];
  state.pickups = _pickups;
  _nextId = 1;
  _spawnAccum = 0;
  _pads = [];
  _remotePositions = null;
  // Kick off async model loads; meshes built before they resolve use the
  // procedural fallback, then nothing re-swaps (cheap + never blocks the loop).
  ensureLoader();
}

// 'host'|'sp' run the authoritative spawn/contact sim; 'client' makes update()
// a no-op and switches to snapshot apply. Mirrors enemies.setSimMode.
export function setSimMode(state, mode) {
  _simMode = (mode === 'host' || mode === 'client') ? mode : 'sp';
}

export function resetPickups(state) {
  removeAllMeshes(state);
  _pickups.length = 0;
  if (!state.pickups) state.pickups = _pickups;
  _nextId = 1;
  _spawnAccum = 0;
  _remotePositions = null;
  // Re-arm every pad: host/SP spawn an active pickup immediately; clients leave
  // _pickups empty and wait for the first snapshot.
  if (_simMode !== 'client') {
    for (const pad of _pads) spawnPickup(state, pad);
  }
}

// Install the spawn-pad list for the chosen map. mapDef is the active map
// definition (scene.MAPS[id]); pickupPads is [[x,z,'ammo'|'weapon'], ...].
// Falls back to a deterministic default layout if the map carries no pads
// (keeps SP working before scene.js's map registry lands).
export function loadForMap(state, mapDef) {
  _pads = [];
  const pads = (mapDef && Array.isArray(mapDef.pickupPads) && mapDef.pickupPads.length)
    ? mapDef.pickupPads
    : defaultPads();

  for (const entry of pads) {
    const kind = entry[2] === 'weapon' ? 'weapon' : 'ammo';
    // Optional 4th entry: explicit payload (e.g. ['x','z','weapon','shotgun']).
    const payload = makePayload(kind, entry[3]);
    // Nudge the pad OUT of any crate/wall so it's actually reachable (was a bug:
    // pads authored inside cover geometry were uncollectible).
    const adj = clearOfColliders(state, entry[0], entry[1]);
    _pads.push({ x: adj.x, z: adj.z, kind, payload });
  }

  // Rebuild live pickups for the new pad geography (host/SP only).
  removeAllMeshes(state);
  _pickups.length = 0;
  _nextId = 1;
  if (_simMode !== 'client') {
    for (const pad of _pads) spawnPickup(state, pad);
  }
}

// Push a pickup pad (x,z) out of any static collider's XZ footprint (expanded by
// a player+pickup clearance) so the player can actually reach it — pads authored
// inside crates/walls were uncollectible. Iterates a few times since exiting one
// box may enter another; clamps inside the arena at the end.
function clearOfColliders(state, x, z) {
  const cols = state.colliders || [];
  const m = 0.9; // clearance ~ player radius + pickup radius
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (const c of cols) {
      if (!c || !c.min || !c.max) continue;
      const minx = c.min.x - m, maxx = c.max.x + m;
      const minz = c.min.z - m, maxz = c.max.z + m;
      if (x > minx && x < maxx && z > minz && z < maxz) {
        const dl = x - minx, dr = maxx - x, db = z - minz, df = maxz - z;
        const mn = Math.min(dl, dr, db, df);
        if (mn === dl) x = minx - 0.01;
        else if (mn === dr) x = maxx + 0.01;
        else if (mn === db) z = minz - 0.01;
        else z = maxz + 0.01;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const lim = (state.arenaHalf || 40) - 1.5;
  if (x < -lim) x = -lim; else if (x > lim) x = lim;
  if (z < -lim) z = -lim; else if (z > lim) z = lim;
  return { x, z };
}

// Deterministic fallback pad layout placed near the crate cover, mirroring the
// CRATE_LAYOUT philosophy. Used when the active map defines no pickupPads.
function defaultPads() {
  return [
    [  12,   0, 'ammo'   ],
    [ -12,   0, 'ammo'   ],
    [   0,  18, 'ammo'   ],
    [   0, -18, 'ammo'   ],
    [  24,  22, 'weapon' ],
    [ -24, -18, 'weapon' ],
  ];
}

// Build the payload record for a pad. For 'weapon' the optional `arg` is the
// weapon name (default shotgun, the locked-until-pickup weapon). For 'ammo' the
// optional `arg` is a weapon-specific ammo target (default generic reserve).
function makePayload(kind, arg) {
  if (kind === 'weapon') {
    return { weaponName: (typeof arg === 'string' && arg) ? arg : 'shotgun' };
  }
  const p = { ammo: AMMO_GRANT };
  if (typeof arg === 'string' && arg) p.weaponName = arg;
  return p;
}

// ===========================================================================
// Spawning (host/SP authoritative)
// ===========================================================================

function spawnPickup(state, pad) {
  const id = _nextId++;
  const mesh = buildPickupMesh(pad.kind, pad.payload);
  mesh.position.set(pad.x, FLOAT_BASE_Y, pad.z);
  mesh.userData.pickupId = id;
  if (state.scene) state.scene.add(mesh);

  const rec = {
    id,
    kind: pad.kind,
    payload: pad.payload,
    pos: new THREE.Vector3(pad.x, 0, pad.z),
    active: true,
    respawnAt: 0,
    mesh,
    bob: Math.random() * Math.PI * 2,
    pad,
  };
  _pickups.push(rec);
  return rec;
}

// ===========================================================================
// Per-frame update (HOST/SP only)
// ===========================================================================

export function update(state, dt) {
  // CLIENT mode: pickups are host-authoritative; never spawn/contact here even if
  // main.js calls update() defensively (mirrors enemies.js:103).
  if (_simMode === 'client') return;
  if (state.phase !== 'playing') {
    // Still animate so resting pickups bob/spin during non-playing phases.
    animatePickups(dt);
    return;
  }

  // --- respawn timers + contact tests ---
  for (let i = 0; i < _pickups.length; i++) {
    const p = _pickups[i];

    if (!p.active) {
      if (state.time >= p.respawnAt) {
        p.active = true;
        if (p.mesh) p.mesh.visible = true;
      }
      continue;
    }

    // Local (host/SP) player contact.
    if (testContact(p, state.player && state.player.position, state.player && state.player.alive)) {
      consume(state, p, 0);
      continue;
    }

    // Host-only: each connected client's last-known position.
    if (_simMode === 'host' && _remotePositions) {
      let taken = false;
      for (const [pid, pos] of _remotePositions) {
        if (!Array.isArray(pos)) continue;
        _toPad.set(pos[0] - p.pos.x, 0, pos[2] - p.pos.z);
        const dxz = _toPad.length();
        const dy = Math.abs((pos[1] || 0) - p.pos.y);
        if (dxz <= CONTACT_RADIUS && dy <= CONTACT_Y) {
          consume(state, p, pid);
          taken = true;
          break;
        }
      }
      if (taken) continue;
    }
  }

  animatePickups(dt);
}

// Test the local player against an active pickup (XZ radius + floor-level y).
function testContact(p, position, alive) {
  if (!position || alive === false) return false;
  _toPad.set(position.x - p.pos.x, 0, position.z - p.pos.z);
  const dxz = _toPad.length();
  const dy = Math.abs((position.y || 0) - p.pos.y);
  return dxz <= CONTACT_RADIUS && dy <= CONTACT_Y;
}

// Consume an active pickup: hide it, arm the respawn timer, push the grant event.
// main.js maps the event to the actual grant (and, in MP, the reliable 'grant'
// message to the client owner). pid 0 == host/SP local player.
function consume(state, p, pid) {
  p.active = false;
  const delay = p.kind === 'weapon' ? WEAPON_RESPAWN_DELAY : AMMO_RESPAWN_DELAY;
  p.respawnAt = state.time + delay;
  if (p.mesh) p.mesh.visible = false;

  state.events.push({
    type: 'pickup',
    pickupId: p.id,
    kind: p.kind,
    payload: p.payload,
    pid,
  });
}

// Host injects pid -> [x,y,z] (from main.js hostInputs) so client-vs-pickup
// contact can be resolved host-side. Pass a Map (or null to clear).
export function setRemotePositions(map) {
  _remotePositions = map || null;
}

// ===========================================================================
// Animation (bob + spin). Safe to call in every mode/phase.
// ===========================================================================

export function animatePickups(dt) {
  for (let i = 0; i < _pickups.length; i++) {
    const p = _pickups[i];
    if (!p.mesh || !p.active) continue;
    // Crates only SPIN now — no vertical bob (per design). Height stays fixed.
    p.mesh.position.y = FLOAT_BASE_Y;
    p.mesh.rotation.y += dt * SPIN_RATE;
  }
}

// ===========================================================================
// Snapshot (HOST -> CLIENT)
// ===========================================================================

// HOST only: compact array the snap message embeds.
// [{ id, k:0|1, wn:weaponNameIndex, p:[x,y,z], a:1|0 }]
export function getActiveForSnapshot(state) {
  const out = [];
  for (let i = 0; i < _pickups.length; i++) {
    const p = _pickups[i];
    const wn = (p.payload && p.payload.weaponName) ? wnToIndex(p.payload.weaponName) : 0;
    out.push({
      id: p.id,
      k: p.kind === 'weapon' ? KIND_WEAPON : KIND_AMMO,
      wn,
      p: [p.pos.x, p.pos.y, p.pos.z],
      a: p.active ? 1 : 0,
    });
  }
  return out;
}

// CLIENT only: reconcile rendered meshes to the authoritative list. Pure visual,
// no grants. list = [{ id, k, wn, p:[x,y,z], a }].
export function applyPickupSnapshot(state, list) {
  if (!state.pickups) state.pickups = _pickups;
  const incoming = list || [];

  const seen = new Set();
  for (const s of incoming) {
    seen.add(s.id);
    const kind = s.k === KIND_WEAPON ? 'weapon' : 'ammo';
    let p = findPickup(s.id);

    if (!p) {
      const payload = kind === 'weapon'
        ? { weaponName: indexToWn(s.wn) }
        : { ammo: AMMO_GRANT, weaponName: indexToWn(s.wn) };
      const mesh = buildPickupMesh(kind, payload);
      const px = s.p[0], pz = s.p[2];
      mesh.position.set(px, FLOAT_BASE_Y, pz);
      mesh.userData.pickupId = s.id;
      if (state.scene) state.scene.add(mesh);
      p = {
        id: s.id,
        kind,
        payload,
        pos: new THREE.Vector3(px, s.p[1] || 0, pz),
        active: s.a === 1,
        respawnAt: 0,
        mesh,
        bob: Math.random() * Math.PI * 2,
        pad: null,
      };
      _pickups.push(p);
    } else {
      p.pos.set(s.p[0], s.p[1] || 0, s.p[2]);
      p.active = s.a === 1;
    }
    if (p.mesh) p.mesh.visible = p.active;
  }

  // Removals: present locally but absent from snapshot.
  for (let i = _pickups.length - 1; i >= 0; i--) {
    const p = _pickups[i];
    if (seen.has(p.id)) continue;
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
    disposeMesh(p.mesh);
    _pickups.splice(i, 1);
  }
}

function findPickup(id) {
  for (let i = 0; i < _pickups.length; i++) if (_pickups[i].id === id) return _pickups[i];
  return null;
}

// ===========================================================================
// Mesh construction
//
// Tries the CC0 GLB prop (Kenney Blaster Kit crates) via GLTFLoader, falling
// back to a procedural cartoon mesh on ANY error or while the model is still
// loading. Both variants are floating, toon-styled, with a colored ground ring.
// ===========================================================================

export function buildPickupMesh(kind, payload) {
  const root = new THREE.Group();
  root.userData.kind = kind;

  // Inner prop group (the bit that visually represents the pickup). Built
  // procedurally now; if/when the GLB is cached, a clone is swapped in.
  const prop = buildProceduralProp(kind, payload);
  prop.userData.isProp = true;
  root.add(prop);

  // Colored ground ring beneath the floating prop (kind-tinted). Opacity bumped
  // from 0.55 -> 0.85 so the pickup reads clearly even behind crate cover.
  const ringColor = kind === 'weapon' ? 0xffcf4a : 0x4ad6ff;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.82, 28),
    new THREE.MeshBasicMaterial({
      color: ringColor, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -FLOAT_BASE_Y + 0.02; // sit just above the floor (y≈0.02)
  ring.userData.isGlow = true; // skip outline/spin-disposal special cases
  root.add(ring);

  // Thin emissive vertical beam so pickups are discoverable from across the map
  // (a "loot beacon"). Additive blending + no depth-write keeps it glowy and
  // non-occluding; it's a child of root, so it bobs/spins with the pickup but
  // reads identically when spun. Purely cosmetic — never affects contact/sync.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.16, 3.2, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: ringColor, transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  // Anchor the beam so it rises from the floor up past the floating prop.
  beam.position.y = -FLOAT_BASE_Y + 1.6;
  beam.userData.isGlow = true; // skip toon outline; cosmetic only
  root.add(beam);

  // Async upgrade to the GLB prop if available (never blocks; safe if absent).
  tryLoadModel(kind, (gltfScene) => {
    if (!root.parent && !root.userData.kind) return; // stale
    const model = gltfScene.clone(true);
    toonifyAndOutline(model, ringColor);
    fitProp(model);
    // Swap the procedural prop for the model.
    const old = root.children.find((c) => c.userData && c.userData.isProp);
    if (old) {
      root.remove(old);
      disposeMesh(old);
    }
    model.userData.isProp = true;
    root.add(model);
  });

  return root;
}

// Procedural cartoon prop: toon ammo box vs floating weapon silhouette.
function buildProceduralProp(kind, payload) {
  const g = new THREE.Group();
  const grad = getGradientMap();

  if (kind === 'weapon') {
    // Floating weapon silhouette: a chunky body + barrel + stock, warm metal.
    const bodyMat = new THREE.MeshToonMaterial({ color: 0x6b7079, gradientMap: grad });
    const accentMat = new THREE.MeshToonMaterial({ color: 0xffb347, gradientMap: grad });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.22, 0.22), bodyMat);
    body.castShadow = true;
    g.add(body);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 12), bodyMat);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(0.6, 0.02, 0);
    g.add(barrel);

    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.3, 0.18), accentMat);
    stock.position.set(-0.5, -0.08, 0);
    g.add(stock);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.34, 0.16), accentMat);
    grip.position.set(-0.18, -0.28, 0);
    grip.rotation.z = 0.25;
    g.add(grip);
  } else {
    // Toon ammo box: a tinted crate with a darker lid band + cartoon studs.
    const boxMat = new THREE.MeshToonMaterial({ color: 0x3f8f4f, gradientMap: grad });
    const lidMat = new THREE.MeshToonMaterial({ color: 0x2b6336, gradientMap: grad });
    const studMat = new THREE.MeshToonMaterial({ color: 0xffd24a, gradientMap: grad });

    const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.42, 0.42), boxMat);
    box.castShadow = true;
    g.add(box);

    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.1, 0.46), lidMat);
    lid.position.y = 0.24;
    g.add(lid);

    // Corner studs for a cartoon look.
    const studGeo = new THREE.SphereGeometry(0.05, 8, 6);
    const sx = 0.27, sy = 0.16, sz = 0.18;
    for (const dx of [-sx, sx]) {
      for (const dz of [-sz, sz]) {
        const stud = new THREE.Mesh(studGeo, studMat);
        stud.position.set(dx, sy, dz);
        g.add(stud);
      }
    }
  }

  toonifyAndOutline(g, kind === 'weapon' ? 0xffcf4a : 0x4ad6ff);
  return g;
}

// Apply a thin inverted-hull dark outline to every mesh under `obj` for the
// cel-shaded cartoon look. Idempotent-ish: tags created hulls so a re-toonify
// (e.g. on a model swap) won't double-add.
function toonifyAndOutline(obj, _ringColor) {
  const hulls = [];
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry || o.userData.isOutline) return;
    const hull = new THREE.Mesh(
      o.geometry,
      new THREE.MeshBasicMaterial({ color: 0x10141a, side: THREE.BackSide }),
    );
    hull.userData.isOutline = true;
    hull.scale.multiplyScalar(1.07);
    hull.position.copy(o.position);
    hull.rotation.copy(o.rotation);
    hull.quaternion.copy(o.quaternion);
    hulls.push({ parent: o.parent || obj, hull });
  });
  for (const { parent, hull } of hulls) parent.add(hull);
}

// Scale + recenter a loaded GLB so it reads at roughly the procedural prop size.
function fitProp(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const target = 0.7; // desired largest extent (m)
  const s = target / maxDim;
  model.scale.setScalar(s);
  // Recenter to origin so it floats around the group center.
  model.position.set(-center.x * s, -center.y * s, -center.z * s);
}

// ===========================================================================
// Async model loading (GLTF, cached, fallback-safe)
// ===========================================================================

// Resolve a GLTFLoader once via the importmapped addon (dynamic import, like
// enemies.js getGltfLoader). Resolves null if the addon can't be imported so
// callers fall back to the procedural prop instead of crashing main.js.
function ensureLoader() {
  if (_loaderPromise) return _loaderPromise;
  _loaderPromise = import('three/addons/loaders/GLTFLoader.js')
    .then((m) => new m.GLTFLoader())
    .catch(() => null);
  return _loaderPromise;
}

// Resolve the cached GLB scene for a kind, loading it once. cb is called with the
// cached scene only on success; on any error (or absent file) it is never called
// and the procedural fallback remains in place.
function tryLoadModel(kind, cb) {
  const path = MODEL_PATHS[kind];
  if (!path) return;

  if (_modelCache[kind]) {
    cb(_modelCache[kind]);
    return;
  }
  // Queue the callback to fire once the (first) load resolves.
  if (!_modelTried[kind]) {
    _modelTried[kind] = true;
    _pendingCbs[kind] = [cb];
    ensureLoader().then((loader) => {
      if (!loader) { _pendingCbs[kind] = null; return; } // no loader -> procedural
      loader.load(
        path,
        (gltf) => {
          const sceneObj = gltf && gltf.scene ? gltf.scene : null;
          if (!sceneObj) { _pendingCbs[kind] = null; return; }
          _modelCache[kind] = sceneObj;
          const cbs = _pendingCbs[kind] || [];
          _pendingCbs[kind] = null;
          for (const fn of cbs) {
            try { fn(sceneObj); } catch (_) { /* ignore */ }
          }
        },
        undefined,
        () => { _pendingCbs[kind] = null; /* absent/failed -> procedural fallback */ },
      );
    });
  } else if (_pendingCbs[kind]) {
    _pendingCbs[kind].push(cb);
  }
}

// 3-step toon gradient ramp (NearestFilter), generated once (zero download).
function getGradientMap() {
  if (_gradientMap) return _gradientMap;
  const colors = new Uint8Array([90, 160, 230]); // 3 luminance steps
  const tex = new THREE.DataTexture(colors, colors.length, 1, THREE.RedFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  _gradientMap = tex;
  return _gradientMap;
}

// ===========================================================================
// Cleanup
// ===========================================================================

function removeAllMeshes(state) {
  if (!_pickups) return;
  for (const p of _pickups) {
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
    disposeMesh(p.mesh);
  }
}

function disposeMesh(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.isMesh) {
      // Geometry may be shared with an inverted-hull outline; dispose once.
      if (o.geometry && !o.userData.isOutline) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    }
  });
}
