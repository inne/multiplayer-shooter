// audio.js — WebAudio synthesized SFX (no asset files, no other-module imports)
//
// Per the shared contract (§8): all exports are fire-and-forget and no-throw. They
// safely no-op until initAudio() has created the context and unlockAudio() has
// resumed it from a user gesture. No state is leaked — every play* call spins up
// short-lived oscillator/buffer-source + gain-envelope nodes that auto-stop.

// ---- module-private singletons -------------------------------------------------
let ctx = null;            // the single AudioContext
let master = null;         // master GainNode -> destination
let masterVolume = 0.6;    // 0..1 user-controllable level
let unlocked = false;      // true once the context has actually been resumed
let noiseBuffer = null;    // reusable white-noise buffer for percussive layers
let gameState = null;      // ref to the shared state (for reading state.weapon.active)

// A registry of currently-sounding source nodes so resetAudio() can hard-stop them.
const activeNodes = new Set();

// ---- bundled CC0 sample registry -----------------------------------------------
// Self-contained, public-domain (CC0) WAV/MP3 assets under assets/sfx/. Each entry
// is fetched + decodeAudioData()'d once into `sampleBuffers`. Everything here is a
// pure ENHANCEMENT layer: if a fetch/decode fails or a buffer is missing, the
// matching play* function silently falls back to the existing synthesized sound,
// so a missing/404 asset can never throw, crash, or leave anything silent.
//
// `playbackRate`/`maxDur` let us cheaply differentiate and trim noisy multi-shot
// source clips down to their first transient without an offline build step.
const SAMPLE_MANIFEST = {
  // per-weapon fire
  'fire.pistol':  { url: 'assets/sfx/pistol_fire.wav',  gain: 0.9, maxDur: 0.35 },
  'fire.rifle':   { url: 'assets/sfx/rifle_fire.wav',   gain: 0.9, maxDur: 0.30 },
  'fire.shotgun': { url: 'assets/sfx/shotgun_fire.wav', gain: 1.0, maxDur: 0.45 },
  // clean single-shot base (generic fire fallback / pitch-shiftable)
  'fire.single':  { url: 'assets/sfx/singlebullet1.wav', gain: 0.9 },
  // per-weapon reload (+ generic)
  'reload':         { url: 'assets/sfx/reload.wav',        gain: 0.8 },
  'reload.pistol':  { url: 'assets/sfx/reload_pistol.wav', gain: 0.8 },
  'reload.rifle':   { url: 'assets/sfx/reload_rifle.wav',  gain: 0.8 },
  'reload.shotgun': { url: 'assets/sfx/shotgun_cock.wav',  gain: 0.9 },
  // empty-mag / dry-fire click
  'empty':          { url: 'assets/sfx/empty_click.mp3',   gain: 0.8 },
};

// Decoded AudioBuffers keyed by SAMPLE_MANIFEST key. Missing key => not loaded
// (failed or still loading) => synth fallback. Never throws.
const sampleBuffers = Object.create(null);
let samplesRequested = false; // guard so we only kick the loads off once

// ---- internal helpers ----------------------------------------------------------

// Current audio-clock time, or 0 if we have no context yet. Centralizes the guard.
function now() {
  return ctx ? ctx.currentTime : 0;
}

// True when it's actually safe to make noise. play* functions bail early otherwise
// so they remain no-throw before init/unlock.
function ready() {
  return ctx !== null && master !== null && unlocked && ctx.state === 'running';
}

// Build (once) a 1-second mono white-noise buffer we can reuse for every noisy layer.
function getNoiseBuffer() {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(ctx.sampleRate);
  noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

// Track a source so reset can stop it, and auto-untrack when it ends.
function track(node) {
  activeNodes.add(node);
  node.onended = () => activeNodes.delete(node);
}

// Create a gain node with a fast attack + exponential-ish decay envelope.
// `peak` is the gain at attack, `dur` total length in seconds.
function envGain(start, peak, dur, attack = 0.005) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack);
  // ExponentialRamp can't hit 0, so ramp toward a tiny floor then snap silent.
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  return g;
}

// Spawn a tone (oscillator) with an optional pitch slide. Returns the osc so callers
// can tweak. Auto-connects osc -> gain -> (extra | master) and schedules stop.
function tone(type, freq, slideTo, start, dur, peak, destination = master) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo != null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), start + dur);
  }
  const g = envGain(start, peak, dur);
  osc.connect(g).connect(destination);
  track(osc);
  osc.start(start);
  osc.stop(start + dur + 0.02);
  return osc;
}

// Spawn a filtered burst of white noise. `filterType`/`filterFreq` shape it
// (e.g. bandpass for thuds, highpass for crisp gun snap).
function noise(start, dur, peak, filterType, filterFreq, q = 1, destination = master) {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer();
  // Randomize the read offset a touch so repeated shots don't sound identical.
  src.loop = false;
  const g = envGain(start, peak, dur, 0.002);

  let chainEnd = g;
  if (filterType) {
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, start);
    filter.Q.value = q;
    src.connect(filter).connect(g).connect(destination);
  } else {
    src.connect(g).connect(destination);
  }

  track(src);
  src.start(start);
  src.stop(start + dur + 0.02);
  return src;
}

// ---- sample loading + playback -------------------------------------------------

// Fetch + decode every bundled sample once. Fully non-throwing: any failure leaves
// that key absent from `sampleBuffers`, which transparently selects synth fallback.
// Safe to call before unlock — decodeAudioData works on a suspended context.
function loadSamples() {
  if (samplesRequested || !ctx) return;
  samplesRequested = true;
  for (const key of Object.keys(SAMPLE_MANIFEST)) {
    const entry = SAMPLE_MANIFEST[key];
    // Each load is independent; one 404/decode error never affects the others.
    fetch(entry.url)
      .then((r) => (r && r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((buf) => decodeAudio(buf))
      .then((decoded) => {
        if (decoded) sampleBuffers[key] = decoded;
      })
      .catch(() => {
        /* leave key undefined -> synth fallback; no throw, no 404 crash */
      });
  }
}

// decodeAudioData wrapper that works with both the promise and callback signatures.
function decodeAudio(arrayBuffer) {
  return new Promise((resolve) => {
    try {
      const p = ctx.decodeAudioData(
        arrayBuffer,
        (b) => resolve(b),
        () => resolve(null),
      );
      if (p && typeof p.then === 'function') p.then(resolve).catch(() => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// Resolve a logical sample name to a decoded buffer, trying the given key then any
// provided fallbacks (e.g. 'reload.shotgun' -> 'reload'). Returns null if none ready.
function pickBuffer(...keys) {
  for (const k of keys) {
    if (k && sampleBuffers[k]) return k;
  }
  return null;
}

// Play a decoded buffer through master with an optional gain/pitch/trim. Returns
// true if it actually started (so callers know whether to skip the synth fallback).
function playBuffer(key, { gain = 1, rate = 1 } = {}) {
  const buffer = sampleBuffers[key];
  if (!buffer) return false;
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain * (SAMPLE_MANIFEST[key]?.gain ?? 1);
    src.connect(g).connect(master);
    track(src);
    const start = now();
    src.start(start);
    // Trim noisy multi-shot clips to their first transient when maxDur is set.
    const maxDur = SAMPLE_MANIFEST[key]?.maxDur;
    if (maxDur) src.stop(start + maxDur / Math.max(rate, 0.0001));
    return true;
  } catch {
    return false; // fall back to synth on any playback error
  }
}

// Normalize a weapon name (explicit arg wins; else read the live shared state).
function activeWeapon(name) {
  if (typeof name === 'string' && name) return name;
  try {
    const w = gameState && gameState.weapon && gameState.weapon.active;
    if (typeof w === 'string' && w) return w;
  } catch {
    /* ignore */
  }
  return null;
}

// ---- public API ----------------------------------------------------------------

export function initAudio(state) {
  if (state) gameState = state;
  // Lazily create the context. It may start suspended until unlockAudio().
  if (!ctx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // No WebAudio support — stay fully no-op.
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = masterVolume;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
      return;
    }
  }
  // Begin fetching + decoding the bundled CC0 samples (once). Non-blocking and
  // non-throwing; until they resolve, play* falls back to the synth layer.
  loadSamples();
  // Optional readiness flag for HUD/debug; we do not store nodes on state.
  if (state) state.audioReady = ready();
}

export function unlockAudio() {
  if (!ctx) return;
  const finish = () => {
    unlocked = true;
  };
  // resume() returns a promise on most browsers; guard for older sync versions.
  try {
    const p = ctx.resume();
    if (p && typeof p.then === 'function') p.then(finish).catch(() => {});
    else finish();
  } catch {
    /* no-op — stay silent rather than throw */
  }
  // Mark unlocked optimistically; ready() still double-checks ctx.state==='running'.
  finish();
}

// Fire SFX. Optional explicit weapon name (e.g. 'pistol'); otherwise the active
// weapon is read from the shared state. Plays the matching bundled CC0 sample if
// it has decoded, else the procedural crack below. Synthesized layer unchanged.
export function playShoot(weaponName) {
  if (!ready()) return;
  // 1) bundled sample, per-weapon, with a clean single-shot fallback.
  const w = activeWeapon(weaponName);
  const key = pickBuffer(w && `fire.${w}`, 'fire.single');
  if (key) {
    // Cheaply differentiate the shared single-shot base by weapon if that is what
    // resolved (rifle reads heavier/slower, pistol snappier).
    let rate = 1;
    if (key === 'fire.single') rate = w === 'rifle' ? 0.85 : w === 'pistol' ? 1.15 : 1;
    playBuffer(key, { rate });
    return;
  }
  // 2) procedural fallback (unchanged): punchy crack + short body + sub-thump.
  const t = now();
  noise(t, 0.09, 0.5, 'highpass', 1200, 0.7);
  noise(t, 0.05, 0.35, 'bandpass', 3500, 1.2);
  const o = tone('square', 220, 80, t, 0.08, 0.32);
  o.detune.value = -10;
  tone('sine', 90, 50, t, 0.07, 0.4);
}

// Alias matching the task's requested per-weapon API: audio.playFire('pistol').
export function playFire(weaponName) {
  playShoot(weaponName);
}

// Reload SFX. Optional explicit weapon name; otherwise reads the active weapon.
// Plays the per-weapon bundled CC0 reload sample (with a generic-reload fallback),
// else the procedural click sequence below.
export function playReload(weaponName) {
  if (!ready()) return;
  // 1) bundled sample: per-weapon, then generic reload.
  const w = activeWeapon(weaponName);
  const key = pickBuffer(w && `reload.${w}`, 'reload');
  if (key && playBuffer(key)) return;
  // 2) procedural fallback (unchanged): mag out, mag in, charging handle.
  const t = now();
  const click = (offset, freq, peak) => {
    noise(t + offset, 0.03, peak, 'highpass', freq, 0.8);
    tone('square', freq, freq * 0.6, t + offset, 0.025, peak * 0.5);
  };
  click(0.0, 1800, 0.4);
  click(0.18, 1400, 0.45);
  click(0.5, 2200, 0.5); // crisp final "chk-chk"
}

export function playEnemyHit() {
  if (!ready()) return;
  const t = now();
  // Soft fleshy thud: band-passed noise plus a low dull tone.
  noise(t, 0.08, 0.4, 'bandpass', 500, 1.5);
  tone('sine', 160, 90, t, 0.09, 0.3);
}

export function playEnemyDeath() {
  if (!ready()) return;
  const t = now();
  // Descending growl + a noisy collapse — reads as a kill confirm.
  tone('sawtooth', 300, 70, t, 0.45, 0.35);
  tone('sine', 200, 50, t, 0.4, 0.28);
  noise(t + 0.02, 0.35, 0.3, 'lowpass', 900, 0.7);
}

export function playPlayerHurt() {
  if (!ready()) return;
  const t = now();
  // Low body thump + brief muffled lowpass noise (taking damage feels heavy/dull).
  tone('sine', 120, 55, t, 0.22, 0.5);
  noise(t, 0.18, 0.45, 'lowpass', 600, 0.9);
}

export function playEmpty() {
  if (!ready()) return;
  // 1) bundled dry-click sample.
  if (pickBuffer('empty') && playBuffer('empty')) return;
  // 2) procedural fallback (unchanged): dry mechanical trigger click.
  const t = now();
  noise(t, 0.025, 0.35, 'highpass', 2500, 1.0);
  tone('square', 1600, 1200, t, 0.02, 0.15);
}

export function setMasterVolume(v) {
  masterVolume = Math.min(1, Math.max(0, Number(v) || 0));
  if (master && ctx) {
    // Smooth the change slightly to avoid clicks.
    master.gain.setTargetAtTime(masterVolume, ctx.currentTime, 0.01);
  }
}

export function resetAudio() {
  // Hard-stop any sustained/scheduled nodes still sounding.
  for (const node of activeNodes) {
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
  }
  activeNodes.clear();
}
