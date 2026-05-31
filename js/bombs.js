// Bombs: bomberman-style CROSS-blast bombs for the top-down tank game.
//
// A dropped bomb sits with a short fuse, then detonates in a PLUS/CROSS:
// from its home cell it extends up to REACH cells along each of the four
// cardinal directions, STOPPING at the first wall (tested per cell-center
// via map.pointInWall). Any tank/enemy whose center lies inside a lit blast
// cell dies (friendly fire included — the player can blow themselves up).
//
// WF1 single-player core. State is plain serializable fields (x, y, owner,
// fuse, id, cells[]) so later host-authoritative netcode can snapshot/replay
// bombs without changes. Deterministic against wall-rect DATA, never sprites.
//
// Plain Canvas 2D, ES module, no build step. Procedural fallback if the bomb
// sprite or puff frames are missing.
//
// Public API:
//   create(opts)              -> BombSystem
//   sys.drop(x, y, owner)     -> bomb | null   (place a bomb; capped per owner)
//   sys.update(dt)            -> void           (tick fuses, detonate, kill)
//   sys.render(ctx, cam, imgs)-> void           (cam: { scale, offsetX, offsetY })
//
// Collaborators (injected via create):
//   map         : must expose pointInWall(x, y) -> bool and cellSize.
//   getTanks()  : -> array of tanks/enemies { id, x, y, alive, radius? }.
//   onExplosion(x,y,scale) : optional, push an explosion/whitePuff into world.
//   onShake(amount)        : optional, add screen shake (e.g. along the cross).
//   onDetonate(x,y,owner)  : optional, fired ONCE at detonation (e.g. to kick
//                            off the WebGL "black hole" lens at the bomb's heart).

export const BOMB_CONFIG = {
  FUSE: 2.0,            // seconds before detonation (longer — more time to react/place)
  REACH: 3,            // blast extent in cells along each cardinal direction
  BLAST_DURATION: 0.45, // seconds the blast stays lit (lethal + visible)
  MAX_PER_OWNER: 2,    // live bombs cap, per owning id
  RADIUS: 16,          // bomb body radius (px, for the sprite/circle)
  SHAKE: 12,           // base screen shake on detonation
  KILL_PAD: 2,         // px slack when testing centers inside a blast cell
  BLAST_DAMAGE: 5,     // HP subtracted by a blast cell (one-shots normal enemies)
};

// Cardinal directions in cell steps: N, S, E, W.
const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
];

export class BombSystem {
  constructor(opts = {}) {
    this.map = opts.map || null;
    this.getTanks = opts.getTanks || (() => []);
    this.onExplosion = opts.onExplosion || null;
    this.onShake = opts.onShake || null;
    this.onDetonate = opts.onDetonate || null;
    this.onBlockDestroyed = opts.onBlockDestroyed || null; // (x,y) per crate cleared
    this.onKill = opts.onKill || null; // (tank, bomb) when a blast destroys a tank
    this.onBeep = opts.onBeep || null; // (t) fuse tick; t=0..1 = how close to detonation

    this.cfg = { ...BOMB_CONFIG, ...(opts.config || {}) };

    this.bombs = [];   // live bombs (plain serializable objects)
    this.time = 0;     // accumulated sim time (seconds)
    this._nextId = 1;
  }

  // Cell size from the map (fallback keeps node --check / headless tests sane).
  get cellSize() {
    return (this.map && this.map.cellSize) || 64;
  }

  // Count live bombs belonging to an owner id.
  _liveForOwner(ownerId) {
    let n = 0;
    for (const b of this.bombs) if (b.owner === ownerId) n++;
    return n;
  }

  // Drop a bomb at world (x, y), snapped to its cell center. Returns the bomb,
  // or null if the owner is already at its live-bomb cap.
  drop(x, y, owner) {
    const ownerId = owner && owner.id != null ? owner.id : owner;
    // Bomb count + blast reach are PER-OWNER stats (power-ups raise them on the
    // player); fall back to the global config for owners without their own.
    const cap = (owner && owner.bombMax) || this.cfg.MAX_PER_OWNER;
    if (this._liveForOwner(ownerId) >= cap) return null;

    const cs = this.cellSize;
    const col = Math.floor(x / cs);
    const row = Math.floor(y / cs);

    const bomb = {
      id: this._nextId++,
      owner: ownerId,
      col,
      row,
      // Snap to the cell center so the cross lines up with the grid.
      x: (col + 0.5) * cs,
      y: (row + 0.5) * cs,
      fuse: this.cfg.FUSE,    // counts DOWN to 0
      born: this.time,
      exploded: false,
      blast: 0,               // remaining blast-lit time once detonated
      cells: null,            // lit cell centers [{x,y}] computed at detonation
      // Reach captured at drop time from the owner (so later power-ups don't
      // retroactively grow bombs already on the ground).
      reach: (owner && owner.bombReach) || this.cfg.REACH,
      beepTimer: 0, // counts down to the next fuse beep (0 -> beep on first tick)
    };
    this.bombs.push(bomb);
    return bomb;
  }

  // Advance all bombs by dt: tick fuses, detonate (compute cross + kill), then
  // hold the blast lit for BLAST_DURATION before removing the bomb.
  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;

    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];

      if (!b.exploded) {
        b.fuse -= dt;
        // Accelerating fuse beep: the interval shrinks (and the caller raises the
        // pitch) as the fuse runs out, building into the strobe + detonation.
        if (this.onBeep && b.fuse > 0) {
          b.beepTimer -= dt;
          if (b.beepTimer <= 0) {
            const t = Math.min(1, Math.max(0, 1 - b.fuse / this.cfg.FUSE));
            this.onBeep(t);
            // ~0.5s between beeps early -> ~0.08s right before it blows.
            b.beepTimer = Math.max(0.08, 0.5 - 0.42 * (t * t));
          }
        }
        if (b.fuse <= 0) this._detonate(b);
        continue;
      }

      // Post-detonation: blast stays lethal + visible for a short window.
      b.blast -= dt;
      if (b.blast <= 0) this.bombs.splice(i, 1);
    }
  }

  // Compute the CROSS of lit cells, fire FX/shake, and kill anything centered
  // in a lit cell. Walls stop the blast: along each direction we step outward
  // and stop at the first cell whose center is inside a wall.
  _detonate(b) {
    b.exploded = true;
    b.fuse = 0;
    b.blast = this.cfg.BLAST_DURATION;

    const cs = this.cellSize;
    const cells = [{ x: b.x, y: b.y }]; // home cell is always lit
    const reach = b.reach || this.cfg.REACH; // per-bomb (power-up driven)

    for (const d of DIRS) {
      for (let step = 1; step <= reach; step++) {
        const cx = (b.col + d.dx * step + 0.5) * cs;
        const cy = (b.row + d.dy * step + 0.5) * cs;
        // Destructible crate: blow it up, LIGHT this cell, then stop the arm
        // (the blast clears the crate but doesn't pass through it).
        if (this.map && this.map.softBlockAt) {
          const soft = this.map.softBlockAt(cx, cy);
          if (soft) {
            this.map.destroySoftBlock(soft);
            cells.push({ x: cx, y: cy });
            if (this.onBlockDestroyed) this.onBlockDestroyed(cx, cy);
            break;
          }
        }
        // Hard wall: stop at it (and don't light the wall cell itself).
        if (this.map && this.map.pointInWall && this.map.pointInWall(cx, cy)) {
          break;
        }
        cells.push({ x: cx, y: cy });
      }
    }
    b.cells = cells;

    // FX: an explosion puff on every lit cell, biggest at the bomb's heart.
    if (this.onExplosion) {
      this.onExplosion(b.x, b.y, 1.6);
      for (const c of cells) {
        if (c.x === b.x && c.y === b.y) continue;
        this.onExplosion(c.x, c.y, 1.0);
      }
    }
    // Shake scaled a touch by how far the cross reached.
    if (this.onShake) {
      const reach = cells.length / (1 + this.cfg.REACH * 4);
      this.onShake(this.cfg.SHAKE * (0.7 + 0.6 * reach));
    }
    // One-shot detonation hook (e.g. the black-hole lens) at the bomb's heart.
    if (this.onDetonate) this.onDetonate(b.x, b.y, b.owner);

    this._killInCells(b, cells, cs);

    // CHAIN REACTION: any OTHER live bomb caught in this blast detonates NOW,
    // recursively. Safe/terminating because _detonate sets b.exploded = true
    // up-front, so an already-triggered bomb is skipped below.
    this._chainDetonate(b, cells, cs);
  }

  // Detonate any not-yet-exploded bomb whose body sits in one of `cells` (the
  // signature Bomberman chain). Uses the same half-cell box as the kill test.
  _chainDetonate(b, cells, cs) {
    const half = cs / 2 + this.cfg.KILL_PAD;
    for (const o of this.bombs) {
      if (o === b || o.exploded) continue;
      for (const c of cells) {
        if (Math.abs(o.x - c.x) <= half && Math.abs(o.y - c.y) <= half) {
          this._detonate(o);
          break;
        }
      }
    }
  }

  // Kill every alive tank/enemy whose center lies within a lit blast cell.
  // Uses a half-cell + KILL_PAD box around each cell center so a center sitting
  // anywhere in the cell counts (friendly fire included — owner can die too).
  _killInCells(b, cells, cs) {
    const tanks = this.getTanks() || [];
    const half = cs / 2 + this.cfg.KILL_PAD;

    for (const t of tanks) {
      if (!t || t.alive === false) continue;
      for (const c of cells) {
        if (Math.abs(t.x - c.x) <= half && Math.abs(t.y - c.y) <= half) {
          this._kill(t, b);
          break;
        }
      }
    }
  }

  // Heavy blast damage. Respects the HP system (so it doesn't one-shot a high-hp
  // boss) while still wiping out any normal enemy: subtract BLAST_DAMAGE from
  // hp and only flag dead at hp<=0. A focused pop at the victim either way.
  _kill(tank, bomb) {
    if (tank.alive === false) return;
    const dmg = this.cfg.BLAST_DAMAGE;
    if (tank.hp == null) tank.hp = tank.maxHp || 1;
    tank.hp -= dmg;
    // A focused pop at the victim too, for readable feedback.
    if (this.onExplosion) this.onExplosion(tank.x, tank.y, 1.3);
    if (tank.hp <= 0) {
      tank.hp = 0;
      tank.alive = false;
      tank.vx = 0;
      tank.vy = 0;
      // Notify the world so the kill is handled like a shell kill (game-over
      // for the player — incl. blowing YOURSELF up — kill juice, enemy drops).
      if (this.onKill) this.onKill(tank, bomb);
    }
  }

  // Render every live bomb. cam maps world -> screen via a single uniform
  // scale (matching the project's fixed full-arena camera). We set the canvas
  // transform once and draw in world units. imgs may carry a bomb sprite and
  // a whitePuff frame sequence (imgs.puff = [HTMLImageElement, ...]).
  render(ctx, cam, imgs) {
    if (!ctx) return;
    const scale = (cam && cam.scale) || 1;
    const ox = (cam && cam.offsetX) || 0;
    const oy = (cam && cam.offsetY) || 0;
    const images = imgs || this.images || {};
    const cs = this.cellSize;

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    for (const b of this.bombs) {
      if (b.exploded) this._renderBlast(ctx, b, cs, images);
      else this._renderBomb(ctx, b, images);
    }

    ctx.restore();
  }

  // A live (ticking) bomb: pulsing sprite/circle. Pulse speeds up as the fuse
  // runs out, peaking just before detonation.
  _renderBomb(ctx, b, images) {
    const r = this.cfg.RADIUS;
    // 0 at drop -> 1 at detonation. Blink rate ramps QUADRATICALLY so the bomb
    // goes from a slow throb to a frantic strobe right before it blows. Clamped
    // to [0,1] so an out-of-range fuse can never produce a negative draw scale.
    const t = Math.min(1, Math.max(0, 1 - Math.max(0, b.fuse) / this.cfg.FUSE));
    const freq = 3 + t * t * 42; // rad/s: ~3 at drop -> ~45 at detonation
    const pulse = 0.5 + 0.5 * Math.sin((this.time - b.born) * freq);
    const amp = 0.12 + 0.3 * t;  // scale wobble grows as the fuse runs out
    const s = 1 + amp * pulse;

    ctx.save();
    ctx.translate(b.x, b.y);

    // "About to blow" warning: a red glow over the last ~half of the fuse that
    // pulses brighter/bigger in lockstep with the strobe.
    const warn = Math.max(0, (t - 0.5) / 0.5);
    if (warn > 0) {
      ctx.save();
      ctx.globalAlpha = warn * (0.3 + 0.5 * pulse);
      const gr = r * (1.5 + 0.9 * pulse);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
      g.addColorStop(0, "rgba(255,70,40,0.95)");
      g.addColorStop(1, "rgba(255,70,40,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, gr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const img = images.bomb;
    if (img) {
      const dw = r * 2 * s;
      const dh = dw * (img.height / img.width || 1);
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    } else {
      // Procedural fallback: a dark round bomb body with a blinking fuse spark.
      ctx.beginPath();
      ctx.arc(0, 0, r * s, 0, Math.PI * 2);
      ctx.fillStyle = "#1c1c20";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#000";
      ctx.stroke();
      // Highlight glint.
      ctx.beginPath();
      ctx.arc(-r * 0.35, -r * 0.35, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fill();
      // Fuse spark on top, brightening with the pulse.
      ctx.beginPath();
      ctx.arc(0, -r * s, r * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,${120 + Math.floor(120 * pulse)},40,${0.6 + 0.4 * pulse})`;
      ctx.fill();
    }

    ctx.restore();
  }

  // The detonation blast across the cross of lit cells: a whitePuff frame (if
  // supplied) plus a procedural flame, fading over BLAST_DURATION.
  _renderBlast(ctx, b, cs, images) {
    if (!b.cells) return;
    const life = 1 - Math.max(0, b.blast) / this.cfg.BLAST_DURATION; // 0 -> 1
    const alpha = 1 - life;                                          // 1 -> 0

    const puff = Array.isArray(images.puff) ? images.puff : null;

    for (const c of b.cells) {
      ctx.save();
      ctx.translate(c.x, c.y);

      if (puff && puff.length) {
        const idx = Math.min(puff.length - 1, Math.floor(life * puff.length));
        const frame = puff[idx];
        if (frame) {
          ctx.globalAlpha = alpha;
          const sz = cs * 1.1;
          ctx.drawImage(frame, -sz / 2, -sz / 2, sz, sz);
          ctx.restore();
          continue;
        }
      }

      // Procedural flame: bright hot core, fading to smoke ring.
      const grow = 0.4 + 0.6 * life;
      const rad = (cs / 2) * grow;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
      g.addColorStop(0, `rgba(255,245,200,${0.95 * alpha})`);
      g.addColorStop(0.45, `rgba(255,150,40,${0.8 * alpha})`);
      g.addColorStop(1, `rgba(120,40,10,0)`);
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.restore();
    }
  }

  // Serializable view of all live bombs (snapshot-friendly for later netcode
  // and for __TANK_DEBUG: bombs:[{x,y,fuse}]).
  snapshot() {
    return this.bombs.map((b) => ({
      x: round(b.x),
      y: round(b.y),
      fuse: round(Math.max(0, b.fuse)),
      owner: b.owner,
      id: b.id,
      exploded: b.exploded,
    }));
  }
}

function round(v, dp = 2) {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

// Factory so callers can `create({ map, getTanks, ... })` without `new`.
export function create(opts) {
  return new BombSystem(opts);
}

export default { create, BombSystem, BOMB_CONFIG };
