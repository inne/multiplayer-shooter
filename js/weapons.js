// weapons.js — viewmodel, raycast firing, recoil, ammo
//
// Owns state.weapon.*. Builds a procedural viewmodel parented to the camera,
// handles semi/auto firing via a fire-rate gate, recoil + spread, reloading,
// and muzzle-flash animation. Hits are resolved through enemies.applyDamage();
// this module never reads enemy health or kills enemies directly (contract §5).

import * as THREE from 'three';
import { getEnemyMeshes, applyDamage } from './enemies.js';

// ---- per-frame feel constants shared by all weapons ----
const RECOIL_RECOVER = 12;      // how fast recoil/kick decay (per second)
const SPREAD_RECOVER = 0.08;    // spread bled off per second of not firing
const MUZZLE_FLASH_TIME = 0.045;// seconds the muzzle flash stays visible
const EMPTY_CLICK_INTERVAL = 0.25; // rate-limit dry-fire clicks
const RESERVE_CAP_MULT = 4;     // reserve clamp = magSize * this when topping up

// ---------------------------------------------------------------------------
// WEAPON DEFINITIONS — per-weapon stats. The rifle row is intentionally
// byte-identical to the legacy single-rifle tunables so single-player feel is
// unchanged (magSize 30, damage 25, fireInterval 0.1, reloadTime 1.6,
// defaultReserve 90, spread/recoil values matching the old module constants).
// ---------------------------------------------------------------------------
export const WEAPONS = {
  pistol: {
    name: 'pistol',
    magSize: 12,
    damage: 22,
    headshotMultiplier: 2.0,
    fireInterval: 0.18,
    auto: false,
    reloadTime: 1.1,
    range: 120,
    pellets: 1,
    spreadBase: 0.0,
    spreadPerShot: 0.006,
    spreadMax: 0.04,
    recoilPitch: 0.016,
    recoilKick: 0.05,
    defaultReserve: 60,
    viewmodel: 'pistol',
  },
  rifle: {
    name: 'rifle',
    magSize: 30,
    damage: 25,
    headshotMultiplier: 2.0,
    fireInterval: 0.1,
    auto: true,
    reloadTime: 1.6,
    range: 200,
    pellets: 1,
    spreadBase: 0.006,
    spreadPerShot: 0.004,
    spreadMax: 0.05,
    recoilPitch: 0.018,
    recoilKick: 0.06,
    defaultReserve: 90,
    viewmodel: 'rifle',
  },
  shotgun: {
    name: 'shotgun',
    magSize: 6,
    damage: 12,            // per pellet
    headshotMultiplier: 1.5,
    fireInterval: 0.8,
    auto: false,
    reloadTime: 2.4,
    range: 40,
    pellets: 8,
    spreadBase: 0.06,
    spreadPerShot: 0.0,
    spreadMax: 0.06,
    recoilPitch: 0.05,
    recoilKick: 0.14,
    defaultReserve: 24,
    viewmodel: 'shotgun',
  },
};

// Stable order for next/prev cycling and the 1/2/3 number keys.
const WEAPON_ORDER = ['pistol', 'rifle', 'shotgun'];

// ===========================================================================
// SELF-CONTAINED SAMPLE SFX (CC0 bundled WAV/MP3) with synth fallback.
// ---------------------------------------------------------------------------
// audio.js is 100% WebAudio-synthesized and main.js's handleEvent calls its
// argless playShoot()/playReload()/playEmpty() synth functions off the
// 'shoot'/'reloadStart'/'emptyClick'/'weaponSwitch' events this module pushes.
// The task constrains edits to weapons.js, so we add a small self-owned sample
// player here: own AudioContext, lazily fetch()+decodeAudioData() the bundled
// CC0 files, and play the per-weapon buffer on fire/reload/empty. When a sample
// plays we SUPPRESS the corresponding synth event so there's no double sound;
// when a buffer is missing/undecoded we still push the event so audio.js's
// synth fallback fires (constraint satisfied, zero 404 crash risk — a failed
// fetch/decode just leaves the buffer undefined). This is presentation-layer
// only: it reacts to the same already-synced events on every peer, so the
// host-authoritative multiplayer protocol is untouched.
// ===========================================================================

// Per-weapon sample map. Keys 'fire'/'reload' are indexed by weapon name; the
// shared 'empty' click is weapon-agnostic. Paths are bundled, CC0, verified.
const SFX_ASSETS = {
  fire: {
    pistol: 'assets/sfx/pistol_fire.wav',
    rifle: 'assets/sfx/rifle_fire.wav',
    shotgun: 'assets/sfx/shotgun_fire.wav',
  },
  reload: {
    pistol: 'assets/sfx/reload_pistol.wav',
    rifle: 'assets/sfx/reload_rifle.wav',
    shotgun: 'assets/sfx/shotgun_cock.wav',
  },
  empty: 'assets/sfx/empty_click.mp3',
};

// Per-sample gain so the loud 96kHz fire WAVs sit alongside the synth feel.
const SFX_GAIN = { fire: 0.6, reload: 0.7, empty: 0.8 };

let _sfxCtx = null;             // weapons-owned AudioContext (separate from audio.js)
let _sfxMaster = null;          // master gain -> destination
const _sfxBuffers = {};         // { 'fire:pistol': AudioBuffer, 'empty': AudioBuffer, ... }
const _sfxLoading = {};         // { key: Promise } so we fetch each file at most once
let _sfxUnlockBound = false;    // user-gesture resume listeners bound once
let _sfxReady = false;          // true once ctx exists and is (or becomes) running

// Build the weapons-owned AudioContext lazily and bind one-shot gesture
// listeners that resume it (autoplay policy). No-throw: if WebAudio is absent
// we simply never load samples and the synth path handles everything.
function ensureSfxContext() {
  if (_sfxCtx) return _sfxCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _sfxCtx = new AC();
    _sfxMaster = _sfxCtx.createGain();
    _sfxMaster.gain.value = 0.9;
    _sfxMaster.connect(_sfxCtx.destination);
    _sfxReady = _sfxCtx.state === 'running';
  } catch {
    _sfxCtx = null;
    _sfxMaster = null;
    return null;
  }
  if (!_sfxUnlockBound) {
    _sfxUnlockBound = true;
    const resume = () => {
      if (!_sfxCtx) return;
      try {
        const p = _sfxCtx.resume();
        if (p && typeof p.then === 'function') {
          p.then(() => { _sfxReady = true; }).catch(() => {});
        }
      } catch { /* stay silent */ }
      _sfxReady = true;
    };
    window.addEventListener('pointerdown', resume, { passive: true });
    window.addEventListener('keydown', resume, { passive: true });
    window.addEventListener('mousedown', resume, { passive: true });
  }
  return _sfxCtx;
}

// Kick off the fetch+decode for a sample if we haven't already. Returns nothing;
// the decoded buffer lands in _sfxBuffers[key] when (and if) it succeeds. A
// failed fetch/decode leaves the buffer undefined -> synth fallback, no throw.
function loadSfx(key, url) {
  if (_sfxBuffers[key] !== undefined || _sfxLoading[key]) return;
  const ctx = ensureSfxContext();
  if (!ctx) return;
  _sfxLoading[key] = fetch(url)
    .then((r) => { if (!r.ok) throw new Error('sfx 404'); return r.arrayBuffer(); })
    .then((buf) => ctx.decodeAudioData(buf))
    .then((decoded) => { _sfxBuffers[key] = decoded; })
    .catch(() => { /* leave undefined -> synth fallback */ });
}

// Preload every bundled sample once. Called from initWeapon (additive). Each
// failure is isolated; no 404 can crash the game or block the loop.
function preloadSfx() {
  if (!ensureSfxContext()) return;
  for (const name of WEAPON_ORDER) {
    loadSfx('fire:' + name, SFX_ASSETS.fire[name]);
    loadSfx('reload:' + name, SFX_ASSETS.reload[name]);
  }
  loadSfx('empty', SFX_ASSETS.empty);
}

// Play a decoded buffer through the weapons master. `rate` pitch-shifts (1=normal).
// Returns true if a sample actually started (caller then suppresses the synth
// event), false if no buffer / context not ready (caller emits the event).
function playSample(key, gain, rate) {
  if (!_sfxReady || !_sfxCtx || !_sfxMaster) return false;
  if (_sfxCtx.state !== 'running') return false;
  const buffer = _sfxBuffers[key];
  if (!buffer) return false;
  try {
    const src = _sfxCtx.createBufferSource();
    src.buffer = buffer;
    if (rate && rate !== 1) src.playbackRate.value = rate;
    const g = _sfxCtx.createGain();
    g.gain.value = (gain == null ? 1 : gain);
    src.connect(g).connect(_sfxMaster);
    src.start();
    return true;
  } catch {
    return false;
  }
}

// Try to play the per-weapon FIRE sample. Returns true on success (synth event
// then suppressed by the caller in fire()).
function playFireSample(weaponName) {
  return playSample('fire:' + weaponName, SFX_GAIN.fire, 1);
}

// Try to play the per-weapon RELOAD sample.
function playReloadSample(weaponName) {
  return playSample('reload:' + weaponName, SFX_GAIN.reload, 1);
}

// Try to play the empty-mag click sample.
function playEmptySample() {
  return playSample('empty', SFX_GAIN.empty, 1);
}

// Asset keys -> file paths for GLTF viewmodels (procedural fallback on error).
// These are the NEW self-contained CC0 Quaternius models (textures, if any,
// embedded in the .glb so there are zero external asset 404s at runtime).
// Confirmed: pistol/rifle/shotgun all have images:0 / no external URIs.
const VIEWMODEL_ASSETS = {
  pistol: 'assets/weapons/pistol.glb',
  rifle: 'assets/weapons/rifle.glb',
  shotgun: 'assets/weapons/shotgun.glb',
};

// Target view-space LENGTH (longest dimension, metres) the loaded weapon mesh
// is scaled to so it reads clearly in first person. Per-weapon so a long rifle
// and a stubby pistol both sit nicely in the lower-right of the frame.
const VIEWMODEL_TARGET_LEN = {
  pistol: 0.30,
  rifle: 0.52,
  shotgun: 0.46,
};

// ---- module-scoped reusable temporaries (no per-frame allocation) ----
const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _spreadAxisX = new THREE.Vector3();
const _spreadAxisY = new THREE.Vector3();

// ---- module-private viewmodel handles & animation accumulators ----
// One viewmodel per weapon name; `.visible` toggled to show the active one.
// muzzleFlash/muzzleLight are re-pointed at the active viewmodel on switch.
const viewmodels = {};        // { pistol: Group, rifle: Group, shotgun: Group }
let viewmodel = null;         // active THREE.Group parented to camera
let muzzleFlash = null;       // active muzzle flash mesh
let muzzleLight = null;       // active muzzle point light
let viewmodelHome = null;     // resting local position of the active viewmodel

let recoilKick = 0;       // current viewmodel pushback (decays to 0)
let recoilAngle = 0;      // current viewmodel pitch-up (decays to 0)
let spread = 0;           // current accumulated aim-cone half-angle
let muzzleTimer = 0;      // remaining muzzle-flash visible time
let swayTime = 0;         // accumulator for idle bob/sway
let armsRecoil = 0;       // 0..1 arms recoil pulse (set to 1 on fire, decays)
let lastEmptyClick = -Infinity;

// Semi-auto latch: true while the trigger has fired and not yet released.
// Reset when input.firing goes false (mouseup). Prevents holding the button
// from auto-firing pistol/shotgun.
let triggerHeld = false;

// ---- self-owned one-frame input flags ----
// We attach our OWN listeners (reload key, weapon-switch keys, mouse wheel)
// rather than relying on player.js's input flags. Reason: player.update() runs
// BEFORE weapons.update() each frame and clears its one-frame flags at the end
// of its own update, so a flag set on KeyR would already be cleared by the time
// weapons.update reads it (the documented reload bug). By owning the listeners
// here and consuming+clearing the flags inside weapons.update(), the one-frame
// semantics are preserved regardless of module update order. This is purely
// additive: player.js's own input handling is untouched.
const _winput = {
  reload: false,    // KeyR pressed this frame
  switchTo: null,   // weapon name or 0-based slot index requested this frame
  wheel: 0,         // accumulated wheel delta sign (+1 next / -1 prev)
};
let _listenersBound = false;

// ---- multiplayer authority flag ----
// true on host/single-player (local raycast hits are authoritative);
// false on a client (host decides hits, so we skip applyDamage/enemyHit).
// Defaults to true so the single-player path is byte-for-byte unchanged.
let authoritative = true;

/**
 * Set whether this client's local fire() owns hit resolution.
 *  - true  (host / single-player): fire() applies damage and pushes 'enemyHit'
 *           exactly as it always has.
 *  - false (network client): fire() keeps the responsive local feel (ammo,
 *           recoil, muzzle flash) and still emits 'localFire' for the net layer,
 *           but does NOT call applyDamage() or push 'enemyHit' — the host is
 *           authoritative for hits.
 * main.js calls this on entering a host/client run; never touched in 'sp'.
 */
export function setAuthoritative(state, isAuthoritative) {
  authoritative = !!isAuthoritative;
}

/**
 * Bind weapons.js's own input listeners exactly once. These set one-frame flags
 * that weapons.update() consumes-and-clears, sidestepping the cross-module flag
 * ordering bug (see _winput notes). Reload uses KeyR; switching uses Digit1/2/3
 * and the mouse wheel. Guarded against double-bind on hot reload.
 */
function bindInputListeners(state) {
  if (_listenersBound) return;
  _listenersBound = true;

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyR':
        _winput.reload = true;
        break;
      case 'Digit1': _winput.switchTo = 0; break;
      case 'Digit2': _winput.switchTo = 1; break;
      case 'Digit3': _winput.switchTo = 2; break;
      default: break;
    }
  });

  // Mouse wheel cycles weapons. Only act while pointer-locked / playing so menu
  // scrolling is unaffected. We store the sign; weapons.update consumes it.
  window.addEventListener('wheel', (e) => {
    if (state.phase !== 'playing') return;
    if (e.deltaY === 0) return;
    _winput.wheel = e.deltaY > 0 ? 1 : -1;
  }, { passive: true });
}

// Local 4-band toon gradient ramp (mirrors scene.js's private ramp so loaded
// GLB weapon meshes match the cel-shaded world; scene.js's helper isn't
// exported and the task forbids editing it). Lazily built, shared by all
// viewmodel materials. NearestFilter => hard toon bands, no mipmaps.
let _gradientMap = null;
function toonGradientMap() {
  if (_gradientMap) return _gradientMap;
  const steps = new Uint8Array([60, 130, 200, 255]); // 4-band ramp
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _gradientMap = tex;
  return tex;
}

// Cartoon-toon materials reused across procedural viewmodels.
function makeBodyMat(color) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradientMap() });
}

/**
 * Build a muzzle flash + point light at the given barrel-tip offset and add them
 * to a viewmodel group. Returns { flash, light } so the active pair can be wired
 * up on weapon switch. Flash is hidden by default.
 */
function addMuzzle(group, tipZ, tipY) {
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffcc66,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.18), flashMat);
  flash.position.set(0, tipY, tipZ);
  flash.visible = false;
  group.add(flash);

  const light = new THREE.PointLight(0xffaa44, 0, 6, 2);
  light.position.set(0, tipY, tipZ);
  group.add(light);

  group.userData.muzzleFlash = flash;
  group.userData.muzzleLight = light;
}

/** Procedural rifle viewmodel — the legacy primitive build, toon-shaded. */
function buildRifleViewmodel() {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(0x2b2f36);
  const accentMat = makeBodyMat(0x14161a);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.12, 0.42), bodyMat);
  body.position.set(0, 0, -0.10);
  group.add(body);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.34, 12), accentMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.42);
  group.add(barrel);

  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.22), bodyMat);
  handguard.position.set(0, 0.005, -0.34);
  group.add(handguard);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.09), accentMat);
  mag.position.set(0, -0.12, -0.05);
  mag.rotation.x = 0.18;
  group.add(mag);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.18), accentMat);
  stock.position.set(0, -0.02, 0.16);
  group.add(stock);

  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.03, 0.02), accentMat);
  sight.position.set(0, 0.075, -0.02);
  group.add(sight);

  addMuzzle(group, -0.60, 0.012);
  return group;
}

/** Procedural pistol viewmodel — compact slide + grip. */
function buildPistolViewmodel() {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(0x3a3f47);
  const accentMat = makeBodyMat(0x14161a);

  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.22), bodyMat);
  slide.position.set(0, 0.0, -0.10);
  group.add(slide);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.10, 10), accentMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.005, -0.22);
  group.add(barrel);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.06), accentMat);
  grip.position.set(0, -0.09, 0.0);
  grip.rotation.x = 0.22;
  group.add(grip);

  addMuzzle(group, -0.28, 0.005);
  return group;
}

/** Procedural shotgun viewmodel — fat body, wide barrel, pump. */
function buildShotgunViewmodel() {
  const group = new THREE.Group();
  const bodyMat = makeBodyMat(0x4a352a);   // toon woody brown receiver
  const accentMat = makeBodyMat(0x1b1d22);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.44), bodyMat);
  body.position.set(0, 0, -0.08);
  group.add(body);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.40, 12), accentMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.44);
  group.add(barrel);

  const pump = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.14), accentMat);
  pump.position.set(0, -0.02, -0.34);
  group.add(pump);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.20), bodyMat);
  stock.position.set(0, -0.03, 0.18);
  group.add(stock);

  addMuzzle(group, -0.66, 0.02);
  return group;
}

const VIEWMODEL_BUILDERS = {
  pistol: buildPistolViewmodel,
  rifle: buildRifleViewmodel,
  shotgun: buildShotgunViewmodel,
};

// ===========================================================================
// FIRST-PERSON TOON ARMS / HANDS
// ---------------------------------------------------------------------------
// Procedural cel-shaded arms (sleeve forearm + mitten hand) attached to each
// weapon's viewmodel GROUP. By parenting to the group, the arms inherit the
// viewmodel's home placement, idle bob/sway, recoil pushback/pitch and reload
// dip automatically — so the hands always look like they grip the gun, even
// after the async GLB swap (which only strips the procedural GUN meshes, never
// the arms — buildViewmodel removes nothing, and tryLoadViewmodelGLTF only
// removes children that aren't the muzzle flash/light; we additionally tag the
// arms group so a future change can't drop it). Recommendation per the research
// notes: procedural toon arms, no GLB. If anything here ever fails the gun is
// still drawn; arms are a pure additive cosmetic layer.
// ===========================================================================

// Toon skin + sleeve materials, built once and shared by every arm.
let _skinMat = null;
let _sleeveMat = null;
function armSkinMat() {
  if (!_skinMat) _skinMat = makeBodyMat(0xc98a5e); // warm cartoon skin tone
  return _skinMat;
}
function armSleeveMat() {
  if (!_sleeveMat) _sleeveMat = makeBodyMat(0x2f6b4f); // military-green sleeve
  return _sleeveMat;
}

// Build one arm: a sleeve forearm cylinder + a rounded mitten hand, grouped so
// it can be posed (positioned + aimed) toward a grip point as a unit. Local
// origin sits at the WRIST/hand; the forearm extends back along +Z (toward the
// player) so it reads as coming from off-screen.
function buildArm(handScale) {
  const arm = new THREE.Group();
  const s = handScale || 1;

  // Forearm: a slightly tapered sleeve running back along +Z from the wrist.
  const forearm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032 * s, 0.045 * s, 0.30, 10),
    armSleeveMat(),
  );
  forearm.rotation.x = Math.PI / 2;     // lay the cylinder along Z
  forearm.position.set(0, 0, 0.17);     // centre behind the wrist
  arm.add(forearm);

  // Cuff ring where sleeve meets hand (little toon detail).
  const cuff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.038 * s, 0.038 * s, 0.03, 10),
    armSkinMat(),
  );
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, 0, 0.035);
  arm.add(cuff);

  // Palm: a rounded box mitten.
  const palm = new THREE.Mesh(
    new THREE.BoxGeometry(0.07 * s, 0.045 * s, 0.085 * s),
    armSkinMat(),
  );
  palm.position.set(0, 0, -0.015);
  arm.add(palm);

  // Thumb nub on the inner side.
  const thumb = new THREE.Mesh(
    new THREE.BoxGeometry(0.022 * s, 0.03 * s, 0.04 * s),
    armSkinMat(),
  );
  thumb.position.set(0.04 * s, 0.005, -0.01);
  thumb.rotation.z = -0.4;
  arm.add(thumb);

  // Curled fingers wrapping forward (toward the gun, -Z) as a single block.
  const fingers = new THREE.Mesh(
    new THREE.BoxGeometry(0.07 * s, 0.05 * s, 0.03 * s),
    armSkinMat(),
  );
  fingers.position.set(0, -0.012, -0.055 * s);
  fingers.rotation.x = 0.5;
  arm.add(fingers);

  arm.traverse((o) => { o.frustumCulled = false; });
  return arm;
}

// Per-weapon grip placement (group-local). `main` = trigger/grip hand,
// `support` = foregrip/forward hand. Hands are placed near the gun in the
// viewmodel group's local space so they visibly grip it. Tuned to the
// procedural gun geometry; close enough for the scaled GLB swap too. `rest`
// holds the resting local positions so we can lerp small recoil offsets.
const ARM_LAYOUT = {
  pistol: {
    main: { pos: [-0.005, -0.08, 0.02], rot: [0.5, 0.2, -0.1], scale: 1.0 },
    support: null,
  },
  rifle: {
    main: { pos: [0.0, -0.085, 0.05], rot: [0.45, 0.15, -0.05], scale: 1.0 },
    support: { pos: [0.01, -0.05, -0.30], rot: [0.7, -0.2, 0.1], scale: 0.95 },
  },
  shotgun: {
    main: { pos: [0.0, -0.085, 0.12], rot: [0.45, 0.15, -0.05], scale: 1.05 },
    support: { pos: [0.01, -0.06, -0.30], rot: [0.7, -0.2, 0.1], scale: 1.0 },
  },
};

// Build + attach the arms for a weapon onto its viewmodel group. Stores handles
// in group.userData.arms = [{ obj, rest:Vector3 }, ...] for per-frame posing.
function attachArms(name, group) {
  const layout = ARM_LAYOUT[name];
  if (!layout) return;
  const arms = [];
  const place = (cfg) => {
    if (!cfg) return;
    const arm = buildArm(cfg.scale);
    arm.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
    arm.rotation.set(cfg.rot[0], cfg.rot[1], cfg.rot[2]);
    group.add(arm);
    arms.push({ obj: arm, rest: arm.position.clone() });
  };
  place(layout.main);
  place(layout.support);
  group.userData.arms = arms;
}

// Pose the arms each frame: a tiny recoil kick-back (arms travel with the gun's
// own recoilKick already, this adds a subtle extra hand-recoil pulse) plus a
// reload sink on the support/foregrip hand. Cheap; no allocation.
function animateArms(group, reloadArc) {
  const arms = group && group.userData && group.userData.arms;
  if (!arms) return;
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    const rest = a.rest;
    // Main hand (i===0) recoils back; support hand dips during reload.
    const back = armsRecoil * 0.03;
    const dip = (i > 0 ? reloadArc * 0.06 : 0);
    a.obj.position.set(rest.x, rest.y - dip, rest.z + back);
  }
}

/**
 * Build ALL three viewmodels once, parent each to the camera, and toggle
 * visibility by the active weapon. Each viewmodel gets its own muzzle flash +
 * light at its barrel tip; the active pair is pointed-to by the module
 * muzzleFlash/muzzleLight handles in setActiveViewmodel(). GLTF models are
 * loaded async and merged in on success; on ANY load error the procedural
 * primitive remains (graceful fallback, never blocks the loop).
 */
function buildViewmodel(state) {
  for (const name of WEAPON_ORDER) {
    const group = VIEWMODEL_BUILDERS[name]();

    // Resting placement: down-right, slightly forward of the near plane.
    group.position.set(0.16, -0.16, -0.4);
    group.rotation.y = -0.04;
    group.userData.home = group.position.clone();
    group.visible = false;

    // Viewmodel must not be culled by the world; render on top reliably.
    group.traverse((o) => { o.frustumCulled = false; });

    // Attach procedural toon arms/hands gripping this weapon (additive cosmetic
    // layer; survives the async GLB swap — see tryLoadViewmodelGLTF cleanup).
    attachArms(name, group);

    viewmodels[name] = group;
    state.camera.add(group);

    // Try to load the CC0 GLTF asset and swap in its meshes (additive, async).
    tryLoadViewmodelGLTF(name, group);
  }

  setActiveViewmodel(state.weapon.active || 'rifle');
}

/**
 * Rotate `model` in place so that the LONGEST dimension of its current world
 * bounding box ends up running along the -Z axis (camera forward / down-sight).
 * The new Quaternius weapons are NOT all long along the same local axis (the
 * rifle's barrel runs along Z, the pistol/shotgun along X), so we orient from
 * measured bounds instead of a hard-coded rotation. Operates on the live object
 * (which may carry node-level scale/rotation), measuring via Box3.setFromObject.
 */
function orientLongestAxisToMinusZ(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  // Pick the dominant axis of the mesh's extent.
  if (size.x >= size.y && size.x >= size.z) {
    // Long along X -> rotate about Y so +X (or -X) maps toward -Z.
    model.rotation.y += -Math.PI / 2;
  } else if (size.z >= size.x && size.z >= size.y) {
    // Long along Z -> flip 180 about Y so the muzzle (+Z) points to -Z.
    model.rotation.y += Math.PI;
  } else {
    // Long along Y (rare/upright) -> tip it forward about X to lie along Z,
    // then flip so the tip faces -Z.
    model.rotation.x += -Math.PI / 2;
    model.rotation.y += Math.PI;
  }
  model.updateMatrixWorld(true);
}

// Lazy GLTFLoader import so the module loads even if addons are unreachable.
// Loads the self-contained CC0 GLB, robustly normalizes scale/orientation/pivot
// from measured bounds, toon-shades it, and only then replaces the procedural
// primitive. Any failure (network, parse, OR an unresolved/missing texture)
// keeps the guaranteed-visible procedural gun.
function tryLoadViewmodelGLTF(name, group) {
  const url = VIEWMODEL_ASSETS[name];
  if (!url) return;
  import('three/addons/loaders/GLTFLoader.js')
    .then(({ GLTFLoader }) => {
      // A LoadingManager catches texture 404s: GLTFLoader resolves load() with
      // gltf.scene even when a referenced image fails (it only logs and leaves
      // material.map=null), so the onError third-arg never fires for that case.
      // The manager's onError DOES fire for the texture sub-request; we record
      // it and skip the swap, keeping the procedural primitive (fix A/B item 2).
      let assetFailed = false;
      const manager = new THREE.LoadingManager();
      manager.onError = () => { assetFailed = true; };
      const loader = new GLTFLoader(manager);
      loader.load(
        url,
        (gltf) => {
          // Bail to procedural if any sub-resource (e.g. a texture) failed.
          if (assetFailed) return;

          const model = gltf.scene;

          // Toon-ify every mesh, preserving the source map (if any) and color so
          // textured kits keep their atlas and vertex/material-colored Quaternius
          // meshes keep their tint. (The bundled weapons have no maps, so nothing
          // can 404; the assetFailed guard above handles any future textured kit.)
          model.traverse((o) => {
            if (!o.isMesh) return;
            o.frustumCulled = false;
            o.castShadow = false;
            o.receiveShadow = false;
            const src = o.material;
            const col = (src && src.color) ? src.color.clone() : new THREE.Color(0x888888);
            const map = (src && src.map) ? src.map : null;
            o.material = new THREE.MeshToonMaterial({
              color: col,
              map,
              gradientMap: toonGradientMap(),
            });
          });

          // --- Robust normalize: orient longest axis to -Z, recenter, scale. ---
          // 1) Orient first (so the post-rotation bounds drive centering/scale).
          orientLongestAxisToMinusZ(model);

          // 2) Measure the oriented bounds.
          const box = new THREE.Box3().setFromObject(model);
          if (box.isEmpty()) return; // no geometry -> keep procedural
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z);
          if (!(longest > 0) || !isFinite(longest)) return; // keep procedural

          // 3) Scale the mesh to the per-weapon target view length.
          const target = VIEWMODEL_TARGET_LEN[name] || 0.4;
          const s = target / longest;

          // 4) Re-center on the group origin. Scaling about the model's node
          // origin by `s` moves the centroid from `center` to
          // P_old + (center - P_old)*s; we want that at the pivot origin, so set
          // model.position = -(center - P_old)*s. Wrap in a pivot to offset the
          // whole thing cleanly regardless of the model's internal transforms.
          const pOld = model.position.clone();
          model.scale.multiplyScalar(s);
          const pivot = new THREE.Group();
          pivot.add(model);
          model.position.copy(center.sub(pOld).multiplyScalar(s).multiplyScalar(-1));
          // Nudge forward so the barrel sits ahead of the eye, and a touch up so
          // the grip reads in the lower-right (group is already at 0.16,-0.16).
          pivot.position.set(0, 0.02, -0.06);
          pivot.frustumCulled = false;
          pivot.traverse((o) => { o.frustumCulled = false; });

          // --- COMMIT: now (and only now) strip the procedural primitive. ---
          // Keep the muzzle flash + light; reposition them at the new muzzle tip
          // (front-most -Z point of the oriented, scaled, centered model).
          const flash = group.userData.muzzleFlash;
          const light = group.userData.muzzleLight;
          // Keep the muzzle flash/light AND the procedural arms (cosmetic hands
          // that grip the gun); only strip the procedural GUN primitives.
          const arms = group.userData.arms;
          const keep = new Set([flash, light]);
          if (arms) for (const a of arms) keep.add(a.obj);
          for (let k = group.children.length - 1; k >= 0; k--) {
            const c = group.children[k];
            if (!keep.has(c)) group.remove(c);
          }
          group.add(pivot);

          // The model's front is at -size.z/2 in pivot space after centering;
          // place the muzzle slightly beyond it down the -Z barrel line.
          const tipZ = -(size.z * s) / 2 - 0.04 + pivot.position.z;
          if (flash) flash.position.set(0, pivot.position.y, tipZ);
          if (light) light.position.set(0, pivot.position.y, tipZ);
        },
        undefined,
        () => { /* network/parse error: keep procedural primitive (graceful) */ },
      );
    })
    .catch(() => { /* addons unreachable: keep procedural primitive */ });
}

/**
 * Show only the named weapon's viewmodel and re-point the module muzzle handles
 * + viewmodelHome at it. Safe to call before/after GLTF swap-in.
 */
function setActiveViewmodel(name) {
  for (const n of WEAPON_ORDER) {
    if (viewmodels[n]) viewmodels[n].visible = (n === name);
  }
  const g = viewmodels[name];
  if (!g) return;
  viewmodel = g;
  viewmodelHome = g.userData.home;
  muzzleFlash = g.userData.muzzleFlash || null;
  muzzleLight = g.userData.muzzleLight || null;
  if (muzzleFlash) muzzleFlash.visible = false;
  if (muzzleLight) muzzleLight.intensity = 0;
}

// Build a fresh per-slot inventory record for a weapon name. owned controls
// whether the player can switch to it. Mag is full, reserve at the weapon default.
function makeSlot(name, owned) {
  const def = WEAPONS[name];
  return {
    ammoInMag: def.magSize,
    reserveAmmo: def.defaultReserve,
    owned: !!owned,
  };
}

/**
 * Refresh the top-level convenience mirrors on state.weapon so existing readers
 * (hud.js: ammoInMag/magSize/reserveAmmo/reloading/reloadProgress;
 *  main.js: damage/headshotMultiplier) keep working unchanged. The mirrors
 * reflect the ACTIVE slot + active weapon definition.
 */
function refreshMirrors(state) {
  const w = state.weapon;
  const def = WEAPONS[w.active];
  const slot = w.slots[w.active];
  w.name = def.name;
  w.magSize = def.magSize;
  w.ammoInMag = slot.ammoInMag;
  w.reserveAmmo = slot.reserveAmmo;
  w.damage = def.damage;
  w.headshotMultiplier = def.headshotMultiplier;
  // reloading / reloadProgress / lastShotTime stay live on w itself.
}

// Persist the live mirror ammo back into the active slot (call before switching
// away or whenever ammo changes are made through the mirror).
function syncSlotFromMirrors(state) {
  const w = state.weapon;
  const slot = w.slots[w.active];
  slot.ammoInMag = w.ammoInMag;
  slot.reserveAmmo = w.reserveAmmo;
}

/**
 * Initialize weapon inventory and build the viewmodels. Called once by main.js
 * after the camera exists. Defaults: pistol + rifle owned, shotgun locked until
 * pickup; active = rifle so single-player starts identical to the legacy build.
 */
export function initWeapon(state) {
  const w = state.weapon;
  w.active = 'rifle';
  w.slots = {
    pistol: makeSlot('pistol', true),
    rifle: makeSlot('rifle', true),
    shotgun: makeSlot('shotgun', false),
  };
  w.reloading = false;
  w.reloadProgress = 0;
  w.lastShotTime = -Infinity;
  refreshMirrors(state);

  recoilKick = 0;
  recoilAngle = 0;
  spread = 0;
  muzzleTimer = 0;
  swayTime = 0;
  triggerHeld = false;
  lastEmptyClick = -Infinity;

  armsRecoil = 0;

  bindInputListeners(state);
  buildViewmodel(state);
  preloadSfx();
}

/** Begin a reload if it's valid to do so. */
function startReload(state) {
  const w = state.weapon;
  if (w.reloading) return;
  if (w.ammoInMag >= w.magSize) return;
  if (w.reserveAmmo <= 0) return;
  w.reloading = true;
  w.reloadProgress = 0;
  // Bundled per-weapon reload sample; fall back to the synth 'reloadStart' event.
  if (!playReloadSample(w.active)) state.events.push({ type: 'reloadStart' });
}

/** Complete an in-progress reload, pulling rounds from the reserve. */
function finishReload(state) {
  const w = state.weapon;
  const needed = w.magSize - w.ammoInMag;
  const taken = Math.min(needed, w.reserveAmmo);
  w.ammoInMag += taken;
  w.reserveAmmo -= taken;
  w.reloading = false;
  w.reloadProgress = 1;
  syncSlotFromMirrors(state);
  state.events.push({ type: 'reloadEnd' });
}

// Resolve a single pellet ray against enemies authoritatively (apply damage +
// push enemyHit). Shared by single-ray and multi-pellet (shotgun) firing.
function resolvePellet(state, def, originVec, dirVec) {
  _raycaster.set(originVec, dirVec);
  _raycaster.far = def.range;

  const targets = getEnemyMeshes(state);
  if (!targets || targets.length === 0) return;

  const hits = _raycaster.intersectObjects(targets, true);
  if (hits.length === 0) return;

  const hit = hits[0];

  // Walk up the parent chain to find the object carrying enemyId in userData.
  let obj = hit.object;
  let enemyId = obj.userData && obj.userData.enemyId;
  let headY = obj.userData && obj.userData.headY;
  while ((enemyId === undefined || enemyId === null) && obj.parent) {
    obj = obj.parent;
    if (obj.userData) {
      if (enemyId === undefined || enemyId === null) enemyId = obj.userData.enemyId;
      if (headY === undefined || headY === null) headY = obj.userData.headY;
    }
  }
  if (enemyId === undefined || enemyId === null) return;

  const headThreshold = (typeof headY === 'number' ? headY : 1.6) - 0.18;
  const headshot = hit.point.y >= headThreshold;

  const damage = def.damage * (headshot ? def.headshotMultiplier : 1);
  applyDamage(state, enemyId, damage, hit.point);
  state.events.push({ type: 'enemyHit', enemyId, damage, headshot });
}

/**
 * Fire one shot of the active weapon: spend ammo, kick camera + viewmodel, flash
 * the muzzle, and raycast `pellets` rays (each with its own spread sample). Each
 * pellet routes damage through resolvePellet() exactly as the legacy single ray
 * did. Emits one 'localFire' carrying ALL pellet rays so the host can resolve
 * the full shot (single-pellet weapons send a one-element array, and also keep
 * the legacy flat origin/dir fields for older readers).
 */
function fire(state) {
  const w = state.weapon;
  const def = WEAPONS[w.active];
  w.ammoInMag -= 1;
  w.lastShotTime = state.time;
  syncSlotFromMirrors(state);
  // Prefer the bundled per-weapon CC0 fire sample; only push 'shoot' (which
  // drives audio.js's synth in main.js) when no sample played, so we never
  // double up. Missing/undecoded buffer -> false -> synth fallback fires.
  if (!playFireSample(w.active)) state.events.push({ type: 'shoot' });

  // Arms recoil snap (decays in animateViewmodel via the same recoil accumulators).
  armsRecoil = 1;

  // Camera kick (player.js owns pitch but applies it next frame; nudging here
  // is read by player.update's clamp on the following frame — small & safe).
  state.player.pitch = Math.min(
    Math.PI / 2 - 0.01,
    state.player.pitch + def.recoilPitch,
  );

  // Viewmodel kick + accumulate spread (clamped to the weapon's max).
  recoilKick = def.recoilKick;
  recoilAngle = def.recoilPitch * 2.0;
  spread = Math.min(def.spreadMax, spread + def.spreadPerShot);

  // Muzzle flash pop.
  muzzleTimer = MUZZLE_FLASH_TIME;
  if (muzzleFlash) {
    muzzleFlash.visible = true;
    muzzleFlash.rotation.z = Math.random() * Math.PI; // random spin per shot
    const s = 0.8 + Math.random() * 0.6;
    muzzleFlash.scale.set(s, s, s);
  }
  if (muzzleLight) muzzleLight.intensity = 4;

  // Camera origin + base forward (shared by all pellets this shot).
  state.camera.getWorldPosition(_origin);
  state.camera.getWorldQuaternion(_camQuat);
  _spreadAxisX.set(1, 0, 0).applyQuaternion(_camQuat);
  _spreadAxisY.set(0, 1, 0).applyQuaternion(_camQuat);

  // Effective cone half-angle for this shot: baseline + accumulated spread.
  const cone = def.spreadBase + spread;

  const rays = [];
  const pellets = Math.max(1, def.pellets);
  for (let p = 0; p < pellets; p++) {
    _forward.set(0, 0, -1).applyQuaternion(_camQuat).normalize();
    if (cone > 0) {
      const ang = Math.random() * Math.PI * 2;
      const mag = cone * Math.sqrt(Math.random()); // uniform over the disc
      _forward
        .addScaledVector(_spreadAxisX, Math.cos(ang) * mag)
        .addScaledVector(_spreadAxisY, Math.sin(ang) * mag)
        .normalize();
    }
    rays.push({
      origin: [_origin.x, _origin.y, _origin.z],
      dir: [_forward.x, _forward.y, _forward.z],
    });

    // Authoritative resolution per pellet (host / single-player only).
    if (authoritative) resolvePellet(state, def, _origin, _forward);
  }

  // Emit the local shot for the net layer. Carry the weapon name + full pellet
  // ray array (host resolves all pellets with the shooter's stats). Keep the
  // legacy flat origin/dir (first ray) so any older single-ray reader still
  // works. Inert in 'sp' (main.js only forwards 'localFire' in MP modes).
  state.events.push({
    type: 'localFire',
    weapon: w.active,
    rays,
    origin: rays[0].origin,
    dir: rays[0].dir,
  });
}

/**
 * Per-frame: drive reload progression, fire-rate gating, recoil/spread decay,
 * muzzle-flash fade, and subtle idle sway. No firing unless phase==='playing'.
 */
export function update(state, dt) {
  const w = state.weapon;
  const def = WEAPONS[w.active];
  const playing = state.phase === 'playing';

  // --- Reload progression (per-weapon reload time) ---
  if (w.reloading) {
    w.reloadProgress += dt / def.reloadTime;
    if (w.reloadProgress >= 1) finishReload(state);
  }

  // --- Consume self-owned weapon-switch input (one-frame flags we own). ---
  // Done before firing so a same-frame switch+fire uses the new weapon's gate.
  if (playing) {
    if (_winput.switchTo !== null) {
      if (typeof _winput.switchTo === 'number') selectSlot(state, _winput.switchTo);
      else switchWeapon(state, _winput.switchTo);
    }
    if (_winput.wheel !== 0) {
      cycleWeapon(state, _winput.wheel);
    }
  }
  _winput.switchTo = null;
  _winput.wheel = 0;

  // Re-read after a possible switch (active weapon / def may have changed).
  const adef = WEAPONS[w.active];

  if (playing) {
    // --- Reload trigger (weapons.js owns input.reload via its own listener) ---
    if (_winput.reload && !w.reloading &&
        w.ammoInMag < w.magSize && w.reserveAmmo > 0) {
      startReload(state);
    }

    // --- Firing ---
    // Semi-auto weapons (auto:false) require a fresh trigger press: gate on the
    // triggerHeld latch which is cleared on mouseup (input.firing -> false).
    if (state.input.firing && !w.reloading) {
      if (w.ammoInMag > 0) {
        const canTrigger = adef.auto || !triggerHeld;
        if (canTrigger && state.time - w.lastShotTime >= adef.fireInterval) {
          fire(state);
          triggerHeld = true;
        }
      } else {
        // Dry fire — rate-limited dry click (also latches the semi trigger).
        if (!adef.auto && triggerHeld) {
          // already clicked this press; stay silent until release
        } else if (state.time - lastEmptyClick >= EMPTY_CLICK_INTERVAL) {
          lastEmptyClick = state.time;
          triggerHeld = true;
          // Bundled empty-click sample; fall back to synth 'emptyClick' event.
          if (!playEmptySample()) state.events.push({ type: 'emptyClick' });
        }
      }
    } else if (!state.input.firing) {
      // Trigger released: re-arm semi-auto weapons.
      triggerHeld = false;
    }
  }
  // Always consume the one-frame reload flag (consumer clears it).
  _winput.reload = false;

  // --- Spread recovery (only bleeds off when not actively firing) ---
  const firingNow = playing && state.input.firing && w.ammoInMag > 0 && !w.reloading;
  if (!firingNow && spread > 0) {
    spread = Math.max(0, spread - SPREAD_RECOVER * dt);
  }

  // --- Recoil decay ---
  recoilKick = Math.max(0, recoilKick - recoilKick * RECOIL_RECOVER * dt);
  recoilAngle = Math.max(0, recoilAngle - recoilAngle * RECOIL_RECOVER * dt);
  armsRecoil = Math.max(0, armsRecoil - armsRecoil * RECOIL_RECOVER * dt);

  // --- Muzzle flash fade ---
  if (muzzleTimer > 0) {
    muzzleTimer -= dt;
    if (muzzleTimer <= 0 && muzzleFlash) muzzleFlash.visible = false;
    if (muzzleLight) {
      muzzleLight.intensity = muzzleTimer > 0
        ? 4 * (muzzleTimer / MUZZLE_FLASH_TIME)
        : 0;
    }
  }

  animateViewmodel(state, dt);
}

/**
 * Pose the viewmodel each frame: resting position + recoil pushback/pitch,
 * a reload dip, and a gentle idle/move sway.
 */
function animateViewmodel(state, dt) {
  if (!viewmodel || !viewmodelHome) return;
  const w = state.weapon;

  swayTime += dt;

  // Idle/move bob — larger when the player is moving horizontally.
  const speed = Math.hypot(state.player.velocity.x, state.player.velocity.z);
  const bobAmt = 0.004 + Math.min(speed, 8) * 0.0016;
  const bobX = Math.sin(swayTime * 6) * bobAmt;
  const bobY = Math.abs(Math.cos(swayTime * 6)) * bobAmt;

  // Reload dip: drop and tilt the gun while reloading.
  let reloadDip = 0;
  let reloadRoll = 0;
  if (w.reloading) {
    // Smooth up/down arc over the reload duration.
    const arc = Math.sin(w.reloadProgress * Math.PI);
    reloadDip = arc * 0.12;
    reloadRoll = arc * 0.5;
  }

  viewmodel.position.set(
    viewmodelHome.x + bobX,
    viewmodelHome.y + bobY - reloadDip,
    viewmodelHome.z + recoilKick,
  );
  viewmodel.rotation.x = recoilAngle;
  viewmodel.rotation.z = reloadRoll;

  // Pose the gripping hands (subtle extra recoil + reload sink). The arms are
  // children of the viewmodel group, so they already follow the bob/recoil
  // transform above; this only adds the hand-relative motion.
  const arc = w.reloading ? Math.sin(w.reloadProgress * Math.PI) : 0;
  animateArms(viewmodel, arc);
}

// ===========================================================================
// Active-weapon multiplayer sync hook.
// ===========================================================================

/**
 * The local player's active weapon name. main.js embeds this as `wpn` in each
 * snapshot player record (host reads its own; clients send 'wswitch') so peers
 * render the correct gun on remote avatars and the host applies per-weapon
 * damage. Inert in single-player.
 */
export function getActiveWeapon(state) {
  return state.weapon.active;
}

// ===========================================================================
// Weapon switching & inventory mutation (exported; used by input + pickups).
// ===========================================================================

/**
 * Switch to an owned weapon by name. No-op if unowned, already active, or mid
 * reload (can't swap during a reload). Snapshots the current slot's ammo back,
 * sets the active weapon, refreshes the HUD/snapshot mirrors, resets spread, and
 * pushes a 'weaponSwitch' event (main.js plays a sound + emits net 'wswitch').
 */
export function switchWeapon(state, name) {
  const w = state.weapon;
  if (!WEAPONS[name]) return;
  if (!w.slots[name] || !w.slots[name].owned) return;
  if (name === w.active) return;
  if (w.reloading) return;

  // Persist current ammo, then activate the new slot.
  syncSlotFromMirrors(state);
  w.active = name;
  w.reloadProgress = 0;
  refreshMirrors(state);

  // Fresh weapon feel: clear accumulated spread + re-arm the semi trigger gate.
  spread = 0;
  triggerHeld = true; // require a fresh click before firing the new weapon

  setActiveViewmodel(name);
  state.events.push({ type: 'weaponSwitch', name });
}

// Cycle to the next/prev OWNED weapon. dir > 0 = next, dir < 0 = previous.
function cycleWeapon(state, dir) {
  const w = state.weapon;
  const order = WEAPON_ORDER;
  const cur = order.indexOf(w.active);
  if (cur < 0) return;
  const n = order.length;
  for (let step = 1; step <= n; step++) {
    const idx = ((cur + dir * step) % n + n) % n;
    const name = order[idx];
    if (w.slots[name] && w.slots[name].owned) {
      switchWeapon(state, name);
      return;
    }
  }
}

/** Switch to the next owned weapon (mouse-wheel up / cycling). */
export function nextWeapon(state) {
  cycleWeapon(state, 1);
}

/** Switch to the owned weapon at the given 0-based slot index (number keys). */
export function selectSlot(state, index) {
  const name = WEAPON_ORDER[index];
  if (!name) return;
  switchWeapon(state, name);
}

/**
 * Grant ownership of a weapon (weapon pickups). If newly owned, top its mag up
 * to one full magazine. Does NOT auto-switch (caller/input decides). Safe to
 * call repeatedly. Refreshes mirrors if the granted weapon is the active one.
 */
export function giveWeapon(state, name) {
  const w = state.weapon;
  const def = WEAPONS[name];
  if (!def || !w.slots[name]) return;
  const slot = w.slots[name];
  if (!slot.owned) {
    slot.owned = true;
    slot.ammoInMag = def.magSize;          // top up to one mag when newly owned
  }
  if (name === w.active) refreshMirrors(state);
}

/**
 * Add reserve ammo to the named weapon (or the active weapon if name omitted),
 * clamped to magSize * RESERVE_CAP_MULT. Used by ammo pickups. Refreshes the
 * mirrors if the affected weapon is active so the HUD updates immediately.
 */
export function addReserve(state, amount, weaponName) {
  const w = state.weapon;
  const name = weaponName || w.active;
  const def = WEAPONS[name];
  if (!def || !w.slots[name]) return;
  const slot = w.slots[name];
  // Keep the active slot's live mirror authoritative before mutating it.
  if (name === w.active) syncSlotFromMirrors(state);
  const cap = def.magSize * RESERVE_CAP_MULT;
  slot.reserveAmmo = Math.min(cap, slot.reserveAmmo + amount);
  if (name === w.active) refreshMirrors(state);
}

/**
 * Restore per-slot ammo to defaults and reset active='rifle'. Called by main.js
 * on restart (SP/host/client). Keeps owned flags (pistol/rifle owned, shotgun
 * locked) consistent with initWeapon so restarts start identical.
 */
export function resetWeapon(state) {
  const w = state.weapon;
  w.active = 'rifle';
  w.slots = {
    pistol: makeSlot('pistol', true),
    rifle: makeSlot('rifle', true),
    shotgun: makeSlot('shotgun', false),
  };
  w.reloading = false;
  w.reloadProgress = 0;
  w.lastShotTime = -Infinity;
  refreshMirrors(state);

  recoilKick = 0;
  recoilAngle = 0;
  spread = 0;
  muzzleTimer = 0;
  armsRecoil = 0;
  triggerHeld = false;
  lastEmptyClick = -Infinity;

  setActiveViewmodel(w.active);
  if (muzzleFlash) muzzleFlash.visible = false;
  if (muzzleLight) muzzleLight.intensity = 0;
  if (viewmodel && viewmodelHome) {
    viewmodel.position.copy(viewmodelHome);
    viewmodel.rotation.set(0, viewmodel.rotation.y, 0);
  }
}
