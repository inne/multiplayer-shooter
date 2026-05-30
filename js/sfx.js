// sfx.js — tiny WebAudio sound module for the tank game.
//
// Loads the bundled CC0 samples once (decodeAudioData) and plays them fire-and-
// forget. No-throw: if WebAudio is unavailable or a file fails to load, calls are
// silent no-ops. The AudioContext is created lazily and resumed on the first user
// gesture (browser autoplay policy).
//
// Mapping (per design):
//   playFire()      -> assets/sfx/fire.mp3       (DeathFlash — firing a shell)
//   playExplosion() -> assets/sfx/explosion.mp3  (Chunky Explosion — tank/enemy dies)

const SAMPLES = {
  fire: "../assets/sfx/fire.mp3",
  explosion: "../assets/sfx/explosion.mp3",
};

let ctx = null;
let master = null;
const buffers = {}; // key -> AudioBuffer (once decoded)
let bound = false;

function ensureCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);
  } catch (_) {
    ctx = null;
    return null;
  }
  return ctx;
}

function loadSample(key, url) {
  const c = ensureCtx();
  if (!c) return;
  fetch(new URL(url, import.meta.url).href)
    .then((r) => { if (!r.ok) throw new Error("sfx 404"); return r.arrayBuffer(); })
    .then((buf) => c.decodeAudioData(buf))
    .then((decoded) => { buffers[key] = decoded; })
    .catch(() => { /* leave undefined -> silent */ });
}

// Preload + bind gesture-resume listeners. Safe to call once at boot.
export function init() {
  if (!ensureCtx()) return;
  for (const [k, u] of Object.entries(SAMPLES)) loadSample(k, u);
  if (!bound) {
    bound = true;
    const resume = () => { try { if (ctx && ctx.state !== "running") ctx.resume(); } catch (_) {} };
    window.addEventListener("pointerdown", resume, { passive: true });
    window.addEventListener("keydown", resume, { passive: true });
    window.addEventListener("mousedown", resume, { passive: true });
  }
}

function play(key, gain, rate) {
  const c = ctx;
  const b = buffers[key];
  if (!c || !b) return;
  if (c.state !== "running") { try { c.resume(); } catch (_) {} }
  try {
    const src = c.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate || 1;
    const g = c.createGain();
    g.gain.value = gain == null ? 1 : gain;
    src.connect(g);
    g.connect(master);
    src.start();
  } catch (_) { /* ignore */ }
}

// Slight random pitch so repeated shots/explosions do not sound mechanical.
export function playFire() { play("fire", 0.6, 0.96 + Math.random() * 0.08); }
export function playExplosion() { play("explosion", 0.9, 0.92 + Math.random() * 0.12); }

export default { init, playFire, playExplosion };
