// main.js — owner of shared state, the rAF loop, and all cross-module wiring.
//
// This is the ONLY module that imports the others and the ONLY place that:
//   - constructs the shared `state` object (contract §2)
//   - calls each module's update() in the normative order (contract §9.5)
//   - drains state.events and maps them to side effects (contract §9.6)
//   - increments score/kills (single writer)
//   - owns the start/restart flow and pointer-lock UX (contract §9.3/§9.8)
//   - wires the serverless WebRTC LAN multiplayer (net.js) for HOST/CLIENT modes,
//     while leaving the single-player path byte-for-byte unchanged.

import * as THREE from 'three';
import * as scene from './scene.js';
import * as player from './player.js';
import * as weapons from './weapons.js';
import * as enemies from './enemies.js';
import * as pickups from './pickups.js';
import * as hud from './hud.js';
import * as audio from './audio.js';
import * as net from './net.js';

// ---------------------------------------------------------------------------
// 1. Build the shared state object (exact shape of §2; sub-objects pre-allocated).
// ---------------------------------------------------------------------------
const state = {
  THREE,
  renderer: null,
  scene: null,
  camera: null,
  clock: null,

  colliders: [],
  arenaHalf: 0,

  mapId: scene.DEFAULT_MAP_ID, // active map id (host broadcasts; clients load it)

  phase: 'start', // 'start' | 'playing' | 'paused' | 'gameover'
  time: 0,

  player: {
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 100,
    maxHealth: 100,
    alive: true,
    radius: 0.4,
  },

  weapon: {
    name: 'rifle',
    ammoInMag: 30,
    magSize: 30,
    reserveAmmo: 90,
    reloading: false,
    reloadProgress: 0,
    lastShotTime: 0,
    damage: 25,
    headshotMultiplier: 2.0,
  },

  enemies: [],
  wave: 0,
  enemiesRemaining: 0,

  score: 0,
  kills: 0,

  input: {
    forward: false, back: false, left: false, right: false,
    jump: false, reload: false, firing: false,
    pointerLocked: false,
  },

  events: [],

  config: {},
};

// ---------------------------------------------------------------------------
// 2. Inits IN ORDER (scene first).
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game-canvas');

scene.initScene(state, canvas); // defaults to DEFAULT_MAP_ID (warehouse) for SP
player.initPlayer(state);
weapons.initWeapon(state);
enemies.initEnemies(state);
pickups.initPickups(state);
pickups.setSimMode(state, 'sp');
pickups.loadForMap(state, scene.MAPS[state.mapId]);
audio.initAudio(state);
hud.initHUD(state, {
  onStart,
  onRestart,
  // Multiplayer lobby handlers (additive; inert in single-player).
  onHostClick,
  onJoinClick,
  onCreateInvite,
  onAcceptAnswer,
  onSubmitOffer,
  onCopyAnswer,
  onStartMatch,
  onBackToMenu,
  onSelectMap, // host lobby map <select> change
  // Room flow: ACCEPT button per pending joiner (hud.setLobbyPending renders them).
  onAcceptJoiner,
  // Room flow: one-click Copy of the shareable ?room= link.
  onCopyRoomLink,
});

// Populate the lobby map picker once the HUD exists.
hud.setLobbyMaps(scene.getMapList(), state.mapId);

state.clock = new THREE.Clock();

// ===========================================================================
// MULTIPLAYER WIRING
// ===========================================================================

// A short random player name so rosters are distinguishable.
const SELF_NAME = 'P' + Math.floor(Math.random() * 1000);

// ===========================================================================
// ROOM TRANSPORT (Trystero) — frictionless, no-server, no-copy-paste matchmaking
// ===========================================================================
//
// Replaces the manual copy-paste SIGNALING with a ROOM the host shares as a link.
// The other player opens the link, AUTO-CONNECTS via Trystero's free public relays
// (Nostr by default; MQTT/torrent fallbacks), and appears as a PENDING joiner in
// the host's lobby. The host explicitly clicks ACCEPT to admit each one (the
// "secure enough" gate). Game data still flows P2P over WebRTC exactly as before.
//
// This module-internal adapter (`roomNet`) re-implements ONLY the slice of the
// net.js API that main.js consumes, mapping the room's single reliable data
// action onto the same send/broadcast/getRoster contract and reusing the SAME
// {t:...} message envelope and the SAME net.setCallbacks() callbacks. The manual
// net.js path is left untouched as the Advanced/manual fallback.
//
// Trystero is pinned (NOT floating) and loaded lazily from esm.sh. Verified
// against trystero@0.21.8: makeAction(id) returns a TUPLE [send, get] where
// send(data, targetPeerId?) and get((data, peerId) => ...). selfId is the opaque
// per-client id. We layer our existing INT pid model on top (host = pid 0).

const TRYSTERO_APP_ID = 'cod-browser-' + net.PROTO; // namespaces the game on the relays
// Ordered fallback: MQTT + torrent are the DEFAULTS — Trystero's bundled Nostr
// relay list went stale (relay.nostrcity.club / nostr.cool110.xyz are down and
// spam the console), so Nostr is now the last-ditch fallback. Each is a pinned
// esm.sh subpath import.
const TRYSTERO_STRATEGIES = [
  'https://esm.sh/trystero@0.21.8/mqtt',
  'https://esm.sh/trystero@0.21.8/torrent',
  'https://esm.sh/trystero@0.21.8/nostr',
];
// Curated, reachability-tested relay/broker/tracker URLs per strategy (probed
// 2026-05) — override Trystero's stale defaults so connections actually land and
// the dead-relay console noise disappears. Re-probe if connections regress.
const TRYSTERO_RELAYS = {
  mqtt: ['wss://broker.hivemq.com:8884/mqtt'],
  torrent: ['wss://tracker.openwebtorrent.com', 'wss://tracker.btorrent.xyz'],
  nostr: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
};
const ROOM_CONNECT_TIMEOUT_MS = 9000; // per-strategy: no relay/peer handshake -> try next

// Crockford-ish base32 (no ambiguous 0/O/1/I/L) for a short, URL-safe room id.
const ROOM_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
function makeRoomId(len = 7) {
  let out = '';
  try {
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    for (let i = 0; i < len; i++) out += ROOM_ALPHABET[buf[i] % ROOM_ALPHABET.length];
  } catch (_) {
    for (let i = 0; i < len; i++) out += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return out;
}

function roomLinkFor(roomId, strat) {
  let url = location.origin + location.pathname + '?room=' + encodeURIComponent(roomId);
  // Pin the host's chosen strategy so the joiner uses the SAME relay family.
  // Without this, host and client fall through mqtt/torrent/nostr independently
  // and can land on different relays -> they never discover each other (flaky).
  if (strat) url += '&s=' + encodeURIComponent(strat);
  return url;
}

// Read a ?room=<id> from the current URL (query string, parsed with URLSearchParams).
function readRoomFromLocation() {
  try {
    const id = new URLSearchParams(location.search).get('room');
    return id ? id.trim() : null;
  } catch (_) {
    return null;
  }
}

// The room transport. Mirrors the net.js surface main.js touches. When a room
// session is active, `mp` (below) points here instead of at net.js.
const roomNet = (() => {
  let mode = 'sp';           // 'sp' | 'host' | 'client'
  let selfPid = -1;          // 0 on host, assigned int on client, -1 in sp
  let selfName = 'PLAYER';
  let room = null;           // Trystero room
  let sendAction = null;     // (data, targetPeerId?) => ...
  let strategyName = null;
  let roomId = null;
  let cb = {};               // callbacks from main.js (onMessage/onPeerJoin/...)

  // HOST identity maps + admission state.
  const peerToPid = new Map();   // Trystero peerId -> int pid (admitted only)
  const pidToPeer = new Map();   // int pid -> Trystero peerId
  const pending = new Map();     // Trystero peerId -> { peerId, name }
  let nextClientId = 1;

  // CLIENT state.
  let hostPeerId = null;         // Trystero peerId of the host (the only other peer at join)
  let admitted = false;

  // Shared roster + host-published config (welcome payload).
  const roster = new Map();      // pid -> name
  let hostConfig = {};
  let hostTime = 0;

  function setCallbacks(c) { cb = c || {}; }
  function emitErr(err) { if (cb.onError) { try { cb.onError(err); } catch (_) {} } else console.error('[roomNet]', err); }

  function getRoster() {
    const out = [];
    for (const [pid, name] of roster.entries()) out.push({ pid, name });
    out.sort((a, b) => a.pid - b.pid);
    return out;
  }

  function getPending() {
    return [...pending.values()].map((p) => ({ peerId: p.peerId, name: p.name || ('joining…') }));
  }

  function broadcastRoster() {
    if (mode !== 'host') return;
    const players = getRoster();
    rawBroadcast({ t: 'roster', players });
  }

  // --- low-level send via the single reliable action ---
  function rawSendTo(peerId, msg) {
    if (!sendAction || !peerId) return;
    try { sendAction(msg, peerId); } catch (err) { emitErr(err); }
  }
  function rawBroadcast(msg) {
    if (!sendAction) return;
    try { sendAction(msg); } catch (err) { emitErr(err); } // no target => all peers
  }

  // --- incoming routing (mirrors net.js _handleIncoming + _host/_clientHandle) ---
  function onActionData(msg, peerId) {
    if (!msg || typeof msg.t !== 'string') return;

    if (mode === 'host') {
      // GATE: ignore everything from non-admitted peers except their initial hello.
      const pid = peerToPid.get(peerId);
      if (pid === undefined) {
        if (msg.t === 'hello') {
          const rec = pending.get(peerId);
          if (rec) {
            rec.name = (typeof msg.name === 'string' && msg.name) ? msg.name.slice(0, 16) : rec.name;
            refreshPendingUI();
          }
        }
        return; // not admitted -> never reaches game logic
      }
      // Admitted peer.
      if (msg.t === 'bye') { dropPeer(pid); return; }
      if (cb.onMessage) { try { cb.onMessage(pid, msg); } catch (err) { emitErr(err); } }
      return;
    }

    if (mode === 'client') {
      // Only the host matters; ignore anything until admitted (except admit/welcome).
      if (msg.t === 'admit') {
        admitted = true;
        hostPeerId = peerId; // pin the authoritative host peer
        return; // welcome follows and drives onOpen
      }
      if (msg.t === 'denied') {
        if (hud && hud.setLobbyStatus) hud.setLobbyStatus('The host declined your join request.');
        return;
      }
      if (!admitted && msg.t !== 'welcome') return;
      if (msg.t === 'welcome') {
        admitted = true;
        hostPeerId = peerId; // pin the authoritative host peer
        selfPid = msg.pid;
        roster.clear();
        if (Array.isArray(msg.roster)) for (const r of msg.roster) roster.set(r.pid, r.name);
        if (cb.onOpen) { try { cb.onOpen(selfPid); } catch (err) { emitErr(err); } }
      } else if (msg.t === 'roster') {
        if (Array.isArray(msg.players)) { roster.clear(); for (const r of msg.players) roster.set(r.pid, r.name); }
      } else if (msg.t === 'peerLeave') {
        roster.delete(msg.pid);
      }
      if (cb.onMessage) { try { cb.onMessage(0, msg); } catch (err) { emitErr(err); } }
    }
  }

  // HOST: admit a pending peer -> allocate pid, welcome it, fire onPeerJoin.
  function admitPeer(peerId) {
    if (mode !== 'host') return null;
    const rec = pending.get(peerId);
    if (!rec) return null;
    pending.delete(peerId);
    const pid = nextClientId++;
    peerToPid.set(peerId, pid);
    pidToPeer.set(pid, peerId);
    const name = rec.name || ('P' + pid);
    roster.set(pid, name);

    // Tell the joiner it's in, then send the full welcome payload (same shape as net.js).
    rawSendTo(peerId, { t: 'admit', pid });
    rawSendTo(peerId, {
      t: 'welcome', pid, hostName: selfName, config: hostConfig,
      roster: getRoster(), tickRate: net.TICK_RATE, time: hostTime,
    });
    if (cb.onPeerJoin) { try { cb.onPeerJoin(pid, name); } catch (err) { emitErr(err); } }
    broadcastRoster();
    refreshPendingUI();
    return pid;
  }

  function denyPeer(peerId) {
    if (mode !== 'host') return;
    if (!pending.has(peerId)) return;
    pending.delete(peerId);
    rawSendTo(peerId, { t: 'denied' });
    refreshPendingUI();
  }

  function dropPeer(pid) {
    const peerId = pidToPeer.get(pid);
    pidToPeer.delete(pid);
    if (peerId) peerToPid.delete(peerId);
    if (!roster.has(pid)) return;
    roster.delete(pid);
    if (mode === 'host') {
      if (cb.onPeerLeave) { try { cb.onPeerLeave(pid); } catch (err) { emitErr(err); } }
      rawBroadcast({ t: 'peerLeave', pid });
      broadcastRoster();
    }
  }

  // Wire a freshly-joined Trystero room's events + the typed action.
  function wireRoom(r) {
    room = r;
    const action = room.makeAction('g'); // short id; tuple [send, get] in 0.21.x
    sendAction = action[0];
    const getAction = action[1];
    getAction((data, peerId) => onActionData(data, peerId));

    room.onPeerJoin((peerId) => {
      if (mode === 'host') {
        // A link-holder connected. Park as PENDING; do NOT assign pid/roster yet.
        if (!pending.has(peerId) && peerToPid.get(peerId) === undefined) {
          pending.set(peerId, { peerId, name: null });
          refreshPendingUI();
        }
      } else if (mode === 'client') {
        // A peer appeared (normally the host). Say hello so the host can show our
        // name in its pending list. Default hostPeerId to the first peer; it's
        // pinned authoritatively when a welcome/admit actually arrives (onActionData).
        if (!hostPeerId) hostPeerId = peerId;
        rawSendTo(peerId, { t: 'hello', name: selfName.slice(0, 16) });
      }
    });

    room.onPeerLeave((peerId) => {
      if (mode === 'host') {
        if (pending.delete(peerId)) { refreshPendingUI(); return; }
        const pid = peerToPid.get(peerId);
        if (pid !== undefined) dropPeer(pid);
      } else if (mode === 'client') {
        if (peerId === hostPeerId && cb.onClose) { try { cb.onClose(); } catch (_) {} }
      }
    });
  }

  // Lazily import a Trystero strategy, with ordered fallback if no relay handshakes
  // within the timeout. Resolves once joinRoom succeeds for some strategy.
  async function joinWithFallback(rid, only) {
    let lastErr = null;
    // When `only` (a strategy key like 'mqtt') is given — the joiner read it from
    // the host's room link — use ONLY that strategy so both peers share a relay
    // family. Otherwise (host) try the full ordered fallback.
    let urls = TRYSTERO_STRATEGIES;
    if (only) {
      const m = TRYSTERO_STRATEGIES.filter((u) => u.split('/').pop() === only);
      if (m.length) urls = m;
    }
    for (const url of urls) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        if (typeof mod.joinRoom !== 'function') throw new Error('joinRoom missing in ' + url);
        const stratKey = url.split('/').pop();
        const cfg = { appId: TRYSTERO_APP_ID };
        const relays = TRYSTERO_RELAYS[stratKey];
        if (relays && relays.length) cfg.relayUrls = relays;
        const r = mod.joinRoom(cfg, rid);
        // Consider the join "live" as soon as the room object exists (relays are
        // contacted asynchronously). We race a short connection probe: if a peer
        // shows up OR the timeout elapses with the room intact, keep it; only a
        // throw during setup advances to the next strategy.
        strategyName = url.split('/').pop();
        return r;
      } catch (err) {
        lastErr = err;
        // try next strategy
      }
    }
    throw lastErr || new Error('All relay strategies failed');
  }

  return {
    // mode/identity
    getMode() { return mode; },
    getSelfId() { return selfPid; },
    isHost() { return mode === 'host'; },
    isClient() { return mode === 'client'; },
    getRoster,
    getPending,
    getRoomId() { return roomId; },
    getStrategy() { return strategyName; },
    setCallbacks,

    // host-published welcome config
    setHostInfo(config, time) {
      if (config && typeof config === 'object') hostConfig = config;
      if (typeof time === 'number') hostTime = time;
    },

    // ---- session lifecycle ----
    async startHostRoom({ name } = {}) {
      resetSession();
      mode = 'host';
      selfPid = 0;
      selfName = (name || 'HOST').slice(0, 16);
      roster.set(0, selfName);
      roomId = makeRoomId();
      const r = await joinWithFallback(roomId);
      wireRoom(r);
      return { roomId, link: roomLinkFor(roomId, strategyName), strategy: strategyName };
    },

    async startJoinRoom({ name, roomId: rid, strategy } = {}) {
      resetSession();
      mode = 'client';
      selfPid = -1;
      admitted = false;
      selfName = (name || 'PLAYER').slice(0, 16);
      roomId = String(rid || '').trim();
      if (!roomId) throw new Error('Missing room id');
      const r = await joinWithFallback(roomId, strategy);
      wireRoom(r);
      return { roomId, strategy: strategyName };
    },

    admitPeer,
    denyPeer,

    // ---- send API (single reliable action; unreliable variants alias it) ----
    send(pid, msg) { rawSendTo(pidToPeer.get(pid), msg); },
    sendUnreliable(pid, msg) { rawSendTo(pidToPeer.get(pid), msg); },
    broadcast(msg) {
      // Only admitted peers receive game/control traffic.
      if (mode === 'client') { rawSendTo(hostPeerId, msg); return; }
      for (const peerId of pidToPeer.values()) rawSendTo(peerId, msg);
    },
    broadcastUnreliable(msg) {
      if (mode === 'client') { rawSendTo(hostPeerId, msg); return; }
      for (const peerId of pidToPeer.values()) rawSendTo(peerId, msg);
    },
    sendToHost(msg) { rawSendTo(hostPeerId, msg); },
    sendToHostUnreliable(msg) { rawSendTo(hostPeerId, msg); },

    disconnect() {
      if (mode === 'client' && hostPeerId) rawSendTo(hostPeerId, { t: 'bye' });
      try { if (room) room.leave(); } catch (_) {}
      resetSession();
      if (cb.onClose) { try { cb.onClose(); } catch (_) {} }
    },
  };

  function resetSession() {
    try { if (room) room.leave(); } catch (_) {}
    room = null; sendAction = null; strategyName = null; roomId = null;
    peerToPid.clear(); pidToPeer.clear(); pending.clear();
    roster.clear(); nextClientId = 1;
    hostPeerId = null; admitted = false;
    hostConfig = {}; hostTime = 0;
    mode = 'sp'; selfPid = -1;
  }
})();

// `mp` is the ACTIVE transport: the room transport while a room session is live,
// else net.js (manual copy-paste fallback + single-player no-op). All hot-path and
// message-handler code talks to `mp` so the room transport is actually exercised;
// the lobby setup handlers below pick which one to activate.
let mp = net;
function useRoomTransport() { mp = roomNet; }
function useManualTransport() { mp = net; }

// ---- Pending-joiners HUD panel (host-only, room flow) ---------------------
// hud.js owns the pending-joiner UI: hud.setLobbyPending(list) renders each
// connected-but-not-admitted joiner with an ACCEPT button that calls back into
// our onAcceptJoiner(peerId) handler (wired in hud.initHUD). The admitted list
// keeps using hud.setLobbyPlayers(getRoster()) as before. refreshPendingUI()
// just pushes the current pending list into the HUD.
function refreshPendingUI() {
  // Only meaningful for a host in a live room session.
  if (mp !== roomNet || !roomNet.isHost()) {
    hud.setLobbyPending([]);
    return;
  }
  hud.setLobbyPending(roomNet.getPending());
}

function onAcceptJoiner(peerId) {
  if (mp !== roomNet || !roomNet.isHost()) return;
  const pid = roomNet.admitPeer(peerId);
  if (pid != null) {
    hud.setLobbyPlayers(mp.getRoster());
    hud.setLobbyStatus('Player admitted. Press “Start Match” when everyone is in.');
  }
  refreshPendingUI();
}

// Host: one-click Copy of the shareable ?room= link.
function onCopyRoomLink() {
  hud.copyLobbyRoomLink();
}

// Host: latest input received per client pid -> { pos:[x,y,z], yaw, pitch, vel, firing, seq }.
const hostInputs = new Map();

// Host: authoritative per-client gameplay state (closes the "clients immortal"
// gap). pid -> { health, alive, wpn }. Initialized on join, reset in beginRunHost.
const hostPlayers = new Map();

function ensureHostPlayer(pid) {
  let hp = hostPlayers.get(pid);
  if (!hp) {
    hp = { health: state.player.maxHealth, alive: true, wpn: 'rifle' };
    hostPlayers.set(pid, hp);
  }
  return hp;
}

// Host: name per pid for spawning avatars / roster.
function hostNameFor(pid) {
  const r = mp.getRoster().find((x) => x.pid === pid);
  return r ? r.name : ('P' + pid);
}

// Client: 2-deep snapshot buffer for interpolation (latest at index 1).
const snapBuffer = [];

// Client: input throttle.
let lastInputSent = 0;
let inputSeq = 0;

// Host: snapshot accumulator + tick counter.
let snapAccum = 0;
let snapTick = 0;

// Host: guard so the answer-paste auto-detect can't double-fire acceptAnswerCode
// while a previous accept is still in flight.
let _acceptInFlight = false;
// Harness captures: last invite/answer codes produced by the real lobby handlers.
let _lastInviteCode = null;
let _lastAnswerCode = null;
// Harness captures: last room id/link produced by the room flow.
let _lastRoomId = null;
let _lastRoomLink = null;

// Register net callbacks once at boot. The SAME callback contract is registered
// on BOTH transports (manual net.js + room roomNet) so main.js wiring is identical
// regardless of which one `mp` points at.
const _netCallbacks = {
  onMessage: handleNetMessage,
  onPeerJoin,
  onPeerLeave,
  onOpen: onNetOpen,
  onClose: onNetClose,
  onError: (err) => { console.error('[net]', err); hud.setLobbyStatus('Net error: ' + (err && err.message ? err.message : err)); },
};
net.setCallbacks(_netCallbacks);
roomNet.setCallbacks(_netCallbacks);

// Best-effort graceful disconnect on tab close.
window.addEventListener('beforeunload', () => {
  if (mp.getMode() !== 'sp') mp.disconnect();
});

// ---- Lobby handlers (synchronous entry; may await internally) -------------

// Host: create a ROOM and show its one-click shareable link. The other player
// opens the link and auto-connects via Trystero's public relays, then appears as
// a PENDING joiner (host clicks ACCEPT to admit). No code exchange, no server.
async function onHostClick() {
  useRoomTransport();
  hud.setLobbyRole('host');
  hud.setLobbyMaps(scene.getMapList(), state.mapId);
  hud.showScreen(state, 'lobby');
  hud.setLobbyStatus('Creating room…');
  try {
    const { roomId, link, strategy } = await mp.startHostRoom({ name: SELF_NAME });
    _lastRoomId = roomId;
    _lastRoomLink = link; // harness capture (__COD_MP)
    // Publish authoritative config + clock (including the chosen map) for 'welcome'.
    publishHostInfo();
    hud.setLobbyPlayers(mp.getRoster());
    // Fill the dedicated read-only ROOM LINK field (one-click Copy via onCopyRoomLink).
    hud.setLobbyRoomLink(link);
    refreshPendingUI();
    hud.setLobbyStatus('Room ready (' + strategy + '). Copy the link above and send it. '
      + 'When a player connects, click ACCEPT, then “Start Match”.');
  } catch (err) {
    // Relays unreachable (e.g. blocked network) — fall back to the manual flow.
    useManualTransport();
    await net.startHost({ name: SELF_NAME });
    publishHostInfo();
    hud.setLobbyPlayers(net.getRoster());
    hud.setLobbyAdvancedOpen(true);
    hud.setLobbyStatus('Relays unavailable (' + (err && err.message ? err.message : err)
      + '). Use the Advanced manual invite/answer flow below.');
  }
}

// Join: with no room id this just opens the lobby in client role for the manual
// Advanced flow. The room flow is entered via the ?room= auto-join at boot.
function onJoinClick() {
  useManualTransport();
  net.startJoin({ name: SELF_NAME });
  hud.setLobbyRole('client');
  hud.setLobbyStatus('Open the host’s room link to join automatically, or paste an invite link in Advanced below.');
  hud.showScreen(state, 'lobby');
}

// Boot auto-join: the player opened a ?room=<id> link. Connect to the room via
// Trystero and sit PENDING until the host admits us.
async function autoJoinRoom(roomId, strategy) {
  // Read the host's pinned strategy from the link (?s=) if not passed explicitly,
  // BEFORE the boot code strips the query — so the joiner uses the same relay.
  if (!strategy) {
    try { strategy = new URLSearchParams(location.search).get('s') || undefined; } catch (_) { /* ignore */ }
  }
  useRoomTransport();
  hud.setLobbyRole('client');
  hud.showScreen(state, 'lobby');
  hud.setLobbyJoinPhase('connecting');
  hud.setLobbyStatus('Connecting to the host’s room via public relays…');
  try {
    const { strategy: joined } = await mp.startJoinRoom({ name: SELF_NAME, roomId, strategy });
    hud.setLobbyJoinPhase('waiting-accept', 'Connected (' + joined + ') — waiting for the host to accept you…');
    hud.setLobbyStatus('Waiting for the host to accept your join request.');
  } catch (err) {
    hud.setLobbyJoinPhase('error', 'Could not reach the room: ' + (err && err.message ? err.message : err));
    hud.setLobbyStatus('Could not reach the room: ' + (err && err.message ? err.message : err)
      + '. The host can fall back to the Advanced manual invite below.');
  }
}

// Host: produce a short shareable invite LINK (compressed offer in the URL hash).
// Also keeps the manual offer textarea populated so the Advanced flow still works.
async function onCreateInvite() {
  try {
    // Advanced/manual path: ensure the manual net.js transport is the active host.
    if (mp !== net || !net.isHost()) {
      if (mp === roomNet && roomNet.getMode() !== 'sp') roomNet.disconnect();
      useManualTransport();
      await net.startHost({ name: SELF_NAME });
      publishHostInfo();
      hud.setLobbyRole('host');
    }
    hud.setLobbyStatus('Gathering ICE candidates…');
    const { link, code } = await net.createInviteLink();
    _lastInviteCode = code; // harness capture (__COD_MP)
    hud.setLobbyInviteLink(link);   // primary: shareable link
    hud.setLobbyOffer(code);        // keep the manual area populated too
    hud.setLobbyStatus('Link ready — Copy and send it to a player. Paste their answer below when received.');
  } catch (err) {
    hud.setLobbyStatus('Create invite failed: ' + err.message);
  }
}

// Host: accept a returned answer LINK or CODE (iid-routed). The auto-detect in the
// HUD plus the manual "ADD PLAYER" button both call this; the in-flight guard keeps
// a paste burst from firing it twice.
async function onAcceptAnswer() {
  // Prefer the link/code box; fall back to the manual answer textarea (raw blob).
  const linkInput = hud.getLobbyAnswerCodeInput();
  const manualInput = hud.getLobbyOfferInput(); // host role -> pasted answer blob
  const input = linkInput || manualInput;
  if (!input) { hud.setLobbyStatus('Paste the player’s answer link/code first.'); return; }
  if (_acceptInFlight) return;
  _acceptInFlight = true;
  try {
    hud.setLobbyStatus('Connecting…');
    // acceptAnswerCode degrades to the legacy _pending.pop() path for raw blobs
    // that carry no iid, so a manual base64 answer pasted into either box works.
    await net.acceptAnswerCode(input);
    hud.setLobbyStatus('Player connecting…');
  } catch (err) {
    hud.setLobbyStatus('Accept answer failed: ' + err.message);
  } finally {
    _acceptInFlight = false;
  }
}

// Client: consume the host's invite LINK or CODE and produce the answer to send back.
async function onSubmitOffer() {
  // Prefer the link box; fall back to the manual offer-in textarea (raw blob).
  const input = hud.getLobbyJoinLinkInput() || hud.getLobbyOfferInput();
  if (!input) { hud.setLobbyStatus('Paste the host’s invite link first.'); return; }
  try {
    // Advanced/manual path: ensure the manual net.js transport is the active client.
    if (mp !== net || !net.isClient()) {
      if (mp === roomNet && roomNet.getMode() !== 'sp') roomNet.disconnect();
      useManualTransport();
      await net.startJoin({ name: SELF_NAME });
      hud.setLobbyRole('client');
    }
    hud.setLobbyJoinState('Joining…');
    hud.setLobbyStatus('Generating answer (gathering ICE)…');
    const { code, link } = await net.makeAnswerFromCode(input);
    hud.setLobbyAnswerCode(link); // show the full `#a=` link
    hud.setLobbyAnswer(code);     // keep the manual answer area populated too
    hud.setLobbyJoinState('Answer ready — copy it back to the host.');
    hud.setLobbyStatus('Send your answer to the host, then wait for the match to start.');
  } catch (err) {
    hud.setLobbyJoinState('');
    hud.setLobbyStatus('Generate answer failed: ' + err.message);
  }
}

function onCopyAnswer() {
  // hud handles selection/clipboard; nothing required here.
}

// DEV autostart flag: set true by devAutostart() (URL `?dev=1`). Declared up here
// (module scope, before the pointer-lock handler that reads it) so the diagnostic
// run is never auto-paused on an "unlocked" pointer state. Inert when false, so
// the normal single-player + multiplayer flows are completely unaffected.
let _devMode = false;
let _devGod = false; // dev/test: keep player alive (see loop()); never set in normal play

// Page-load auto-join: the friend opened a `#o=` invite link. Enter the join flow,
// auto-create the answer, and surface the `#a=` link to copy back to the host — no
// "Generate answer" click required.
async function autoEnterJoinFromLink(offerCode) {
  useManualTransport();
  net.startJoin({ name: SELF_NAME });
  hud.setLobbyRole('client');
  hud.showScreen(state, 'lobby');
  hud.setLobbyJoinState('Joining…');
  hud.setLobbyStatus('Reading invite and gathering ICE…');
  try {
    const { code, link } = await net.makeAnswerFromCode(offerCode);
    _lastAnswerCode = code; // harness capture (__COD_MP)
    hud.setLobbyAnswerCode(link);   // show full `#a=` link (code is the fallback)
    hud.setLobbyAnswer(code);       // keep the manual answer area populated too
    hud.setLobbyJoinState('Answer ready — copy it back to the host.');
    hud.setLobbyStatus('Send your answer to the host, then wait for the match to start.');
  } catch (err) {
    hud.setLobbyJoinState('');
    hud.setLobbyStatus('Join failed: ' + err.message);
  }
  // Strip '#o=' so a refresh doesn't re-trigger against a now-stale peer.
  try {
    if (history && history.replaceState) {
      history.replaceState(null, '', location.origin + location.pathname + location.search);
    }
  } catch (_) { /* non-fatal */ }
}

function onStartMatch() {
  if (!mp.isHost()) return;
  // Tell every connected client to enter the game together, then start locally.
  // Clients sit in the lobby (see onNetOpen) until they receive this.
  mp.broadcast({ t: 'start' });
  beginRunHost();
}

function onBackToMenu() {
  mp.disconnect();
  useManualTransport(); // back to a clean default transport for the next session
  hud.setLobbyPending([]); // clear any room pending-joiner rows
  scene.clearRemotePlayers(state);
  hostInputs.clear();
  hostPlayers.clear();
  snapBuffer.length = 0;
  enemies.setSimMode(state, 'sp');
  pickups.setSimMode(state, 'sp');
  weapons.setAuthoritative(state, true);
  state.phase = 'start';
  if (document.exitPointerLock) document.exitPointerLock();
  hud.showScreen(state, 'start');
}

// Host lobby map selection. Loads the map locally, re-arms pickups for it,
// republishes the welcome config (so late joiners get it), and broadcasts a
// reliable 'map' message so already-connected clients re-sync mid-lobby.
function onSelectMap(mapId) {
  if (!scene.MAPS[mapId]) return;
  state.mapId = mapId;
  // Apply locally so the host previews the chosen map.
  scene.loadMap(state, mapId);
  pickups.loadForMap(state, scene.MAPS[mapId]);
  hud.setLobbyMaps(scene.getMapList(), mapId);
  if (mp.isHost()) {
    publishHostInfo();
    mp.broadcast({ t: 'map', mapId });
  }
}

// Publish authoritative config + clock for the 'welcome' payload (now carries
// the chosen mapId so clients load the right map before the first snapshot).
function publishHostInfo() {
  mp.setHostInfo({
    ARENA_HALF: scene.ARENA_HALF,
    PLAYER_EYE_HEIGHT: scene.PLAYER_EYE_HEIGHT,
    GRAVITY: scene.GRAVITY,
    PLAYER_SPEED: scene.PLAYER_SPEED,
    PLAYER_JUMP_SPEED: scene.PLAYER_JUMP_SPEED,
    PLAYER_MAX_HEALTH: scene.PLAYER_MAX_HEALTH,
    mapId: state.mapId,
  }, state.time);
}

// ---- Peer callbacks --------------------------------------------------------

function onPeerJoin(pid, name) {
  // Host: a client connected & said hello. Spawn its avatar so the host sees it.
  scene.spawnRemotePlayer(state, pid, name);
  hud.setLobbyPlayers(mp.getRoster());
  if (mp.isHost()) {
    ensureHostPlayer(pid);
    if (state.phase === 'playing') {
      // Late-joiner during a live match — give it an input slot and tell it to
      // start immediately (idempotent: already-playing clients ignore 'start').
      if (!hostInputs.has(pid)) hostInputs.set(pid, null);
      mp.broadcast({ t: 'start' });
    } else {
      // Still in the lobby — prompt the host to begin once players have joined.
      hud.setLobbyStatus('Player connected! Press “Start Match” when everyone is in.');
    }
  }
}

function onPeerLeave(pid) {
  scene.removeRemotePlayer(state, pid);
  hostInputs.delete(pid);
  hostPlayers.delete(pid);
  hud.setLobbyPlayers(mp.getRoster());
}

function onNetOpen(pid) {
  // Client: 'welcome' arrived; pid is our assigned selfId. Do NOT start the game
  // yet — wait in the lobby until the host presses Start Match and broadcasts
  // {t:'start'} (handled in handleClientMessage). This makes the host's explicit
  // Start authoritative for everyone, and a late-joiner gets {t:'start'} on join.
  if (mp.isClient()) {
    // Room flow: the dedicated phase block goes to its 'accepted' (spinner-off) state.
    // Manual flow: the join-state line shows the same message.
    if (mp === roomNet) hud.setLobbyJoinPhase('accepted');
    hud.setLobbyJoinState('✅ Connected — waiting for the host to start the match…');
    hud.setLobbyStatus('Connected to host. The match begins when the host presses “Start Match”.');
    hud.setLobbyPlayers(mp.getRoster());
  }
}

function onNetClose() {
  // Connection lost. Drop back to the menu cleanly.
  useManualTransport(); // reset to the default transport for the next session
  hud.setLobbyPending([]); // clear any room pending-joiner rows
  scene.clearRemotePlayers(state);
  hostInputs.clear();
  hostPlayers.clear();
  snapBuffer.length = 0;
  enemies.setSimMode(state, 'sp');
  pickups.setSimMode(state, 'sp');
  weapons.setAuthoritative(state, true);
  if (state.phase === 'playing' || state.phase === 'paused') {
    state.phase = 'start';
    if (document.exitPointerLock) document.exitPointerLock();
    hud.showScreen(state, 'start');
    hud.setLobbyStatus('Disconnected.');
  }
}

// ---------------------------------------------------------------------------
// 3. Start / restart / mode-specific begin functions.
// ---------------------------------------------------------------------------
function beginRun() {
  // Single-player (mode 'sp'): unchanged behavior + pickups.
  audio.unlockAudio();
  scene.loadMap(state, state.mapId);
  player.resetPlayer(state);
  weapons.resetWeapon(state);
  enemies.resetEnemies(state);
  enemies.setSimMode(state, 'sp');
  pickups.setSimMode(state, 'sp');
  pickups.loadForMap(state, scene.MAPS[state.mapId]);
  pickups.resetPickups(state);
  weapons.setAuthoritative(state, true);
  state.score = 0;
  state.kills = 0;
  state.time = 0;
  state.phase = 'playing';
  hud.showScreen(state, 'game');
  if (canvas.requestPointerLock) canvas.requestPointerLock();
}

function beginRunHost() {
  // Same authoritative reset as SP, plus net wiring.
  audio.unlockAudio();
  scene.loadMap(state, state.mapId); // honor the lobby map choice on (re)start
  player.resetPlayer(state);
  weapons.resetWeapon(state);
  enemies.resetEnemies(state);
  enemies.setSimMode(state, 'host');
  pickups.setSimMode(state, 'host');
  pickups.loadForMap(state, scene.MAPS[state.mapId]);
  pickups.resetPickups(state);
  weapons.setAuthoritative(state, true);
  state.score = 0;
  state.kills = 0;
  state.time = 0;
  state.phase = 'playing';
  snapAccum = 0;
  snapTick = 0;
  // Make sure every already-connected client has an input slot + authoritative
  // health record (real, not the old immortal placeholder).
  hostPlayers.clear();
  for (const r of mp.getRoster()) {
    if (r.pid !== 0 && !hostInputs.has(r.pid)) hostInputs.set(r.pid, null);
    if (r.pid !== 0) ensureHostPlayer(r.pid);
  }
  hud.showScreen(state, 'game');
  if (canvas.requestPointerLock) canvas.requestPointerLock();
}

function beginRunClient() {
  // Reset only LOCAL player/weapon. Enemies/score/wave come from snapshots.
  audio.unlockAudio();
  // Apply host config if present (incl. the chosen map) BEFORE the first snapshot.
  const cfg = clientConfig;
  if (cfg && cfg.mapId && scene.MAPS[cfg.mapId]) {
    state.mapId = cfg.mapId;
  }
  scene.loadMap(state, state.mapId);
  player.resetPlayer(state);
  weapons.resetWeapon(state);
  enemies.setSimMode(state, 'client');
  pickups.setSimMode(state, 'client');
  pickups.loadForMap(state, scene.MAPS[state.mapId]);
  pickups.resetPickups(state);
  weapons.setAuthoritative(state, false);
  if (cfg && typeof cfg.PLAYER_MAX_HEALTH === 'number') {
    state.player.maxHealth = cfg.PLAYER_MAX_HEALTH;
    state.player.health = cfg.PLAYER_MAX_HEALTH;
  }
  state.time = 0;
  state.phase = 'playing';
  hud.showScreen(state, 'game');
  if (canvas.requestPointerLock) canvas.requestPointerLock();
  hud.setLobbyStatus('Connected — waiting for first snapshot…');
}

let clientConfig = null;

function onStart() {
  if (state.phase === 'paused') {
    state.phase = 'playing';
    hud.showScreen(state, 'game');
    if (canvas.requestPointerLock) canvas.requestPointerLock();
    audio.unlockAudio();
    return;
  }
  // Single-player: honor the start-screen map picker.
  const picked = hud.getSelectedMap ? hud.getSelectedMap() : null;
  if (picked && scene.MAPS[picked]) state.mapId = picked;
  beginRun();
}

function onRestart() {
  // In multiplayer, restart drops back to the menu (host owns the run).
  if (mp.getMode() !== 'sp') {
    onBackToMenu();
    return;
  }
  beginRun();
}

// ---------------------------------------------------------------------------
// 4. Resize.
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => scene.onResize(state));

// ---------------------------------------------------------------------------
// Pointer-lock loss pauses ONLY in single-player. In multiplayer the world is
// host-driven and must keep running, so we don't freeze the loop on unlock.
// ---------------------------------------------------------------------------
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (_devMode) {
    // DEV autostart: there's no user gesture to acquire the lock, so never
    // freeze the diagnostic run on an "unlocked" state.
    return;
  }
  if (mp.getMode() !== 'sp') {
    // MP: never auto-pause the authoritative/networked loop.
    return;
  }
  if (!locked && state.phase === 'playing') {
    state.phase = 'paused';
    hud.showPause(state, true);
  } else if (locked && state.phase === 'paused') {
    state.phase = 'playing';
    hud.showPause(state, false);
  }
});

// ===========================================================================
// NET MESSAGE HANDLER — the ONLY net-aware game logic.
// ===========================================================================

const _ray = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();

function handleNetMessage(pid, msg) {
  if (mp.isHost()) {
    handleHostMessage(pid, msg);
  } else if (mp.isClient()) {
    handleClientMessage(msg);
  }
}

function handleHostMessage(pid, msg) {
  switch (msg.t) {
    case 'hello':
      // net.js already handled roster/welcome/onPeerJoin. Ensure avatar exists.
      scene.spawnRemotePlayer(state, pid, (msg.name || hostNameFor(pid)));
      if (!hostInputs.has(pid)) hostInputs.set(pid, null);
      ensureHostPlayer(pid);
      break;

    case 'in': {
      const prev = hostInputs.get(pid);
      if (prev && typeof prev.seq === 'number' && typeof msg.seq === 'number' && msg.seq <= prev.seq) {
        break; // stale/out-of-order
      }
      hostInputs.set(pid, msg);
      // Feed the avatar immediately so the host sees the remote move smoothly.
      if (Array.isArray(msg.pos)) {
        scene.updateRemotePlayer(state, pid, msg.pos, msg.yaw || 0, true);
      }
      break;
    }

    case 'fire': {
      // Authoritative raycast against enemies (mirrors weapons.fire logic).
      // Multi-ray (shotgun) shots carry msg.rays; legacy single-ray shots carry
      // msg.origin/msg.dir. The shooter's weapon picks the damage table.
      hostResolveFire(pid, msg);
      break;
    }

    case 'wswitch': {
      // Client told us its new active weapon. Store for remote rendering + the
      // per-shooter damage lookup in hostResolveFire.
      if (typeof msg.name === 'string' && weapons.WEAPONS[msg.name]) {
        ensureHostPlayer(pid).wpn = msg.name;
      }
      break;
    }

    case 'bye':
      // net.js treats as leave; onPeerLeave handles cleanup.
      break;

    default:
      break;
  }
}

function hostResolveFire(pid, msg) {
  // Resolve every pellet of the shot with the SHOOTER's weapon stats. Shotgun
  // shots carry msg.rays (an array of {origin,dir}); rifle/pistol shots carry the
  // legacy flat msg.origin/msg.dir (treated as a single ray).
  const rays = (Array.isArray(msg.rays) && msg.rays.length)
    ? msg.rays
    : [{ origin: msg.origin, dir: msg.dir }];

  // Pick the weapon definition for this shooter. Prefer the weapon named in the
  // message, fall back to the host's stored value for the client, default rifle.
  const hp = hostPlayers.get(pid);
  const wpnName =
    (typeof msg.weapon === 'string' && weapons.WEAPONS[msg.weapon]) ? msg.weapon
    : (hp && hp.wpn && weapons.WEAPONS[hp.wpn]) ? hp.wpn
    : 'rifle';
  const def = weapons.WEAPONS[wpnName];

  const targets = enemies.getEnemyMeshes(state);

  for (const ray of rays) {
    const origin = ray.origin;
    const dir = ray.dir;
    if (!Array.isArray(origin) || !Array.isArray(dir)) continue;

    if (targets.length) {
      _rayOrigin.set(origin[0], origin[1], origin[2]);
      _rayDir.set(dir[0], dir[1], dir[2]).normalize();
      _ray.set(_rayOrigin, _rayDir);
      _ray.far = def.range;
      const hits = _ray.intersectObjects(targets, true);
      if (hits.length) {
        const hit = hits[0];
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
        if (enemyId !== undefined && enemyId !== null) {
          const headThreshold = (typeof headY === 'number' ? headY : 1.6) - 0.18;
          const headshot = hit.point.y >= headThreshold;
          const damage = def.damage * (headshot ? def.headshotMultiplier : 1);
          // applyDamage pushes enemyHit/enemyDeath/waveCleared events as usual.
          enemies.applyDamage(state, enemyId, damage, hit.point);
          state.events.push({ type: 'enemyHit', enemyId, damage, headshot });
          mp.broadcast({
            t: 'hit', shooterPid: pid, enemyId, headshot,
            point: [hit.point.x, hit.point.y, hit.point.z],
          });
        }
      }
    }

    // Everyone draws the tracer per ray (clients ignore self-echo).
    scene.spawnTracer(state, origin, dir);
  }

  // Re-broadcast the shot so other clients render the shooter's tracers.
  mp.broadcast({ t: 'fire', pid, weapon: wpnName, rays, time: state.time });
}

function handleClientMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      clientConfig = msg.config || null;
      // Seed roster avatars for everyone except self.
      if (Array.isArray(msg.roster)) {
        for (const r of msg.roster) {
          if (r.pid !== mp.getSelfId()) scene.spawnRemotePlayer(state, r.pid, r.name);
        }
      }
      // We now WAIT in the lobby (see onNetOpen); the game begins on 'start'.
      break;

    case 'start':
      // Host pressed Start Match (or we're a late joiner into a live match).
      // Enter the game once; ignore duplicate 'start' messages.
      if (mp.isClient() && state.phase !== 'playing') beginRunClient();
      break;

    case 'roster': {
      const players = Array.isArray(msg.players) ? msg.players : [];
      const keep = new Set();
      for (const r of players) {
        if (r.pid === mp.getSelfId()) continue;
        keep.add(r.pid);
        scene.spawnRemotePlayer(state, r.pid, r.name); // idempotent
      }
      // Remove avatars no longer in the roster.
      for (const r of mp.getRoster()) {
        if (r.pid !== mp.getSelfId() && !keep.has(r.pid)) {
          scene.removeRemotePlayer(state, r.pid);
        }
      }
      hud.setLobbyPlayers(mp.getRoster());
      break;
    }

    case 'snap':
      applySnapshot(msg);
      break;

    case 'fire':
      if (msg.pid !== mp.getSelfId()) {
        // Draw a tracer per ray (shotgun = many); support legacy origin/dir.
        if (Array.isArray(msg.rays) && msg.rays.length) {
          for (const r of msg.rays) scene.spawnTracer(state, r.origin, r.dir);
        } else if (msg.origin && msg.dir) {
          scene.spawnTracer(state, msg.origin, msg.dir);
        }
      }
      break;

    case 'hit':
      // Cosmetic only in v1.
      break;

    case 'map':
      // Host changed the lobby map. Re-sync our world + pickup geography.
      if (scene.MAPS[msg.mapId]) {
        state.mapId = msg.mapId;
        scene.loadMap(state, msg.mapId);
        pickups.loadForMap(state, scene.MAPS[msg.mapId]);
        hud.setLobbyMaps(scene.getMapList(), msg.mapId);
      }
      break;

    case 'grant':
      // Host applied a pickup to us. Mirror the grant effect locally (the host is
      // authoritative over WHEN; we only get the effect).
      if (msg.pid === mp.getSelfId()) {
        applyGrant(msg.kind, msg.wn, msg.ammo);
      }
      break;

    case 'hurt':
      if (msg.pid === mp.getSelfId()) {
        player.applyNetHealth(state, msg.health);
        state.events.push({ type: 'playerHurt' });
      }
      break;

    case 'dead':
      if (msg.pid === mp.getSelfId()) {
        state.player.alive = false;
        state.phase = 'gameover';
        if (document.exitPointerLock) document.exitPointerLock();
        hud.setGameOverStats(state);
        hud.showScreen(state, 'gameover');
      }
      break;

    case 'peerLeave':
      scene.removeRemotePlayer(state, msg.pid);
      hud.setLobbyPlayers(mp.getRoster());
      break;

    default:
      break;
  }
}

function applySnapshot(snap) {
  // Buffer for interpolation (keep the two most recent).
  snapBuffer.push({ time: performance.now() / 1000, snap });
  while (snapBuffer.length > 2) snapBuffer.shift();

  // HUD-bound shared run stats.
  if (typeof snap.wave === 'number') state.wave = snap.wave;
  if (typeof snap.enemiesRemaining === 'number') state.enemiesRemaining = snap.enemiesRemaining;
  if (typeof snap.score === 'number') state.score = snap.score;
  if (typeof snap.kills === 'number') state.kills = snap.kills;

  // Own player health from the snapshot.
  const selfId = mp.getSelfId();
  if (Array.isArray(snap.players)) {
    for (const p of snap.players) {
      if (p.pid === selfId) {
        if (typeof p.health === 'number') player.applyNetHealth(state, p.health);
      } else {
        scene.updateRemotePlayer(state, p.pid, p.pos, p.yaw || 0, p.alive !== false, p.wpn);
      }
    }
  }

  // Reconcile pickup meshes from the authoritative list (pure visual).
  pickups.applyPickupSnapshot(state, snap.pickups || []);

  // Hand enemies to the client-apply path. We stamp samples with the current
  // state.time so interpolation (which also uses state.time) stays in one clock.
  // interpolateEnemies runs every frame from the loop.
  enemies.applyEnemySnapshot(state, snap.enemies || [], state.time);
}

// ---------------------------------------------------------------------------
// 6. Event dispatch — the ONE place side effects + score/kills happen.
// ---------------------------------------------------------------------------
function handleEvent(e) {
  const mode = mp.getMode();

  switch (e.type) {
    case 'shoot':
      audio.playShoot();
      break;
    case 'reloadStart':
      audio.playReload();
      break;
    case 'reloadEnd':
      break;
    case 'emptyClick':
      audio.playEmpty();
      break;
    case 'enemyHit':
      audio.playEnemyHit();
      break;
    case 'enemyDeath':
      audio.playEnemyDeath();
      // Host & SP own scoring. On a client these never fire (no local sim).
      if (mode !== 'client') {
        state.score += e.scoreValue;
        state.kills += 1;
      }
      break;
    case 'playerHurt':
      audio.playPlayerHurt();
      break;
    case 'playerDead':
      // Host & SP local death. (Client death arrives as a 'dead' message.)
      state.phase = 'gameover';
      if (document.exitPointerLock) document.exitPointerLock();
      hud.setGameOverStats(state);
      hud.showScreen(state, 'gameover');
      break;
    case 'waveStart':
    case 'waveCleared':
      break;
    case 'localFire': {
      // The local player's own shot. Forward to the net layer. Carry the weapon
      // name + all pellet rays (shotgun = many) so the host resolves per-weapon
      // per-pellet damage. Keep the legacy flat origin/dir on the wire too.
      const rays = (Array.isArray(e.rays) && e.rays.length)
        ? e.rays
        : [{ origin: e.origin, dir: e.dir }];
      if (mode === 'host') {
        // Host's own shot already applied damage in weapons.fire(); just share it.
        mp.broadcast({ t: 'fire', pid: 0, weapon: e.weapon, rays, time: state.time });
        for (const r of rays) scene.spawnTracer(state, r.origin, r.dir);
      } else if (mode === 'client') {
        mp.sendToHost({ t: 'fire', pid: mp.getSelfId(), weapon: e.weapon, rays, time: state.time });
        for (const r of rays) scene.spawnTracer(state, r.origin, r.dir); // immediate local feedback
      }
      // mode 'sp': inert (no net), tracer not used in SP.
      break;
    }
    case 'weaponSwitch':
      // Audible switch + tell the host so it can render our gun + bill our shots
      // with the right weapon.
      audio.playReload(); // reuse the chunky reload click as a switch cue
      if (mode === 'client') {
        mp.sendToHost({ t: 'wswitch', name: e.name });
      }
      // SP / host: nothing to send (host reads its own state.weapon.active).
      break;
    case 'pickup':
      // A pickup was consumed (host/SP authoritative). Apply the grant to the
      // correct owner. pid 0 == host/SP local player.
      handlePickup(e);
      break;
    default:
      break;
  }
}

// Apply a pickup grant to a player. On host/SP for the local player (pid 0) we
// mutate directly; for a remote client (pid != 0) the host sends a reliable
// 'grant' so that client applies its own reserve/weapon.
function handlePickup(e) {
  const mode = mp.getMode();
  const payload = e.payload || {};
  if (e.pid === 0) {
    // Local player (SP host, or the host's own pickup).
    applyGrant(e.kind, payload.weaponName, payload.ammo);
    hud.showPickup({
      kind: e.kind, weaponName: payload.weaponName, ammo: payload.ammo,
    });
  } else if (mode === 'host') {
    // A client picked it up — send the effect to that client only.
    mp.send(e.pid, {
      t: 'grant', pid: e.pid, kind: e.kind,
      wn: payload.weaponName || null, ammo: payload.ammo || 0,
    });
  }
}

// Mirror a pickup grant onto the LOCAL inventory via the weapons single-owner API.
function applyGrant(kind, weaponName, ammo) {
  if (kind === 'weapon') {
    if (weaponName) weapons.giveWeapon(state, weaponName);
  } else {
    weapons.addReserve(state, ammo || 0, weaponName || null);
  }
}

// ---------------------------------------------------------------------------
// 5. The main loop, branched by net mode.
// ---------------------------------------------------------------------------
function loop() {
  requestAnimationFrame(loop);

  const raw = state.clock.getDelta();
  const dt = Math.min(raw, 0.05);
  if (state.phase === 'playing') state.time += dt;

  // Dev/test god-mode: keep the local player topped up so the automated harness
  // can screenshot a living scene instead of the death screen. Inert in normal
  // play (only enabled by ?dev autostart or window.__COD_DEBUG.god(true)).
  if (_devGod && state.player) state.player.health = state.player.maxHealth;

  const prevH = state.player ? state.player.health : 0;
  const mode = mp.getMode();

  if (mode === 'host') {
    loopHost(dt);
  } else if (mode === 'client') {
    loopClient(dt);
  } else {
    loopSinglePlayer(dt);
  }

  // Blood-on-glass: flash the damage overlay whenever the player's health dropped
  // this frame (covers SP, host, and client snapshot-driven damage uniformly).
  if (state.player && state.player.health < prevH - 0.01) {
    hud.showDamage(prevH - state.player.health);
  }
}

function loopSinglePlayer(dt) {
  player.update(state, dt);
  weapons.update(state, dt);
  enemies.update(state, dt);
  pickups.update(state, dt); // host-authoritative sim; in SP that's local
  hud.update(state, dt);

  for (let i = 0; i < state.events.length; i++) handleEvent(state.events[i]);
  state.events.length = 0;

  scene.render(state);
}

function loopHost(dt) {
  // 1. Host's own (authoritative) player.
  player.update(state, dt);

  // 2. Feed each client's latest input into its avatar (visual on the host).
  for (const [pid, inp] of hostInputs) {
    if (inp && Array.isArray(inp.pos)) {
      const hp = hostPlayers.get(pid);
      scene.updateRemotePlayer(state, pid, inp.pos, inp.yaw || 0, hp ? hp.alive : true, hp ? hp.wpn : undefined);
    }
  }

  // 3. Authoritative weapon (host raycast hits are real).
  weapons.update(state, dt);

  // 4. Authoritative enemy sim.
  enemies.update(state, dt);

  // 4b. Host-authoritative pickups. Feed each client's last-known position so
  //     client-vs-pickup contact is resolved host-side, then tick the sim.
  pickups.setRemotePositions(buildRemotePositions());
  pickups.update(state, dt);

  // 4c. Host-side enemy melee against CLIENTS. enemies.js only damages the host's
  //     local player (state.player); we close the "clients immortal" gap by
  //     applying proximity melee to each client's authoritative health here.
  hostDamageClients(dt);

  // 5. Smooth remote avatars + tracers. Remote samples are stamped with
  //    state.time inside scene.updateRemotePlayer, so interpolate one buffer
  //    behind in the same clock.
  scene.updateTracers(state, dt);
  scene.interpolateRemotePlayers(state, state.time - net.INTERP_DELAY);

  // 6. HUD.
  hud.update(state, dt);

  // 7. Drain events (handleEvent layers in MP broadcasts for localFire etc.).
  for (let i = 0; i < state.events.length; i++) handleEvent(state.events[i]);
  state.events.length = 0;

  // 8. Snapshot broadcast at TICK_RATE.
  snapAccum += dt;
  const tickDt = 1 / net.TICK_RATE;
  if (snapAccum >= tickDt) {
    snapAccum -= tickDt;
    broadcastSnapshot();
  }

  // 9. Render.
  scene.render(state);
}

function loopClient(dt) {
  // 1. Local prediction of own movement (cosmetic/responsive).
  player.update(state, dt);

  // 2. Throttled input to host.
  const now = performance.now();
  if (now - lastInputSent >= 1000 / net.INPUT_HZ) {
    lastInputSent = now;
    const ns = player.getNetState(state);
    mp.sendToHost({
      t: 'in', seq: ++inputSeq,
      pos: ns.pos, yaw: ns.yaw, pitch: ns.pitch, vel: ns.vel, firing: ns.firing,
    });
  }

  // 3. Local weapon feel (non-authoritative; skips applyDamage).
  weapons.update(state, dt);

  // 4. Apply/interpolate host world. Snapshots applied on arrival (applySnapshot);
  //    interpolate one INTERP_DELAY behind, in the same state.time clock used to
  //    stamp both enemy and remote-player samples.
  const renderTime = state.time - net.INTERP_DELAY;
  enemies.interpolateEnemies(state, renderTime);
  scene.interpolateRemotePlayers(state, renderTime);
  scene.updateTracers(state, dt);
  pickups.animatePickups(dt); // bob/spin the snapshot-reconciled pickup meshes

  // 5. HUD (health/score/wave already set by applySnapshot).
  hud.update(state, dt);

  // 6. Drain events: localFire -> sendToHost; suppress host-only side effects.
  for (let i = 0; i < state.events.length; i++) handleEvent(state.events[i]);
  state.events.length = 0;

  // 7. Render.
  scene.render(state);
}

// Host: build a Map pid -> [x,y,z] of each connected client's last-known
// position (from its latest input) for pickup contact + melee resolution.
function buildRemotePositions() {
  const map = new Map();
  for (const [pid, inp] of hostInputs) {
    if (inp && Array.isArray(inp.pos)) map.set(pid, inp.pos);
  }
  return map;
}

// Mirror of enemies.js melee tuning (enemies.js doesn't export these and only
// hurts the host's local player; we apply the same rules to clients here).
const CLIENT_ATTACK_RANGE = 1.6;
const CLIENT_ENEMY_DAMAGE = 10;
const CLIENT_ATTACK_COOLDOWN = 1.0;

// Host-side: damage each client whose authoritative position is within an
// enemy's melee range, on a per-client cooldown. Crossing 0 marks them dead and
// broadcasts the reliable 'dead'; every hit broadcasts the reliable 'hurt'.
const _toClient = new THREE.Vector3();
function hostDamageClients(dt) {
  if (state.phase !== 'playing') return;
  for (const [pid, inp] of hostInputs) {
    if (!inp || !Array.isArray(inp.pos)) continue;
    const hp = ensureHostPlayer(pid);
    if (!hp.alive) continue;
    if (state.time - (hp.lastHurt || 0) < CLIENT_ATTACK_COOLDOWN) continue;

    // Is any live enemy within melee range of this client?
    let inMelee = false;
    for (const e of state.enemies) {
      if (!e.alive || e.state === 'dying') continue;
      _toClient.set(inp.pos[0] - e.position.x, 0, inp.pos[2] - e.position.z);
      if (_toClient.lengthSq() <= CLIENT_ATTACK_RANGE * CLIENT_ATTACK_RANGE) {
        inMelee = true;
        break;
      }
    }
    if (!inMelee) continue;

    hp.lastHurt = state.time;
    hp.health = Math.max(0, hp.health - CLIENT_ENEMY_DAMAGE);
    mp.send(pid, { t: 'hurt', pid, health: hp.health });
    if (hp.health <= 0 && hp.alive) {
      hp.alive = false;
      mp.send(pid, { t: 'dead', pid });
    }
  }
}

function broadcastSnapshot() {
  // Players: host (pid 0) from local state, plus each connected client from its
  // input + its REAL authoritative health/alive (closes the immortal-client gap).
  const players = [];
  const hostNs = player.getNetState(state);
  players.push({
    pid: 0, pos: hostNs.pos, yaw: hostNs.yaw, pitch: hostNs.pitch,
    health: state.player.health, alive: state.player.alive,
    wpn: weapons.getActiveWeapon(state),
  });
  for (const [pid, inp] of hostInputs) {
    if (!inp || !Array.isArray(inp.pos)) continue;
    const hp = ensureHostPlayer(pid);
    players.push({
      pid, pos: inp.pos, yaw: inp.yaw || 0, pitch: inp.pitch || 0,
      health: hp.health, alive: hp.alive, wpn: hp.wpn,
    });
  }

  // Enemies from authoritative state.
  const enemyList = [];
  for (const e of state.enemies) {
    enemyList.push({
      id: e.id,
      pos: [e.position.x, e.position.y, e.position.z],
      yaw: e.mesh ? e.mesh.rotation.y : 0,
      state: e.state,
      hp: e.health,
      max: e.maxHealth,
    });
  }

  mp.broadcastUnreliable({
    t: 'snap',
    tick: ++snapTick,
    time: state.time,
    players,
    enemies: enemyList,
    pickups: pickups.getActiveForSnapshot(state),
    wave: state.wave,
    enemiesRemaining: state.enemiesRemaining,
    score: state.score,
    kills: state.kills,
  });
}

// ===========================================================================
// DEV AUTOSTART HOOK — automated visual verification (no normal-path impact).
// ===========================================================================
// When the URL carries `?dev=1`, skip the lobby + pointer-lock gate and jump
// straight into a single-player run on a chosen map, with a chosen weapon
// equipped, a few enemies spawned directly in front of the camera, AND one ammo
// + one weapon pickup placed just ahead of the player, then render continuously.
// This exists so an automated screenshot tool can capture the gun + arms/hands +
// enemies + pickups + environment in one frame. It is purely additive: with no
// `?dev=1` param the boot path below is byte-for-byte the original behavior, and
// the WebRTC multiplayer + normal single-player flows are completely untouched.
//
//   ?dev=1                         -> autostart SP (default map warehouse)
//   ?dev=1&map=desert              -> map ∈ {warehouse, desert, night_city}
//   ?dev=1&weapon=shotgun          -> weapon ∈ {pistol, rifle, shotgun}
//
// We deliberately reuse the public, already-tested module APIs (beginRun /
// scene.spawnPoints / enemies.devSpawn -> the real spawnEnemy lifecycle /
// weapons.giveWeapon+switchWeapon) rather than reaching into private sim
// internals, so dev mode can't drift from real gameplay.

function readDevParams() {
  let qs;
  try {
    qs = new URLSearchParams(location.search);
  } catch (_) {
    return null;
  }
  if (qs.get('dev') !== '1') return null;

  const rawMap = (qs.get('map') || '').trim();
  const map = scene.MAPS[rawMap] ? rawMap : scene.DEFAULT_MAP_ID;

  const rawWpn = (qs.get('weapon') || '').trim();
  const weapon = weapons.WEAPONS[rawWpn] ? rawWpn : 'rifle';

  let count = parseInt(qs.get('enemies') || '', 10);
  if (!Number.isFinite(count) || count < 0) count = 3;
  count = Math.min(count, 12);

  return { map, weapon, count };
}

// Build a single enemy directly in front of the camera by routing through the
// REAL spawn lifecycle. enemies.devSpawn() is a thin exported wrapper over the
// (private) spawnEnemy(), so the dev path gets the exact same record shape, id
// allocation (via enemies.js's own _nextId — no private counter here), scene.add,
// userData tagging, AND the converging skeleton-upgrade sweep arming that wave
// spawns get. Because the record lives in state.enemies with the canonical
// userData.upgraded/variantIndex/variantKind, the upgrade sweep can reach it and
// the harness can verify real skeletons on the dev path. The old hand-rolled
// off-list record duplicated spawnEnemy and used a private high id base; routing
// removes that drift entirely. A specific numeric variantIndex still forces a
// deterministic skeleton variant (or VARIANT_IMP for the imp) via buildEnemyMesh.
let _devDummyPid = 900000; // high base for diagnostic remote-avatar pids (no collision)
function devSpawnEnemyAt(px, pz, yawTowardCam, variantIndex) {
  // wave=1 matches the dev-frame intent (speed/health/score = wave 1). spawnEnemy
  // jitters the spawn slightly around the point; pass the exact point and accept
  // the small jitter (the screenshot frame is forgiving and enemies are frozen).
  const point = new THREE.Vector3(px, 0, pz);
  const enemy = enemies.devSpawn(state, point, 1, variantIndex);
  // Face the spawned enemy back toward the camera for the screenshot. spawnEnemy
  // leaves rotation at 0 until the AI faces the player; set it explicitly here so
  // the frozen dev enemies present their front (+Z / face) to the camera.
  if (enemy && enemy.mesh) enemy.mesh.rotation.y = yawTowardCam;
  return enemy;
}

function devAutostart(params) {
  _devMode = true;
  _devGod = true; // survive the spawned enemies so the harness screenshots a live scene

  // Choose the map, then run the standard SP begin (full reset + loadMap +
  // pickups + render setup). requestPointerLock() inside beginRun() will fail
  // silently without a user gesture; that's fine — _devMode keeps us from
  // pausing, and the run renders regardless of lock state.
  state.mapId = params.map;
  beginRun();
  // Dev/test: disable wave auto-spawns. We place a fixed, FROZEN set of enemies at
  // a clear distance below, so the harness camera is never buried inside a chasing
  // enemy (that was the "two glowing orbs" — an enemy's eyes filling the view).
  // setAutoWaves(false) is the real guard: the dev set is placed asynchronously
  // (behind whenEnemiesReady()), and during that window state.enemies is briefly
  // empty, which previously let the wave system fire wave 1 and trickle extra
  // chasing skeletons into the frame. Disabling auto-waves keeps the dev set at
  // exactly the placed count. Fall back gracefully on older modules.
  state.enemiesRemaining = 0;
  if (typeof enemies.setAutoWaves === 'function') enemies.setAutoWaves(false);

  // Equip the requested weapon: own it (shotgun is locked by default), give it a
  // little reserve, then make it active so the correct viewmodel is visible.
  weapons.giveWeapon(state, params.weapon);
  weapons.addReserve(state, 90, params.weapon);
  weapons.switchWeapon(state, params.weapon);

  // Aim the camera at the arena center so the spawned enemies (placed in front)
  // are framed dead-ahead for the screenshot. yaw 0 looks toward -Z in this
  // project's convention; we place enemies along -Z accordingly.
  state.player.yaw = 0;
  state.player.pitch = -0.12; // tilt slightly down so ground + enemies + gun all frame

  // Drop one AMMO pickup and one WEAPON pickup directly in front of the camera
  // (just ahead of the spawned enemies along -Z, offset left/right) so a single
  // screenshot verifies pickups + hands + gun together. We re-run the public
  // pickups.loadForMap() with a SHALLOW-CLONED map def whose pickupPads is the
  // real pad set PLUS these two dev pads — so the normal SP spawn/contact/bob
  // loop drives them exactly like map pads (collectible, animated, snapshot-safe)
  // and the real map def is never mutated. Pad fmt: [x, z, kind, optionalArg].
  try {
    const baseDef = scene.MAPS[state.mapId] || {};
    const basePads = Array.isArray(baseDef.pickupPads) ? baseDef.pickupPads : [];
    const pxd = state.player.position.x;
    const pzd = state.player.position.z;
    const devPads = [
      [pxd - 3.0, pzd - 5.0, 'ammo'],            // ammo pickup, front-left, mid-distance
      [pxd + 3.0, pzd - 5.0, 'weapon', 'shotgun'], // weapon pickup, front-right
    ];
    const devMapDef = { ...baseDef, pickupPads: basePads.concat(devPads) };
    pickups.loadForMap(state, devMapDef);
    pickups.resetPickups(state);
  } catch (_) { /* non-fatal: dev pickups are diagnostic only */ }

  // Spawn a few enemies fanned out in front of the camera (-Z), facing back at
  // it. They sit ~6–9 m ahead so the gun viewmodel and the enemies both fit.
  // The actual spawn is deferred behind enemies.whenEnemiesReady() (when present)
  // so the CC0 variant templates are preloaded and every dev enemy upgrades to a
  // real skeleton in ONE converging sweep pass — making the skeleton check
  // deterministic for the harness instead of racing a cold GLB parse.
  const px0 = state.player.position.x;
  const pz0 = state.player.position.z;
  const n = Math.max(1, params.count);

  // Cycle the variant assignment so the dev set shows the full spread the real
  // waves produce: the 4 skeleton variants PLUS the red imp as a minority. The
  // imp variant key is exported by enemies.js; fall back to plain skeleton
  // indices if it isn't present (older module).
  const devOrder = (enemies.VARIANT_IMP !== undefined)
    ? [0, 1, 2, 3, enemies.VARIANT_IMP]
    : [0, 1, 2, 3];
  const placeDevEnemies = () => {
    for (let i = 0; i < n; i++) {
      const spread = (n === 1) ? 0 : (i / (n - 1) - 0.5); // -0.5..0.5
      const ex = px0 + spread * 6.0;
      const ez = pz0 - (8.0 + Math.abs(spread) * 2.0); // ~8-9 m ahead, clear of the camera
      const variant = devOrder[i % devOrder.length];
      devSpawnEnemyAt(ex, ez, 0, variant); // yaw 0 => their +Z (front) faces the camera at +Z
    }
    // Freeze the placed enemies so they hold position for the screenshot (speed 0
    // stops them chasing into the camera; god-mode also keeps the player alive).
    for (const e of state.enemies) e.speed = 0;
  };

  // Prefer the readiness hook if enemies.js exposes one; otherwise spawn now and
  // rely on buildEnemyMesh's own upgrade kickoff + the per-spawn sweep. Either way
  // the records are registered in state.enemies so the upgrade path can reach them.
  // Signal harness readiness. Set ONLY after the dev enemies are placed AND their
  // async skeleton upgrades have converged, so a verifier that snapshots on
  // __COD_DEV_READY sees "skeletons = N of N" deterministically instead of racing
  // the SkeletonUtils.clone() microtasks. Falls back to signaling right after
  // placement when the upgrade-readiness hook isn't present (older module).
  const signalReady = () => {
    try { window.__COD_DEV_READY = { map: params.map, weapon: params.weapon, enemies: n, pickups: true }; } catch (_) {}
  };
  const afterPlacement = () => {
    placeDevEnemies();
    // Re-freeze in case the sweep/swap touched the records between spawn + now.
    for (const e of state.enemies) e.speed = 0;
    if (typeof enemies.whenEnemiesUpgraded === 'function') {
      enemies.whenEnemiesUpgraded(state).then(() => {
        for (const e of state.enemies) e.speed = 0; // re-freeze post-upgrade
        signalReady();
      }).catch(signalReady);
    } else {
      signalReady();
    }
  };

  if (typeof enemies.whenEnemiesReady === 'function') {
    enemies.whenEnemiesReady().then(afterPlacement).catch(() => { placeDevEnemies(); signalReady(); });
  } else {
    afterPlacement();
  }
}

// ---------------------------------------------------------------------------
// 7. Initial screen + kick off the loop.
// ---------------------------------------------------------------------------
// If this page was opened from a shareable invite link (`<origin><path>#o=<code>`),
// auto-enter the join/answer flow so the friend just copies the answer back. The
// hash is read AFTER HUD init so the lobby is ready to render the answer code.
const _devParams = readDevParams();
const _offerCode = net.readOfferFromLocation();
const _roomIdFromLink = readRoomFromLocation();
if (_devParams) {
  // Diagnostic autostart wins over everything (it implies a fresh SP session).
  devAutostart(_devParams);
} else if (_roomIdFromLink) {
  // The page was opened from a shareable ROOM link (`<origin><path>?room=<id>`):
  // auto-connect to the room and sit PENDING until the host admits us.
  autoJoinRoom(_roomIdFromLink);
  // Strip `?room=` so a refresh doesn't re-trigger against a stale session
  // (same technique the `#o=` flow uses after reading the hash).
  try {
    if (history && history.replaceState) {
      history.replaceState(null, '', location.origin + location.pathname);
    }
  } catch (_) { /* non-fatal */ }
} else if (_offerCode) {
  autoEnterJoinFromLink(_offerCode);
} else {
  hud.showScreen(state, 'start');
}

// Test/diagnostic introspection hook for the automated harness. Read-only except
// god(), which only matters when the dev autostart is active. Safe to expose:
// it reflects existing state and changes nothing in normal play.
try {
  window.__COD_DEBUG = {
    god(on = true) { _devGod = !!on; },
    snapshot() {
      const p = state.player || {};
      const en = (state.enemies || []).map((e) => {
        const ud = (e.mesh && e.mesh.userData) || {};
        // variantKind is stamped by enemies.js ('skeleton' | 'imp'); fall back to
        // inferring from the upgrade flag so the harness gets a usable label even
        // before that field exists. 'skeleton' is reported as a GLB-upgraded enemy;
        // a procedural imp is upgraded:true but is NOT a skeleton, so we key the
        // boolean off variantKind when present to avoid mislabeling the imp.
        const kind = (typeof ud.variantKind === 'string')
          ? ud.variantKind
          : (ud.upgraded ? 'skeleton' : 'procedural');
        return {
          id: e.id, alive: e.alive,
          kind,
          variantKind: kind,
          // Skeleton == a real GLB-upgraded skeleton variant (not the procedural imp).
          skeleton: (typeof ud.variantKind === 'string')
            ? (ud.variantKind === 'skeleton' && !!ud.upgraded)
            : !!ud.upgraded,
          upgraded: !!ud.upgraded,
          visible: !!(e.mesh && e.mesh.visible),
          x: e.position ? +e.position.x.toFixed(2) : null,
          z: e.position ? +e.position.z.toFixed(2) : null,
        };
      });
      const pk = (state.pickups || []).map((q) => ({
        kind: q.kind, active: !!q.active,
        visible: !!(q.mesh && q.mesh.visible),
        x: q.mesh ? +q.mesh.position.x.toFixed(2) : null,
        y: q.mesh ? +q.mesh.position.y.toFixed(2) : null,
        z: q.mesh ? +q.mesh.position.z.toFixed(2) : null,
      }));
      return {
        phase: state.phase, mode: mp.getMode(), mapId: state.mapId,
        weapon: state.weapon ? state.weapon.name : null,
        player: { x: +(p.position?.x ?? 0).toFixed(2), y: +(p.position?.y ?? 0).toFixed(2), z: +(p.position?.z ?? 0).toFixed(2), yaw: p.yaw, health: p.health, maxHealth: p.maxHealth },
        enemies: { total: en.length, skeletons: en.filter((e) => e.skeleton).length, list: en },
        pickups: { total: pk.length, active: pk.filter((q) => q.active).length, visible: pk.filter((q) => q.visible).length, list: pk },
      };
    },
    // Dump the actual scene-graph of enemy i: every node's type, visibility,
    // material color, and geometry size. Reveals whether the rendered geometry is
    // a swapped skeleton GLB (many SkinnedMeshes, high vert count) or the red
    // procedural fallback — i.e. ground truth vs the upgraded flag.
    enemyMeshInfo(i = 0) {
      const e = (state.enemies || [])[i];
      if (!e || !e.mesh) return null;
      const nodes = [];
      e.mesh.traverse((o) => {
        let color = null, mat = null, verts = null;
        if (o.material) { mat = o.material.type; if (o.material.color) color = '#' + o.material.color.getHexString(); }
        if (o.geometry && o.geometry.attributes && o.geometry.attributes.position) verts = o.geometry.attributes.position.count;
        nodes.push({ name: o.name || '(unnamed)', type: o.type, skinned: !!o.isSkinnedMesh, mesh: !!o.isMesh, visible: o.visible, mat, color, verts });
      });
      const meshes = nodes.filter((n) => n.mesh);
      return {
        id: e.id, upgraded: !!e.mesh.userData.upgraded, variantKind: e.mesh.userData.variantKind || null,
        totalNodes: nodes.length, meshCount: meshes.length, skinnedCount: meshes.filter((m) => m.skinned).length,
        totalVerts: meshes.reduce((a, m) => a + (m.verts || 0), 0),
        nodes: nodes.slice(0, 40),
      };
    },
    // Teleport the local player (diagnostic framing only).
    teleport(x, z) { if (state.player) { state.player.position.x = x; state.player.position.z = z; } },
    // Trigger the blood-on-glass overlay (diagnostic — enemies are frozen in dev).
    hurt(amount = 35) { try { hud.showDamage(amount); } catch (_) {} },
    // Aim the camera at a world point (for framing pickups/enemies in screenshots).
    look(x, z) {
      if (!state.player) return;
      const dx = x - state.player.position.x, dz = z - state.player.position.z;
      state.player.yaw = Math.atan2(dx, -dz); // project convention: yaw 0 looks -Z
      state.player.pitch = 0;
    },
    // Spawn ONE remote-player avatar at (x,z) via the real scene path so the
    // harness can screenshot the player avatar without a live WebRTC peer. Reuses
    // scene.spawnRemotePlayer + scene.updateRemotePlayer (the exact functions the
    // host uses for connected clients) so the avatar looks identical to a real
    // remote player. Returns the synthetic pid used, or null if unavailable.
    // Purely diagnostic: it adds a cosmetic avatar mesh and changes no game state.
    spawnDummyRemote(x = 0, z = -6) {
      try {
        if (typeof scene.spawnRemotePlayer !== 'function') return null;
        // High synthetic pid that won't collide with real client pids.
        const pid = _devDummyPid++;
        scene.spawnRemotePlayer(state, pid, 'DUMMY');
        // Place + face it toward the camera (yaw points back along +Z to -Z origin).
        if (typeof scene.updateRemotePlayer === 'function') {
          scene.updateRemotePlayer(state, pid, [x, 0, z], 0, true);
        }
        return pid;
      } catch (_) {
        return null;
      }
    },
  };
} catch (_) { /* non-browser env */ }

// Multiplayer test hook: drives the REAL lobby handlers so a two-window harness
// can exercise the full host->invite->join->answer->Start path deterministically.
try {
  window.__COD_MP = {
    // ROOM flow (primary): host creates a room + link; the other side auto-joins
    // by opening the link (autoJoinRoom), then the host admits pending joiners.
    hostClick: async () => { await onHostClick(); return _lastRoomLink; },
    getRoomLink: () => _lastRoomLink,
    getRoomId: () => _lastRoomId,
    joinRoom: async (roomId) => { await autoJoinRoom(roomId || _lastRoomId); },
    pending: () => (mp === roomNet && mp.getPending ? mp.getPending() : []),
    admit: (peerId) => onAcceptJoiner(peerId),
    admitFirst: () => {
      const list = (mp === roomNet && mp.getPending) ? mp.getPending() : [];
      return list.length ? onAcceptJoiner(list[0].peerId) : null;
    },
    strategy: () => (mp === roomNet && mp.getStrategy ? mp.getStrategy() : null),
    // Manual copy-paste flow (Advanced fallback) — preserved unchanged.
    createInvite: async () => { await onCreateInvite(); return _lastInviteCode; },
    joinFromLink: async (offerCode) => { await autoEnterJoinFromLink(offerCode); return _lastAnswerCode; },
    getInvite: () => _lastInviteCode,
    getAnswer: () => _lastAnswerCode,
    acceptAnswer: async (ans) => { await net.acceptAnswerCode(ans); },
    startMatch: () => onStartMatch(),
    phase: () => state.phase,
    mode: () => mp.getMode(),
    roster: () => mp.getRoster().length,
  };
} catch (_) { /* non-browser env */ }

loop();
