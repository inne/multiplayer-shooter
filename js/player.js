// player.js — pointer-lock FPS controller
//
// Owns: state.player.* (position, velocity, yaw, pitch, onGround, health, alive),
//       state.input.*, and the camera transform.
// Talks to the rest of the app only through the shared `state` object and the
// event queue (pushes {type:'playerDead'} on death).
//
// Movement model: classic arcade-FPS feel — instant ground acceleration with a
// little air control, a fixed jump impulse, gravity from scene consts, and AABB
// penetration resolution against static colliders (resolved per-axis so we slide
// along walls instead of sticking).

import * as THREE from 'three';
import {
  GRAVITY,
  PLAYER_SPEED,
  PLAYER_JUMP_SPEED,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF,
  PLAYER_MAX_HEALTH,
  ARENA_HALF,
} from './scene.js';

// --- internal tuning constants (not exported) ---
const PLAYER_LOOK_SENS = 0.0022;          // radians per pixel of mouse movement
const PITCH_LIMIT = Math.PI / 2 - 0.01;   // clamp so we never gimbal-flip straight up/down
const GROUND_ACCEL = 90;                   // m/s^2 — snappy on the ground
const AIR_ACCEL = 14;                      // m/s^2 — limited air control
const GROUND_FRICTION = 12;                // per-second damping when no input on ground
const ARENA_MARGIN = 0.5;                  // safety keep-in from the arena edge
const SPAWN = { x: 0, y: 0, z: 0 };        // feet spawn position

// Module-scoped reusable temporaries (no per-frame allocation; never stored on state).
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

// Listener handles are registered once in initPlayer. We guard with a flag so a
// double-init (hot reload, etc.) doesn't stack duplicate listeners.
let _listenersBound = false;

export function initPlayer(state) {
  const p = state.player;

  // Player state defaults.
  p.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
  p.velocity.set(0, 0, 0);
  p.yaw = 0;
  p.pitch = 0;
  p.onGround = true;
  p.health = PLAYER_MAX_HEALTH;
  p.maxHealth = PLAYER_MAX_HEALTH;
  p.alive = true;
  p.radius = PLAYER_HALF.x;

  // Input snapshot — player.js owns this object's fields.
  const i = state.input;
  i.forward = i.back = i.left = i.right = false;
  i.jump = i.reload = i.firing = false;
  i.pointerLocked = false;

  // Drive the camera once so the very first rendered frame is already aligned.
  writeCamera(state);

  if (_listenersBound) return;
  _listenersBound = true;

  // --- keyboard ---
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    i.forward = true; break;
      case 'KeyS': case 'ArrowDown':  i.back = true; break;
      case 'KeyA': case 'ArrowLeft':  i.left = true; break;
      case 'KeyD': case 'ArrowRight': i.right = true; break;
      case 'Space':
        i.jump = true;          // one-frame flag; cleared at end of update
        e.preventDefault();     // stop the page from scrolling on space
        break;
      case 'KeyR':
        i.reload = true;        // one-frame flag; weapons.js consumes, we clear in update
        break;
      default: break;
    }
  });

  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    i.forward = false; break;
      case 'KeyS': case 'ArrowDown':  i.back = false; break;
      case 'KeyA': case 'ArrowLeft':  i.left = false; break;
      case 'KeyD': case 'ArrowRight': i.right = false; break;
      default: break;
    }
  });

  // --- mouse look (only while pointer is locked) ---
  document.addEventListener('mousemove', (e) => {
    if (!i.pointerLocked) return;
    p.yaw -= e.movementX * PLAYER_LOOK_SENS;
    p.pitch -= e.movementY * PLAYER_LOOK_SENS;
    if (p.pitch > PITCH_LIMIT) p.pitch = PITCH_LIMIT;
    else if (p.pitch < -PITCH_LIMIT) p.pitch = -PITCH_LIMIT;
  });

  // --- fire button (held = automatic; weapons.js reads input.firing) ---
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0 && i.pointerLocked) i.firing = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) i.firing = false;
  });

  // --- pointer-lock state tracking ---
  document.addEventListener('pointerlockchange', () => {
    i.pointerLocked = (document.pointerLockElement != null);
    if (!i.pointerLocked) i.firing = false; // never get stuck firing after losing lock
  });

  // Convenience: clicking the canvas while playing re-acquires lock. main.js also
  // requests lock from the Start gesture; this is purely a quality-of-life extra.
  const canvas = state.renderer && state.renderer.domElement;
  if (canvas) {
    canvas.addEventListener('click', () => {
      if (state.phase === 'playing' && !i.pointerLocked) {
        canvas.requestPointerLock();
      }
    });
  }
}

export function update(state, dt) {
  // World is frozen unless we're actively playing.
  if (state.phase !== 'playing') {
    writeCamera(state); // keep camera aligned for menus/pause
    return;
  }

  const p = state.player;
  const i = state.input;

  // --- 1. Build the wish direction from input, relative to current yaw. ---
  // Forward is -Z at yaw 0 (Three.js camera default). We keep movement on the XZ
  // plane: looking up/down must not slow you down.
  _euler.set(0, p.yaw, 0, 'YXZ');
  _forward.set(0, 0, -1).applyEuler(_euler);
  _right.set(1, 0, 0).applyEuler(_euler);

  _wish.set(0, 0, 0);
  if (i.forward) _wish.add(_forward);
  if (i.back)    _wish.sub(_forward);
  if (i.right)   _wish.add(_right);
  if (i.left)    _wish.sub(_right);
  _wish.y = 0;
  const hasInput = _wish.lengthSq() > 1e-6;
  if (hasInput) _wish.normalize();

  // --- 2. Horizontal acceleration toward the target velocity. ---
  // Target = wish * PLAYER_SPEED. We accelerate the current horizontal velocity
  // toward it; on the ground we accelerate hard (snappy), in the air gently.
  const accel = p.onGround ? GROUND_ACCEL : AIR_ACCEL;
  const targetVX = _wish.x * PLAYER_SPEED;
  const targetVZ = _wish.z * PLAYER_SPEED;

  if (hasInput) {
    p.velocity.x = approach(p.velocity.x, targetVX, accel * dt);
    p.velocity.z = approach(p.velocity.z, targetVZ, accel * dt);
  } else if (p.onGround) {
    // No input on the ground: apply friction so we come to a clean stop.
    const f = Math.max(0, 1 - GROUND_FRICTION * dt);
    p.velocity.x *= f;
    p.velocity.z *= f;
    if (Math.abs(p.velocity.x) < 0.02) p.velocity.x = 0;
    if (Math.abs(p.velocity.z) < 0.02) p.velocity.z = 0;
  }
  // (No active air friction: keep momentum while airborne.)

  // --- 3. Jump (only off the ground). ---
  if (i.jump && p.onGround) {
    p.velocity.y = PLAYER_JUMP_SPEED;
    p.onGround = false;
  }

  // --- 4. Gravity. ---
  p.velocity.y -= GRAVITY * dt;

  // --- 5. Integrate + collide, resolved per-axis so we slide along surfaces. ---
  moveAndCollide(state, dt);

  // --- 6. Arena keep-in (safety net beyond the wall colliders). ---
  const limit = ARENA_HALF - ARENA_MARGIN;
  if (p.position.x >  limit) { p.position.x =  limit; if (p.velocity.x > 0) p.velocity.x = 0; }
  if (p.position.x < -limit) { p.position.x = -limit; if (p.velocity.x < 0) p.velocity.x = 0; }
  if (p.position.z >  limit) { p.position.z =  limit; if (p.velocity.z > 0) p.velocity.z = 0; }
  if (p.position.z < -limit) { p.position.z = -limit; if (p.velocity.z < 0) p.velocity.z = 0; }

  // --- 7. Death detection (single owner of player death). ---
  if (p.health <= 0 && p.alive) {
    p.alive = false;
    p.health = 0;
    state.events.push({ type: 'playerDead' });
  }

  // --- 8. Drive the camera from the (now final) transform. ---
  writeCamera(state);

  // --- 9. Reset one-frame input flags. ---
  i.jump = false;
  i.reload = false;
}

export function damagePlayer(state, amount) {
  // The ONLY path that reduces player health. enemies.js calls this; it (not us)
  // pushes the 'playerHurt' event. We just clamp; death is detected in update().
  const p = state.player;
  if (!p.alive) return;
  p.health = Math.max(0, p.health - amount);
}

// =============================================================================
// Multiplayer (additive) — serializable local state + host-applied health.
// These are no-ops for single-player; main.js only calls them in MP modes.
// =============================================================================

// Return a plain, JSON-serializable snapshot of the local player's net state.
// Read from state.player (feet position, yaw/pitch radians, velocity) and
// state.input (firing). Called <=30 Hz; allocates small arrays, which is fine.
// This is what the CLIENT puts in 'in' messages and the HOST reads for its own
// pid-0 record.
export function getNetState(state) {
  const p = state.player;
  const i = state.input;
  return {
    pos: [p.position.x, p.position.y, p.position.z],
    yaw: p.yaw,
    pitch: p.pitch,
    vel: [p.velocity.x, p.velocity.y, p.velocity.z],
    firing: !!(i && i.firing),
  };
}

// CLIENT-ONLY convenience: apply the host-authoritative health value (from
// 'hurt'/'snap'). Does NOT run death logic — the client receives an explicit
// 'dead' message. Existing damagePlayer remains the host/sp damage path.
export function applyNetHealth(state, health) {
  const p = state.player;
  p.health = health;
}

export function resetPlayer(state) {
  const p = state.player;
  p.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
  p.velocity.set(0, 0, 0);
  p.yaw = 0;
  p.pitch = 0;
  p.onGround = true;
  p.health = PLAYER_MAX_HEALTH;
  p.maxHealth = PLAYER_MAX_HEALTH;
  p.alive = true;

  const i = state.input;
  i.forward = i.back = i.left = i.right = false;
  i.jump = i.reload = i.firing = false;

  writeCamera(state);
}

// =============================================================================
// Internals
// =============================================================================

// Move one velocity-integration step, resolving each axis independently against
// the static colliders so the player slides along walls and lands on top of
// crates instead of jittering or sticking. y is handled last and sets onGround.
function moveAndCollide(state, dt) {
  const p = state.player;
  const colliders = state.colliders || [];

  // Horizontal X.
  p.position.x += p.velocity.x * dt;
  resolveAxis(p, colliders, 'x');

  // Horizontal Z.
  p.position.z += p.velocity.z * dt;
  resolveAxis(p, colliders, 'z');

  // Vertical Y.
  p.onGround = false;
  p.position.y += p.velocity.y * dt;
  resolveAxis(p, colliders, 'y');

  // Hard floor at y = 0 (matches scene.js ground at y=0). The ground slab
  // collider should also catch this, but clamping guarantees agreement.
  if (p.position.y <= 0) {
    p.position.y = 0;
    if (p.velocity.y < 0) p.velocity.y = 0;
    p.onGround = true;
  }
}

// Resolve penetration on a single axis given the player AABB (feet-anchored).
// For each overlapping collider, push the player out along `axis` by the smaller
// of the two penetration depths and cancel inbound velocity on that axis.
function resolveAxis(p, colliders, axis) {
  const h = PLAYER_HALF;

  // Player AABB from feet position: x/z centered, y from feet to feet+2*h.y.
  let minX = p.position.x - h.x, maxX = p.position.x + h.x;
  let minY = p.position.y,       maxY = p.position.y + h.y * 2;
  let minZ = p.position.z - h.z, maxZ = p.position.z + h.z;

  for (let c = 0; c < colliders.length; c++) {
    const col = colliders[c];
    const cmin = col.min, cmax = col.max;

    // AABB overlap test.
    if (maxX <= cmin.x || minX >= cmax.x) continue;
    if (maxY <= cmin.y || minY >= cmax.y) continue;
    if (maxZ <= cmin.z || minZ >= cmax.z) continue;

    if (axis === 'x') {
      // Penetration to each side; pick the shallower exit.
      const penPos = maxX - cmin.x;  // pushing player to -x
      const penNeg = cmax.x - minX;  // pushing player to +x
      if (penPos < penNeg) p.position.x -= penPos;
      else                 p.position.x += penNeg;
      if ((penPos < penNeg && p.velocity.x > 0) ||
          (penPos >= penNeg && p.velocity.x < 0)) p.velocity.x = 0;
      minX = p.position.x - h.x; maxX = p.position.x + h.x;

    } else if (axis === 'z') {
      const penPos = maxZ - cmin.z;
      const penNeg = cmax.z - minZ;
      if (penPos < penNeg) p.position.z -= penPos;
      else                 p.position.z += penNeg;
      if ((penPos < penNeg && p.velocity.z > 0) ||
          (penPos >= penNeg && p.velocity.z < 0)) p.velocity.z = 0;
      minZ = p.position.z - h.z; maxZ = p.position.z + h.z;

    } else { // 'y'
      const penUp = maxY - cmin.y;   // moving up into the box's underside
      const penDown = cmax.y - minY; // moving down onto the box's top
      if (penDown < penUp) {
        // Land on top of the collider.
        p.position.y += penDown;
        if (p.velocity.y < 0) p.velocity.y = 0;
        p.onGround = true;
      } else {
        // Bonk head on the underside.
        p.position.y -= penUp;
        if (p.velocity.y > 0) p.velocity.y = 0;
      }
      minY = p.position.y; maxY = p.position.y + h.y * 2;
    }
  }
}

// Move `current` toward `target` by at most `maxDelta`.
function approach(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

// Write the camera transform from feet position + eye height and yaw/pitch.
function writeCamera(state) {
  const cam = state.camera;
  if (!cam) return;
  const p = state.player;
  cam.position.set(p.position.x, p.position.y + PLAYER_EYE_HEIGHT, p.position.z);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(p.pitch, p.yaw, 0);
}
