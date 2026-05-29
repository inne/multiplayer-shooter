// hud.js — DOM overlay + start/game-over screens
//
// Owns all DOM inside #hud-root. Never touches the Three.js scene; it only READS
// `state` each frame and reflects it into cheap DOM updates. The only "writes" it
// performs are calling the handler callbacks main.js provides (onStart/onRestart).
//
// Per the shared contract this module imports NOTHING from sibling game modules.

// ----------------------------------------------------------------------------
// Module-scoped references (singletons; no per-frame allocation, no state leaks)
// ----------------------------------------------------------------------------
let root = null; // the #hud-root element
let styleEl = null; // injected <style>

// Persistent element handles so update() can do targeted writes.
const el = {
  hud: null, // in-game HUD container
  healthFill: null,
  healthText: null,
  ammo: null,
  weaponName: null, // active-weapon label above the ammo readout
  reloadBar: null, // reload progress bar wrapper
  reloadFill: null, // reload progress fill
  pickupFeed: null, // container for transient pickup-notification toasts
  score: null,
  kills: null,
  wave: null,
  waveBanner: null,
  hurtFlash: null,
  startScreen: null,
  gameoverScreen: null,
  pauseScreen: null,
  goScore: null,
  goKills: null,
  goWave: null,
  // --- Multiplayer lobby ---
  lobbyScreen: null,
  lobbyHostCol: null,
  lobbyClientCol: null,
  lobbyOfferTA: null, // host: read-only offer to copy
  lobbyAnswerInTA: null, // host: paste answer here
  lobbyOfferInTA: null, // client: paste host offer here
  lobbyAnswerTA: null, // client: read-only answer to copy
  lobbyPlayersHost: null, // <ul>
  lobbyPlayersClient: null, // <ul>
  lobbyStatus: null,
  lobbyMapWrap: null, // host-only map-selector row
  lobbyMapSelect: null, // host: <select> of maps
  lobbyMapShown: null, // client: read-only label of host's chosen map
  // --- Link-first lobby additions ---
  lobbyInviteLink: null, // host: read-only invite LINK field
  lobbyCopyLink: null, // host: Copy-link button
  lobbyAnswerCodeIn: null, // host: paste-answer-code box (link or code)
  lobbyHostAdvanced: null, // host: <details> wrapping the OLD offer/answer textareas
  lobbyJoinLinkIn: null, // client: paste-invite-link box
  lobbyAnswerCode: null, // client: read-only answer CODE/LINK to copy
  lobbyCopyAnswerCode: null, // client: Copy button
  lobbyJoinState: null, // client: "joining…" status block
  lobbyClientAdvanced: null, // client: <details> wrapping the OLD textareas
};

// Currently selected lobby role ('host' | 'client'); drives column visibility.
let lobbyRole = 'host';

// Handlers object supplied by main.js (kept so lobby controls can call back).
let hudHandlers = {};

// Lobby map-selection state. `lobbyMaps` is [{id,name}] for the <select>;
// `selectedMapId` is the currently chosen map id (host authoritative).
let lobbyMaps = [];
let selectedMapId = null;

// Active pickup toasts: {el, ttl} pairs, faded out in update().
const pickupToasts = [];

// Cache of last-rendered values to skip redundant DOM writes.
const last = {
  healthPct: -1,
  ammo: '',
  weaponName: '',
  reloadVisible: false,
  reloadPct: -1,
  score: -1,
  kills: -1,
  wave: -1,
  hurtAt: -1, // tracks player.health drops to trigger the damage flash
  prevHealth: Infinity,
  bannerWave: -1,
};

// Wave-banner animation bookkeeping (purely cosmetic; HUD-local).
let bannerTimer = 0;

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Build the entire HUD DOM tree and wire the Start/Restart buttons.
 * @param {object} state  shared game state (read-only here)
 * @param {{onStart:Function, onRestart:Function}} handlers  callbacks owned by main.js
 */
export function initHUD(state, handlers) {
  handlers = handlers || {};
  hudHandlers = handlers;
  root = document.getElementById('hud-root');
  if (!root) {
    // Defensive: create the root if index.html somehow lacks it.
    root = document.createElement('div');
    root.id = 'hud-root';
    document.body.appendChild(root);
  }

  injectStyles();
  root.innerHTML = ''; // clean slate (supports hot-reload)

  buildInGameHUD();
  buildStartScreen(handlers);
  buildGameOverScreen(handlers);
  buildPauseScreen(handlers);
  buildLobbyScreen(handlers);
  buildBloodOverlay();

  // Start in the start-screen state; main.js may re-assert via showScreen().
  showScreen(state, 'start');
}

// --- Blood-on-glass damage overlay -----------------------------------------
// Full-screen layers above the canvas (pointer-events: none): a splatter flash
// that blooms on hit and fades, plus a persistent edge vignette that intensifies
// as health drops. Procedural (CSS radial gradients) — no image assets.
let _bloodFlash = 0; // 0..1, decays each frame

function buildBloodOverlay() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;';

  // Persistent low-health red vignette (opacity driven by health in update()).
  const vig = document.createElement('div');
  vig.style.cssText =
    'position:absolute;inset:0;opacity:0;transition:opacity .25s ease;' +
    'box-shadow:inset 0 0 26vmin 8vmin rgba(140,0,0,0.85);' +
    'background:radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(120,0,0,0.5) 100%);';

  // Hit splatter — several blood blobs clustered at the edges like spray on glass.
  const splat = document.createElement('div');
  splat.style.cssText =
    'position:absolute;inset:0;opacity:0;mix-blend-mode:multiply;' +
    'background:' +
    'radial-gradient(circle at 12% 18%, rgba(110,0,0,0.95) 0 5%, rgba(140,0,0,0) 18%),' +
    'radial-gradient(circle at 86% 26%, rgba(120,0,0,0.9) 0 6%, rgba(140,0,0,0) 20%),' +
    'radial-gradient(circle at 24% 82%, rgba(100,0,0,0.9) 0 7%, rgba(140,0,0,0) 22%),' +
    'radial-gradient(circle at 78% 80%, rgba(130,0,0,0.85) 0 5%, rgba(140,0,0,0) 17%),' +
    'radial-gradient(circle at 50% 50%, rgba(90,0,0,0.6) 0 3%, rgba(140,0,0,0) 12%),' +
    'radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(110,0,0,0.55) 100%);';

  wrap.appendChild(vig);
  wrap.appendChild(splat);
  root.appendChild(wrap);
  el.bloodVignette = vig;
  el.bloodSplat = splat;
}

// Trigger a blood splatter sized to the damage taken (bigger hit => more blood).
export function showDamage(amount) {
  const a = Math.max(0, Number(amount) || 0);
  _bloodFlash = Math.min(1, Math.max(_bloodFlash, 0.5 + a / 60));
}

function updateBlood(state, dt) {
  if (!el.bloodSplat) return;
  if (_bloodFlash > 0) {
    _bloodFlash = Math.max(0, _bloodFlash - dt * 1.4); // ~0.7s fade
    el.bloodSplat.style.opacity = _bloodFlash.toFixed(3);
  }
  const p = state.player;
  const hp = p ? p.health / (p.maxHealth || 100) : 1;
  // Vignette ramps in below 45% health, up to ~0.7 opacity at 0 hp.
  const lo = hp < 0.45 ? (0.45 - hp) / 0.45 : 0;
  el.bloodVignette.style.opacity = (lo * 0.7).toFixed(3);
}

/**
 * Reflect current state into the DOM. Called every frame AFTER all gameplay logic.
 * Only writes when a value actually changed to keep this cheap.
 */
export function update(state, dt) {
  if (!root) return;

  const p = state.player;
  const w = state.weapon;

  updateBlood(state, dt); // blood splatter fade + low-health vignette

  // --- Health bar -----------------------------------------------------------
  const maxH = p.maxHealth || 100;
  const pct = Math.max(0, Math.min(100, (p.health / maxH) * 100));
  if (pct !== last.healthPct) {
    el.healthFill.style.width = pct + '%';
    // Color shifts green -> amber -> red as health drops.
    el.healthFill.style.background = healthColor(pct);
    el.healthText.textContent = Math.max(0, Math.ceil(p.health)).toString();
    last.healthPct = pct;
  }

  // --- Damage flash ---------------------------------------------------------
  // Trigger a quick red vignette pulse whenever health drops.
  if (p.health < last.prevHealth - 0.0001 && state.phase === 'playing') {
    triggerHurtFlash();
  }
  last.prevHealth = p.health;
  // Fade the flash overlay.
  if (el.hurtFlash._alpha > 0) {
    el.hurtFlash._alpha = Math.max(0, el.hurtFlash._alpha - dt * 2.5);
    el.hurtFlash.style.opacity = el.hurtFlash._alpha.toFixed(3);
  }

  // --- Active weapon name ---------------------------------------------------
  // Prefer the arsenal's active-slot name (w.active); fall back to legacy w.name.
  const wname = (w.active || w.name || '').toString();
  if (wname !== last.weaponName) {
    if (el.weaponName) el.weaponName.textContent = wname.toUpperCase();
    last.weaponName = wname;
  }

  // --- Ammo -----------------------------------------------------------------
  let ammoStr;
  if (w.reloading) {
    const dots = '.'.repeat(1 + (Math.floor(state.time * 4) % 3));
    ammoStr = 'RELOADING' + dots;
  } else {
    ammoStr = `${w.ammoInMag} / ${w.reserveAmmo}`;
  }
  if (ammoStr !== last.ammo) {
    el.ammo.textContent = ammoStr;
    // Flash low-ammo warning when mag is nearly empty.
    el.ammo.classList.toggle('low', !w.reloading && w.ammoInMag <= Math.ceil(w.magSize * 0.2));
    last.ammo = ammoStr;
  }

  // --- Reload progress bar --------------------------------------------------
  if (w.reloading !== last.reloadVisible) {
    if (el.reloadBar) el.reloadBar.classList.toggle('show', !!w.reloading);
    last.reloadVisible = !!w.reloading;
    if (!w.reloading) last.reloadPct = -1;
  }
  if (w.reloading && el.reloadFill) {
    // w.reloadProgress runs 0..1 over the weapon's reload time (weapons.js).
    const rp = Math.max(0, Math.min(1, Number(w.reloadProgress) || 0));
    const rpInt = Math.round(rp * 100);
    if (rpInt !== last.reloadPct) {
      el.reloadFill.style.width = rpInt + '%';
      last.reloadPct = rpInt;
    }
  }

  // --- Pickup toasts fade ---------------------------------------------------
  if (pickupToasts.length) updatePickupToasts(dt);

  // --- Score / kills / wave -------------------------------------------------
  if (state.score !== last.score) {
    el.score.textContent = formatNumber(state.score);
    last.score = state.score;
  }
  if (state.kills !== last.kills) {
    el.kills.textContent = state.kills.toString();
    last.kills = state.kills;
  }
  if (state.wave !== last.wave) {
    el.wave.textContent = state.wave > 0 ? state.wave.toString() : '-';
    // New wave -> flash the big banner.
    if (state.wave > 0 && state.wave !== last.bannerWave) {
      showWaveBanner(state.wave, state.enemiesRemaining);
      last.bannerWave = state.wave;
    }
    last.wave = state.wave;
  }

  // --- Wave banner fade -----------------------------------------------------
  if (bannerTimer > 0) {
    bannerTimer -= dt;
    const a = bannerTimer > 1 ? 1 : Math.max(0, bannerTimer); // hold then fade in last 1s
    el.waveBanner.style.opacity = a.toFixed(3);
    if (bannerTimer <= 0) el.waveBanner.classList.remove('show');
  }
}

/**
 * Switch which overlay is visible.
 * @param {string} which  'start' | 'game' | 'gameover' | 'lobby'
 */
export function showScreen(state, which) {
  if (!root) return;
  const playing = which === 'game';

  el.hud.classList.toggle('visible', playing);
  el.startScreen.classList.toggle('visible', which === 'start');
  el.gameoverScreen.classList.toggle('visible', which === 'gameover');
  if (el.lobbyScreen) el.lobbyScreen.classList.toggle('visible', which === 'lobby');
  // Pause overlay is driven separately via showPause(); hide on any hard switch.
  el.pauseScreen.classList.remove('visible');

  // Make sure the lobby reflects the active role each time it's shown.
  if (which === 'lobby') applyLobbyRole();

  if (which === 'gameover') setGameOverStats(state);

  // Reset caches so the next 'game' frame fully repaints the HUD.
  if (playing) {
    last.healthPct = -1;
    last.ammo = '';
    last.weaponName = '';
    last.reloadVisible = false;
    last.reloadPct = -1;
    last.score = -1;
    last.kills = -1;
    last.wave = -1;
    last.bannerWave = -1;
    last.prevHealth = state.player.health;
  }
}

/** Populate the game-over panel with final run stats. */
export function setGameOverStats(state) {
  if (!el.goScore) return;
  el.goScore.textContent = formatNumber(state.score);
  el.goKills.textContent = state.kills.toString();
  el.goWave.textContent = (state.wave || 0).toString();
}

/**
 * Optional helper main.js may call on pointer-lock loss while playing.
 * Not in the required export set but harmless and useful; toggles the pause hint.
 */
export function showPause(state, on) {
  if (!el.pauseScreen) return;
  el.pauseScreen.classList.toggle('visible', !!on);
}

/**
 * Show a transient pickup-notification toast (e.g. "+90 RIFLE AMMO" or
 * "PICKED UP SHOTGUN"). Called by main.js when a 'pickup'/'grant' lands for the
 * local player. Purely cosmetic; safe to call any time.
 * @param {{kind?:string, weaponName?:string, ammo?:number, text?:string}} info
 */
export function showPickup(info) {
  if (!el.pickupFeed) return;
  info = info || {};
  const label = info.text != null ? String(info.text) : pickupLabel(info);
  if (!label) return;

  const toast = div('cb-pickup');
  const icon = div('cb-pickup-icon');
  icon.textContent = info.kind === 'weapon' ? '✦' : '◆'; // star / diamond
  const txt = div('cb-pickup-text');
  txt.textContent = label;
  toast.appendChild(icon);
  toast.appendChild(txt);
  el.pickupFeed.appendChild(toast);
  // Force the entry transition.
  // eslint-disable-next-line no-unused-expressions
  toast.offsetHeight;
  toast.classList.add('show');

  pickupToasts.push({ el: toast, ttl: 2.8 });
  // Cap the on-screen count so a burst of pickups can't flood the feed.
  while (pickupToasts.length > 4) {
    const old = pickupToasts.shift();
    if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
  }
}

function pickupLabel(info) {
  const wn = info.weaponName ? String(info.weaponName).toUpperCase() : '';
  if (info.kind === 'weapon') {
    return wn ? `PICKED UP ${wn}` : 'NEW WEAPON';
  }
  // ammo (default)
  const amt = Number(info.ammo);
  const amtStr = Number.isFinite(amt) && amt > 0 ? '+' + amt + ' ' : '+';
  return wn ? `${amtStr}${wn} AMMO` : `${amtStr}AMMO`;
}

function updatePickupToasts(dt) {
  for (let i = pickupToasts.length - 1; i >= 0; i--) {
    const t = pickupToasts[i];
    t.ttl -= dt;
    if (t.ttl <= 0) {
      t.el.classList.remove('show');
      // Allow the fade-out transition before removal.
      if (t.ttl <= -0.4) {
        if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
        pickupToasts.splice(i, 1);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// DOM construction
// ----------------------------------------------------------------------------

function buildInGameHUD() {
  const hud = div('cb-hud');
  el.hud = hud;

  // Crosshair (pure CSS lines + center dot).
  const cross = div('cb-crosshair');
  cross.innerHTML =
    '<span class="ch ch-t"></span><span class="ch ch-b"></span>' +
    '<span class="ch ch-l"></span><span class="ch ch-r"></span>' +
    '<span class="ch ch-dot"></span>';
  hud.appendChild(cross);

  // Damage flash vignette.
  const flash = div('cb-hurt');
  flash._alpha = 0;
  el.hurtFlash = flash;
  hud.appendChild(flash);

  // Bottom-left: health.
  const healthWrap = div('cb-health');
  const hLabel = div('cb-label');
  hLabel.textContent = 'HEALTH';
  const hBar = div('cb-healthbar');
  const hFill = div('cb-healthfill');
  const hText = div('cb-healthnum');
  hText.textContent = '100';
  hBar.appendChild(hFill);
  hBar.appendChild(hText);
  healthWrap.appendChild(hLabel);
  healthWrap.appendChild(hBar);
  el.healthFill = hFill;
  el.healthText = hText;
  hud.appendChild(healthWrap);

  // Bottom-right: weapon + ammo + reload progress.
  const ammoWrap = div('cb-ammo');
  const wName = div('cb-weaponname');
  wName.textContent = 'RIFLE';
  const aVal = div('cb-ammonum');
  aVal.textContent = '30 / 90';
  const aLabel = div('cb-label');
  aLabel.textContent = 'AMMO';
  // Reload progress bar (hidden unless reloading).
  const rBar = div('cb-reloadbar');
  const rFill = div('cb-reloadfill');
  rBar.appendChild(rFill);
  ammoWrap.appendChild(wName);
  ammoWrap.appendChild(aVal);
  ammoWrap.appendChild(aLabel);
  ammoWrap.appendChild(rBar);
  el.weaponName = wName;
  el.ammo = aVal;
  el.reloadBar = rBar;
  el.reloadFill = rFill;
  hud.appendChild(ammoWrap);

  // Bottom-center: pickup-notification feed (transient toasts).
  const feed = div('cb-pickupfeed');
  el.pickupFeed = feed;
  hud.appendChild(feed);

  // Top-left: score + kills.
  const stats = div('cb-stats');
  stats.appendChild(stat('SCORE', '0', (n) => (el.score = n)));
  stats.appendChild(stat('KILLS', '0', (n) => (el.kills = n)));
  hud.appendChild(stats);

  // Top-right: wave indicator.
  const waveWrap = div('cb-wave');
  const wLabel = div('cb-label');
  wLabel.textContent = 'WAVE';
  const wVal = div('cb-wavenum');
  wVal.textContent = '-';
  waveWrap.appendChild(wLabel);
  waveWrap.appendChild(wVal);
  el.wave = wVal;
  hud.appendChild(waveWrap);

  // Center wave banner (flashes on new wave).
  const banner = div('cb-banner');
  el.waveBanner = banner;
  hud.appendChild(banner);

  root.appendChild(hud);
}

function buildStartScreen(handlers) {
  const screen = div('cb-screen cb-start');
  const panel = div('cb-panel');

  const title = div('cb-title');
  title.textContent = 'COD::BROWSER';
  const sub = div('cb-subtitle');
  sub.textContent = 'Survive the waves. Aim for the head.';

  const btn = document.createElement('button');
  btn.className = 'cb-btn cb-btn-primary';
  btn.type = 'button';
  btn.textContent = 'CLICK TO PLAY';
  btn.addEventListener('click', () => {
    if (typeof handlers.onStart === 'function') handlers.onStart();
  });

  // Multiplayer entry: Host / Join chooser opens the lobby in the matching role.
  const mpRow = div('cb-mprow');
  const hostBtn = document.createElement('button');
  hostBtn.className = 'cb-btn cb-btn-mp';
  hostBtn.type = 'button';
  hostBtn.textContent = 'HOST GAME';
  hostBtn.addEventListener('click', () => {
    if (typeof handlers.onHostClick === 'function') handlers.onHostClick();
  });
  const joinBtn = document.createElement('button');
  joinBtn.className = 'cb-btn cb-btn-mp';
  joinBtn.type = 'button';
  joinBtn.textContent = 'JOIN GAME';
  joinBtn.addEventListener('click', () => {
    if (typeof handlers.onJoinClick === 'function') handlers.onJoinClick();
  });
  mpRow.appendChild(hostBtn);
  mpRow.appendChild(joinBtn);

  const tips = div('cb-tips');
  tips.innerHTML =
    '<div><b>WASD</b> move</div><div><b>MOUSE</b> look</div>' +
    '<div><b>LEFT-CLICK</b> fire</div><div><b>R</b> reload</div>' +
    '<div><b>SPACE</b> jump</div>';

  panel.appendChild(title);
  panel.appendChild(sub);
  panel.appendChild(btn);
  panel.appendChild(mpRow);
  panel.appendChild(tips);
  screen.appendChild(panel);
  el.startScreen = screen;
  root.appendChild(screen);
}

function buildGameOverScreen(handlers) {
  const screen = div('cb-screen cb-gameover');
  const panel = div('cb-panel');

  const title = div('cb-title cb-title-dead');
  title.textContent = 'YOU DIED';

  const statsRow = div('cb-final');
  statsRow.appendChild(finalStat('SCORE', '0', (n) => (el.goScore = n)));
  statsRow.appendChild(finalStat('KILLS', '0', (n) => (el.goKills = n)));
  statsRow.appendChild(finalStat('WAVE', '0', (n) => (el.goWave = n)));

  const btn = document.createElement('button');
  btn.className = 'cb-btn cb-btn-primary';
  btn.type = 'button';
  btn.textContent = 'RESTART';
  btn.addEventListener('click', () => {
    if (typeof handlers.onRestart === 'function') handlers.onRestart();
  });

  panel.appendChild(title);
  panel.appendChild(statsRow);
  panel.appendChild(btn);
  screen.appendChild(panel);
  el.gameoverScreen = screen;
  root.appendChild(screen);
}

function buildPauseScreen(handlers) {
  const screen = div('cb-screen cb-pause');
  const panel = div('cb-panel');
  const title = div('cb-title');
  title.textContent = 'PAUSED';
  const sub = div('cb-subtitle');
  sub.textContent = 'Click to resume';

  // Clicking the pause overlay re-engages: reuse onStart to re-lock the pointer.
  screen.addEventListener('click', () => {
    if (typeof handlers.onStart === 'function') handlers.onStart();
  });

  panel.appendChild(title);
  panel.appendChild(sub);
  screen.appendChild(panel);
  el.pauseScreen = screen;
  root.appendChild(screen);
}

// ----------------------------------------------------------------------------
// Multiplayer lobby
// ----------------------------------------------------------------------------

/**
 * Build the multiplayer lobby overlay (host + client columns) under #hud-root.
 * Wires the lobby buttons to the handlers main.js supplies. Pure DOM/transport-
 * agnostic: it only reads textareas and invokes the handler callbacks.
 * @param {object} handlers
 */
function buildLobbyScreen(handlers) {
  handlers = handlers || {};
  const screen = div('cb-screen cb-lobby');
  const panel = div('cb-panel cb-lobby-panel');

  const title = div('cb-title cb-lobby-title');
  title.textContent = 'MULTIPLAYER';

  const cols = div('cb-lobby-cols');

  // ---- Host column -------------------------------------------------------
  const hostCol = div('cb-lobby-col cb-lobby-host');
  el.lobbyHostCol = hostCol;
  hostCol.appendChild(colHeading('HOST'));

  // Row 1: CREATE INVITE -> produces a shareable LINK (handler unchanged).
  const createBtn = lobbyButton('CREATE INVITE', () => {
    if (typeof handlers.onCreateInvite === 'function') handlers.onCreateInvite();
  });
  hostCol.appendChild(createBtn);

  // Row 2: read-only invite LINK + Copy button.
  hostCol.appendChild(fieldLabel('YOUR INVITE LINK (copy & send to a player)'));
  const inviteLink = makeTextarea('cb-ta cb-ta-ro cb-ta-link', true);
  inviteLink.placeholder = 'Click "Create invite" to generate a link…';
  el.lobbyInviteLink = inviteLink;
  hostCol.appendChild(inviteLink);
  const copyLinkBtn = lobbyButton('COPY LINK', () => {
    copyTextarea(inviteLink);
  });
  el.lobbyCopyLink = copyLinkBtn;
  hostCol.appendChild(copyLinkBtn);

  // Row 3: paste the player's returned answer (link or code) with auto-detect.
  hostCol.appendChild(fieldLabel('PASTE PLAYER ANSWER (link or code)'));
  const answerCodeIn = makeTextarea('cb-ta', false);
  answerCodeIn.placeholder = "Paste the player's answer link or code here…";
  el.lobbyAnswerCodeIn = answerCodeIn;
  attachAutoDetect(answerCodeIn, ['#a='], () => {
    if (typeof handlers.onAcceptAnswer === 'function') handlers.onAcceptAnswer();
  });
  hostCol.appendChild(answerCodeIn);

  hostCol.appendChild(
    lobbyButton('ADD PLAYER', () => {
      if (typeof handlers.onAcceptAnswer === 'function') handlers.onAcceptAnswer();
    })
  );

  hostCol.appendChild(fieldLabel('CONNECTED PLAYERS'));
  const hostUl = document.createElement('ul');
  hostUl.className = 'cb-roster';
  el.lobbyPlayersHost = hostUl;
  hostCol.appendChild(hostUl);

  // Host-only map selector.
  const mapWrap = div('cb-lobby-maprow');
  mapWrap.appendChild(fieldLabel('MAP'));
  const mapSel = document.createElement('select');
  mapSel.className = 'cb-mapselect';
  mapSel.addEventListener('change', () => {
    selectedMapId = mapSel.value;
    if (typeof hudHandlers.onSelectMap === 'function') hudHandlers.onSelectMap(mapSel.value);
  });
  el.lobbyMapSelect = mapSel;
  mapWrap.appendChild(mapSel);
  el.lobbyMapWrap = mapWrap;
  hostCol.appendChild(mapWrap);

  hostCol.appendChild(
    lobbyButton('START MATCH', () => {
      if (typeof handlers.onStartMatch === 'function') handlers.onStartMatch();
    }, 'cb-btn-primary')
  );

  // Advanced / manual disclosure: original raw-blob offer/answer textareas.
  const hostAdv = makeDisclosure('Advanced / manual (raw blobs)');
  el.lobbyHostAdvanced = hostAdv.details;
  hostAdv.body.appendChild(fieldLabel('YOUR INVITE (raw offer blob — copy & send)'));
  const offerTA = makeTextarea('cb-ta cb-ta-ro', true);
  offerTA.placeholder = 'Click "Create invite" to generate…';
  el.lobbyOfferTA = offerTA;
  hostAdv.body.appendChild(offerTA);
  hostAdv.body.appendChild(fieldLabel('PASTE PLAYER ANSWER (raw answer blob)'));
  const answerInTA = makeTextarea('cb-ta', false);
  answerInTA.placeholder = "Paste the player's answer blob here…";
  el.lobbyAnswerInTA = answerInTA;
  hostAdv.body.appendChild(answerInTA);
  hostAdv.body.appendChild(
    lobbyButton('ADD PLAYER (manual)', () => {
      if (typeof handlers.onAcceptAnswer === 'function') handlers.onAcceptAnswer();
    })
  );
  hostCol.appendChild(hostAdv.details);

  // ---- Client column -----------------------------------------------------
  const clientCol = div('cb-lobby-col cb-lobby-client');
  el.lobbyClientCol = clientCol;
  clientCol.appendChild(colHeading('JOIN'));

  // Row 1: paste the host's invite LINK (or code) with auto-detect.
  clientCol.appendChild(fieldLabel('PASTE INVITE LINK'));
  const joinLinkIn = makeTextarea('cb-ta', false);
  joinLinkIn.placeholder = "Paste the host's invite link here…";
  el.lobbyJoinLinkIn = joinLinkIn;
  attachAutoDetect(joinLinkIn, ['#o='], () => {
    if (typeof handlers.onSubmitOffer === 'function') handlers.onSubmitOffer();
  });
  clientCol.appendChild(joinLinkIn);

  clientCol.appendChild(
    lobbyButton('GENERATE ANSWER', () => {
      if (typeof handlers.onSubmitOffer === 'function') handlers.onSubmitOffer();
    })
  );

  // Row 2: auto-answer "joining…" state line.
  const joinState = div('cb-join-state');
  joinState.textContent = '';
  el.lobbyJoinState = joinState;
  clientCol.appendChild(joinState);

  // Row 3: read-only answer code/link to send back + Copy button.
  clientCol.appendChild(fieldLabel('SEND THIS BACK TO HOST'));
  const answerCode = makeTextarea('cb-ta cb-ta-ro cb-ta-link', true);
  answerCode.placeholder = 'Your answer link appears here once joining…';
  el.lobbyAnswerCode = answerCode;
  clientCol.appendChild(answerCode);
  const copyAnswerCodeBtn = lobbyButton('COPY', () => {
    if (typeof handlers.onCopyAnswer === 'function') {
      handlers.onCopyAnswer();
    } else {
      copyTextarea(answerCode);
    }
  });
  el.lobbyCopyAnswerCode = copyAnswerCodeBtn;
  clientCol.appendChild(copyAnswerCodeBtn);

  clientCol.appendChild(fieldLabel('MAP'));
  const mapShown = div('cb-mapshown');
  mapShown.textContent = '—';
  el.lobbyMapShown = mapShown;
  clientCol.appendChild(mapShown);

  clientCol.appendChild(fieldLabel('CONNECTED PLAYERS'));
  const clientUl = document.createElement('ul');
  clientUl.className = 'cb-roster';
  el.lobbyPlayersClient = clientUl;
  clientCol.appendChild(clientUl);

  // Advanced / manual disclosure: original raw-blob offer-in / answer textareas.
  const clientAdv = makeDisclosure('Advanced / manual (raw blobs)');
  el.lobbyClientAdvanced = clientAdv.details;
  clientAdv.body.appendChild(fieldLabel('PASTE HOST INVITE (raw offer blob)'));
  const offerInTA = makeTextarea('cb-ta', false);
  offerInTA.placeholder = "Paste the host's invite blob here…";
  el.lobbyOfferInTA = offerInTA;
  clientAdv.body.appendChild(offerInTA);
  clientAdv.body.appendChild(
    lobbyButton('GENERATE ANSWER (manual)', () => {
      if (typeof handlers.onSubmitOffer === 'function') handlers.onSubmitOffer();
    })
  );
  clientAdv.body.appendChild(fieldLabel('YOUR ANSWER (raw answer blob — copy & send)'));
  const answerTA = makeTextarea('cb-ta cb-ta-ro', true);
  answerTA.placeholder = 'Generate an answer after pasting the invite…';
  el.lobbyAnswerTA = answerTA;
  clientAdv.body.appendChild(answerTA);
  clientAdv.body.appendChild(
    lobbyButton('COPY ANSWER (manual)', () => {
      copyTextarea(answerTA);
    })
  );
  clientCol.appendChild(clientAdv.details);

  cols.appendChild(hostCol);
  cols.appendChild(clientCol);

  // ---- Status line + back button ----------------------------------------
  const status = div('cb-lobby-status');
  status.textContent = '';
  el.lobbyStatus = status;

  const backBtn = lobbyButton('BACK TO MENU', () => {
    if (typeof handlers.onBackToMenu === 'function') handlers.onBackToMenu();
  }, 'cb-btn-ghost');

  panel.appendChild(title);
  panel.appendChild(cols);
  panel.appendChild(status);
  panel.appendChild(backBtn);
  screen.appendChild(panel);
  el.lobbyScreen = screen;
  root.appendChild(screen);
}

/**
 * Toggle which lobby column is visible.
 * @param {'host'|'client'} role
 */
export function setLobbyRole(role) {
  lobbyRole = role === 'client' ? 'client' : 'host';
  applyLobbyRole();
}

function applyLobbyRole() {
  if (!el.lobbyHostCol || !el.lobbyClientCol) return;
  const host = lobbyRole === 'host';
  el.lobbyHostCol.classList.toggle('hidden', !host);
  el.lobbyClientCol.classList.toggle('hidden', host);
}

/** Host: fill the read-only OFFER textarea. Client: shows host's offer slot value. */
export function setLobbyOffer(blobString) {
  const s = blobString == null ? '' : String(blobString);
  if (lobbyRole === 'host') {
    if (el.lobbyOfferTA) {
      el.lobbyOfferTA.value = s;
      autoSelect(el.lobbyOfferTA);
    }
  } else if (el.lobbyOfferInTA) {
    el.lobbyOfferInTA.value = s;
  }
}

/** Host: reflect pasted answer area. Client: fill the read-only ANSWER textarea to copy. */
export function setLobbyAnswer(blobString) {
  const s = blobString == null ? '' : String(blobString);
  if (lobbyRole === 'client') {
    if (el.lobbyAnswerTA) {
      el.lobbyAnswerTA.value = s;
      autoSelect(el.lobbyAnswerTA);
    }
  } else if (el.lobbyAnswerInTA) {
    el.lobbyAnswerInTA.value = s;
  }
}

/**
 * Returns the value main.js needs to consume for the current step:
 *   host  -> the pasted ANSWER blob (the host consumes a player's answer)
 *   client-> the pasted host OFFER blob (the client consumes the host's invite)
 */
export function getLobbyOfferInput() {
  if (lobbyRole === 'host') {
    return el.lobbyAnswerInTA ? el.lobbyAnswerInTA.value.trim() : '';
  }
  return el.lobbyOfferInTA ? el.lobbyOfferInTA.value.trim() : '';
}

// --- Link-first lobby getters/setters (additive; manual flow uses the above) ---

/**
 * Host: fill the read-only invite LINK field and auto-select it. No-op for client.
 */
export function setLobbyInviteLink(linkString) {
  if (lobbyRole !== 'host') return;
  const s = linkString == null ? '' : String(linkString);
  if (el.lobbyInviteLink) {
    el.lobbyInviteLink.value = s;
    autoSelect(el.lobbyInviteLink);
  }
}

/**
 * Client: fill the read-only answer CODE/LINK field and auto-select it. No-op for host.
 */
export function setLobbyAnswerCode(codeOrLinkString) {
  if (lobbyRole !== 'client') return;
  const s = codeOrLinkString == null ? '' : String(codeOrLinkString);
  if (el.lobbyAnswerCode) {
    el.lobbyAnswerCode.value = s;
    autoSelect(el.lobbyAnswerCode);
  }
}

/** Host: returns the pasted answer link/code (trimmed). */
export function getLobbyAnswerCodeInput() {
  return el.lobbyAnswerCodeIn ? el.lobbyAnswerCodeIn.value.trim() : '';
}

/** Client: returns the pasted invite link/code (trimmed). */
export function getLobbyJoinLinkInput() {
  return el.lobbyJoinLinkIn ? el.lobbyJoinLinkIn.value.trim() : '';
}

/** Client: write the auto-answer "joining…" state line. */
export function setLobbyJoinState(text) {
  if (el.lobbyJoinState) el.lobbyJoinState.textContent = text == null ? '' : String(text);
}

/** Expand (or collapse) the Advanced/manual disclosure for the active role. */
export function setLobbyAdvancedOpen(open) {
  const details = lobbyRole === 'host' ? el.lobbyHostAdvanced : el.lobbyClientAdvanced;
  if (details) details.open = !!open;
}

/** Render the connected-players list into whichever column is active. */
export function setLobbyPlayers(players) {
  players = Array.isArray(players) ? players : [];
  renderRoster(el.lobbyPlayersHost, players);
  renderRoster(el.lobbyPlayersClient, players);
}

function renderRoster(ul, players) {
  if (!ul) return;
  ul.innerHTML = '';
  if (players.length === 0) {
    const li = document.createElement('li');
    li.className = 'cb-roster-empty';
    li.textContent = 'no players yet';
    ul.appendChild(li);
    return;
  }
  for (const p of players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'cb-roster-dot';
    const name = document.createElement('span');
    name.className = 'cb-roster-name';
    name.textContent = (p && p.name != null ? String(p.name) : 'player') +
      (p && p.pid === 0 ? ' (host)' : '');
    li.appendChild(dot);
    li.appendChild(name);
    ul.appendChild(li);
  }
}

/** Show a status/error line in the lobby panel. */
export function setLobbyStatus(text) {
  if (el.lobbyStatus) el.lobbyStatus.textContent = text == null ? '' : String(text);
}

/**
 * Populate the lobby map selector and reflect the chosen map.
 * Host: fills the <select>. Client: updates the read-only map label (joiners
 * see the host's choice). Safe to call repeatedly (e.g. on mid-lobby change).
 * @param {Array<{id:string,name:string}>} list  available maps
 * @param {string} [selId]  currently-selected map id
 */
export function setLobbyMaps(list, selId) {
  lobbyMaps = Array.isArray(list) ? list : [];
  if (selId != null) {
    selectedMapId = selId;
  } else if (selectedMapId == null && lobbyMaps.length) {
    selectedMapId = lobbyMaps[0].id;
  }

  // Rebuild the host <select> options.
  if (el.lobbyMapSelect) {
    el.lobbyMapSelect.innerHTML = '';
    for (const m of lobbyMaps) {
      const opt = document.createElement('option');
      opt.value = String(m.id);
      opt.textContent = String(m.name != null ? m.name : m.id);
      el.lobbyMapSelect.appendChild(opt);
    }
    if (selectedMapId != null) el.lobbyMapSelect.value = String(selectedMapId);
  }

  // Update the client read-only label with the friendly name.
  if (el.lobbyMapShown) {
    const found = lobbyMaps.find((m) => String(m.id) === String(selectedMapId));
    el.lobbyMapShown.textContent = found ? String(found.name) : (selectedMapId || '—');
  }
}

/** Returns the currently-selected map id (host's choice), or null if none. */
export function getSelectedMap() {
  return selectedMapId;
}

// --- Lobby DOM helpers -------------------------------------------------------

function colHeading(text) {
  const h = div('cb-lobby-heading');
  h.textContent = text;
  return h;
}

function fieldLabel(text) {
  const l = div('cb-field-label');
  l.textContent = text;
  return l;
}

function makeTextarea(cls, readOnly) {
  const ta = document.createElement('textarea');
  ta.className = cls;
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.autocomplete = 'off';
  ta.rows = 3;
  if (readOnly) {
    ta.readOnly = true;
    // Selecting all on focus makes copy a one-click affair.
    ta.addEventListener('focus', () => ta.select());
  }
  return ta;
}

/**
 * Build a collapsible "Advanced / manual" disclosure. Returns the <details>
 * element and an inner body container to append fields into.
 */
function makeDisclosure(summaryText) {
  const details = document.createElement('details');
  details.className = 'cb-disclosure';
  const summary = document.createElement('summary');
  summary.className = 'cb-disclosure-summary';
  summary.textContent = summaryText;
  details.appendChild(summary);
  const body = div('cb-disclosure-body');
  details.appendChild(body);
  return { details, body };
}

/**
 * Auto-fire `onDetect` (debounced) when the field's value gains one of the
 * `markers` (e.g. '#o=' / '#a=') or a non-trivial code-looking blob. Idempotent
 * per distinct value so paste + input don't double-fire; main.js owns the
 * in-flight guard, this just avoids re-firing on the SAME text.
 */
function attachAutoDetect(field, markers, onDetect) {
  let lastFired = null;
  const tryFire = () => {
    const v = (field.value || '').trim();
    if (!v) return;
    const looksLikeMarker = markers.some((m) => v.indexOf(m) !== -1);
    // A bare code: no whitespace, reasonably long, no marker required.
    const looksLikeCode = !/\s/.test(v) && v.length >= 24;
    if (!looksLikeMarker && !looksLikeCode) return;
    if (v === lastFired) return; // already handled this exact value
    lastFired = v;
    onDetect();
  };
  field.addEventListener('input', () => {
    // Debounce so rapid keystrokes coalesce into one detect.
    clearTimeout(field._autoDetectTimer);
    field._autoDetectTimer = setTimeout(tryFire, 250);
  });
  field.addEventListener('paste', () => {
    // Paste lands the value after this tick; check on next frame.
    clearTimeout(field._autoDetectTimer);
    field._autoDetectTimer = setTimeout(tryFire, 60);
  });
}

function lobbyButton(label, onClick, extraCls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cb-btn cb-btn-sm' + (extraCls ? ' ' + extraCls : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function autoSelect(ta) {
  if (!ta.value) return;
  // Defer so the textarea is visible/focusable when first populated.
  try {
    ta.focus();
    ta.select();
  } catch (_) {
    /* ignore */
  }
}

function copyTextarea(ta) {
  if (!ta || !ta.value) return;
  ta.focus();
  ta.select();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value);
    } else {
      document.execCommand('copy');
    }
  } catch (_) {
    /* clipboard may be blocked; manual select still works */
  }
}

// ----------------------------------------------------------------------------
// Behavior helpers
// ----------------------------------------------------------------------------

function triggerHurtFlash() {
  el.hurtFlash._alpha = 0.7;
  el.hurtFlash.style.opacity = '0.7';
}

function showWaveBanner(wave, count) {
  el.waveBanner.innerHTML =
    `<div class="cb-banner-big">WAVE ${wave}</div>` +
    `<div class="cb-banner-small">${count} HOSTILES INBOUND</div>`;
  el.waveBanner.classList.add('show');
  el.waveBanner.style.opacity = '1';
  // Hold for ~1.4s then fade out over the final second (see update()).
  bannerTimer = 2.4;
}

function healthColor(pct) {
  // Green (full) -> amber (~40%) -> red (low). Simple hue interpolation.
  const hue = Math.max(0, Math.min(120, (pct / 100) * 120)); // 120=green, 0=red
  return `linear-gradient(90deg, hsl(${hue},75%,38%), hsl(${hue},85%,52%))`;
}

function formatNumber(n) {
  return Math.floor(n).toLocaleString('en-US');
}

// ----------------------------------------------------------------------------
// Tiny DOM builders
// ----------------------------------------------------------------------------

function div(cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  return d;
}

function stat(label, value, capture) {
  const wrap = div('cb-stat');
  const l = div('cb-label');
  l.textContent = label;
  const v = div('cb-statnum');
  v.textContent = value;
  wrap.appendChild(v);
  wrap.appendChild(l);
  capture(v);
  return wrap;
}

function finalStat(label, value, capture) {
  const wrap = div('cb-finalstat');
  const v = div('cb-finalnum');
  v.textContent = value;
  const l = div('cb-label');
  l.textContent = label;
  wrap.appendChild(v);
  wrap.appendChild(l);
  capture(v);
  return wrap;
}

// ----------------------------------------------------------------------------
// Styles (injected once)
// ----------------------------------------------------------------------------

function injectStyles() {
  if (styleEl && document.head.contains(styleEl)) return;
  styleEl = document.createElement('style');
  styleEl.id = 'cb-hud-styles';
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}

const CSS = `
#hud-root {
  position: fixed; inset: 0; z-index: 10;
  pointer-events: none; /* gameplay clicks pass through; buttons re-enable below */
  font-family: 'Segoe UI', Roboto, system-ui, sans-serif;
  color: #e8eef2; user-select: none; -webkit-user-select: none;
  text-shadow: 0 1px 3px rgba(0,0,0,0.85);
}
#hud-root, #hud-root * { box-sizing: border-box; }

/* ---------- In-game HUD ---------- */
.cb-hud { position: absolute; inset: 0; opacity: 0; transition: opacity .25s ease; }
.cb-hud.visible { opacity: 1; }

/* Crosshair */
.cb-crosshair {
  position: absolute; left: 50%; top: 50%;
  width: 26px; height: 26px; transform: translate(-50%, -50%);
}
.cb-crosshair .ch { position: absolute; background: rgba(255,255,255,.85);
  box-shadow: 0 0 2px rgba(0,0,0,.9); }
.ch-t, .ch-b { left: 50%; width: 2px; height: 7px; margin-left: -1px; }
.ch-l, .ch-r { top: 50%; height: 2px; width: 7px; margin-top: -1px; }
.ch-t { top: 0; } .ch-b { bottom: 0; } .ch-l { left: 0; } .ch-r { right: 0; }
.ch-dot { left: 50%; top: 50%; width: 2px; height: 2px; margin: -1px 0 0 -1px;
  background: rgba(255,80,80,.95); }

/* Damage vignette */
.cb-hurt {
  position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse at center,
    rgba(180,0,0,0) 45%, rgba(180,0,0,.55) 100%);
}

/* Labels */
.cb-label { font-size: 11px; letter-spacing: 2px; opacity: .65; font-weight: 700; }

/* Health (bottom-left) */
.cb-health { position: absolute; left: 26px; bottom: 26px; width: 260px; }
.cb-healthbar {
  position: relative; height: 22px; margin-top: 5px; border-radius: 4px;
  background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.18); overflow: hidden;
}
.cb-healthfill {
  height: 100%; width: 100%;
  background: linear-gradient(90deg, hsl(120,75%,38%), hsl(120,85%,52%));
  transition: width .12s linear, background .25s linear;
}
.cb-healthnum {
  position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; font-weight: 800; font-size: 13px;
}

/* Ammo (bottom-right) */
.cb-ammo { position: absolute; right: 26px; bottom: 26px; text-align: right; }
.cb-ammonum { font-size: 34px; font-weight: 800; line-height: 1; letter-spacing: 1px; }
.cb-ammonum.low { color: #ff6a5a; animation: cb-pulse .6s ease-in-out infinite; }
.cb-ammo .cb-label { margin-top: 2px; }

/* Stats (top-left) */
.cb-stats { position: absolute; left: 26px; top: 22px; display: flex; gap: 26px; }
.cb-stat { text-align: left; }
.cb-statnum { font-size: 26px; font-weight: 800; line-height: 1; }

/* Wave (top-right) */
.cb-wave { position: absolute; right: 26px; top: 22px; text-align: right; }
.cb-wavenum { font-size: 26px; font-weight: 800; line-height: 1; color: #ffcf5a; }

/* Wave banner (center) */
.cb-banner {
  position: absolute; left: 50%; top: 28%; transform: translate(-50%, -50%);
  text-align: center; opacity: 0; pointer-events: none; display: none;
}
.cb-banner.show { display: block; }
.cb-banner-big {
  font-size: 54px; font-weight: 900; letter-spacing: 6px; color: #ffcf5a;
  text-shadow: 0 2px 18px rgba(0,0,0,.9);
}
.cb-banner-small { font-size: 16px; letter-spacing: 4px; opacity: .85; margin-top: 4px; }

/* ---------- Full-screen overlays ---------- */
.cb-screen {
  position: absolute; inset: 0; display: none;
  align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(8,12,16,.72), rgba(4,6,8,.93));
  backdrop-filter: blur(3px); pointer-events: auto;
}
.cb-screen.visible { display: flex; animation: cb-fade .3s ease; }
.cb-pause { background: rgba(4,6,8,.55); }

.cb-panel {
  text-align: center; padding: 40px 56px; max-width: 560px;
  border: 1px solid rgba(255,255,255,.10); border-radius: 14px;
  background: rgba(14,18,24,.55); box-shadow: 0 24px 80px rgba(0,0,0,.6);
}
.cb-title { font-size: 52px; font-weight: 900; letter-spacing: 4px; }
.cb-title-dead { color: #ff5a4a; text-shadow: 0 0 24px rgba(255,40,30,.5); }
.cb-subtitle { margin-top: 8px; font-size: 16px; opacity: .8; letter-spacing: 1px; }

.cb-btn {
  pointer-events: auto; cursor: pointer; margin-top: 28px;
  font: inherit; font-weight: 800; letter-spacing: 2px; font-size: 16px;
  padding: 14px 34px; border-radius: 8px; border: none; color: #0b0f12;
  transition: transform .08s ease, filter .15s ease;
}
.cb-btn-primary { background: linear-gradient(180deg, #ffd25a, #ff9e2c); }
.cb-btn:hover { filter: brightness(1.08); }
.cb-btn:active { transform: translateY(1px) scale(.98); }

.cb-tips {
  display: flex; flex-wrap: wrap; gap: 10px 22px; justify-content: center;
  margin-top: 26px; font-size: 13px; opacity: .7;
}
.cb-tips b { color: #ffcf5a; letter-spacing: 1px; }

/* Game-over final stats */
.cb-final { display: flex; gap: 40px; justify-content: center; margin-top: 26px; }
.cb-finalstat { text-align: center; }
.cb-finalnum { font-size: 38px; font-weight: 900; color: #ffcf5a; line-height: 1; }
.cb-finalstat .cb-label { margin-top: 6px; }

/* ---------- Start-screen multiplayer chooser ---------- */
.cb-mprow { display: flex; gap: 14px; justify-content: center; margin-top: 14px; }
.cb-btn-mp {
  margin-top: 0; font-size: 14px; padding: 11px 22px;
  background: linear-gradient(180deg, #5ab4ff, #2c7cff); color: #04101c;
}

/* ---------- Multiplayer lobby ---------- */
.cb-lobby-panel { max-width: 880px; width: min(92vw, 880px); padding: 32px 36px; }
.cb-lobby-title { font-size: 40px; letter-spacing: 5px; }
.cb-lobby-cols {
  display: flex; gap: 26px; margin-top: 22px; text-align: left;
  align-items: stretch;
}
.cb-lobby-col {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 8px;
  padding: 16px; border-radius: 10px;
  background: rgba(8,12,18,.5); border: 1px solid rgba(255,255,255,.10);
}
.cb-lobby-col.hidden { display: none; }
.cb-lobby-heading {
  font-size: 18px; font-weight: 900; letter-spacing: 3px; color: #ffcf5a;
  margin-bottom: 4px;
}
.cb-lobby-client .cb-lobby-heading { color: #5ab4ff; }
.cb-field-label {
  font-size: 10px; letter-spacing: 1.5px; font-weight: 700; opacity: .6;
  margin-top: 6px; text-transform: uppercase;
}
.cb-ta {
  width: 100%; resize: vertical; min-height: 56px; font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.35; color: #d8e6f2;
  background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.16);
  border-radius: 6px; padding: 8px 10px; word-break: break-all;
}
.cb-ta:focus { outline: none; border-color: rgba(120,180,255,.7); }
.cb-ta-ro { background: rgba(0,0,0,.6); color: #9fd0ff; }
/* Link fields stay compact (single-line feel) since the code is one token. */
.cb-ta-link { min-height: 40px; resize: none; }

/* Client auto-answer "joining…" state line */
.cb-join-state {
  min-height: 16px; margin-top: 6px; font-size: 12px; letter-spacing: .5px;
  font-weight: 700; color: #9fd0ff;
}

/* Advanced / manual disclosure */
.cb-disclosure {
  margin-top: 12px; border-top: 1px dashed rgba(255,255,255,.14); padding-top: 8px;
}
.cb-disclosure-summary {
  cursor: pointer; pointer-events: auto; list-style: revert;
  font-size: 10px; letter-spacing: 1.5px; font-weight: 700; opacity: .55;
  text-transform: uppercase; user-select: none; -webkit-user-select: none;
}
.cb-disclosure-summary:hover { opacity: .85; }
.cb-disclosure[open] .cb-disclosure-summary { opacity: .85; margin-bottom: 6px; }
.cb-disclosure-body { display: flex; flex-direction: column; gap: 6px; }
.cb-btn-sm {
  margin-top: 8px; font-size: 13px; padding: 9px 16px; letter-spacing: 1px;
  background: linear-gradient(180deg, #3a4452, #232a33); color: #e8eef2;
  align-self: flex-start;
}
.cb-btn-sm.cb-btn-primary { background: linear-gradient(180deg, #ffd25a, #ff9e2c); color: #0b0f12; }
.cb-btn-ghost {
  background: transparent; border: 1px solid rgba(255,255,255,.22); color: #e8eef2;
}
.cb-roster {
  list-style: none; margin: 4px 0 0; padding: 8px 10px; min-height: 56px;
  background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.10);
  border-radius: 6px; font-size: 13px;
}
.cb-roster li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.cb-roster-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #4ce06a; box-shadow: 0 0 6px rgba(76,224,106,.8);
}
.cb-roster-name { font-weight: 600; }
.cb-roster-empty { opacity: .45; font-style: italic; }
.cb-lobby-status {
  margin-top: 18px; min-height: 18px; font-size: 13px; letter-spacing: .5px;
  color: #ffcf5a; text-align: center;
}

/* Weapon name (above ammo) */
.cb-weaponname {
  font-size: 14px; font-weight: 800; letter-spacing: 3px; color: #ffcf5a;
  margin-bottom: 2px;
}

/* Reload progress bar (under ammo, bottom-right) */
.cb-reloadbar {
  margin-top: 6px; margin-left: auto; width: 150px; height: 6px;
  border-radius: 3px; background: rgba(0,0,0,.5);
  border: 1px solid rgba(255,255,255,.18); overflow: hidden;
  opacity: 0; transition: opacity .12s ease;
}
.cb-reloadbar.show { opacity: 1; }
.cb-reloadfill {
  height: 100%; width: 0%;
  background: linear-gradient(90deg, #ffd25a, #ff9e2c);
  transition: width .08s linear;
}

/* Pickup notification feed (bottom-center) */
.cb-pickupfeed {
  position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%);
  display: flex; flex-direction: column-reverse; align-items: center; gap: 8px;
  pointer-events: none;
}
.cb-pickup {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 16px; border-radius: 999px;
  background: rgba(14,18,24,.72); border: 1px solid rgba(255,207,90,.45);
  box-shadow: 0 4px 18px rgba(0,0,0,.5);
  opacity: 0; transform: translateY(10px);
  transition: opacity .3s ease, transform .3s ease;
}
.cb-pickup.show { opacity: 1; transform: translateY(0); }
.cb-pickup-icon { color: #ffcf5a; font-size: 15px; line-height: 1; }
.cb-pickup-text { font-size: 14px; font-weight: 800; letter-spacing: 1.5px; }

/* Lobby map selector */
.cb-lobby-maprow { display: flex; flex-direction: column; gap: 4px; }
.cb-mapselect {
  pointer-events: auto; cursor: pointer; width: 100%;
  font: inherit; font-size: 13px; font-weight: 700; letter-spacing: 1px;
  padding: 8px 10px; border-radius: 6px; color: #e8eef2;
  background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.18);
}
.cb-mapselect:focus { outline: none; border-color: rgba(255,207,90,.7); }
.cb-mapshown {
  padding: 8px 10px; border-radius: 6px; font-size: 14px; font-weight: 800;
  letter-spacing: 1px; color: #9fd0ff;
  background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.10);
}

/* Animations */
@keyframes cb-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes cb-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
`;
