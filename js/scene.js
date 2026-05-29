// scene.js — world, renderer, lighting, arena map & static collision.
// Owns: state.THREE, state.renderer, state.scene, state.camera, state.colliders,
//       state.arenaHalf, state.config. No per-frame update(): the world is static.
//
// Imports allowed: 'three' only (per shared contract).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';

// ---------------------------------------------------------------------------
// QUALITY FLAGS — gate the expensive post stack so integrated GPUs can opt out.
// state.quality (set by callers) may override; default 'high'. 'low' bypasses
// the EffectComposer entirely (falls back to renderer.render) and skips bloom.
// All visual enrichers keep a procedural fallback regardless of quality.
// ---------------------------------------------------------------------------
const QUALITY = {
  enableComposer: true, // master switch for the post pipeline
  enableBloom: true,    // UnrealBloom (~5 passes) — heaviest add
  enableOutline: true,  // inverted-hull cel edges on hero props
  // PERF: the entire world/props/enemies use MeshToonMaterial, which ignores
  // scene.environment/envMap. The RoomEnvironment PMREM and the multi-MB HDRI
  // download + PMREM are therefore pure waste under the toon look. Disabled so
  // map loads are hitch-free; the procedural gradient/JPG sky (loadSky) is the
  // visible sky and the look is unchanged.
  enableEnvIBL: false,  // RoomEnvironment / HDRI image-based lighting for PBR props
  enableHDRI: false,    // swap procedural sky for a real CC0 equirect HDRI
  enableInstancedProps: true, // kit/foliage/debris InstancedMesh decoration layer
};

// PERF: cap device pixel ratio for the WHOLE pipeline (renderer + composer).
// On a retina panel min(dpr,2) renders every post pass at up to 2x, multiplying
// the cost of every full-screen pass. 1.5 keeps edges clean while cutting the
// pixel count by ~44% vs 2.0. Single source of truth so renderer/composer agree.
const MAX_PIXEL_RATIO = 1.5;
function pixelRatio() {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

// ---------------------------------------------------------------------------
// Exported shared constants — single source of truth for the whole game.
// Other modules import these instead of hardcoding (see contract §3).
// ---------------------------------------------------------------------------
export const ARENA_HALF = 50;          // floor is 100 x 100, x/z in [-50, 50]
export const WALL_HEIGHT = 6;
export const WALL_THICKNESS = 1;
export const PLAYER_EYE_HEIGHT = 1.7;
export const GRAVITY = 24;             // m/s^2 — punchy game-feel value, not 9.8
export const PLAYER_SPEED = 7;         // m/s ground move speed
export const PLAYER_JUMP_SPEED = 8;    // m/s initial jump velocity
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_HALF = { x: 0.4, y: 0.9, z: 0.4 };
export const ENEMY_HALF  = { x: 0.5, y: 1.0, z: 0.5 };

// ---------------------------------------------------------------------------
// Collider helper — the unit of static collision shared with player/enemies.
// Returns a plain object { min, max, mesh } in world space. Collision logic in
// other modules uses min/max only; mesh is optional/debug.
// ---------------------------------------------------------------------------
export function makeCollider(centerX, centerY, centerZ, halfX, halfY, halfZ, mesh = null) {
  return {
    min: new THREE.Vector3(centerX - halfX, centerY - halfY, centerZ - halfZ),
    max: new THREE.Vector3(centerX + halfX, centerY + halfY, centerZ + halfZ),
    mesh,
  };
}

// Deterministic crate layout (center x,z + half-extent + height). Hand-placed so
// the arena has interesting sightlines, flanks and chest-high cover near spawns
// without ever blocking the central spawn point (0,0).
const CRATE_LAYOUT = [
  // [x, z, halfXZ, height]
  [  12,   8, 1.5, 2.2 ],
  [ -14,  10, 1.5, 1.5 ],
  [  18, -16, 2.0, 3.0 ],
  [ -20, -18, 1.5, 2.2 ],
  [   6, -26, 1.2, 1.2 ],
  [ -8,  -30, 1.8, 2.6 ],
  [  28,  22, 2.0, 3.4 ],
  [ -30,  26, 1.5, 2.2 ],
  [  34, -32, 1.5, 1.5 ],
  [ -36, -34, 2.2, 4.0 ],
  [   0,  24, 2.5, 1.5 ],   // wide low wall north of center
  [  22,   0, 1.2, 2.2 ],
  [ -24,   0, 1.2, 2.2 ],
  [   0, -14, 1.5, 1.0 ],   // small low crate, hoppable cover
  [  40,  10, 1.0, 1.0 ],
  [ -42, -10, 1.0, 1.0 ],
];

// Module-scoped spawn points cache (deterministic, computed once).
let _spawnPoints = null;

// ===========================================================================
// MAP REGISTRY — multiple distinct arenas (layout/palette/skybox/lighting).
// Arena DIMENSIONS (ARENA_HALF/WALL_HEIGHT) are constant across maps so the
// player keep-in, collider math and host config handshake stay valid. Maps only
// differ in cover layout, palette, lighting, sky and textures. (contract: MAPS)
// ===========================================================================

export const DEFAULT_MAP_ID = 'warehouse';

// Desert: sparse, tall cover for long sightlines.
const DESERT_LAYOUT = [
  [  16,  12, 2.2, 4.0 ],
  [ -18,  16, 1.8, 3.2 ],
  [  24, -20, 2.4, 4.6 ],
  [ -26, -22, 2.0, 3.6 ],
  [   0,  28, 3.0, 2.0 ],
  [  36,  30, 2.2, 4.0 ],
  [ -38,  32, 1.8, 3.2 ],
  [  30, -34, 2.0, 3.6 ],
  [ -34, -36, 2.6, 5.0 ],
  [   2,  -8, 1.6, 1.4 ],
];

// Night city: many low/medium "containers" packed for close-quarters lanes.
const NIGHT_LAYOUT = [
  [  10,   6, 1.6, 2.6 ],
  [ -12,   8, 1.6, 2.6 ],
  [  14, -10, 1.6, 2.6 ],
  [ -16, -12, 1.6, 2.6 ],
  [  22,  18, 1.8, 3.0 ],
  [ -24,  20, 1.8, 3.0 ],
  [  26, -22, 1.6, 2.6 ],
  [ -28, -24, 1.6, 2.6 ],
  [   0,  16, 2.6, 1.4 ],
  [   0, -16, 2.6, 1.4 ],
  [  18,   0, 1.4, 2.2 ],
  [ -18,   0, 1.4, 2.2 ],
  [  38,  12, 1.4, 2.2 ],
  [ -40, -12, 1.4, 2.2 ],
];

export const MAPS = {
  warehouse: {
    id: 'warehouse',
    name: 'Warehouse',
    palette: {
      ground: ['#3a3f47', '#444a53'],
      wall: 0x6d717a,
      crateTint: 0xb07a3c,
      fog: 0x9fb6cc,
      sky: ['#1b3a63', '#5b86b0', '#9fb6cc', '#b9c7d4'],
    },
    lighting: {
      hemiSky: 0xbcd6ff, hemiGround: 0x4a4636, hemiInt: 0.65,
      ambient: 0x404653, ambientInt: 0.35,
      sunColor: 0xfff2d8, sunPos: [40, 60, 25], sunInt: 1.1,
    },
    crateLayout: CRATE_LAYOUT,
    pickupPads: [
      [12, 8, 'ammo'], [-14, 10, 'ammo'], [18, -16, 'weapon'],
      [-20, -18, 'ammo'], [0, 24, 'weapon'], [28, 22, 'ammo'],
    ],
    textures: { ground: 'tex.ground.warehouse', wall: 'tex.wall.warehouse', crate: 'tex.crate.wood' },
    sky: 'sky.warehouse',
    worldTex: { ground: 'world.ground.warehouse', wall: 'world.wall.warehouse' },
    hdri: 'hdri.warehouse',
    // Decoration layer (instanced + kit GLBs). Purely additive over crateLayout.
    decor: {
      barrelKey: 'barrel_large', barrels: 26,
      foliageKey: null, foliage: 0,         // industrial: no greenery
      debrisKey: 'rubble_half', debris: 18,
      pillarKey: 'pillar', pillars: 8,
      barrelTint: 0x9a7b3c, debrisTint: 0x6d717a,
      heroKit: ['crates_stacked', 'box_stacked', 'barrel_small_stack'],
    },
  },

  desert: {
    id: 'desert',
    name: 'Desert',
    palette: {
      ground: ['#b39463', '#c7a875'],
      wall: 0xc2a878,
      crateTint: 0xcaa46a,
      fog: 0xd8c39a,
      sky: ['#6f86a8', '#b9a980', '#dcc79a', '#e8d9b4'],
    },
    lighting: {
      hemiSky: 0xffe6b8, hemiGround: 0x6b5a38, hemiInt: 0.75,
      ambient: 0x5a4f3a, ambientInt: 0.45,
      sunColor: 0xffd49a, sunPos: [55, 40, -20], sunInt: 1.25,
    },
    crateLayout: DESERT_LAYOUT,
    pickupPads: [
      [16, 12, 'ammo'], [-18, 16, 'ammo'], [24, -20, 'weapon'],
      [-26, -22, 'ammo'], [0, 28, 'weapon'], [36, 30, 'ammo'],
    ],
    textures: { ground: 'tex.ground.desert', wall: 'tex.wall.desert', crate: 'tex.crate.wood' },
    sky: 'sky.desert',
    worldTex: { ground: 'world.ground.desert', wall: 'world.wall.desert' },
    hdri: 'hdri.desert',
    decor: {
      barrelKey: 'barrel_small', barrels: 16,
      foliageKey: 'dead_trees', foliage: 10,   // sparse dead trees
      debrisKey: 'rubble_large', debris: 14,
      pillarKey: 'column', pillars: 6,
      barrelTint: 0xb08a52, debrisTint: 0xc2a878,
      heroKit: ['crates_stacked', 'box_large', 'keg'],
      grassTint: 0xb39463, grassTufts: 120,
    },
  },

  night_city: {
    id: 'night_city',
    name: 'Night City',
    palette: {
      ground: ['#1a1d24', '#23272f'],
      wall: 0x2a2e36,
      crateTint: 0x2f6f8f,
      fog: 0x141a2a,
      sky: ['#05060d', '#0c1326', '#16203d', '#1d2a4a'],
    },
    lighting: {
      hemiSky: 0x2a3a66, hemiGround: 0x0a0c14, hemiInt: 0.40,
      ambient: 0x121a30, ambientInt: 0.30,
      sunColor: 0x9fb6ff, sunPos: [-30, 50, 30], sunInt: 0.55,
      accents: [
        { color: 0xff8a3c, pos: [18, 5, 0], intensity: 1.6, distance: 40 },
        { color: 0x3cc0ff, pos: [-18, 5, 8], intensity: 1.4, distance: 40 },
        { color: 0xff3c8a, pos: [0, 6, -20], intensity: 1.2, distance: 45 },
      ],
    },
    crateLayout: NIGHT_LAYOUT,
    pickupPads: [
      [10, 6, 'ammo'], [-12, 8, 'ammo'], [14, -10, 'weapon'],
      [-16, -12, 'ammo'], [22, 18, 'weapon'], [-24, 20, 'ammo'],
    ],
    textures: { ground: 'tex.ground.night_city', wall: 'tex.wall.night_city', crate: 'tex.crate.container' },
    sky: 'sky.night_city',
    worldTex: { ground: 'world.ground.night_city', wall: 'world.wall.night_city' },
    hdri: 'hdri.night_city',
    decor: {
      barrelKey: 'barrel_large', barrels: 22,
      foliageKey: null, foliage: 0,
      debrisKey: 'rubble_half', debris: 12,
      pillarKey: 'pillar', pillars: 10,
      barrelTint: 0x3c5a6f, debrisTint: 0x2a2e36,
      heroKit: ['box_stacked', 'crates_stacked', 'column'],
      neon: true, // emissive trim strips that bloom under the post stack
    },
  },
};

// getMapList — [{id,name}] for the lobby UI.
export function getMapList() {
  return Object.values(MAPS).map((m) => ({ id: m.id, name: m.name }));
}

// ---------------------------------------------------------------------------
// ASSET PIPELINE (folded into scene.js) — load bundled CC0 textures/models,
// falling back to procedural generators on ANY error. Never blocks the loop:
// loadTextureInto applies a procedural fallback immediately, then swaps in the
// real texture asynchronously once it loads. (contract: ART / ASSET PIPELINE)
// ---------------------------------------------------------------------------
const ASSET_BASE = 'assets/env/';
const TEXTURE_PATHS = {
  'tex.ground.warehouse': ASSET_BASE + 'textures/ground_warehouse.jpg',
  'tex.ground.desert': ASSET_BASE + 'textures/ground_desert.jpg',
  'tex.ground.night_city': ASSET_BASE + 'textures/ground_night_city.jpg',
  'tex.wall.warehouse': ASSET_BASE + 'textures/wall_warehouse.jpg',
  'tex.wall.desert': ASSET_BASE + 'textures/wall_desert.jpg',
  'tex.wall.night_city': ASSET_BASE + 'textures/wall_night_city.jpg',
  'tex.crate.wood': ASSET_BASE + 'textures/crate_wood.jpg',
  'tex.crate.container': ASSET_BASE + 'textures/crate_container.jpg',
};
const SKY_PATHS = {
  'sky.warehouse': ASSET_BASE + 'skybox/sky_warehouse.jpg',
  'sky.desert': ASSET_BASE + 'skybox/sky_desert.jpg',
  'sky.night_city': ASSET_BASE + 'skybox/sky_night_city.jpg',
};

// Richer CC0 PBR ground/wall color maps (ambientCG) live under assets/world/.
// We only sample the *_color.jpg (toon material uses .map only) — keeping the
// download light. Missing files leave the env/ texture (or procedural) in place.
const WORLD_BASE = 'assets/world/';
const WORLD_TEX_PATHS = {
  'world.ground.warehouse': WORLD_BASE + 'ground_paving_color.jpg',
  'world.ground.desert': WORLD_BASE + 'ground_sand_color.jpg',
  'world.ground.night_city': WORLD_BASE + 'ground_paving_color.jpg',
  'world.wall.warehouse': WORLD_BASE + 'wall_concrete_color.jpg',
  'world.wall.desert': WORLD_BASE + 'wall_brick_color.jpg',
  'world.wall.night_city': WORLD_BASE + 'wall_metal_color.jpg',
};

// CC0 Poly Haven equirect HDRIs for IBL + visible skybox (assets/world/*.hdr).
const HDRI_PATHS = {
  'hdri.warehouse': WORLD_BASE + 'sky_warehouse.hdr',
  'hdri.desert': WORLD_BASE + 'sky_desert.hdr',
  'hdri.night_city': WORLD_BASE + 'sky_night.hdr',
};

// Self-contained CC0 modular kit GLBs (KayKit + Quaternius) under assets/kit/.
// Every key has a procedural fallback so a missing file never breaks a map.
const KIT_BASE = 'assets/kit/';
const KIT_PATHS = {
  barrel_large: KIT_BASE + 'kaykit_barrel_large.glb',
  barrel_small: KIT_BASE + 'kaykit_barrel_small.glb',
  barrel_small_stack: KIT_BASE + 'kaykit_barrel_small_stack.glb',
  box_large: KIT_BASE + 'kaykit_box_large.glb',
  box_small: KIT_BASE + 'kaykit_box_small.glb',
  box_stacked: KIT_BASE + 'kaykit_box_stacked.glb',
  crates_stacked: KIT_BASE + 'kaykit_crates_stacked.glb',
  crate: KIT_BASE + 'quaternius_crate.glb',
  column: KIT_BASE + 'kaykit_column.glb',
  pillar: KIT_BASE + 'kaykit_pillar.glb',
  keg: KIT_BASE + 'kaykit_keg.glb',
  rubble_large: KIT_BASE + 'kaykit_rubble_large.glb',
  rubble_half: KIT_BASE + 'kaykit_rubble_half.glb',
  tree: KIT_BASE + 'quaternius_tree.glb',
  pine_trees: KIT_BASE + 'quaternius_pine_trees.glb',
  dead_trees: KIT_BASE + 'quaternius_dead_trees.glb',
};

// Self-contained CC0 humanoid avatar (Quaternius "Adventurer", vertex-colored
// toon look, no external images/buffers). Used for remote players; procedural
// toon humanoid is the fallback if the GLB is missing or fails to parse.
const AVATAR_BASE = 'assets/avatars/';
const AVATAR_MODEL_URL = AVATAR_BASE + 'Adventurer.glb';

let _texLoader = null;
function texLoader() {
  if (!_texLoader) _texLoader = new THREE.TextureLoader();
  return _texLoader;
}

// loadColorTexture — returns a procedural fallback texture immediately and, when
// a bundled file exists, swaps its image in asynchronously (same material map).
// `epoch` guards against a stale async load overwriting a newer map's texture.
function loadColorTexture(key, fallbackTex, onReady) {
  const url = TEXTURE_PATHS[key];
  fallbackTex.colorSpace = THREE.SRGBColorSpace;
  fallbackTex.wrapS = fallbackTex.wrapT = THREE.RepeatWrapping;
  if (!url) return fallbackTex;
  texLoader().load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      if (typeof onReady === 'function') onReady(tex);
    },
    undefined,
    () => { /* missing/failed — keep procedural fallback (no-op) */ },
  );
  return fallbackTex;
}

// Renderer max anisotropy (cached). Falls back to 8 if no renderer yet.
let _maxAnisoCache = 0;
function _maxAnisotropy() {
  if (_maxAnisoCache) return _maxAnisoCache;
  // texLoader has no caps; we rely on the active renderer via a global hook set
  // in initScene. If absent, return a sane default.
  _maxAnisoCache = (_anisoRenderer && _anisoRenderer.capabilities)
    ? _anisoRenderer.capabilities.getMaxAnisotropy() : 8;
  return _maxAnisoCache || 8;
}
let _anisoRenderer = null;

// loadWorldTexture — async load a richer CC0 color map from assets/world/. Calls
// onReady only on success; on failure the caller's existing map stays untouched.
function loadWorldTexture(key, onReady) {
  const url = WORLD_TEX_PATHS[key];
  if (!url) return;
  texLoader().load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      if (typeof onReady === 'function') onReady(tex);
    },
    undefined,
    () => { /* keep existing map */ },
  );
}

// loadSky — apply procedural gradient now, swap equirect JPG in if present.
function loadSky(scene, mapDef, epoch) {
  const grad = makeSkyGradient(mapDef.palette.sky);
  scene.background = grad;
  const url = SKY_PATHS[mapDef.sky];
  if (!url) return;
  texLoader().load(
    url,
    (tex) => {
      if (_mapEpoch !== epoch) { tex.dispose(); return; }
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      if (scene.background && scene.background.dispose && scene.background !== tex) {
        scene.background.dispose();
      }
      scene.background = tex;
    },
    undefined,
    () => { /* keep gradient */ },
  );
}

// Shared model loader (used for character/weapon/pickup models elsewhere; kept
// here so the single asset pipeline lives in one place per the plan).
let _gltfLoader = null;
export function loadModel(key, url, onLoad, onError) {
  if (!_gltfLoader) _gltfLoader = new GLTFLoader();
  _gltfLoader.load(
    url,
    (gltf) => { try { onLoad(gltf); } catch (_) { if (onError) onError(_); } },
    undefined,
    (err) => { if (onError) onError(err); },
  );
}

// ---------------------------------------------------------------------------
// TOON / CEL-SHADED materials — MeshToonMaterial + a tiny stepped gradient map.
// Procedural-only (zero download). Used for world surfaces so the look stays
// consistent with remote avatars/enemies. (contract: ART DIRECTION)
// ---------------------------------------------------------------------------
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

function makeToonMaterial(opts = {}) {
  return new THREE.MeshToonMaterial({
    color: opts.color != null ? opts.color : 0xffffff,
    map: opts.map || null,
    gradientMap: toonGradientMap(),
    transparent: !!opts.transparent,
    opacity: opts.opacity != null ? opts.opacity : 1,
  });
}

// ---------------------------------------------------------------------------
// addOutline — inverted-hull cartoon edge. Renders mesh.geometry a second time
// scaled out along normals with a black BackSide MeshBasicMaterial. Shares the
// geometry (no copy); the hull is parented to the mesh so it follows transforms.
// Use only on hero/dynamic props (doubles their draw calls). Gated by quality.
// (contract ENV §3 — inverted hull, NOT OutlinePass.)
// ---------------------------------------------------------------------------
function addOutline(mesh, thickness = 0.035, color = 0x10131a) {
  if (!QUALITY.enableOutline || !mesh || !mesh.geometry) return null;
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, fog: true });
  const hull = new THREE.Mesh(mesh.geometry, m);
  hull.scale.multiplyScalar(1 + thickness);
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.renderOrder = -1;
  mesh.add(hull);
  return hull;
}

// Deterministic small PRNG (mulberry32) so every peer places identical decor.
function makePRNG(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convert any imported (PBR) GLB subtree to MeshToonMaterial so kit props match
// the cel-shaded world. Preserves .map / vertex colors / .color from the source.
function toonifyTree(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    const toon = new THREE.MeshToonMaterial({
      color: (src && src.color) ? src.color.clone() : new THREE.Color(0xffffff),
      map: (src && src.map) ? src.map : null,
      gradientMap: toonGradientMap(),
      vertexColors: !!(o.geometry && o.geometry.attributes && o.geometry.attributes.color),
    });
    if (toon.map) toon.map.colorSpace = THREE.SRGBColorSpace;
    o.material = toon;
  });
}

// loadKitModel — load a self-contained kit GLB, normalize to a target size,
// center its pivot, toonify, and hand the prepared root to onReady. On ANY error
// (missing file, parse failure) onReady is NEVER called; the caller's procedural
// fallback (already added to the scene) stays. epoch guards stale map switches.
//   opts: { target (max-dim metres), rotY, toonify, outline, yOffsetFrac }
function loadKitModel(key, opts, epoch, onReady) {
  const url = KIT_PATHS[key];
  if (!url) return; // unknown key -> caller fallback
  loadModel(
    key, url,
    (gltf) => {
      if (_mapEpoch !== epoch) return; // map switched mid-load
      const model = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      if (!model) return;
      if (opts && typeof opts.rotY === 'number') model.rotation.y = opts.rotY;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const target = (opts && opts.target) || 1;
      const s = target / maxDim;
      // Re-center to footprint origin: x/z centered, base at y=0.
      model.position.x -= center.x;
      model.position.z -= center.z;
      model.position.y -= (center.y - size.y / 2);
      const wrap = new THREE.Group();
      wrap.add(model);
      wrap.scale.setScalar(s);
      if (opts && opts.toonify !== false) toonifyTree(wrap);
      if (opts && opts.outline) {
        wrap.traverse((o) => { if (o.isMesh) addOutline(o); });
      }
      try { onReady(wrap, size, s); } catch (_) { /* keep fallback */ }
    },
    () => { /* error -> keep procedural fallback (no-op) */ },
  );
}

// ---------------------------------------------------------------------------
// Per-map teardown bookkeeping. _mapGroup holds every arena mesh for the active
// map; _mapColliderCount is how many entries this map appended to state.colliders
// so loadMap can splice exactly those out without disturbing dynamic colliders.
// _mapEpoch invalidates in-flight async asset loads across map changes.
// ---------------------------------------------------------------------------
let _mapGroup = null;
let _mapColliderCount = 0;
let _mapEpoch = 0;

// Image-based-lighting state. _roomEnvTex is the procedural RoomEnvironment PMREM
// (built once, cheap, reused across maps). _hdriEnvTex is a per-map HDRI PMREM
// that must be disposed on map teardown to avoid GPU leaks.
let _roomEnvTex = null;
let _hdriEnvTex = null;
let _rgbeLoader = null;

// Shared contact-shadow CanvasTexture (fake AO under props). Cached & reused;
// reset to null on map teardown because it gets disposed with the map group.
let _contactTex = null;

// setupEnvironmentIBL — give imported PBR/Standard kit props soft IBL using the
// in-addon RoomEnvironment (zero download). MeshToonMaterial ignores envMap, so
// this only affects any non-toonified Standard meshes; harmless otherwise.
function setupEnvironmentIBL(state) {
  if (!QUALITY.enableEnvIBL || _roomEnvTex || !state.renderer) return;
  try {
    const pmrem = new THREE.PMREMGenerator(state.renderer);
    _roomEnvTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    state.scene.environment = _roomEnvTex;
  } catch (_) { _roomEnvTex = null; /* IBL is optional */ }
}

// loadHDRI — swap the procedural gradient sky for a real CC0 equirect HDRI (and
// use it for environment reflections). Fully async; keeps the gradient until the
// HDRI resolves, and bails silently on any failure (procedural fallback stays).
function loadHDRI(state, mapDef, epoch) {
  if (!QUALITY.enableHDRI) return;
  const url = HDRI_PATHS[mapDef.hdri];
  if (!url) return;
  if (!_rgbeLoader) _rgbeLoader = new RGBELoader();
  _rgbeLoader.load(
    url,
    (hdr) => {
      if (_mapEpoch !== epoch) { hdr.dispose(); return; }
      try {
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const scene = state.scene;
        // Visible sky: replace the gradient/jpg background.
        if (scene.background && scene.background.dispose && scene.background !== hdr) {
          scene.background.dispose();
        }
        scene.background = hdr;
        // Reflections: prefer the HDRI env over RoomEnvironment for this map.
        if (QUALITY.enableEnvIBL) {
          const pmrem = new THREE.PMREMGenerator(state.renderer);
          if (_hdriEnvTex) _hdriEnvTex.dispose();
          _hdriEnvTex = pmrem.fromEquirectangular(hdr).texture;
          pmrem.dispose();
          scene.environment = _hdriEnvTex;
        }
      } catch (_) { hdr.dispose(); }
    },
    undefined,
    () => { /* keep procedural/jpg sky */ },
  );
}

// ---------------------------------------------------------------------------
// initScene — build renderer, scene, camera, lights, skybox, arena geometry and
// register all static colliders. Called FIRST by main.js (before any other init).
// ---------------------------------------------------------------------------
export function initScene(state, canvas, mapId = DEFAULT_MAP_ID) {
  // ---- Renderer ----------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(pixelRatio()); // PERF: capped DPR (see MAX_PIXEL_RATIO)
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  // PERF: PCFShadowMap instead of PCFSoftShadowMap — one fewer texture tap set
  // per shadowed fragment. The contact-shadow AO quads keep the soft grounding,
  // so the cartoon look is preserved while the sun shadow gets a touch crisper.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES tone-map pairs with OutputPass (which applies the color transform). When
  // the composer is bypassed (low quality) the renderer still tone-maps directly.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // ---- Scene + camera ----------------------------------------------------
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  camera.rotation.order = 'YXZ'; // yaw then pitch — player.js drives this
  camera.position.set(0, PLAYER_EYE_HEIGHT, 0);
  // The first-person weapon viewmodels are parented to the camera (see
  // weapons.js buildViewmodel -> state.camera.add(group)). Objects parented to a
  // camera are only rendered if the camera itself is part of the rendered scene
  // graph, so the camera MUST be added to the scene — otherwise the gun never
  // appears. THREE.PerspectiveCamera is an Object3D; adding it to the scene is
  // safe and does not affect the camera's own transform / projection.
  scene.add(camera);

  // ---- Collision world ---------------------------------------------------
  state.colliders = [];

  // ---- Publish handles & config onto shared state ------------------------
  state.THREE = THREE;
  state.renderer = renderer;
  _anisoRenderer = renderer; // for texture anisotropy capability lookups
  state.scene = scene;
  state.camera = camera;
  state.arenaHalf = ARENA_HALF;

  state.config = {
    ARENA_HALF,
    WALL_HEIGHT,
    WALL_THICKNESS,
    PLAYER_EYE_HEIGHT,
    GRAVITY,
    PLAYER_SPEED,
    PLAYER_JUMP_SPEED,
    PLAYER_HALF,
    ENEMY_HALF,
    PLAYER_MAX_HEALTH,
  };

  // ---- Post-processing composer (cartoon bloom + AA + vignette) ----------
  buildComposer(state);

  // ---- Image-based lighting for imported PBR props (procedural, no DL) ----
  setupEnvironmentIBL(state);

  // ---- Build the chosen map (lights, sky, fog, arena geometry) -----------
  loadMap(state, mapId);
}

// ---------------------------------------------------------------------------
// buildComposer — assemble the EffectComposer post stack ONCE. Stored on state
// so render()/onResize() can reuse and resize it. On 'low' quality (or any
// failure) state.composer stays null and render() falls back to renderer.render.
// (contract ENV §2 — cheap post stack; OutputPass MUST be last.)
// ---------------------------------------------------------------------------
function buildComposer(state) {
  if (state.quality === 'low') QUALITY.enableComposer = false;
  if (!QUALITY.enableComposer) { state.composer = null; return; }
  const { renderer, scene, camera } = state;
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = pixelRatio(); // PERF: capped DPR for the whole post chain
  try {
    // PERF FIX: do NOT give the composer a multisampled (samples>0) render
    // target. EffectComposer ping-pongs between TWO targets cloned from this one,
    // so MSAA samples force a full multisample RESOLVE on EVERY full-screen pass
    // (RenderPass -> bloom -> vignette -> output). On a real GPU at retina DPR
    // that resolve-per-pass roughly DOUBLED frame cost — the regression. A plain
    // (single-sample) HalfFloat target keeps the bloom bright-pass headroom with
    // zero per-pass resolve; edge AA is restored cheaply by the single FXAA pass
    // below. Let EffectComposer build its own default target sized via setSize.
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(scene, camera));

    let bloom = null;
    if (QUALITY.enableBloom) {
      // High threshold => only emissive eyes/tracers/neon bloom; world stays crisp.
      // PERF (cut D): run bloom at half resolution. The glow is soft and the
      // threshold is high, so half-res is visually indistinguishable while the
      // ~5 internal bloom passes touch ~4x fewer pixels.
      bloom = new UnrealBloomPass(
        new THREE.Vector2(Math.max(1, w >> 1), Math.max(1, h >> 1)),
        0.45, 0.6, 0.85,
      );
      composer.addPass(bloom);
    }

    const vig = new ShaderPass(VignetteShader);
    vig.uniforms.offset.value = 0.95;
    vig.uniforms.darkness.value = 1.1;
    composer.addPass(vig);

    // Single cheap full-screen FXAA pass for edge AA (replaces per-pass MSAA
    // resolve). One shader pass total — far cheaper than multisampling every pass.
    const fxaa = new ShaderPass(FXAAShader);
    fxaa.material.uniforms.resolution.value.set(1 / (w * dpr), 1 / (h * dpr));
    composer.addPass(fxaa);

    composer.addPass(new OutputPass()); // last: color transform + tone map

    state.composer = composer;
    state.composerBloom = bloom;
    state.composerFXAA = fxaa;
  } catch (_) {
    state.composer = null; // any addon hiccup -> safe fallback path
  }
}

// ---------------------------------------------------------------------------
// loadMap — tear down the previous map's arena meshes/colliders and rebuild
// ground/walls/crates, sky, lighting and fog from MAPS[mapId]. Idempotent and
// safe to call at runtime; the host broadcasts the chosen id so all peers load
// the same map. setMap is a thin alias for the same broadcast contract.
// ---------------------------------------------------------------------------
export function loadMap(state, mapId) {
  const mapDef = MAPS[mapId] || MAPS[DEFAULT_MAP_ID];
  const scene = state.scene;
  if (!scene) return mapDef; // initScene not run yet

  _mapEpoch++;
  const epoch = _mapEpoch;

  // ---- Tear down previous map -------------------------------------------
  if (_mapGroup) {
    scene.remove(_mapGroup);
    disposeAvatar(_mapGroup); // reuse the generic deep-disposer
    _mapGroup = null;
  }
  // Drop the previous map's HDRI env PMREM (RoomEnvironment env is kept/reused).
  if (_hdriEnvTex) {
    _hdriEnvTex.dispose();
    _hdriEnvTex = null;
    if (_roomEnvTex) scene.environment = _roomEnvTex;
  }
  // The shared contact-shadow CanvasTexture is parented into the (now disposed)
  // map group, so disposeAvatar will have freed it. Drop the cache so the next
  // map regenerates a live texture instead of reusing a disposed one.
  _contactTex = null;
  if (_mapColliderCount > 0 && Array.isArray(state.colliders)) {
    // Map colliders are appended contiguously at the FRONT during build, before
    // any dynamic colliders. Remove exactly that prefix count.
    state.colliders.splice(0, _mapColliderCount);
    _mapColliderCount = 0;
  }

  // ---- Fresh group for all arena meshes of this map ---------------------
  const group = new THREE.Group();
  group.name = 'mapGroup:' + mapDef.id;
  _mapGroup = group;
  scene.add(group);

  // Track how many colliders this build appends so teardown is exact. We splice
  // them to the FRONT so they always occupy [0, count) regardless of dynamic
  // colliders added later by other subsystems.
  const before = state.colliders.length;
  const mapColliders = [];

  // ---- Sky + fog --------------------------------------------------------
  loadSky(scene, mapDef, epoch);   // procedural gradient now (instant)
  loadHDRI(state, mapDef, epoch);  // swap in a real CC0 HDRI async if present
  scene.fog = new THREE.Fog(new THREE.Color(mapDef.palette.fog), 60, 220);

  // ---- Lighting ---------------------------------------------------------
  addLighting(group, mapDef.lighting);

  // ---- Arena geometry ---------------------------------------------------
  buildGround(group, mapColliders, mapDef, epoch);
  buildWalls(group, mapColliders, mapDef, epoch);
  buildCrates(group, mapColliders, mapDef, epoch);

  // ---- Richer decoration layer (instanced props, kit GLBs, foliage, AO) --
  buildDecoration(group, mapColliders, mapDef, epoch);

  // Prepend map colliders so they own the stable [0, count) range.
  if (mapColliders.length) {
    state.colliders.unshift(...mapColliders);
  }
  _mapColliderCount = state.colliders.length - before;

  state.mapId = mapDef.id;
  _spawnPoints = null; // spawn ring is map-independent but recompute defensively
  return mapDef;
}

// setMap — alias the host broadcasts to switch the active map. Same as loadMap;
// kept distinct so callers reading the contract have a stable verb.
export function setMap(state, mapId) {
  return loadMap(state, mapId);
}

// ---------------------------------------------------------------------------
// onResize — keep camera aspect and renderer size in sync with the window.
// main.js owns the actual 'resize' listener and calls this.
// ---------------------------------------------------------------------------
export function onResize(state) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (state.camera) {
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
  }
  if (state.renderer) {
    state.renderer.setPixelRatio(pixelRatio()); // PERF: capped DPR
    state.renderer.setSize(w, h, false);
  }
  if (state.composer) {
    const dpr = pixelRatio();
    state.composer.setPixelRatio(dpr);
    state.composer.setSize(w, h);
    // PERF: keep bloom at half resolution (cut D).
    if (state.composerBloom) {
      state.composerBloom.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    }
    // Keep FXAA's inverse-resolution uniform in sync with the drawing buffer.
    if (state.composerFXAA) {
      state.composerFXAA.material.uniforms.resolution.value.set(
        1 / (w * dpr), 1 / (h * dpr),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// render — called LAST every frame by main.js.
// ---------------------------------------------------------------------------
export function render(state) {
  if (state.composer) {
    state.composer.render();
  } else {
    state.renderer.render(state.scene, state.camera);
  }
}

// ---------------------------------------------------------------------------
// spawnPoints — deterministic enemy spawn feet positions near arena edges,
// well away from the origin. Cached so repeated calls return stable vectors.
// ---------------------------------------------------------------------------
export function spawnPoints() {
  if (_spawnPoints) return _spawnPoints.map((p) => p.clone());

  const r = ARENA_HALF - 6; // a few meters in from the walls
  const pts = [];
  const COUNT = 8;
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  _spawnPoints = pts;
  return _spawnPoints.map((p) => p.clone());
}

// ===========================================================================
// Internal builders
// ===========================================================================

// Procedural sky gradient rendered into a small canvas -> equirect texture set
// as scene.background. No external images; deterministic and cheap.
function makeSkyGradient(stops) {
  // stops = [zenith, mid, horizon, ground]; default to the original blue sky.
  const s = stops && stops.length >= 4
    ? stops
    : ['#1b3a63', '#5b86b0', '#9fb6cc', '#b9c7d4'];
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0.0, s[0]); // zenith
  grad.addColorStop(0.5, s[1]); // mid sky
  grad.addColorStop(0.85, s[2]); // hazy horizon (matches fog color)
  grad.addColorStop(1.0, s[3]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function addLighting(parent, L) {
  // L = map lighting descriptor. Defaults mirror the original warehouse values so
  // a missing field degrades to the baseline look. Toon shading wants bumped
  // ambient/hemisphere so the stepped bands read as flat cartoon color.
  L = L || {};
  const hemi = new THREE.HemisphereLight(
    L.hemiSky != null ? L.hemiSky : 0xbcd6ff,
    L.hemiGround != null ? L.hemiGround : 0x4a4636,
    L.hemiInt != null ? L.hemiInt : 0.65,
  );
  hemi.position.set(0, 50, 0);
  parent.add(hemi);

  // Low ambient so shadowed faces aren't pure black.
  parent.add(new THREE.AmbientLight(
    L.ambient != null ? L.ambient : 0x404653,
    L.ambientInt != null ? L.ambientInt : 0.35,
  ));

  // Key directional "sun" with a shadow camera framing the whole arena.
  const sun = new THREE.DirectionalLight(
    L.sunColor != null ? L.sunColor : 0xfff2d8,
    L.sunInt != null ? L.sunInt : 1.1,
  );
  const sp = L.sunPos || [40, 60, 25];
  sun.position.set(sp[0], sp[1], sp[2]);
  sun.castShadow = true;
  // PERF (cut E): 1024 shadow map instead of 2048 — a quarter of the shadow
  // texels re-rendered each frame. With PCFShadowMap + contact-shadow AO quads
  // the cartoon contact shadows still read soft; hero crates/walls still cast.
  sun.shadow.mapSize.set(1024, 1024);

  const sc = sun.shadow.camera;
  const span = ARENA_HALF + 10;
  sc.left = -span;
  sc.right = span;
  sc.top = span;
  sc.bottom = -span;
  sc.near = 1;
  sc.far = 200;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;

  // Target the arena center so the frustum is centered.
  sun.target.position.set(0, 0, 0);
  parent.add(sun);
  parent.add(sun.target);

  // Optional warm/neon point accents (e.g. night_city) for colored fill.
  if (Array.isArray(L.accents)) {
    for (const a of L.accents) {
      const pl = new THREE.PointLight(
        a.color != null ? a.color : 0xffffff,
        a.intensity != null ? a.intensity : 1.0,
        a.distance != null ? a.distance : 40,
        a.decay != null ? a.decay : 1.5,
      );
      const p = a.pos || [0, 5, 0];
      pl.position.set(p[0], p[1], p[2]);
      parent.add(pl);
    }
  }
}

function buildGround(parent, mapColliders, mapDef, epoch) {
  const size = ARENA_HALF * 2;
  const repeat = size / 4; // one tile per 4m

  // Procedural fallback (palette-tinted concrete checker) shown immediately;
  // bundled CC0 texture swaps in async if present.
  const fallback = makeFloorTexture(mapDef.palette.ground);
  fallback.repeat.set(repeat, repeat);
  fallback.anisotropy = 4;

  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  const mat = makeToonMaterial({ map: fallback, color: 0xffffff });
  const ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2; // lay flat in XZ at y=0
  ground.receiveShadow = true;
  ground.name = 'ground';
  parent.add(ground);

  // Anisotropy from device caps (sharp grazing-angle tiling), capped at 8.
  let maxAniso = 8;
  try { maxAniso = Math.min(8, _maxAnisotropy()); } catch (_) { /* default */ }
  fallback.anisotropy = maxAniso;

  loadColorTexture(mapDef.textures.ground, fallback, (tex) => {
    if (_mapEpoch !== epoch) { tex.dispose(); return; }
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = maxAniso;
    mat.map = tex;
    mat.needsUpdate = true;
    // Then try the richer CC0 world ground color on top (best available wins).
    if (mapDef.worldTex && mapDef.worldTex.ground) {
      loadWorldTexture(mapDef.worldTex.ground, (wtex) => {
        if (_mapEpoch !== epoch) { wtex.dispose(); return; }
        wtex.repeat.set(repeat, repeat);
        wtex.anisotropy = maxAniso;
        mat.map = wtex;
        mat.needsUpdate = true;
      });
    }
  });

  // Large-scale AO/darkening overlay plane breaks up tile repetition and darkens
  // toward the walls (cheap "detail texture" trick, no shaders). y just above floor.
  const overlayTex = makeGroundOverlayTexture();
  const overlayMat = new THREE.MeshBasicMaterial({
    map: overlayTex, transparent: true, opacity: 0.55,
    depthWrite: false, fog: true,
  });
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), overlayMat);
  overlay.rotation.x = -Math.PI / 2;
  overlay.position.y = 0.01;
  overlay.renderOrder = 1;
  overlay.name = 'groundOverlay';
  parent.add(overlay);

  // Ground collider: thin slab below y=0 spanning the arena. Player/enemy
  // collision resolution treats the top face (y=0) as the floor.
  mapColliders.push(
    makeCollider(0, -0.5, 0, ARENA_HALF, 0.5, ARENA_HALF, ground),
  );
}

function buildWalls(parent, mapColliders, mapDef, epoch) {
  const h = WALL_HEIGHT;
  const t = WALL_THICKNESS;
  const len = ARENA_HALF * 2 + t * 2; // overlap corners
  const half = ARENA_HALF;

  // Fallback flat-color wall texture from palette; real texture swaps in async.
  const fallback = makeWallTexture(mapDef.palette.wall);
  fallback.repeat.set(len / 4, h / 2);
  const mat = makeToonMaterial({ map: fallback, color: mapDef.palette.wall });

  loadColorTexture(mapDef.textures.wall, fallback, (tex) => {
    if (_mapEpoch !== epoch) { tex.dispose(); return; }
    tex.repeat.set(len / 4, h / 2);
    mat.map = tex;
    mat.color.setHex(0xffffff); // let the texture provide color
    mat.needsUpdate = true;
    // Richer CC0 world wall color on top if available.
    if (mapDef.worldTex && mapDef.worldTex.wall) {
      loadWorldTexture(mapDef.worldTex.wall, (wtex) => {
        if (_mapEpoch !== epoch) { wtex.dispose(); return; }
        wtex.repeat.set(len / 4, h / 2);
        mat.map = wtex;
        mat.needsUpdate = true;
      });
    }
  });

  // Each wall: [centerX, centerZ, sizeX, sizeZ]
  const walls = [
    [0,  half + t / 2, len, t], // +Z (north)
    [0, -half - t / 2, len, t], // -Z (south)
    [ half + t / 2, 0, t, len], // +X (east)
    [-half - t / 2, 0, t, len], // -X (west)
  ];

  for (const [cx, cz, sx, sz] of walls) {
    const geo = new THREE.BoxGeometry(sx, h, sz);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, h / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);

    mapColliders.push(
      makeCollider(cx, h / 2, cz, sx / 2, h / 2, sz / 2, mesh),
    );
  }

  // ---- Wall relief: instanced pilasters break the flat silhouette. Purely
  // visual (thin, flush to the wall, no colliders). One InstancedMesh, 1 draw.
  buildWallPilasters(parent, mapDef, h, half, t);
}

// Pilasters: vertical buttress strips spaced along each wall, slightly proud of
// the surface, darker tint. Single InstancedMesh so it's ~1 draw call.
function buildWallPilasters(parent, mapDef, h, half, t) {
  const pw = 0.6, pd = 0.35; // pilaster width / depth (proud of wall)
  const geo = new THREE.BoxGeometry(pw, h * 0.92, pd);
  const tint = new THREE.Color(mapDef.palette.wall).multiplyScalar(0.78);
  const mat = makeToonMaterial({ color: tint.getHex() });
  const spacing = 10; // metres between pilasters
  const perWall = Math.floor((half * 2) / spacing); // count along one wall
  const N = perWall * 4;
  if (N <= 0) return;
  const inst = new THREE.InstancedMesh(geo, mat, N);
  // PERF (cut E): pilasters are flush cosmetic wall relief — they don't read as
  // hero shadow casters, so skip them from the sun shadow pass. They still
  // receive shadows so the walls stay grounded.
  inst.castShadow = false;
  inst.receiveShadow = true;
  inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const o = new THREE.Object3D();
  let i = 0;
  const start = -half + spacing / 2;
  const surfY = (h * 0.92) / 2;
  for (let k = 0; k < perWall; k++) {
    const p = start + k * spacing;
    // +Z and -Z walls (vary x), +X and -X walls (vary z).
    const place = [
      [p, half + t / 2 + pd / 2, 0],          // north, facing -Z (no rot needed)
      [p, -half - t / 2 - pd / 2, 0],          // south
      [half + t / 2 + pd / 2, p, Math.PI / 2], // east (rotated)
      [-half - t / 2 - pd / 2, p, Math.PI / 2],// west
    ];
    // First two entries are (x,z) along Z-walls, last two along X-walls.
    o.position.set(place[0][0], surfY, place[0][1]); o.rotation.y = 0; o.updateMatrix(); inst.setMatrixAt(i++, o.matrix);
    o.position.set(place[1][0], surfY, place[1][1]); o.rotation.y = 0; o.updateMatrix(); inst.setMatrixAt(i++, o.matrix);
    o.position.set(place[2][0], surfY, place[2][1]); o.rotation.y = Math.PI / 2; o.updateMatrix(); inst.setMatrixAt(i++, o.matrix);
    o.position.set(place[3][0], surfY, place[3][1]); o.rotation.y = Math.PI / 2; o.updateMatrix(); inst.setMatrixAt(i++, o.matrix);
  }
  inst.count = i;
  inst.instanceMatrix.needsUpdate = true;
  inst.name = 'wallPilasters';
  parent.add(inst);
}

function buildCrates(parent, mapColliders, mapDef, epoch) {
  // Shared crate texture/material — reuse the geometry-independent texture.
  const tint = mapDef.palette.crateTint;
  const fallback = makeCrateTexture(tint);

  for (const [x, z, halfXZ, height] of mapDef.crateLayout) {
    const geo = new THREE.BoxGeometry(halfXZ * 2, height, halfXZ * 2);

    // Per-crate material/texture clone so the repeat scales with crate size.
    const cloneTex = fallback.clone();
    cloneTex.needsUpdate = true;
    cloneTex.wrapS = cloneTex.wrapT = THREE.RepeatWrapping;
    cloneTex.repeat.set(Math.max(1, halfXZ), Math.max(1, height / 2));

    const mat = makeToonMaterial({ map: cloneTex, color: tint });

    loadColorTexture(mapDef.textures.crate, cloneTex, (tex) => {
      if (_mapEpoch !== epoch) { tex.dispose(); return; }
      tex.repeat.set(Math.max(1, halfXZ), Math.max(1, height / 2));
      mat.map = tex;
      mat.needsUpdate = true;
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, height / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'crate';
    addOutline(mesh); // cel edge on hero cover (gated by quality)
    parent.add(mesh);

    // Stacked-box read: nest a smaller lighter box on top of the taller crates.
    if (height >= 2.0) {
      const topH = height * 0.35;
      const topHalf = halfXZ * 0.62;
      const topGeo = new THREE.BoxGeometry(topHalf * 2, topH, topHalf * 2);
      const topMat = makeToonMaterial({
        map: cloneTex,
        color: new THREE.Color(tint).lerp(new THREE.Color(0xffffff), 0.22).getHex(),
      });
      const top = new THREE.Mesh(topGeo, topMat);
      top.position.set(x, height + topH / 2, z);
      top.castShadow = true;
      top.receiveShadow = true;
      addOutline(top);
      parent.add(top);
      mapColliders.push(
        makeCollider(x, height + topH / 2, z, topHalf, topH / 2, topHalf, top),
      );
    }

    mapColliders.push(
      makeCollider(x, height / 2, z, halfXZ, height / 2, halfXZ, mesh),
    );

    // Contact-shadow AO quad grounds the crate visually (cheap fake AO).
    addContactShadow(parent, x, z, halfXZ * 1.5);
  }
}

// addContactShadow — a soft dark radial quad at the prop base (fake AO). Cheap,
// transparent, no shadow cost. radius in metres. (_contactTex declared with the
// other module state vars near the top so loadMap teardown can reset it.)
function contactShadowTexture() {
  if (_contactTex) return _contactTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _contactTex = new THREE.CanvasTexture(c);
  _contactTex.colorSpace = THREE.SRGBColorSpace;
  _contactTex.needsUpdate = true;
  return _contactTex;
}
function addContactShadow(parent, x, z, radius) {
  const mat = new THREE.MeshBasicMaterial({
    map: contactShadowTexture(), transparent: true, opacity: 0.5,
    depthWrite: false, fog: true,
  });
  const q = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat);
  q.rotation.x = -Math.PI / 2;
  q.position.set(x, 0.02, z);
  q.renderOrder = 2;
  q.name = 'contactShadow';
  parent.add(q);
  return q;
}

// ===========================================================================
// DECORATION LAYER — instanced props (barrels, debris, pillars, foliage, grass)
// + async kit GLB hero clusters + neon trim. All placement is deterministic
// (seeded PRNG keyed by map id) so every peer renders an identical arena. Solid
// props push AABB colliders into mapColliders so collision stays in sync; small
// cosmetic props (debris/foliage/grass) are visual-only. Everything has a
// procedural fallback and is parented into the map group for clean teardown.
// (contract ENV §4/§5 — InstancedMesh + modular kit layering.)
// ===========================================================================

// Hash a string to a 32-bit seed for the per-map PRNG.
function _hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Reject a candidate (x,z) if it overlaps existing colliders (keeps spawn lanes
// and cover clear) or strays outside the playable inset. radius = prop footprint.
function _placeClear(x, z, radius, colliders, inset) {
  if (Math.abs(x) > inset || Math.abs(z) > inset) return false;
  if (x * x + z * z < 9) return false; // keep the central spawn (0,0) clear
  for (const c of colliders) {
    // Only test box colliders that are above the floor (skip the ground slab).
    if (c.max.y <= 0.05) continue;
    const nx = Math.max(c.min.x, Math.min(x, c.max.x));
    const nz = Math.max(c.min.z, Math.min(z, c.max.z));
    const dx = x - nx, dz = z - nz;
    if (dx * dx + dz * dz < radius * radius) return false;
  }
  return true;
}

function buildDecoration(parent, mapColliders, mapDef, epoch) {
  if (!QUALITY.enableInstancedProps) return;
  const d = mapDef.decor || {};
  const rng = makePRNG(_hashSeed('decor:' + mapDef.id));
  const inset = ARENA_HALF - 4;

  // --- Barrels: solid instanced cover (colliders pushed per instance). -----
  if (d.barrels > 0) {
    const r = 0.42, hgt = 1.1;
    const geo = new THREE.CylinderGeometry(r, r, hgt, 12);
    const mat = makeToonMaterial({ color: d.barrelTint != null ? d.barrelTint : 0x9a7b3c });
    placeInstanced(parent, mapColliders, {
      geo, mat, count: d.barrels, rng, inset, colliders: mapColliders,
      footprint: r, halfY: hgt / 2, solid: true, tintVary: 0.12,
      contact: true,
    });
  }

  // --- Pillars: tall solid columns for verticality / sightline blockers. ---
  if (d.pillars > 0) {
    const r = 0.6, hgt = WALL_HEIGHT * 0.9;
    const geo = new THREE.CylinderGeometry(r, r * 1.15, hgt, 10);
    const mat = makeToonMaterial({
      color: new THREE.Color(mapDef.palette.wall).multiplyScalar(0.92).getHex(),
    });
    placeInstanced(parent, mapColliders, {
      geo, mat, count: d.pillars, rng, inset, colliders: mapColliders,
      footprint: r, halfY: hgt / 2, solid: true, tintVary: 0.06,
      contact: true,
    });
  }

  // --- Debris/rubble: small cosmetic clutter (no colliders, low boxes). ----
  if (d.debris > 0) {
    const geo = new THREE.DodecahedronGeometry(0.45, 0);
    const mat = makeToonMaterial({ color: d.debrisTint != null ? d.debrisTint : 0x6d717a });
    placeInstanced(parent, mapColliders, {
      geo, mat, count: d.debris, rng, inset, colliders: mapColliders,
      footprint: 0.45, halfY: 0.2, solid: false, tintVary: 0.18,
      scaleMin: 0.5, scaleMax: 1.2, yJitter: true,
    });
  }

  // --- Grass tufts: crossed alpha-tested quads near edges (huge richness). -
  if (d.grassTufts > 0) {
    buildGrassTufts(parent, mapDef, rng, inset, d.grassTufts, d.grassTint);
  }

  // --- Foliage / trees: async kit GLB instanced via cloning a loaded model. -
  if (d.foliage > 0 && d.foliageKey) {
    buildFoliageTrees(parent, mapColliders, mapDef, rng, inset, epoch);
  }

  // --- Hero kit GLB clusters: a few large prepared models at deterministic
  //     anchor points. Each falls back silently to nothing (crates already
  //     provide the gameplay cover). ------------------------------------------
  if (Array.isArray(d.heroKit) && d.heroKit.length) {
    buildHeroKit(parent, mapColliders, mapDef, rng, inset, epoch);
  }

  // --- Replace plain barrels with KayKit barrel GLBs where available (visual
  //     upgrade layered on top; colliders already placed by the instanced pass).
  // (No-op if the GLB is missing — the procedural cylinders remain.)

  // --- Neon trim for night_city: emissive strips that bloom under post. -----
  if (d.neon) buildNeonTrim(parent, mapDef, rng);
}

// placeInstanced — scatter `count` instances of (geo,mat) at clear locations.
// Pushes colliders + contact shadows when solid. Single InstancedMesh => 1 draw.
function placeInstanced(parent, mapColliders, o) {
  const { geo, mat, count, rng, inset, colliders } = o;
  const inst = new THREE.InstancedMesh(geo, mat, count);
  // PERF (cut E): only solid cover (barrels/pillars) casts the sun shadow;
  // cosmetic non-solid clutter (debris/rubble) is skipped from the shadow pass.
  // The contact-shadow quads still ground the solid props.
  inst.castShadow = !!o.solid;
  inst.receiveShadow = true;
  inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const obj = new THREE.Object3D();
  const baseCol = (mat.color || new THREE.Color(0xffffff)).clone();
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 30;
  while (placed < count && attempts < maxAttempts) {
    attempts++;
    const x = (rng() * 2 - 1) * inset;
    const z = (rng() * 2 - 1) * inset;
    if (!_placeClear(x, z, (o.footprint || 0.5) + 0.4, colliders, inset)) continue;
    const sc = o.scaleMin != null
      ? o.scaleMin + rng() * (o.scaleMax - o.scaleMin) : 1;
    const halfY = (o.halfY || 0.5) * sc;
    const y = o.yJitter ? halfY * 0.5 : halfY;
    obj.position.set(x, y, z);
    obj.rotation.y = rng() * Math.PI * 2;
    obj.scale.setScalar(sc);
    obj.updateMatrix();
    inst.setMatrixAt(placed, obj.matrix);
    if (o.tintVary) {
      const t = (rng() * 2 - 1) * o.tintVary;
      inst.setColorAt(placed, baseCol.clone().offsetHSL(0, 0, t));
    }
    placed++;
    if (o.solid) {
      mapColliders.push(
        makeCollider(x, y, z, (o.footprint || 0.5) * sc, halfY, (o.footprint || 0.5) * sc, null),
      );
    }
    if (o.contact) addContactShadow(parent, x, z, (o.footprint || 0.5) * sc * 1.8);
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  parent.add(inst);
  return inst;
}

// buildGrassTufts — crossed-quad billboards (two perpendicular planes) with an
// alpha-tested cartoon grass texture, instanced. No shadows, no colliders.
function buildGrassTufts(parent, mapDef, rng, inset, count, tint) {
  const tex = makeGrassTexture(tint);
  const mat = new THREE.MeshToonMaterial({
    map: tex, gradientMap: toonGradientMap(),
    alphaTest: 0.5, side: THREE.DoubleSide, transparent: false,
  });
  // Crossed quads merged into one BufferGeometry (two planes).
  const blade = new THREE.PlaneGeometry(0.9, 0.9);
  blade.translate(0, 0.45, 0);
  const blade2 = blade.clone();
  blade2.rotateY(Math.PI / 2);
  const geo = mergeTwo(blade, blade2);
  const inst = new THREE.InstancedMesh(geo, mat, count);
  inst.castShadow = false;
  inst.receiveShadow = false;
  inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const obj = new THREE.Object3D();
  let placed = 0, attempts = 0;
  while (placed < count && attempts < count * 8) {
    attempts++;
    // Bias grass toward arena edges for a framed look.
    const edge = 0.55 + rng() * 0.45;
    const ang = rng() * Math.PI * 2;
    const x = Math.cos(ang) * inset * edge;
    const z = Math.sin(ang) * inset * edge;
    if (x * x + z * z < 25) continue;
    const sc = 0.6 + rng() * 0.8;
    obj.position.set(x, 0, z);
    obj.rotation.y = rng() * Math.PI;
    obj.scale.setScalar(sc);
    obj.updateMatrix();
    inst.setMatrixAt(placed, obj.matrix);
    placed++;
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  inst.name = 'grassTufts';
  parent.add(inst);
}

// mergeTwo — minimal two-geometry position/normal/uv concat (no addon needed).
function mergeTwo(a, b) {
  const geo = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const aa = a.getAttribute(name), bb = b.getAttribute(name);
    if (!aa || !bb) continue;
    const arr = new Float32Array(aa.array.length + bb.array.length);
    arr.set(aa.array, 0);
    arr.set(bb.array, aa.array.length);
    geo.setAttribute(name, new THREE.BufferAttribute(arr, aa.itemSize));
  }
  if (a.index && b.index) {
    const ai = a.index.array, bi = b.index.array;
    const vcount = a.getAttribute('position').count;
    const idx = new Uint32Array(ai.length + bi.length);
    idx.set(ai, 0);
    for (let i = 0; i < bi.length; i++) idx[ai.length + i] = bi[i] + vcount;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

// buildFoliageTrees — load one tree GLB, then scatter instanced clones. Falls
// back to procedural cone+trunk trees if the GLB is missing.
function buildFoliageTrees(parent, mapColliders, mapDef, rng, inset, epoch) {
  const d = mapDef.decor;
  const spots = [];
  let tries = 0;
  while (spots.length < d.foliage && tries < d.foliage * 20) {
    tries++;
    const x = (rng() * 2 - 1) * inset;
    const z = (rng() * 2 - 1) * inset;
    if (!_placeClear(x, z, 1.6, mapColliders, inset)) continue;
    spots.push([x, z, 0.8 + rng() * 0.6, rng() * Math.PI * 2]);
  }
  // Procedural fallback trees placed immediately (so foliage always exists).
  const fallbackGroup = makeProceduralTrees(spots, mapDef);
  fallbackGroup.name = 'foliageFallback';
  parent.add(fallbackGroup);
  for (const [x, z] of spots) {
    addContactShadow(parent, x, z, 1.6);
    // Trees are solid-ish cover: a thin trunk collider.
    mapColliders.push(makeCollider(x, 1.5, z, 0.35, 1.5, 0.35, null));
  }
  // Async upgrade: replace fallback with real kit trees when the GLB resolves.
  loadKitModel(d.foliageKey, { target: 4.5, toonify: true }, epoch, (proto) => {
    if (fallbackGroup.parent) {
      fallbackGroup.parent.remove(fallbackGroup);
      disposeAvatar(fallbackGroup);
    }
    const grp = new THREE.Group();
    grp.name = 'foliageTrees';
    for (const [x, z, s, ry] of spots) {
      const c = proto.clone(true);
      c.position.set(x, 0, z);
      c.rotation.y = ry;
      c.scale.multiplyScalar(s);
      grp.add(c);
    }
    parent.add(grp);
  });
}

// Procedural cartoon tree: a brown trunk + 2 stacked green cones.
function makeProceduralTrees(spots, mapDef) {
  const grp = new THREE.Group();
  const trunkMat = makeToonMaterial({ color: 0x6b4a2b });
  const leafTint = mapDef.id === 'desert' ? 0x8a7a44 : 0x4f7d3a;
  const leafMat = makeToonMaterial({ color: leafTint });
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 1.6, 7);
  const c1 = new THREE.ConeGeometry(1.1, 1.6, 8);
  const c2 = new THREE.ConeGeometry(0.8, 1.3, 8);
  for (const [x, z, s, ry] of spots) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.8; trunk.castShadow = true;
    const cone1 = new THREE.Mesh(c1, leafMat);
    cone1.position.y = 2.0; cone1.castShadow = true;
    const cone2 = new THREE.Mesh(c2, leafMat);
    cone2.position.y = 2.9; cone2.castShadow = true;
    tree.add(trunk, cone1, cone2);
    tree.position.set(x, 0, z);
    tree.rotation.y = ry;
    tree.scale.setScalar(s);
    grp.add(tree);
  }
  return grp;
}

// buildHeroKit — place a handful of large kit GLB clusters at deterministic
// anchors. Each model is box-normalized/toonified by loadKitModel; failure is a
// silent no-op (no fallback mesh needed — crates already cover gameplay).
function buildHeroKit(parent, mapColliders, mapDef, rng, inset, epoch) {
  const d = mapDef.decor;
  const anchors = [];
  let tries = 0;
  while (anchors.length < d.heroKit.length && tries < 60) {
    tries++;
    const x = (rng() * 2 - 1) * inset;
    const z = (rng() * 2 - 1) * inset;
    if (!_placeClear(x, z, 2.4, mapColliders, inset)) continue;
    anchors.push([x, z, rng() * Math.PI * 2]);
  }
  d.heroKit.forEach((key, i) => {
    const a = anchors[i];
    if (!a) return;
    const [x, z, ry] = a;
    addContactShadow(parent, x, z, 2.2);
    // Cover collider sized to a typical 2x2 kit cluster (visual model may vary;
    // the AABB keeps multiplayer/SP collision deterministic regardless of load).
    mapColliders.push(makeCollider(x, 1.0, z, 1.0, 1.0, 1.0, null));
    loadKitModel(key, { target: 2.6, rotY: ry, toonify: true, outline: true }, epoch, (model) => {
      model.position.set(x, 0, z);
      parent.add(model);
    });
  });
}

// buildNeonTrim — emissive strips around a few crates/pillars that bloom under
// the post stack. Visual only; no colliders. night_city flavour.
function buildNeonTrim(parent, mapDef, rng) {
  const colors = [0xff3c8a, 0x3cc0ff, 0xff8a3c, 0x9d6bff];
  const count = 10;
  const geo = new THREE.BoxGeometry(0.12, 0.12, 3.0);
  for (let i = 0; i < count; i++) {
    const col = colors[i % colors.length];
    const mat = new THREE.MeshBasicMaterial({ color: col, fog: false, toneMapped: false });
    const strip = new THREE.Mesh(geo, mat);
    const ang = rng() * Math.PI * 2;
    const r = 12 + rng() * (ARENA_HALF - 18);
    strip.position.set(Math.cos(ang) * r, 0.3 + rng() * 3.5, Math.sin(ang) * r);
    strip.rotation.y = rng() * Math.PI;
    strip.rotation.z = (rng() - 0.5) * 0.3;
    strip.name = 'neonTrim';
    parent.add(strip);
  }
}

// ===========================================================================
// MULTIPLAYER: remote-player avatars + shot tracers (additive; SP unaffected).
// All state lives in module-scoped maps/lists below; none of the existing
// single-player path touches these. main.js drives them only in host/client mode.
// ===========================================================================

// Mirror of net.js INTERP_DELAY (seconds). Kept local so scene.js imports only
// 'three' per the shared contract. Used by the interpolation clamp.
const INTERP_DELAY = 0.10;

// Friendly bluish avatar palette (distinct from enemy red).
const AVATAR_HEAD_Y = 1.55; // local y of head center, mirrors enemy proportions

// pid -> record. Record = { pid, root, body, head, nameSprite,
//   targetPos:Vector3, targetYaw, prevPos:Vector3, prevYaw, lastT, alive }.
const _remotePlayers = new Map();

// Active tracers: { mesh, age, life, mat }.
const _tracers = [];

// ---------------------------------------------------------------------------
// buildAvatarMesh — remote-player avatar. Builds a clean procedural toon
// humanoid (holding a gun shape) IMMEDIATELY so the avatar is visible on the
// first frame, then asynchronously swaps in the self-contained CC0 "Adventurer"
// GLB humanoid (toonified, holding a procedural gun) once it loads. The GLB swap
// preserves root.userData.body / root.userData.head so headshot/anim hooks and
// the weapon-attach logic keep working. On ANY load/parse failure the procedural
// humanoid stays — never blocks the loop, never breaks SP/MP.
// Root group sits at feet (y=0); an inner `body` group holds the primitives.
// ---------------------------------------------------------------------------
function buildAvatarMesh() {
  const root = new THREE.Group();
  const body = buildProceduralHumanoidBody();
  root.add(body);

  root.userData.body = body;
  root.userData.head = body.userData.head;
  root.userData.avatarKind = 'procedural';

  // Hold a default rifle silhouette so the avatar reads as armed from frame one.
  attachAvatarGun(body, 'rifle');

  // Kick off the real CC0 humanoid load; swap in on success (procedural stays
  // until then and on any failure).
  loadAvatarModel(root);

  return root;
}

// buildProceduralHumanoidBody — a tidy cel-shaded humanoid (NOT a blob+stick):
// separated head/torso/hips/arms/legs with cartoon outlines. Returns the `body`
// group with userData.head set. Feet at y=0, head centered at AVATAR_HEAD_Y so
// it matches the GLB-normalized avatar and the enemy proportions.
function buildProceduralHumanoidBody() {
  const body = new THREE.Group();

  // Cel-shaded palette (friendly blue, distinct from enemy red).
  const skin = makeToonMaterial({ color: 0x4a7fd0 });
  const dark = makeToonMaterial({ color: 0x223a63 });
  const limb = makeToonMaterial({ color: 0x3a63a8 });
  const eyeMat = new THREE.MeshToonMaterial({
    color: 0xaee2ff, emissive: 0x55ccff, emissiveIntensity: 1.2,
    gradientMap: toonGradientMap(),
  });

  // Hips.
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.34), dark);
  hips.position.y = 0.82;
  hips.castShadow = true;
  body.add(hips);

  // Legs (two separate boxes — reads as a humanoid, not a single block).
  const legGeo = new THREE.BoxGeometry(0.2, 0.8, 0.24);
  const legL = new THREE.Mesh(legGeo, limb);
  const legR = new THREE.Mesh(legGeo, limb);
  legL.position.set(-0.14, 0.4, 0);
  legR.position.set(0.14, 0.4, 0);
  legL.castShadow = legR.castShadow = true;
  body.add(legL, legR);

  // Torso (tapered chest).
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.62, 0.32), skin);
  torso.position.y = 1.28;
  torso.castShadow = true;
  body.add(torso);

  // Head.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), skin);
  head.position.y = AVATAR_HEAD_Y;
  head.castShadow = true;
  body.add(head);

  // Glowing eyes on local +Z (facing side, matches yaw convention).
  const eyeGeo = new THREE.SphereGeometry(0.045, 8, 6);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.09, AVATAR_HEAD_Y + 0.02, 0.2);
  eyeR.position.set(0.09, AVATAR_HEAD_Y + 0.02, 0.2);
  body.add(eyeL, eyeR);

  // Arms held forward in a ready-to-fire pose.
  const armGeo = new THREE.BoxGeometry(0.15, 0.62, 0.15);
  const armL = new THREE.Mesh(armGeo, limb);
  const armR = new THREE.Mesh(armGeo, limb);
  armL.position.set(-0.38, 1.18, 0.16);
  armR.position.set(0.38, 1.18, 0.16);
  armL.rotation.x = -0.75;
  armR.rotation.x = -0.75;
  armL.castShadow = armR.castShadow = true;
  body.add(armL, armR);

  // Cartoon cel edges on the hero silhouette (gated by quality flag).
  addOutline(torso, 0.04);
  addOutline(head, 0.05);
  addOutline(hips, 0.04);
  addOutline(legL, 0.04);
  addOutline(legR, 0.04);

  body.userData.head = head;
  body.userData.baseScaleY = 1; // for scale-aware death flatten
  return body;
}

// attachAvatarGun — parent a small procedural toon gun silhouette to a body
// group, held forward at chest height (local +Z facing). Removes any previous
// gun first. Used both for the default load-in pose and weapon swaps.
function attachAvatarGun(body, weaponName) {
  if (!body) return null;
  if (body.userData.gun) {
    body.remove(body.userData.gun);
    body.userData.gun.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) m.dispose();
      }
    });
    body.userData.gun = null;
  }

  // Per-weapon barrel length so remote players read distinctly.
  let len = 0.5;
  if (weaponName === 'pistol') len = 0.3;
  else if (weaponName === 'shotgun') len = 0.6;
  else if (weaponName === 'rifle') len = 0.7;

  const gun = new THREE.Group();
  const bodyMat = makeToonMaterial({ color: 0x23282f });
  const metalMat = makeToonMaterial({ color: 0x3a4049 });

  // Receiver + barrel.
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, len * 0.45), bodyMat);
  const barrel = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.08, len * 0.6), metalMat,
  );
  barrel.position.z = len * 0.5;
  // Grip + magazine for a clear gun read.
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.1), bodyMat);
  grip.position.set(0, -0.13, -len * 0.1);
  grip.rotation.x = 0.25;

  receiver.castShadow = barrel.castShadow = true;
  gun.add(receiver, barrel, grip);
  if (QUALITY.enableOutline) {
    addOutline(receiver, 0.03);
    addOutline(barrel, 0.03);
  }

  // Held forward in the avatar's hands at chest height (local +Z facing).
  gun.position.set(0.2, 1.2, 0.34);
  gun.rotation.x = -0.12;
  body.add(gun);
  body.userData.gun = gun;
  return gun;
}

// loadAvatarModel — async-load the self-contained CC0 humanoid GLB and, on
// success, replace root's procedural body with a toonified, normalized clone
// holding a gun. Preserves root.userData.body/head so all downstream hooks work.
function loadAvatarModel(root) {
  if (!root) return;
  loadModel(
    'avatar', AVATAR_MODEL_URL,
    (gltf) => {
      // swapInAvatarModel guards against an already-removed avatar internally.
      try { swapInAvatarModel(root, gltf); } catch (_) { /* keep procedural */ }
    },
    () => { /* missing/parse fail — keep procedural humanoid (no-op) */ },
  );
}

// _avatarRootIsLive — true if any remote-player record still references this root
// (guards against swapping into an avatar that was already removed/disposed).
function _avatarRootIsLive(root) {
  for (const rec of _remotePlayers.values()) {
    if (rec.root === root) return true;
  }
  return false;
}

// swapInAvatarModel — normalize the loaded GLB to standing height, center its
// footprint at the origin, toonify its (vertex-colored) meshes, give it a gun,
// and replace the procedural body in `root`. Keeps root.userData.body/head.
function swapInAvatarModel(root, gltf) {
  if (!_avatarRootIsLive(root)) return; // avatar already gone
  const model = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!model) return;

  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.y, 0.001);
  // Normalize to ~1.8m tall to match player/enemy scale.
  const targetH = 1.8;
  const s = targetH / maxDim;

  // Re-center: x/z centered, base (feet) at y=0.
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= (center.y - size.y / 2);

  const body = new THREE.Group();
  // GLB authored facing -Z; rotate the MODEL (not the whole body) so it faces +Z
  // (our yaw/forward convention). Rotating only the model keeps the body's frame
  // identical to the procedural humanoid, so the gun attaches at +Z front for
  // both avatar kinds via the same attachAvatarGun call.
  model.rotation.y = Math.PI;
  body.add(model);
  body.scale.setScalar(s);
  body.userData.baseScaleY = s; // for scale-aware death flatten

  // Toonify the (vertex-colored) GLB so it matches the cel-shaded world.
  toonifyTree(body);
  body.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

  // Approximate head node for headshot/anim hooks; fall back to a synthetic
  // marker at AVATAR_HEAD_Y if the rig names aren't found.
  let head = null;
  model.traverse((o) => {
    if (head) return;
    const n = (o.name || '').toLowerCase();
    if (n.includes('head')) head = o;
  });
  if (!head) {
    head = new THREE.Object3D();
    head.position.y = AVATAR_HEAD_Y;
    body.add(head);
  }

  // Hold a gun (default rifle; updateRemotePlayer re-attaches on weapon swap).
  attachAvatarGun(body, 'rifle');

  // Swap: remove the old procedural body, attach the GLB body.
  const old = root.userData.body;
  if (old && old.parent === root) {
    root.remove(old);
    disposeAvatar(old);
  }
  root.add(body);
  root.userData.body = body;
  root.userData.head = head;
  root.userData.avatarKind = 'model';

  // Re-sync the held weapon if a specific one was already reported.
  for (const rec of _remotePlayers.values()) {
    if (rec.root === root) {
      rec.body = body;
      rec.head = head;
      if (rec.weaponName) attachAvatarGun(body, rec.weaponName);
      // alive=false avatars were flattened on the old body; reapply (scale-aware).
      if (rec.alive === false) body.scale.y = s * 0.1;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// makeNameSprite — small floating canvas label above the avatar. Optional per
// contract; cheap and improves readability. Returns a THREE.Sprite or null.
// ---------------------------------------------------------------------------
function makeNameSprite(name) {
  const text = String(name == null ? '' : name).slice(0, 16) || 'PLAYER';
  const pad = 8;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = 'bold 28px sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = 40;
  c.width = w;
  c.height = h;
  // Re-fetch context state after resize (canvas resets on dimension change).
  ctx.font = 'bold 28px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(10,20,40,0.6)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#cfe6ff';
  ctx.fillText(text, pad, h / 2 + 1);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  // Scale to roughly readable world size; keep aspect from canvas.
  const scale = 0.0085;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.set(0, AVATAR_HEAD_Y + 0.55, 0);
  sprite.userData.isNameSprite = true;
  return sprite;
}

// ---------------------------------------------------------------------------
// spawnRemotePlayer — create avatar for pid, add to scene, store record.
// Idempotent: if pid already exists, returns the existing record.
// ---------------------------------------------------------------------------
export function spawnRemotePlayer(state, pid, name) {
  if (_remotePlayers.has(pid)) return _remotePlayers.get(pid);

  const root = buildAvatarMesh();
  root.name = 'remotePlayer';
  root.userData.remotePid = pid;

  const nameSprite = makeNameSprite(name);
  if (nameSprite) root.add(nameSprite);

  if (state.scene) state.scene.add(root);

  const rec = {
    pid,
    name: name || '',
    root,
    body: root.userData.body,
    head: root.userData.head,
    nameSprite,
    targetPos: new THREE.Vector3(0, 0, 0),
    targetYaw: 0,
    prevPos: new THREE.Vector3(0, 0, 0),
    prevYaw: 0,
    lastT: 0,        // server timestamp of the latest target (seconds)
    prevT: 0,        // server timestamp of the previous target
    alive: true,
    seeded: false,   // becomes true after the first updateRemotePlayer
  };
  _remotePlayers.set(pid, rec);
  return rec;
}

// ---------------------------------------------------------------------------
// updateRemotePlayer — set new interp target. Shifts the old target into prev.
// pos may be a THREE.Vector3 or a [x,y,z] array; yaw is radians. alive=false
// flattens/hides the avatar (without removing it from the scene).
// ---------------------------------------------------------------------------
export function updateRemotePlayer(state, pid, pos, yaw, alive, weaponName) {
  let rec = _remotePlayers.get(pid);
  if (!rec) rec = spawnRemotePlayer(state, pid);

  // Optional: swap the avatar's held-weapon silhouette when the snapshot reports
  // a different active weapon. Backward compatible — omitted arg leaves it as is.
  if (weaponName && weaponName !== rec.weaponName) {
    rec.weaponName = weaponName;
    setAvatarWeapon(rec, weaponName);
  }

  const px = Array.isArray(pos) ? pos[0] : pos.x;
  const py = Array.isArray(pos) ? pos[1] : pos.y;
  const pz = Array.isArray(pos) ? pos[2] : pos.z;

  const now = (state && typeof state.time === 'number') ? state.time
    : (performance.now() / 1000);

  if (!rec.seeded) {
    // First sample: snap both prev and target so we don't lerp from origin.
    rec.prevPos.set(px, py, pz);
    rec.targetPos.set(px, py, pz);
    rec.prevYaw = yaw;
    rec.targetYaw = yaw;
    rec.root.position.set(px, py, pz);
    rec.root.rotation.y = yaw;
    rec.prevT = now;
    rec.lastT = now;
    rec.seeded = true;
  } else {
    rec.prevPos.copy(rec.targetPos);
    rec.prevYaw = rec.targetYaw;
    rec.prevT = rec.lastT;
    rec.targetPos.set(px, py, pz);
    rec.targetYaw = yaw;
    rec.lastT = now;
  }

  const isAlive = alive !== false;
  if (isAlive !== rec.alive) {
    rec.alive = isAlive;
    rec.root.visible = isAlive;
    // Flatten on death — scale-aware so it works for both the procedural body
    // (base y-scale 1) and the normalized GLB body (base y-scale ~targetH/maxDim).
    if (rec.body) {
      const base = rec.body.userData.baseScaleY != null ? rec.body.userData.baseScaleY : 1;
      rec.body.scale.y = isAlive ? base : base * 0.1;
    }
  }
}

// setAvatarWeapon — swap the held-weapon silhouette in the avatar's hands.
// Purely visual; the gun is parented to the body group (procedural OR GLB) so it
// follows the pose. Delegates to attachAvatarGun (single source of truth for the
// gun shape), which handles disposing the previous gun and per-weapon sizing.
function setAvatarWeapon(rec, weaponName) {
  if (!rec || !rec.body) return;
  rec.weaponMesh = attachAvatarGun(rec.body, weaponName);
}

// Shortest-arc angle lerp (radians).
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// interpolateRemotePlayers — lerp every avatar prev->target. renderTime is a
// server-clock time (now - INTERP_DELAY). Pure visual; no collision.
// ---------------------------------------------------------------------------
export function interpolateRemotePlayers(state, renderTime) {
  for (const rec of _remotePlayers.values()) {
    if (!rec.seeded || !rec.alive) continue;

    let t;
    const span = rec.lastT - rec.prevT;
    if (span > 1e-6) {
      // Position the avatar at renderTime between the two samples; clamp [0,1].
      let rt = renderTime;
      if (typeof rt !== 'number') {
        rt = (state && typeof state.time === 'number' ? state.time
          : performance.now() / 1000) - INTERP_DELAY;
      }
      t = (rt - rec.prevT) / span;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    } else {
      t = 1;
    }

    rec.root.position.lerpVectors(rec.prevPos, rec.targetPos, t);
    rec.root.rotation.y = lerpAngle(rec.prevYaw, rec.targetYaw, t);
  }
}

// ---------------------------------------------------------------------------
// removeRemotePlayer — detach from scene, dispose meshes, drop from map.
// ---------------------------------------------------------------------------
export function removeRemotePlayer(state, pid) {
  const rec = _remotePlayers.get(pid);
  if (!rec) return;
  if (rec.root && rec.root.parent) rec.root.parent.remove(rec.root);
  disposeAvatar(rec.root);
  _remotePlayers.delete(pid);
}

// ---------------------------------------------------------------------------
// clearRemotePlayers — teardown all remote avatars (on disconnect).
// ---------------------------------------------------------------------------
export function clearRemotePlayers(state) {
  for (const rec of _remotePlayers.values()) {
    if (rec.root && rec.root.parent) rec.root.parent.remove(rec.root);
    disposeAvatar(rec.root);
  }
  _remotePlayers.clear();
}

// Free GPU resources for an avatar tree (mirrors enemies.disposeMesh pattern,
// including sprite textures used by the name label).
function disposeAvatar(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.isMesh || o.isSprite) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// spawnTracer — short-lived emissive shot tracer along dir from origin (~40m),
// fades over ~0.08s. origin/dir are [x,y,z] arrays (per wire protocol 'fire').
// ---------------------------------------------------------------------------
export function spawnTracer(state, originArr, dirArr) {
  if (!state || !state.scene) return null;

  const ox = originArr[0], oy = originArr[1], oz = originArr[2];
  let dx = dirArr[0], dy = dirArr[1], dz = dirArr[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;

  const LENGTH = 40;
  const dir = new THREE.Vector3(dx, dy, dz);

  // Thin cylinder aligned to dir. Cylinder's default axis is +Y; orient it.
  const geo = new THREE.CylinderGeometry(0.015, 0.015, LENGTH, 6, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff2b0,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);

  // Midpoint of the segment from origin along dir.
  mesh.position.set(
    ox + dx * (LENGTH / 2),
    oy + dy * (LENGTH / 2),
    oz + dz * (LENGTH / 2),
  );
  // Rotate +Y to dir.
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.name = 'tracer';

  state.scene.add(mesh);

  _tracers.push({ mesh, mat, age: 0, life: 0.08 });
  return mesh;
}

// ---------------------------------------------------------------------------
// updateTracers — advance, fade and expire tracers. Called every frame in MP.
// ---------------------------------------------------------------------------
export function updateTracers(state, dt) {
  for (let i = _tracers.length - 1; i >= 0; i--) {
    const tr = _tracers[i];
    tr.age += dt;
    const k = tr.age / tr.life;
    if (k >= 1) {
      if (tr.mesh.parent) tr.mesh.parent.remove(tr.mesh);
      if (tr.mesh.geometry) tr.mesh.geometry.dispose();
      if (tr.mat) tr.mat.dispose();
      _tracers.splice(i, 1);
    } else {
      tr.mat.opacity = 0.9 * (1 - k);
    }
  }
}

// --- procedural textures (drawn to canvas, no image files) -----------------

function makeFloorTexture(palette) {
  const cols = (palette && palette.length >= 2) ? palette : ['#3a3f47', '#444a53'];
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');

  // Two-tone checker (palette-driven) with a bit of noise.
  ctx.fillStyle = cols[0];
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = cols[1];
  ctx.fillRect(0, 0, s / 2, s / 2);
  ctx.fillRect(s / 2, s / 2, s / 2, s / 2);

  // Grain.
  const img = ctx.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  // Grid lines for spatial reference.
  ctx.strokeStyle = 'rgba(20,22,26,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, s, s);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Large-scale ground overlay: transparent splotches + radial darkening toward
// the edges. Multiplied over the tiled ground to break up obvious repetition and
// fake ambient occlusion near the walls. Drawn once; reused for the whole arena.
function makeGroundOverlayTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, s, s);

  // Edge darkening: dark frame fading to transparent center.
  const grad = ctx.createRadialGradient(s / 2, s / 2, s * 0.18, s / 2, s / 2, s * 0.7);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);

  // Scattered soft dirt splotches.
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    const r = 6 + Math.random() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,' + (0.10 + Math.random() * 0.18).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Crossed-quad foliage/grass blade texture (alpha-tested). Simple cartoon tuft.
function makeGrassTexture(tintHex) {
  const tint = new THREE.Color(tintHex != null ? tintHex : 0x5b8c3a);
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  const light = '#' + tint.clone().lerp(new THREE.Color(0xffffff), 0.25).getHexString();
  const dark = '#' + tint.clone().multiplyScalar(0.6).getHexString();
  // A few tapered blades rising from the bottom center.
  for (let i = 0; i < 7; i++) {
    const x0 = s * (0.2 + 0.6 * (i / 6));
    const lean = (Math.random() - 0.5) * 18;
    const top = s * (0.08 + Math.random() * 0.22);
    ctx.beginPath();
    ctx.moveTo(x0 - 3, s);
    ctx.quadraticCurveTo(x0 + lean, s * 0.5, x0 + lean, top);
    ctx.quadraticCurveTo(x0 + lean + 2, s * 0.5, x0 + 3, s);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? light : dark;
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Flat-color wall fallback (subtle panel seams) tinted by the map palette.
function makeWallTexture(colorHex) {
  const base = new THREE.Color(colorHex != null ? colorHex : 0x6d717a);
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#' + base.getHexString();
  ctx.fillRect(0, 0, s, s);
  // Panel seams.
  const dark = base.clone().multiplyScalar(0.7);
  ctx.strokeStyle = '#' + dark.getHexString();
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, s - 2, s - 2);
  ctx.beginPath();
  ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeCrateTexture(tintHex) {
  // Derive plank/seam colors from the map crate tint so each map's procedural
  // fallback reads in-palette (warehouse wood, desert sand, night container).
  const tint = new THREE.Color(tintHex != null ? tintHex : 0x9a6a33);
  const base = '#' + tint.getHexString();
  const seam = '#' + tint.clone().multiplyScalar(0.45).getHexString();
  const grain = '#' + tint.clone().multiplyScalar(0.75).getHexString();
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, s, s);

  // Plank seams + border to read as a crate/container.
  ctx.strokeStyle = seam;
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, s - 4, s - 4);
  ctx.beginPath();
  ctx.moveTo(s / 2, 2); ctx.lineTo(s / 2, s - 2);
  ctx.moveTo(2, s / 2); ctx.lineTo(s - 2, s / 2);
  ctx.stroke();

  // Light grain streaks.
  ctx.strokeStyle = grain;
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const y = Math.random() * s;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s, y + (Math.random() - 0.5) * 6);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
