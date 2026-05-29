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
enemies directly in front of the camera, drops **one ammo + one weapon pickup**
just ahead of the player, and renders continuously — so a single screenshot
captures the gun + first-person hands + enemies + pickups + environment. Optional
params:

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
mode is active it also sets
`window.__COD_DEV_READY = { map, weapon, enemies, pickups: true }` so an external
verifier can detect readiness; the two dev pickups are appended to the active
map's pad set via the public `pickups.loadForMap()`, so they spawn, bob/spin, and
are collectible exactly like normal map pickups.)

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

### First-person arms & sound

Every weapon now shows **procedural toon arms/hands** gripping the gun (a trigger
hand on all weapons, plus a forward support hand on the rifle and shotgun). The
arms ride the viewmodel — they bob/sway with idle, snap back on recoil, and dip on
reload — and survive the async GLB viewmodel swap, so they never vanish.

Each weapon also plays **per-weapon sound effects** (distinct fire, reload, and an
empty-mag click) from bundled **CC0** samples under `assets/sfx/`. The fire and
reload cues are chosen by the active weapon (pistol / rifle / shotgun). If a sample
is missing or fails to decode, audio falls back to the original WebAudio synth, so
sound never 404s, double-plays, or breaks. These are pure client-side reactions to
already-synced events, so single-player and host-authoritative multiplayer are
unaffected (no audio is added to the wire protocol).

### Arsenal

You start with a **rifle** (full-auto, 30-round mag) and a **pistol** (semi-auto,
hard-hitting, 12-round mag). The **shotgun** (8 pellets per shot, brutal up close)
is locked until you find it as a pickup. Each weapon keeps its own ammo across
switches, and reloads only pull from that weapon's reserve.

### Pickups

Floating, spinning **pickups** spawn on pads around the arena, each marked by a
bright kind-tinted ground ring **and a thin emissive "loot beacon" beam** so
they're easy to spot from across the map, even behind crate cover:

- **Ammo boxes** (blue ring/beam) top up your reserve ammo.
- **Weapon crates** (gold ring/beam) grant a new weapon (e.g. the shotgun) and top
  up its magazine.

Walk over a pickup to grab it; it respawns on the same pad after a short delay
(~15 s ammo, ~25 s weapons). In multiplayer the host owns when a pickup is
consumed and grants the effect to whoever grabbed it (clients render the pickups
from host snapshots and mirror the grant locally).

### Maps

Three distinct maps ship in: **Warehouse** (cool concrete baseline), **Desert**
(sandy, sparse tall cover, warm low sun), and **Night City** (dark, neon container
crates, colored accent lights). All maps share the same arena dimensions but
differ in cover layout, palette, lighting, skybox, and pickup geography. Single-
player defaults to Warehouse; the host picks the map in the lobby (see below).

## Multiplayer (serverless WebRTC co-op, room-based matchmaking)

The start screen also has **HOST GAME** and **JOIN GAME** buttons. Multiplayer is
host-authoritative co-op: the host runs the real simulation (enemies, spawns,
damage, scoring) and broadcasts world snapshots; clients send their input and
render what the host reports. Single-player is unchanged — if you click
**CLICK TO PLAY** none of the networking runs.

### How it connects — a shareable room link, no server you run

There is **no backend you run**. Matchmaking/signaling uses **Trystero** (MIT,
pinned `0.21.8`, loaded from esm.sh) over **free public relays** — Nostr by
default, with MQTT and BitTorrent-tracker fallbacks if a relay family is blocked.
The relays are used only to exchange the WebRTC handshake; once connected, **all
game data flows directly peer-to-peer over WebRTC**, exactly as before. No accounts,
no API keys.

The flow needs **no manual code exchange**:

1. **Host:** click **HOST GAME**. The host joins a freshly-generated room on the
   relays and shows a short **room link** like `http://…/?room=<id>`. Click
   **COPY ROOM LINK**.
2. Send that link to the other player (AirDrop, iMessage, chat — any channel).
3. **Player:** open the link. Their client **auto-connects** to the room via the
   public relays and appears in the host's lobby under **PENDING JOINERS** (the
   client just watches a phase indicator: *connecting → waiting for host to
   accept → accepted*).
4. **Host:** click **ACCEPT** next to each pending joiner to admit them. This is
   the host's explicit gate — only admitted players enter the roster and receive
   game traffic; un-admitted peers sit connected-but-ignored and can't inject
   input or fire into the match.
5. **Host:** pick a **map** from the lobby's map selector (host-only; the choice is
   broadcast to every connected client so all peers load the same map). Then click
   **START MATCH**. Every admitted client enters the game together on the host's
   chosen map and the host begins broadcasting the world.

The room id is the join capability (knowing it lets a peer *connect*; they still
need the host's **ACCEPT**). The protocol is versioned (`wd1`); the room id is a
short Crockford-base32 token (~35 bits).

> **Tradeoff:** initial matchmaking rides free **public relays** (Nostr / MQTT /
> torrent trackers), not pure copy-paste. Some corporate/school networks block the
> outbound relay WebSockets — if that happens, the host's lobby falls back to the
> manual flow automatically and tells you so. Game data itself is still P2P WebRTC.

### Manual / Advanced fallback (copy-paste, no relays)

The original raw copy-paste signaling flow is preserved under the **Advanced /
manual** disclosure in each lobby panel, so nothing regresses if relays are down:

1. **Host:** open Advanced → **CREATE INVITE**. The browser gathers ICE candidates
   and produces a short **invite link** (`#o=<code>`) — **COPY LINK** and send it.
2. **Player:** open the link (or paste it into Advanced → *paste invite link*). The
   page auto-creates a short **answer link** (`#a=<code>`); copy it back to the host.
3. **Host:** paste the answer into Advanced → *paste player answer*. It auto-connects
   on paste (the **ADD PLAYER** button does the same), and the player joins. Repeat
   per player. Raw base64 OFFER/ANSWER blob textareas are there too for browsers
   without `CompressionStream`/`DecompressionStream`.

This fallback is **LAN-oriented** (the codes only carry local-network candidates —
no relays). Then pick a map and **START MATCH** as above.

### Serving it for two machines

Each player needs the page served over HTTP/HTTPS (modules + importmap don't work
from `file://`). For the **room flow** both peers can be on different networks; for
the **manual fallback** they must share a LAN. Options:

- **GitHub Pages / any HTTPS host:** push the static files; both players open the
  same `https://…/?room=<id>` link. The relays are reachable from an HTTPS page.
- **Each machine serves locally:** run `python3 -m http.server 8000` in
  `cod-browser/` on both machines and each opens `http://localhost:8000/`.
- **One machine serves, others open the LAN IP:** one player runs the server, the
  others open `http://<server-LAN-IP>:8000/` (e.g. `http://192.168.1.42:8000/`).

Either way the actual game traffic flows directly peer-to-peer over WebRTC; the
HTTP server only delivers the static files. First load needs internet access to
fetch three.js and Trystero from the CDN.

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
- `js/net.js` — serverless WebRTC transport. Two signaling paths behind one
  callback contract (`onMessage`/`onPeerJoin`/`onPeerLeave`/`onOpen`/`onClose`):
  the **room** path (Trystero over public relays, with a host **ACCEPT** admission
  gate) and the manual (non-trickle) **copy/paste** fallback. Host-authoritative
  star topology, roster keeping, and the `{t:…}` message envelope are shared by
  both. Imports nothing from the other game modules; `main.js` wires it to the game
  (and carries a parallel room adapter so the relay transport is exercised under
  the same contract).
