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

// A registry of currently-sounding source nodes so resetAudio() can hard-stop them.
const activeNodes = new Set();

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

// ---- public API ----------------------------------------------------------------

export function initAudio(state) {
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

export function playShoot() {
  if (!ready()) return;
  const t = now();
  // Punchy rifle crack: a bright noise snap + a short square "body" that drops fast.
  noise(t, 0.09, 0.5, 'highpass', 1200, 0.7);
  noise(t, 0.05, 0.35, 'bandpass', 3500, 1.2);
  const o = tone('square', 220, 80, t, 0.08, 0.32);
  o.detune.value = -10;
  // Tiny sub-thump to give the shot weight.
  tone('sine', 90, 50, t, 0.07, 0.4);
}

export function playReload() {
  if (!ready()) return;
  const t = now();
  // Mechanical click sequence: mag out, mag in, charging handle — three sharp ticks.
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
  const t = now();
  // Dry mechanical click — trigger pull on an empty mag.
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
