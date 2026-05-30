# What Makes Bomberman Fun — and How to Borrow It for Our Tank Bomb

A design study of Bomberman / Super Bomberman / Bomberman 64 / battle-mode, framed for the
bomb weapon in our top-down 2D tank arena (plain HTML5 Canvas 2D, Wii-Tanks-style enemy
waves, ricocheting shells, and a cross-blast bomb that already exists in
[`js/bombs.js`](../js/bombs.js)).

The single most important insight, from every source below, is that Bomberman builds depth
from **one verb** (place a bomb) plus **consistent, inspectable spatial rules**. You do not
need more mechanics; you need rules the player can read and simulate. The recurring framing
is the loop **"place, predict, pressure, punish."**
([Breach.gg design analysis](https://breach.gg/blog/super-bomberman-collection-weekly-2026-02-12))

---

## 1. Core Loop & Tension — arming a threat to yourself

The defining tension of Bomberman is that the weapon you place is **as dangerous to you as
to your target**. A bomb has a fuse delay (classically ~2.5–3s; ours is `FUSE = 1.4s`), so
the moment you place it you have created a hazard you must immediately escape. The fun lives
in that window:

- **Risk/reward of timing.** A bomb placed to kill must also leave you an exit. Greedy
  placement — laying a bomb to crack one more block, or to reach a power-up faster — is what
  kills attentive players. The article calls these **self-traps** where *"mistakes become
  lethal"* through the environment rather than direct combat.
  ([Breach.gg](https://breach.gg/blog/super-bomberman-collection-weekly-2026-02-12))
- **The corridor trap.** Because the blast is a `+` cross that travels down straight lines,
  a one-tile-wide corridor is a death funnel: a bomb behind you and a wall ahead leaves
  nowhere to dodge. Veterans habitually place bombs only when they already know their escape
  tile. This is the central skill expression of the whole game.
- **Mental simulation.** Because movement and explosions **snap to a grid**, players can
  *"mentally simulate outcomes several moves ahead"* — they pre-visualize the cross before
  they commit. ([Breach.gg](https://breach.gg/blog/super-bomberman-collection-weekly-2026-02-12))

The fuse is not a limitation to design around; it *is* the game. It converts a trivial input
into a planning problem.

---

## 2. Spatial Mechanics — the grid is the language

Bomberman's board is a tile grid the sources describe as a *"legible combat language where
every tile is a decision point and every destructible block a potential information reveal."*
([Breach.gg](https://breach.gg/blog/super-bomberman-collection-weekly-2026-02-12);
[GameDev.net case study](https://www.gamedev.net/articles/programming/general-and-gameplay-programming/case-study-bomberman-mechanics-in-an-entity-component-system-r3159/))

Key spatial rules:

- **Two block types.** *Hard blocks* are indestructible and define permanent structure (the
  classic checkerboard pillars). *Soft blocks* are destructible, hide power-ups, and are the
  resource you spend bombs to clear. Destroying a soft block reveals information (what's
  inside) and opens new lines of movement and blast.
- **Cross-shaped blast, stopped by walls.** The explosion extends outward in the four
  cardinal directions and **stops at the first wall**, lighting neither further nor through
  it. This is exactly what our `_detonate` already does (step outward per direction, `break`
  at the first `pointInWall`). Walls are therefore *cover*, and corners are *safe pockets*.
- **Blast range and bomb count are separable.** *Firepower* lengthens each arm of the cross
  (Super Bomberman: up to 16 tiles); *bomb count* raises how many bombs can be live at once
  (up to ~10). These two axes feel completely different and scale the game differently.
  ([StrategyWiki: Super Bomberman power-ups](https://strategywiki.org/wiki/Super_Bomberman/Power-ups);
  [Bomberman Wiki: Power-Ups](https://bomberman.fandom.com/wiki/Power-Ups))
- **Chain reactions.** A blast that touches another live bomb detonates it instantly. Players
  deliberately *"place bombs in intersections so that via chain reaction the bombs all
  detonate at the same time,"* covering far more ground than range alone allows — but they
  must *"take into account the fuse of the first bomb and make sure they are out of the way by
  the time the chain detonates."* This is the highest-skill offensive setup in the game.
  ([GameDev.net](https://www.gamedev.net/articles/programming/general-and-gameplay-programming/case-study-bomberman-mechanics-in-an-entity-component-system-r3159/))
- **Kicking & throwing.** The *Kick* power-up lets you push a bomb in a straight line until
  it hits an obstacle; *throw/punch* lifts a bomb over walls. These turn the bomb from a
  static trap into a **projectile / area-denial tool** and dramatically raise the mind-game
  ceiling. ([Bomberman Wiki: Power-Ups](https://bomberman.fandom.com/wiki/Power-Ups))

---

## 3. Power-Up / Escalation Curve — how the felt experience changes

Power-ups mostly drop from **destroyed soft blocks** (and, in some titles, from defeated
enemies), so clearing the board is also how you grow.
([Bomberman Wiki: Power-Ups](https://bomberman.fandom.com/wiki/Power-Ups))

The canonical ladder and how each one *changes the feel*:

| Power-up | Effect | How it changes play |
|---|---|---|
| **Fire / Firepower** | +1 blast tile per arm (cap ~16) | Reach turns local fights into long-range zoning; full-fire is a board-spanning threat. |
| **Bomb Up** | +1 simultaneous live bomb (cap ~10) | Enables chains, multi-lane traps, and saturating an area. |
| **Speed (Roller Skates)** | faster movement | Mobility = survivability and aggression — but *"too many speed increases"* causes overshoot/control loss, a real downside. |
| **Kick** | push bombs in a line | Bombs become projectiles and remote area-denial. |
| **Remote (Detonator)** | detonate on demand, no fuse | Removes timing risk, adds **ambush** — lay a bomb early, trigger when the target walks over it. |
| **Pierce / Penetrating** | blast passes through multiple soft blocks (and items, players) | Defeats cover; only hard blocks stop it. Huge tempo swing. ([Bomberman Wiki: Pierce Bomb](https://bomberman.fandom.com/wiki/Pierce_Bomb)) |

A match therefore has a natural **escalation arc**: *opening* (weak, cautious, clearing
blocks) → *territorial pressure* (range and bomb-count let you contest space) → *forced
endgame*. The Breach.gg analysis notes that *"minor rule changes (power-up frequency, wall
density, sudden-death mechanics) drastically alter tempo and player psychology"* — the
escalation curve is a tuning knob, not a fixed thing.
([Breach.gg](https://breach.gg/blog/super-bomberman-collection-weekly-2026-02-12))

---

## 4. PvP Battle-Mode Fun — mind games and comebacks

Battle mode is where Bomberman became a living-room legend. The fun is overwhelmingly about
**reading the other player** and **controlling space**, not reflexes.
([Bomberman Wiki: Battle Game](https://bomberman.fandom.com/wiki/Battle_Game))

Concrete tactics the strategy sources describe
([Bomber Friends strategy guide](https://bombitgame.com/games/bomber-friends/)):

- **Zoning / area denial:** *"Place a bomb, then immediately move to cut off their escape
  route."* You don't aim a bomb at the enemy; you aim it at the tile they must pass through.
- **Center control:** fight for the middle early as a base for offense.
- **Cornering & inescapable traps:** in team play, *"one player herds enemies toward their
  teammate's bombs"* — herding is more reliable than direct hits.
- **Reading patterns:** *"some players always rush power-ups while others play defensively…
  exploit them"* with targeted placement.
- **Timing windows:** mentally count blast timings to *"move through dangerous areas between
  blasts."*

**Comeback / revenge mechanics** keep eliminated players engaged and prevent runaway leads:

- **Revenge Cart / Bad Bomber:** a knocked-out player rides the edge of the arena and
  **throws bombs back in**, still able to score kills. In the "Super" variant, a revenge kill
  **resurrects** them. This is a brilliant anti-snowball, anti-boredom mechanic.
  ([Bomberman Wiki: Bad Bomber](https://bomberman.fandom.com/wiki/Bad_Bomber);
  [Super Bomberman R Revenge Cart tips](https://www.supercheats.com/ps4/super-bomberman-r/1796/revenge-cart/))
- **Sudden Death / Pressure Blocks:** when the round timer runs low, indestructible blocks
  *"rain from the outside to the center,"* shrinking the arena and crushing anyone caught
  beneath. It *"creates urgency, prevents matches going on indefinitely, and forces players to
  engage,"* breaking stalemates and camping.
  ([Bomberman Wiki: Sudden Death](https://bomberman.fandom.com/wiki/Sudden_Death);
  [Bomberman Wiki: Pressure Block](https://bomberman.fandom.com/wiki/Pressure_Block))

---

## 5. Game Feel / Juice — readability under chaos

The explosion has to *land*. The sources stress that the satisfaction comes from
**telegraphing + payoff + clarity**:

- **Fuse telegraph.** The bomb visibly counts down — a blinking spark / pulse that speeds up
  near detonation, so the player feels the threat ramping. (Our `_renderBomb` already does
  this: `freq = 4 + t * 14`, pulse scale wobble — keep it.)
- **The chunk of the explosion.** A bright hot core fading through orange to smoke, drawn on
  *every* lit cell of the cross simultaneously, so the shape reads instantly. Add a punchy
  screen shake scaled to reach (we already scale `SHAKE` by how far the cross travelled).
- **Readability is a discipline, not a side effect.** Even amid mayhem, Bomberman preserves
  *"distinct character silhouettes, contrasted blast patterns, and iconic power-up designs"* so
  combat stays legible — *"blast radii, line-of-sight and risk zones [are] instantly readable
  without UI clutter."* The grid does this work for free.
  ([Breach.gg](https://breach.gg/blog/super-bomberman-collection-weekly-2026-02-12))
- **Audio** sells the fuse hiss and the detonation thump; the explosion sound is part of how
  players time their escapes by ear.

The principle for us: the cross should be **visible the instant it fires**, fill the lit cells
brightly, and shake/feedback should scale with how big the blast actually was.

---

## 6. Failure Modes — what makes it UNfun

Worth designing *against* explicitly:

- **Cheap / unreadable deaths.** If the blast or fuse isn't clearly telegraphed, death feels
  random rather than earned. The whole appeal collapses if players can't simulate the cross.
- **Kill-boxes from over-tuned power-ups.** Max firepower + many bombs + kick can create
  inescapable saturation where a victim has no counterplay. Caps exist for a reason (fire ~16,
  bombs ~10), and **too much speed actively hurts** via overshoot/loss of control.
  ([StrategyWiki](https://strategywiki.org/wiki/Super_Bomberman/Power-ups))
- **Snowballing.** Whoever grabs power-ups first dominates harder, compounding the lead.
  Revenge Cart and Sudden Death exist precisely to claw this back and keep the loser engaged.
- **Stalemates / camping.** Two cautious players can stall forever; the falling-block timer is
  the structural answer.
- **Randomness.** Power-ups hidden in blocks add variety but, if too swingy, feel like luck.
  Bomberman keeps it tolerable because *which* block you crack is a player choice.

---

## 7. Concrete Takeaways for OUR Tank Game (prioritized)

Context: we already have a grid-snapped cross-blast bomb (walls stop each arm, friendly fire
on, HP-based kill so it one-shots normal enemies but not bosses, `MAX_PER_OWNER = 2`,
`REACH = 3`, `FUSE = 1.4s`). Against Wii-Tanks-style AI waves rather than human PvP, the goal
is to turn the bomb from "AoE damage button" into a **spatial / herding tool**. Priorities:

1. **Chain reactions (do this first).** When a blast cell overlaps another live bomb,
   detonate it immediately. *Why:* it's the signature skill expression and we already iterate
   cells in `_detonate` and own all bombs in one array — trivial to add a "did this cell hit a
   live bomb?" check that calls `_detonate(other)`. **Effort: low. Fit: perfect.**

2. **Destructible cover blocks.** Add soft/destructible map cells the blast clears (and which
   stop the cross like walls until destroyed). *Why:* this is what makes placement a *spatial
   puzzle* instead of just damage; it also gates power-up drops. Needs map support for a
   destructible cell type + redrawing. **Effort: medium. Fit: high — it's the heart of
   Bomberman.**

3. **Power-up drops from destroyed enemies/blocks: Fire Range +1 and Bomb Up +1.** Make
   `REACH` and `MAX_PER_OWNER` per-player stats that power-ups increment (with caps). *Why:*
   gives the run an escalation arc and a reason to use bombs aggressively. We already read
   `this.cfg`; move REACH/cap onto the owner. **Effort: low–medium. Fit: high.**

4. **Kick / shove bombs.** Let the tank push a bomb in a straight line (stops at first wall) —
   maps naturally onto a tank ramming. *Why:* converts the bomb into a projectile and an
   area-denial tool to herd AI tanks into corridors. Reuses the same `pointInWall` stepping.
   **Effort: medium. Fit: very high for a tank (ramming reads naturally).**

5. **Remote detonate.** A power-up (or alt-fire) that lets you trigger your bomb on demand
   instead of waiting for the fuse. *Why:* enables ambushes — lay a bomb on a choke the AI
   patrols and pop it when a tank rolls over. We already separate fuse-tick from `_detonate`,
   so this is just "skip the countdown on input." **Effort: low. Fit: high.**

6. **Area-denial AI awareness.** Give enemy tanks a cheap "avoid lit/about-to-be-lit blast
   cells" steering check so the bomb can *herd* them, not just damage them. *Why:* this is
   what makes bombs *tactical* vs. waves rather than a nuke button; it's the single-player
   analogue of zoning an opponent. **Effort: medium (touches enemy AI in
   [`js/enemies.js`](../js/enemies.js)). Fit: high — turns bombs into control.**

7. **Pierce bomb (later).** A power-up making the cross pass through one destructible block
   instead of stopping. *Why:* satisfying tempo swing once destructible cover exists; cheap
   once #2 is in (just don't `break` on the first soft block). **Effort: low after #2. Fit:
   medium.**

8. **Juice polish (ongoing).** Keep the speeding-fuse blink; ensure the cross paints all cells
   the frame it fires; scale shake to reach (done); add a fuse-hiss + detonation thump if/when
   audio lands. **Effort: low. Fit: keep doing it.**

**Deliberately skip / deprioritize for a single-player wave game:** Revenge Cart and falling
Pressure-Block sudden-death are PvP anti-snowball/anti-stalemate tools — they don't map to
PvE waves. Borrow their *spirit* instead: e.g. a wave timer that spawns reinforcements (the
"engage now" pressure) rather than crushing the player. Also keep firepower/speed **capped** —
uncapped speed is a known feel-killer, and uncapped saturation creates kill-boxes.

---

### Sources

- [Breach.gg — Super Bomberman Collection design analysis ("place, predict, pressure, punish")](https://breach.gg/blog/super-bomberman-collection-weekly-2026-02-12)
- [GameDev.net — Case Study: Bomberman Mechanics (chain reactions, fuse timing, blast)](https://www.gamedev.net/articles/programming/general-and-gameplay-programming/case-study-bomberman-mechanics-in-an-entity-component-system-r3159/)
- [Bomberman Wiki — Power-Ups](https://bomberman.fandom.com/wiki/Power-Ups)
- [StrategyWiki — Super Bomberman / Power-ups (caps, speed downside)](https://strategywiki.org/wiki/Super_Bomberman/Power-ups)
- [Bomberman Wiki — Pierce Bomb](https://bomberman.fandom.com/wiki/Pierce_Bomb)
- [Bomberman Wiki — Battle Game](https://bomberman.fandom.com/wiki/Battle_Game)
- [Bomberman Wiki — Bad Bomber / Revenge Cart](https://bomberman.fandom.com/wiki/Bad_Bomber)
- [SuperCheats — Super Bomberman R Revenge Cart tips](https://www.supercheats.com/ps4/super-bomberman-r/1796/revenge-cart/)
- [Bomberman Wiki — Sudden Death](https://bomberman.fandom.com/wiki/Sudden_Death)
- [Bomberman Wiki — Pressure Block](https://bomberman.fandom.com/wiki/Pressure_Block)
- [Bomb It Game — Bomber Friends strategy (zoning, herding, escape routes)](https://bombitgame.com/games/bomber-friends/)
