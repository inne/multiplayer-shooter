# Netcode (preserved for tank multiplayer)

`net.js` is the serverless WebRTC host/client wrapper (Trystero 0.21.8, MIT)
carried over from the original browser-FPS that previously lived in this repo.
It is **not yet wired into the tank game** — it's kept here so tank multiplayer
(host-authoritative: room create/join via invite link, snapshot/replay) can reuse
it later.

Key API: `startHost` / `startJoin`, `createInviteLink` / `acceptAnswerCode`,
`send` / `broadcast` / `sendToHost`, `getRoster`, `setCallbacks`, `PROTO`,
`TICK_RATE`, `INTERP_DELAY`.

Usage notes from the FPS:
- Trystero is loaded via an import map (bare specifiers `trystero`,
  `trystero/mqtt|nostr|torrent` mapped to esm.sh) — see the `fps-archive` branch
  on the remote for the full original integration (index.html import map + main.js).
- Relay strategy was pinned into the invite link to avoid dead-relay flakiness.

The complete original FPS (including how net.js was driven) is preserved on the
remote branch `fps-archive`.
