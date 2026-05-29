# COD::BROWSER

A browser-based wave-survival FPS built on three.js (v0.160.0), with no build
step. It ships with a set of **bundled CC0 assets** — all public-domain CC0, see
`assets/manifest.json` — for a cel-shaded cartoon look:

- **Weapons** (`assets/weapons/`): Quaternius pistol/rifle/shotgun (+bullpup),
  vertex/material-colored, fully self-contained (no external texture URIs).
- **Enemies** (`assets/enemies/`): KayKit rigged skeleton variants (Warrior, Mage,
  Rogue, Minion) with embedded atlases and 95 baked animation clips.
- **Kit props** (`assets/kit/`): KayKit Dungeon + Quaternius crates, barrels,
  pillars, rubble, trees — embedded atlases or vertex colors.
- **World** (`assets/world/`): ambientCG ground/wall color maps and Poly Haven
  CC0 HDRIs for skybox + image-based lighting.

Every asset has a procedural fallback, so the game runs and looks correct even
with an **empty `assets/` folder** — geometry, textures, and sound all degrade to
the original procedural generators with no errors. All bundled `.glb` models are
self-contained (textures embedded), so there are zero external asset 404s at
runtime.

## Run it

Serve the `cod-browser/` directory with any static file server and open it in a
modern browser. The importmap loads three.js from a CDN (esm.sh), so you need an
internet connection on first load.

From inside `cod-browser/`:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000/ and click **CLICK TO PLAY**.

(Alternatively: `npx serve` — then open the URL it prints.)

> A plain `file://` open will not work: ES modules and the importmap require an
> HTTP origin.

### Dev autostart (automated visual verification)

For screenshots and automated visual checks there is a **diagnostic autostart
hook**: append `?dev=1` to the URL and the game **skips the lobby + pointer-lock
gate**, immediately starts a single-player run, equips a weapon, spawns a few
enemies directly in front of the camera, and renders continuously — so a single
screenshot captures the gun + enemies + environment. Optional params:

| Param      | Values                                | Default     |
| ---------- | ------------------------------------- | ----------- |
| `dev`      | `1` (required to arm the hook)        | _(off)_     |
| `map`      | `warehouse` \| `desert` \| `night_city` | `warehouse` |
| `weapon`   | `pistol` \| `rifle` \| `shotgun`      | `rifle`     |
| `enemies`  | `0`–`12` (count spawned in front)     | `3`         |

Examples:

```
http://localhost:8000/?dev=1
http://localhost:8000/?dev=1&map=night_city&weapon=shotgun
http://localhost:8000/?dev=1&map=desert&weapon=pistol&enemies=5
```

The hook reuses the normal single-player begin path plus the public weapon and
enemy-mesh APIs, so dev mode can't drift from real gameplay. With **no `?dev=1`
param the behavior is byte-for-byte the original** — the normal start screen, the
single-player flow, and the WebRTC multiplayer flow are all untouched. (When dev
mode is active it also sets `window.__COD_DEV_READY = { map, weapon, enemies }`
so an external verifier can detect readiness.)

## Controls

| Input            | Action                                          |
| ---------------- | ----------------------------------------------- |
| `W A S D`        | Move                                            |
| Mouse            | Look                                            |
| Left click       | Fire (rifle is full-auto; pistol/shotgun are semi — one shot per click) |
| `R`              | Reload                                           |
| `1` `2` `3`      | Switch weapon (pistol / rifle / shotgun)        |
| Mouse wheel      | Cycle through owned weapons                      |
| `Space`          | Jump                                            |
| `Esc`            | Release the mouse (pauses; click to resume)     |

Clicking **CLICK TO PLAY** locks the pointer and starts wave 1. Survive as long
as you can — enemies stream in from the arena edges and chase you down. Aim for
the head for double damage. If you lose pointer lock mid-fight the world pauses;
click to resume. On death the game-over screen shows your final score, kills, and
wave, with a **RESTART** button.

### Arsenal

You start with a **rifle** (full-auto, 30-round mag) and a **pistol** (semi-auto,
hard-hitting, 12-round mag). The **shotgun** (8 pellets per shot, brutal up close)
is locked until you find it as a pickup. Each weapon keeps its own ammo across
switches, and reloads only pull from that weapon's reserve.

### Pickups

Floating, spinning **pickups** spawn on pads around the arena:

- **Ammo boxes** (blue ring) top up your reserve ammo.
- **Weapon crates** (gold ring) grant a new weapon (e.g. the shotgun) and top up
  its magazine.

Walk over a pickup to grab it; it respawns on the same pad after a short delay
(~15 s ammo, ~25 s weapons). In multiplayer the host owns when a pickup is
consumed and grants the effect to whoever grabbed it.

### Maps

Three distinct maps ship in: **Warehouse** (cool concrete baseline), **Desert**
(sandy, sparse tall cover, warm low sun), and **Night City** (dark, neon container
crates, colored accent lights). All maps share the same arena dimensions but
differ in cover layout, palette, lighting, skybox, and pickup geography. Single-
player defaults to Warehouse; the host picks the map in the lobby (see below).

## Multiplayer (serverless WebRTC LAN co-op)

The start screen also has **HOST GAME** and **JOIN GAME** buttons. Multiplayer is
host-authoritative co-op: the host runs the real simulation (enemies, spawns,
damage, scoring) and broadcasts world snapshots; clients send their input and
render what the host reports. Single-player is unchanged — if you click
**CLICK TO PLAY** none of the networking runs.

### How it connects — no server, no broker

There is **no backend, no signaling server, and no STUN/TURN**. Connections are
plain `RTCPeerConnection` + `RTCDataChannel` on the local network. Signaling is
still **manual** (a browser tab can't deliver SDP across the LAN by itself) — but
it's been made frictionless via a **shareable join link**: each peer's offer/answer
SDP is compressed (`deflate-raw` + base64url) and tucked into the URL hash, so you
hand-carry one short link in each direction.

1. **Host:** click **HOST GAME**, then **Create invite**. The browser gathers ICE
   candidates (a second or two) and produces a short **invite link** like
   `http://…/#o=<code>`. Click **Copy link**.
2. Send that link to the joining player (AirDrop, iMessage, chat — any out-of-band
   channel).
3. **Player:** open the link. The page auto-detects the `#o=` hash, auto-creates
   the answer, and shows a short **answer link** (`#a=<code>`) with a **Copy**
   button — no clicks needed beyond copying. (If you'd rather paste the link
   manually, click **JOIN GAME** and paste it into the *paste invite link* box; the
   answer is generated the same way.)
4. **Player:** send the answer link back to the host.
5. **Host:** paste the answer link into the *paste player answer* box. It
   auto-connects on paste (the manual **ADD PLAYER** button does the same). The data
   channels open and the player appears in the connected-players list. Repeat
   steps 1–5 (one fresh invite link per player) to add more players — each invite
   carries an id so a returned answer routes to the right pending connection.
6. **Host:** pick a **map** from the lobby's map selector (host-only; the choice is
   broadcast to every connected client so all peers load the same map). Then click
   **Start match**. Each connected client auto-enters the game on the host's chosen
   map and the host begins broadcasting the world.

Both peers must be on the **same LAN** (the offer/answer codes only contain
local-network candidates — no public relays). The codes are versioned (`wd1`); a
mismatched/garbled link is rejected with an error line in the lobby.

**Manual / Advanced fallback.** The original raw base64 copy/paste flow is still
available under the **Advanced / manual** disclosure in each lobby panel (host:
read-only OFFER blob + paste-answer blob; client: paste-offer blob + read-only
ANSWER blob). Use it if a browser lacks `CompressionStream`/`DecompressionStream`
or you prefer hand-carrying the raw blobs. Nothing about the old flow changed.

### Serving it for two machines

Each player needs the page served over HTTP (modules + importmap don't work from
`file://`). Two equivalent options:

- **Each machine serves locally:** run `python3 -m http.server 8000` in
  `cod-browser/` on both machines and each opens `http://localhost:8000/`.
- **One machine serves, others open the LAN IP:** one player runs the server, the
  others open `http://<server-LAN-IP>:8000/` (e.g. `http://192.168.1.42:8000/`).

Either way the actual game traffic flows directly peer-to-peer over WebRTC; the
HTTP server only delivers the static files. First load still needs internet access
to fetch three.js from the CDN.

### Multiplayer notes / v1 scope

- Host is fully authoritative for enemies, waves, scoring, pickups, and damage.
- **Clients can be hurt and die.** The host tracks each client's real health and
  reports it in snapshots; enemies in melee range of a client deal authoritative
  damage, and a client crossing 0 HP receives a reliable `dead` message and drops
  to the game-over screen. (Earlier builds hardcoded clients as immortal.)
- Each peer's **active weapon** is synced: the host bills every shot with the
  shooter's actual weapon (shotgun shots carry all pellet rays), and remote avatars
  render the correct gun.
- **Pickups** are host-authoritative: the host decides when a pickup is consumed and
  sends the grant to whoever grabbed it; clients render pickups from snapshots.
- The **map** is chosen by the host in the lobby and carried in the connection
  handshake (plus a live `map` message for mid-lobby changes) so every peer loads
  the identical map.
- Client movement is trusted (LAN co-op); there's no server-side movement
  validation or client reconciliation.
- Remote players and enemies are interpolated one buffer (`~100 ms`) behind for
  smoothness. Shots render as tracers on every peer.

## Architecture

`index.html` loads only `js/main.js` as a module. `main.js` owns the shared
`state` object, runs the requestAnimationFrame loop, and wires six independent
subsystems that communicate only through `state`, a handful of explicit exported
functions, and a per-frame event queue:

- `js/scene.js` — renderer, lighting, skybox, arena geometry, static collision,
  the map registry (`MAPS`, `loadMap`), and the CC0 texture/model asset pipeline
  with procedural fallbacks.
- `js/player.js` — pointer-lock FPS controller, movement, collision, camera.
- `js/weapons.js` — arsenal (`WEAPONS`: pistol/rifle/shotgun), viewmodels, raycast
  firing (per-weapon, multi-pellet), recoil, ammo/reload, weapon switching, and the
  pickup-grant API (`giveWeapon`, `addReserve`). Owns its own reload/switch input.
- `js/enemies.js` — wave spawning, chase AI, contact damage, death (toon-shaded).
- `js/pickups.js` — host-authoritative ammo/weapon pickups, synced over snapshots.
- `js/hud.js` — DOM overlay: crosshair, health, ammo, active weapon, reload bar,
  pickup toasts, score, and start/game-over/lobby (with map selector) screens.
- `js/audio.js` — Web Audio synthesized sound effects.
- `js/net.js` — serverless WebRTC LAN transport: manual (non-trickle) copy/paste
  signaling, host-authoritative star topology, reliable + unreliable data channels,
  and roster keeping. Imports nothing from the other modules; `main.js` wires it to
  the game.
