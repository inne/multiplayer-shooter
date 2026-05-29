// net.js — Serverless WebRTC LAN multiplayer transport for cod-browser ("wd1").
//
// Pure ESM. Imports NOTHING from sibling modules and never touches THREE or the
// scene. It is a dumb transport + manual (non-trickle) signaling layer + roster
// keeper. All game knowledge lives in main.js, which wires callbacks here.
//
// HARD CONSTRAINTS honored:
//   - WebRTC only (RTCPeerConnection + RTCDataChannel). No backend, no STUN/TURN.
//   - LAN-only: RTCPeerConnection is constructed with config {} (NO iceServers).
//   - Manual signaling: non-trickle ICE. We wait for iceGatheringState==='complete'
//     before emitting ONE base64(JSON(sdp)) blob for copy/paste.
//   - Host-authoritative star topology: host opens one RTCPeerConnection per client,
//     two channels each ("wd1" unreliable, "wd1c" reliable).

// ============================================================================
// Exported constants
// ============================================================================

export const PROTO = 'wd1';
export const TICK_RATE = 20;        // host snapshot Hz
export const INTERP_DELAY = 0.10;   // seconds (client interpolation buffer)
export const INPUT_HZ = 30;         // client input cap

// Data channel labels / options.
const CH_UNRELIABLE = 'wd1';        // snapshots + input (latest-wins)
const CH_RELIABLE = 'wd1c';         // control/events (must not be lost)
const RTC_CONFIG = {};              // NO iceServers per LAN-only constraint.
const UNRELIABLE_OPTS = { ordered: false, maxRetransmits: 0 };
const RELIABLE_OPTS = { ordered: true };

// Message types that ride the unreliable channel; everything else is reliable.
const UNRELIABLE_TYPES = { in: true, snap: true };

// ============================================================================
// Module state
// ============================================================================

let _mode = 'sp';       // 'sp' | 'host' | 'client'
let _selfId = -1;       // 0 on host, assigned int on client, -1 in sp
let _selfName = 'PLAYER';

// callbacks registered by main.js
let _cb = {
  onMessage: null,
  onPeerJoin: null,
  onPeerLeave: null,
  onOpen: null,
  onClose: null,
  onError: null,
};

// Peer record shape:
//   { pid, name, pc, reliable, unreliable, open, hello, isPending }
// On the HOST, _peers is keyed by clientId (>=1); pending offers (awaiting an
// answer) are parked in _pending (keyed by a temporary negative-free int).
// On the CLIENT there is exactly one peer record for the host (pid 0).
const _peers = new Map();   // pid -> peer record
const _pending = [];        // host: peer records awaiting their answer (FIFO/most-recent)
const _pendingByIid = new Map(); // host: iid -> pending peer record (precise link router)

let _nextClientId = 1;      // host: stable client id allocator
let _pendingSeq = 0;        // host: temp id allocator for pending offers

// ============================================================================
// Mode / identity accessors
// ============================================================================

export function getMode() { return _mode; }
export function getSelfId() { return _selfId; }
export function isHost() { return _mode === 'host'; }
export function isClient() { return _mode === 'client'; }

export function setCallbacks(cb) {
  _cb = Object.assign({
    onMessage: null,
    onPeerJoin: null,
    onPeerLeave: null,
    onOpen: null,
    onClose: null,
    onError: null,
  }, cb || {});
}

// ============================================================================
// Internal helpers
// ============================================================================

function _emitError(err) {
  if (_cb.onError) {
    try { _cb.onError(err); } catch (_) { /* swallow */ }
  } else {
    // eslint-disable-next-line no-console
    console.error('[net]', err);
  }
}

// base64( JSON( obj ) ) — UTF-8 safe.
function _encodeBlob(obj) {
  const json = JSON.stringify(obj);
  // encodeURIComponent + unescape trick gives a binary string from UTF-8.
  const bin = unescape(encodeURIComponent(json));
  return btoa(bin);
}

function _decodeBlob(blob) {
  const bin = atob(String(blob).trim());
  const json = decodeURIComponent(escape(bin));
  return JSON.parse(json);
}

// ----------------------------------------------------------------------------
// Compression helpers (CompressionStream 'deflate-raw' + base64url, fallback).
// These power the SHAREABLE JOIN LINK flow: an SDP envelope (or any small JSON
// object) is shrunk into a single URL-hash-safe token.
// ----------------------------------------------------------------------------

// Uint8Array -> base64url string (no padding, +/ -> -/_).
function _bytesToB64url(u8) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// base64url string -> Uint8Array.
function _b64urlToBytes(str) {
  let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  // Restore '=' padding to a multiple of 4.
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Read all bytes from a ReadableStream of Uint8Array chunks.
async function _readAllBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Deflate (raw) a Uint8Array via the native CompressionStream.
async function _deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(u8);
  writer.close();
  return _readAllBytes(cs.readable);
}

// Inflate (raw) a Uint8Array via the native DecompressionStream.
async function _inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(u8);
  writer.close();
  return _readAllBytes(ds.readable);
}

// Pack a small JSON-able object into a single URL-hash-safe token.
//   'C' prefix => deflate-raw + base64url ; 'P' prefix => plain base64url(JSON).
export async function packCode(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') {
    const deflated = await _deflateRaw(bytes);
    return 'C' + _bytesToB64url(deflated);
  }
  return 'P' + _bytesToB64url(bytes);
}

// Reverse packCode(): decode a token back into the original object.
export async function unpackCode(code) {
  const s = String(code).trim();
  const prefix = s.charAt(0);
  const body = s.slice(1);
  if (prefix === 'C') {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This link needs a browser with DecompressionStream support');
    }
    const bytes = _b64urlToBytes(body);
    const inflated = await _inflateRaw(bytes);
    const json = new TextDecoder().decode(inflated);
    return JSON.parse(json);
  }
  if (prefix === 'P') {
    const bytes = _b64urlToBytes(body);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }
  throw new Error('Unrecognized code format');
}

// Short invite id (host): used to route a returned answer to the EXACT pending
// RTCPeerConnection that produced its offer (fixes the _pending.pop() misroute).
function _nextIid() {
  return (Date.now() % 1e6).toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

// ----------------------------------------------------------------------------
// URL-hash parsing helpers for the link flow.
// ----------------------------------------------------------------------------

// Extract a named token (e.g. 'o' or 'a') from a full URL, a bare hash, or a
// raw code. Returns the token string, or null if not present.
function _parseHashToken(urlOrHash, key) {
  if (urlOrHash == null) return null;
  const s = String(urlOrHash).trim();
  if (!s) return null;
  // Bare code: no '#' and no '=' => treat the whole thing as the code.
  if (s.indexOf('#') === -1 && s.indexOf('=') === -1) return s;
  // Pull out the hash portion (everything after the first '#').
  const hashIdx = s.indexOf('#');
  const hash = hashIdx === -1 ? s : s.slice(hashIdx + 1);
  // Hash params look like 'o=...&x=...'; split on '&'.
  const parts = hash.split('&');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === key) {
      return part.slice(eq + 1) || null;
    }
  }
  return null;
}

// Wait until ICE gathering on a peer connection has fully completed (non-trickle).
function _awaitIceComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', check);
      clearInterval(poll);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Some browsers don't reliably fire the event; poll as a fallback. Also a
    // null end-of-candidates event signals completion.
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) done();
    });
    const poll = setInterval(check, 100);
  });
}

// Build an offer/answer copy-paste blob from a local description.
function _descBlob(role, desc) {
  return _encodeBlob({
    v: PROTO,
    role,
    sdp: { type: desc.type, sdp: desc.sdp },
  });
}

// Decide which channel a message should travel on, by its `t` field.
function _channelFor(peer, msg) {
  const unreliable = msg && UNRELIABLE_TYPES[msg.t];
  return unreliable ? peer.unreliable : peer.reliable;
}

function _rawSend(peer, msg) {
  if (!peer) return;
  const ch = _channelFor(peer, msg);
  if (ch && ch.readyState === 'open') {
    try {
      ch.send(JSON.stringify(msg));
    } catch (err) {
      _emitError(err);
    }
  }
}

// Both data channels open?
function _bothOpen(peer) {
  return peer.reliable && peer.unreliable &&
    peer.reliable.readyState === 'open' &&
    peer.unreliable.readyState === 'open';
}

function _handleIncoming(peer, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    _emitError(err);
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;

  // Roster / lifecycle bookkeeping that net.js owns directly.
  if (_mode === 'host') {
    _hostHandle(peer, msg);
  } else if (_mode === 'client') {
    _clientHandle(peer, msg);
  }

  // Forward everything to main.js. pid is the sender: on the client, the host
  // is pid 0; on the host it's the client's assigned pid.
  if (_cb.onMessage) {
    const senderPid = (_mode === 'client') ? 0 : peer.pid;
    try { _cb.onMessage(senderPid, msg); } catch (err) { _emitError(err); }
  }
}

// ---- HOST: react to control messages we own ----
function _hostHandle(peer, msg) {
  if (msg.t === 'hello') {
    if (!peer.hello) {
      peer.hello = true;
      peer.name = (typeof msg.name === 'string' && msg.name) ? msg.name.slice(0, 16) : ('P' + peer.pid);
      _hostFinalizeJoin(peer);
    }
  } else if (msg.t === 'bye') {
    _dropPeer(peer.pid, true);
  }
}

// ---- CLIENT: react to control messages we own ----
function _clientHandle(peer, msg) {
  if (msg.t === 'welcome') {
    _selfId = msg.pid;
    // Seed roster (host included as pid 0).
    _roster.clear();
    if (Array.isArray(msg.roster)) {
      for (const r of msg.roster) _roster.set(r.pid, r.name);
    }
    if (_cb.onOpen) {
      try { _cb.onOpen(_selfId); } catch (err) { _emitError(err); }
    }
  } else if (msg.t === 'roster') {
    if (Array.isArray(msg.players)) {
      _roster.clear();
      for (const r of msg.players) _roster.set(r.pid, r.name);
    }
  } else if (msg.t === 'peerLeave') {
    _roster.delete(msg.pid);
  }
}

// Host: once a pending peer's channels are open AND it has said hello, it's a
// real player. Send welcome, fire onPeerJoin, broadcast the new roster.
function _hostFinalizeJoin(peer) {
  if (peer.welcomed || !peer.hello || !_bothOpen(peer)) return;
  peer.welcomed = true;

  _roster.set(peer.pid, peer.name);

  // welcome (reliable, to this client only)
  _rawSend(peer, {
    t: 'welcome',
    pid: peer.pid,
    hostName: _selfName,
    config: _hostConfig,
    roster: getRoster(),
    tickRate: TICK_RATE,
    time: _hostTime,
  });

  if (_cb.onPeerJoin) {
    try { _cb.onPeerJoin(peer.pid, peer.name); } catch (err) { _emitError(err); }
  }

  // broadcast roster to everyone
  _broadcastRoster();
}

function _broadcastRoster() {
  const players = getRoster();
  for (const peer of _peers.values()) {
    if (peer.welcomed) _rawSend(peer, { t: 'roster', players });
  }
}

// Roster: pid -> name. Includes self (host=0). Maintained on both sides.
const _roster = new Map();

// Host-published authoritative config + clock, set via setHostInfo (optional).
let _hostConfig = {};
let _hostTime = 0;

// Optional hook for main.js to keep the welcome payload current. Not part of the
// strict contract API surface but harmless/no-import; safe additive helper.
export function setHostInfo(config, time) {
  if (config && typeof config === 'object') _hostConfig = config;
  if (typeof time === 'number') _hostTime = time;
}

// ============================================================================
// Peer wiring
// ============================================================================

function _wireChannel(peer, ch) {
  if (ch.label === CH_UNRELIABLE) peer.unreliable = ch;
  else if (ch.label === CH_RELIABLE) peer.reliable = ch;

  ch.onopen = () => {
    if (_bothOpen(peer) && !peer.open) {
      peer.open = true;
      if (_cb.onOpen && _mode === 'host') {
        try { _cb.onOpen(peer.pid); } catch (err) { _emitError(err); }
      }
    }
    // Client: announce ourselves once both channels are up.
    if (_mode === 'client' && _bothOpen(peer) && !peer.helloSent) {
      peer.helloSent = true;
      _rawSend(peer, { t: 'hello', name: _selfName.slice(0, 16) });
    }
    // Host: if this client already said hello, finalize now.
    if (_mode === 'host') _hostFinalizeJoin(peer);
  };

  ch.onmessage = (e) => _handleIncoming(peer, e.data);

  ch.onclose = () => {
    if (_mode === 'host') {
      _dropPeer(peer.pid, false);
    } else if (_mode === 'client') {
      // Lost the host.
      if (_cb.onClose) {
        try { _cb.onClose(); } catch (err) { _emitError(err); }
      }
    }
  };

  ch.onerror = (e) => _emitError((e && e.error) || e);
}

function _wirePeerConnection(peer) {
  const pc = peer.pc;
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (_mode === 'host') _dropPeer(peer.pid, false);
      else if (_mode === 'client' && _cb.onClose) {
        try { _cb.onClose(); } catch (err) { _emitError(err); }
      }
    }
  };
  // Client side: the host is the channel creator, so we receive channels here.
  pc.ondatachannel = (e) => _wireChannel(peer, e.channel);
}

function _dropPeer(pid, graceful) {
  const peer = _peers.get(pid);
  if (!peer) return;
  _peers.delete(pid);
  _roster.delete(pid);
  try { if (peer.reliable) peer.reliable.close(); } catch (_) {}
  try { if (peer.unreliable) peer.unreliable.close(); } catch (_) {}
  try { peer.pc.close(); } catch (_) {}

  if (_mode === 'host') {
    if (peer.welcomed) {
      if (_cb.onPeerLeave) {
        try { _cb.onPeerLeave(pid); } catch (err) { _emitError(err); }
      }
      // Tell remaining clients.
      for (const p of _peers.values()) {
        if (p.welcomed) _rawSend(p, { t: 'peerLeave', pid });
      }
      _broadcastRoster();
    }
  }
}

// ============================================================================
// HOST API
// ============================================================================

export async function startHost({ name } = {}) {
  _resetSession();
  _mode = 'host';
  _selfId = 0;
  _selfName = (name || 'HOST').slice(0, 16);
  _roster.set(0, _selfName);
  // No connection until createInvite() is called.
}

export async function createInvite() {
  if (_mode !== 'host') throw new Error('createInvite() requires host mode');

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const pendingId = -(++_pendingSeq); // temporary marker (negative, never collides)
  const iid = _nextIid();
  const peer = {
    pid: null,
    pendingId,
    iid,
    name: null,
    pc,
    reliable: null,
    unreliable: null,
    open: false,
    hello: false,
    welcomed: false,
    helloSent: false,
    isPending: true,
  };

  _wirePeerConnection(peer);

  // HOST creates BOTH channels.
  const unreliable = pc.createDataChannel(CH_UNRELIABLE, UNRELIABLE_OPTS);
  const reliable = pc.createDataChannel(CH_RELIABLE, RELIABLE_OPTS);
  _wireChannel(peer, unreliable);
  _wireChannel(peer, reliable);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await _awaitIceComplete(pc);

  _pending.push(peer);
  _pendingByIid.set(iid, peer); // precise router for the LINK flow

  return {
    id: pendingId,
    iid,
    blob: _descBlob('offer', pc.localDescription),
  };
}

// HOST: create a frictionless shareable join LINK. Reuses createInvite()'s exact
// PC setup (single code path) and wraps the result into a compressed `#o=` code.
export async function createInviteLink({ baseUrl } = {}) {
  if (_mode !== 'host') throw new Error('createInviteLink() requires host mode');
  const { iid } = await createInvite();
  const peer = _pendingByIid.get(iid);
  const desc = peer.pc.localDescription;
  const code = await packCode({
    v: PROTO,
    role: 'offer',
    iid,
    sdp: { type: desc.type, sdp: desc.sdp },
  });
  const base = baseUrl || (location.origin + location.pathname);
  return { iid, code, link: `${base}#o=${code}` };
}

export async function acceptAnswer(blob) {
  if (_mode !== 'host') throw new Error('acceptAnswer() requires host mode');

  let parsed;
  try {
    parsed = _decodeBlob(blob);
  } catch (err) {
    throw new Error('Invalid answer blob: not base64 JSON');
  }
  if (!parsed || parsed.v !== PROTO) throw new Error('Bad blob version (expected ' + PROTO + ')');
  if (parsed.role !== 'answer' || !parsed.sdp || parsed.sdp.type !== 'answer') {
    throw new Error('Blob is not an answer');
  }

  // Match to the most-recent pending offer (FIFO would be the oldest; the contract
  // allows "most-recent pending offer or by order" — we pop the most recent).
  const peer = _pending.pop();
  if (!peer) throw new Error('No pending invite to match this answer');
  // Keep the iid index consistent with the popped peer.
  if (peer.iid) _pendingByIid.delete(peer.iid);

  return _promotePendingPeer(peer, parsed);
}

// Shared tail of the host accept flow: set the remote answer, allocate a stable
// pid, register the peer, and resolve once both channels are open. Used by BOTH
// acceptAnswer() (manual blob) and acceptAnswerCode() (link/code), so finalize,
// routing and timeouts stay byte-identical.
async function _promotePendingPeer(peer, parsedAnswer) {
  await peer.pc.setRemoteDescription(new RTCSessionDescription(parsedAnswer.sdp));

  // Promote to a real client with a stable id and register in the peer map now;
  // the join is finalized (welcome/onPeerJoin) once channels open + hello arrives.
  const clientId = _nextClientId++;
  peer.pid = clientId;
  peer.isPending = false;
  _peers.set(clientId, peer);

  // Resolve with the assigned pid once both channels are open (transport ready).
  await new Promise((resolve, reject) => {
    if (_bothOpen(peer)) { resolve(); return; }
    let settled = false;
    const t = setInterval(() => {
      if (_bothOpen(peer)) {
        settled = true;
        clearInterval(t);
        clearTimeout(to);
        resolve();
      } else if (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed') {
        settled = true;
        clearInterval(t);
        clearTimeout(to);
        reject(new Error('Peer connection failed'));
      }
    }, 50);
    // Safety timeout (15s) so the lobby doesn't hang forever.
    const to = setTimeout(() => {
      if (settled) return;
      clearInterval(t);
      // Don't reject hard; channels may open slightly later. Resolve anyway.
      resolve();
    }, 15000);
  });

  return clientId;
}

// Does a token look like a packCode() output (C/P prefix + base64url body)?
// Manual raw blobs are _encodeBlob() = btoa(JSON): they start with 'eyJ', carry
// '=' padding, and have no C/P prefix, so they fail this test and get routed to
// the legacy _decodeBlob() path instead.
function _looksLikePackCode(token) {
  if (token == null) return false;
  const s = String(token).trim();
  const prefix = s.charAt(0);
  if (prefix !== 'C' && prefix !== 'P') return false;
  // base64url body: no '=' padding and no '+'/'/' (those mark a raw base64 blob).
  return /^[A-Za-z0-9\-_]*$/.test(s.slice(1));
}

// Extract the `o=` (invite/offer) token from a URL, hash, or raw code.
export function parseInviteFromUrl(urlOrHash) {
  return _parseHashToken(urlOrHash, 'o');
}

// Extract the `a=` (answer) token from a URL, hash, or raw code.
export function parseAnswerFromUrl(urlOrHash) {
  return _parseHashToken(urlOrHash, 'a');
}

// Convenience: read the offer code from the current page URL hash ('#o=').
export function readOfferFromLocation() {
  return parseInviteFromUrl(location.hash);
}

// HOST: accept a returned answer LINK or CODE, routed precisely by iid (with a
// legacy _pending.pop() fallback for answers that carry no/unknown iid).
export async function acceptAnswerCode(answerCodeOrLink) {
  if (_mode !== 'host') throw new Error('acceptAnswerCode() requires host mode');

  const code = parseAnswerFromUrl(answerCodeOrLink) || String(answerCodeOrLink || '').trim();
  if (!code) throw new Error('No answer found in that code/link');

  // Manual raw blob (no C/P packCode prefix): route to the legacy base64-JSON
  // path so the Advanced "ADD PLAYER (manual)" flow still works.
  if (!_looksLikePackCode(code)) {
    return acceptAnswer(code);
  }

  let parsed;
  try {
    parsed = await unpackCode(code);
  } catch (err) {
    throw new Error('Invalid answer code: ' + err.message);
  }
  if (!parsed || parsed.v !== PROTO) throw new Error('Bad code version (expected ' + PROTO + ')');
  if (parsed.role !== 'answer' || !parsed.sdp || parsed.sdp.type !== 'answer') {
    throw new Error('Code is not an answer');
  }

  // ROUTING (the fix): precise iid match, else legacy most-recent pop.
  let peer = null;
  if (parsed.iid && _pendingByIid.has(parsed.iid)) {
    peer = _pendingByIid.get(parsed.iid);
    _pendingByIid.delete(parsed.iid);
    const idx = _pending.indexOf(peer);
    if (idx !== -1) _pending.splice(idx, 1);
  } else {
    peer = _pending.pop() || null;
    if (peer && peer.iid) _pendingByIid.delete(peer.iid);
  }
  if (!peer) throw new Error('No matching pending invite for this answer');

  return _promotePendingPeer(peer, parsed);
}

// ============================================================================
// CLIENT API
// ============================================================================

export async function startJoin({ name } = {}) {
  _resetSession();
  _mode = 'client';
  _selfId = -1; // not assigned until 'welcome'
  _selfName = (name || 'PLAYER').slice(0, 16);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = {
    pid: 0,            // the host is always pid 0 from the client's view
    name: 'HOST',
    pc,
    reliable: null,
    unreliable: null,
    open: false,
    hello: false,
    welcomed: false,
    helloSent: false,
    isPending: false,
  };
  _wirePeerConnection(peer); // ondatachannel registered: host creates the channels
  _peers.set(0, peer);
}

export async function makeAnswer(offerBlob) {
  if (_mode !== 'client') throw new Error('makeAnswer() requires client mode');
  const peer = _peers.get(0);
  if (!peer) throw new Error('startJoin() must be called before makeAnswer()');

  let parsed;
  try {
    parsed = _decodeBlob(offerBlob);
  } catch (err) {
    throw new Error('Invalid offer blob: not base64 JSON');
  }
  if (!parsed || parsed.v !== PROTO) throw new Error('Bad blob version (expected ' + PROTO + ')');
  if (parsed.role !== 'offer' || !parsed.sdp || parsed.sdp.type !== 'offer') {
    throw new Error('Blob is not an offer');
  }

  await _buildAnswerDesc(parsed);

  return { blob: _descBlob('answer', peer.pc.localDescription) };
}

// Shared SDP work for both the manual (makeAnswer) and link (makeAnswerFromCode)
// join paths: set the remote offer, create the answer, wait for ICE completion.
// Returns the client peer (pid 0) with its localDescription populated.
async function _buildAnswerDesc(parsedOffer) {
  const peer = _peers.get(0);
  if (!peer) throw new Error('startJoin() must be called first');
  await peer.pc.setRemoteDescription(new RTCSessionDescription(parsedOffer.sdp));
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  await _awaitIceComplete(peer.pc);
  return peer;
}

// CLIENT: consume an invite LINK/CODE and auto-produce a returnable answer code.
// Echoes the offer's iid so the host can route the answer to the exact PC.
export async function makeAnswerFromCode(offerCode, { baseUrl } = {}) {
  if (_mode !== 'client') throw new Error('makeAnswerFromCode() requires client mode');
  const peer = _peers.get(0);
  if (!peer) throw new Error('startJoin() must be called before makeAnswerFromCode()');

  const code = parseInviteFromUrl(offerCode) || String(offerCode || '').trim();
  if (!code) throw new Error('No invite found in that link');

  // Manual raw blob (no C/P packCode prefix): decode via the legacy base64-JSON
  // path so the Advanced "GENERATE (manual)" flow still works. The returned
  // answer is itself a raw blob, matching the host's manual acceptAnswer() path;
  // there is no shareable `#a=` link in this mode, so `link` mirrors the blob.
  if (!_looksLikePackCode(code)) {
    const { blob } = await makeAnswer(code);
    return { iid: undefined, code: blob, link: blob, blob };
  }

  let parsed;
  try {
    parsed = await unpackCode(code);
  } catch (err) {
    throw new Error('Invalid invite code: ' + err.message);
  }
  if (!parsed || parsed.v !== PROTO) throw new Error('Bad code version (expected ' + PROTO + ')');
  if (parsed.role !== 'offer' || !parsed.sdp || parsed.sdp.type !== 'offer') {
    throw new Error('Code is not an offer');
  }

  const iid = parsed.iid; // may be undefined for legacy/manual offers
  await _buildAnswerDesc(parsed);

  const desc = peer.pc.localDescription;
  const envelope = { v: PROTO, role: 'answer', sdp: { type: desc.type, sdp: desc.sdp } };
  if (iid != null) envelope.iid = iid; // echo iid only when present
  const answerCode = await packCode(envelope);
  const base = baseUrl || (location.origin + location.pathname);
  return { iid, code: answerCode, link: `${base}#a=${answerCode}` };
}

// ============================================================================
// SEND API
// ============================================================================

export function send(pid, msg) {
  _rawSend(_peers.get(pid), msg);
}

export function sendUnreliable(pid, msg) {
  const peer = _peers.get(pid);
  if (peer && peer.unreliable && peer.unreliable.readyState === 'open') {
    try { peer.unreliable.send(JSON.stringify(msg)); } catch (err) { _emitError(err); }
  }
}

export function broadcast(msg) {
  for (const peer of _peers.values()) {
    if (peer.welcomed || _mode === 'client') _rawSend(peer, msg);
  }
}

export function broadcastUnreliable(msg) {
  for (const peer of _peers.values()) {
    if (peer.unreliable && peer.unreliable.readyState === 'open') {
      try { peer.unreliable.send(JSON.stringify(msg)); } catch (err) { _emitError(err); }
    }
  }
}

export function sendToHost(msg) {
  // On the client, the host is the single peer (pid 0).
  _rawSend(_peers.get(0), msg);
}

export function sendToHostUnreliable(msg) {
  const peer = _peers.get(0);
  if (peer && peer.unreliable && peer.unreliable.readyState === 'open') {
    try { peer.unreliable.send(JSON.stringify(msg)); } catch (err) { _emitError(err); }
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

export function getRoster() {
  const out = [];
  for (const [pid, name] of _roster.entries()) out.push({ pid, name });
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

export function disconnect() {
  // Client: best-effort graceful 'bye'.
  if (_mode === 'client') {
    const peer = _peers.get(0);
    if (peer) _rawSend(peer, { t: 'bye' });
  }
  // Close every peer connection/channel.
  for (const peer of _peers.values()) {
    try { if (peer.reliable) peer.reliable.close(); } catch (_) {}
    try { if (peer.unreliable) peer.unreliable.close(); } catch (_) {}
    try { peer.pc.close(); } catch (_) {}
  }
  for (const peer of _pending) {
    try { peer.pc.close(); } catch (_) {}
  }
  _resetSession();
  if (_cb.onClose) {
    try { _cb.onClose(); } catch (err) { _emitError(err); }
  }
}

function _resetSession() {
  _peers.clear();
  _pending.length = 0;
  _pendingByIid.clear();
  _roster.clear();
  _nextClientId = 1;
  _pendingSeq = 0;
  _mode = 'sp';
  _selfId = -1;
  _hostConfig = {};
  _hostTime = 0;
}
