// Shells: slow, ricocheting projectile system for the top-down tank game.
//
// WF1 single-player core. This module owns the shell list and the kill/explosion
// resolution that shells cause. State is kept as plain serializable fields
// (x, y, vx, vy, bounces, born, owner, id) so a later workflow can drop in
// host-authoritative networking and snapshot/replay shells without changes.
//
// Plain Canvas 2D, ES module, no build step. Procedural fallback if the shell
// sprite is missing.
//
// Public API:
//   create(opts)            -> ShellSystem
//   sys.fire(owner)         -> shell | null   (spawn from owner's turret muzzle)
//   sys.update(dt)          -> void           (move, reflect, expire, kill)
//   sys.render(ctx, cam)    -> void           (cam: { scale, offsetX, offsetY })
//
// Collaborators (injected via create):
//   map       : must expose either map.reflectShell(shell, radius) -> bool,
//               or a wall list (map.walls) so we can do AABB reflection here.
//   getTanks(): -> array of tanks { id, x, y, alive, ... } to test/kill against.
//   onKill(tank, shell)   : optional, called when a shell kills a tank.
//   onExplosion(x,y,scale): optional, push an explosion into the world.
//   images    : optional sprite map (images.shell) for rendering.

// Deliberately slow — suits future host-authoritative netcode.
export const SHELL_CONFIG = {
  SPEED: 300,          // px/s — fast enough to cross the larger arena
  RADIUS: 7,           // px (matches the bigger ~turret-width visual)
  MAX_BOUNCES: 4,      // expire after roughly this many wall bounces
  LIFETIME: 5.0,       // seconds (range ~1500px, covers the arena)
  MAX_PER_OWNER: 5,    // live shells cap, per owning tank id
  DAMAGE: 1,           // hp removed per hit (tanks/enemies have hp; die at 0)
  MUZZLE_OFFSET: 22,   // spawn distance in front of the turret pivot
  TANK_RADIUS: 16,     // used for shell/tank hit test if a tank omits radius
};

// Per-bulletKey render overrides for "special" projectiles. Anything not listed
// renders as a normal ~12px bolt oriented to its flight direction.
const BULLET_RENDER = {
  // The Windows Me logo xBill lobs: drawn big and tumbling (spin rad/s).
  winme: { width: 30, spin: 3.0 },
};

export class ShellSystem {
  constructor(opts = {}) {
    this.map = opts.map || null;
    this.getTanks = opts.getTanks || (() => []);
    this.onKill = opts.onKill || null;
    this.onHit = opts.onHit || null; // non-lethal hit (target survived with hp>0)
    this.onExplosion = opts.onExplosion || null;
    this.images = opts.images || null;

    // Allow per-instance tuning while keeping sane defaults.
    this.cfg = { ...SHELL_CONFIG, ...(opts.config || {}) };

    this.shells = [];     // live shells (plain serializable objects)
    this.time = 0;        // accumulated sim time (seconds)
    this._nextId = 1;
  }

  // Count live shells belonging to an owner id.
  _liveForOwner(ownerId) {
    let n = 0;
    for (const s of this.shells) if (s.owner === ownerId) n++;
    return n;
  }

  // Spawn a shell from the owner's turret muzzle. Returns the shell, or null
  // if the owner is dead/missing or already at its live-shell cap.
  fire(owner) {
    if (!owner || owner.alive === false) return null;
    const ownerId = owner.id;
    if (this._liveForOwner(ownerId) >= this.cfg.MAX_PER_OWNER) return null;

    const a = owner.turretAngle ?? owner.bodyAngle ?? 0;
    const ca = Math.cos(a);
    const sa = Math.sin(a);

    const shell = {
      id: this._nextId++,
      owner: ownerId,
      x: owner.x + ca * this.cfg.MUZZLE_OFFSET,
      y: owner.y + sa * this.cfg.MUZZLE_OFFSET,
      vx: ca * this.cfg.SPEED,
      vy: sa * this.cfg.SPEED,
      bounces: 0,
      born: this.time,
      bulletKey: owner.bullet || null, // per-color bullet sprite (matches tank)
      armed: false, // can't hit its OWNER until it has cleared the muzzle (below)
    };
    this.shells.push(shell);
    return shell;
  }

  // Advance all shells by dt seconds: move, reflect off walls, expire after
  // ~MAX_BOUNCES or ~LIFETIME, and kill any tank whose circle a shell touches
  // (including the owner — friendly fire is real).
  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;

    const r = this.cfg.RADIUS;
    const tanks = this.getTanks() || [];

    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];

      // Lifetime expiry.
      if (this.time - s.born > this.cfg.LIFETIME) {
        this.shells.splice(i, 1);
        continue;
      }

      this._move(s, dt, r);

      // Arm against the owner once the shell has cleared the owner's body by a
      // margin (so a shot into an adjacent wall can't ricochet straight back and
      // insta-kill you). A genuinely returning ricochet can still get you.
      if (!s.armed) {
        const o = tanks.find((t) => t && t.id === s.owner);
        if (!o) {
          s.armed = true;
        } else {
          const dx = o.x - s.x;
          const dy = o.y - s.y;
          const arm = (o.radius ?? this.cfg.TANK_RADIUS) + r + 24;
          if (dx * dx + dy * dy > arm * arm) s.armed = true;
        }
      }

      // Bounce-count expiry: a small puff so the ricochet "dies" visibly.
      if (s.bounces > this.cfg.MAX_BOUNCES) {
        this._explode(s.x, s.y, 0.6);
        this.shells.splice(i, 1);
        continue;
      }

      // Tank hits.
      if (this._resolveTankHits(s, tanks, r)) {
        this.shells.splice(i, 1);
        continue;
      }
    }
  }

  // Integrate position and reflect velocity off walls.
  // Prefers map.reflectShell(shell, radius) (lets the map own deterministic
  // wall data); falls back to axis-separated AABB reflection on map.walls.
  _move(s, dt, r) {
    if (this.map && typeof this.map.reflectShell === "function") {
      // Move first, then let the map flip velocity and rewind on a hit.
      const px = s.x;
      const py = s.y;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      // reflectShell should flip the velocity component on the hit axis and
      // may rewind position; treat a truthy return as "bounced this step".
      const bounced = this.map.reflectShell(s, r);
      if (bounced) {
        s.bounces += typeof bounced === "number" ? bounced : 1;
        // Defensive: if the map flipped velocity but left the shell inside a
        // wall, rewind to the pre-move position so we never tunnel through.
        if (this._pointInAnyWall(s.x, s.y, r)) {
          s.x = px;
          s.y = py;
        }
      }
      return;
    }

    // Fallback: axis-separated reflection against AABB wall rects.
    const walls = (this.map && this.map.walls) || [];

    s.x += s.vx * dt;
    if (this._pointInAnyWall(s.x, s.y, r, walls)) {
      s.x -= s.vx * dt;
      s.vx = -s.vx;
      s.bounces++;
    }

    s.y += s.vy * dt;
    if (this._pointInAnyWall(s.x, s.y, r, walls)) {
      s.y -= s.vy * dt;
      s.vy = -s.vy;
      s.bounces++;
    }
  }

  // Circle/AABB overlap test against a wall list (deterministic, data-driven).
  _pointInAnyWall(x, y, r, walls) {
    const list = walls || (this.map && this.map.walls) || [];
    const r2 = r * r;
    for (const w of list) {
      const cx = x < w.x ? w.x : x > w.x + w.w ? w.x + w.w : x;
      const cy = y < w.y ? w.y : y > w.y + w.h ? w.y + w.h : y;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r2) return true;
    }
    return false;
  }

  // Kill the first alive tank a shell overlaps. Returns true if a hit occurred.
  _resolveTankHits(s, tanks, r) {
    for (const t of tanks) {
      if (!t || t.alive === false) continue;
      // Your own shell never kills you (avoids constant self-kills from
      // straight ricochets that retrace their path). Other tanks: always lethal.
      if (t.id === s.owner) continue;
      const tr = (t.radius ?? this.cfg.TANK_RADIUS) + r;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      if (dx * dx + dy * dy <= tr * tr) {
        this._applyDamage(t, s, this.cfg.DAMAGE);
        return true; // shell is consumed on any contact, lethal or not
      }
    }
    return false;
  }

  // Deal `dmg` to a tank's hp; destroy it at 0, otherwise register a non-lethal
  // hit (small spark + onHit callback). hp/maxHp default to 1 if a target omits
  // them (back-compat), so a single hit still kills.
  _applyDamage(tank, shell, dmg) {
    if (tank.alive === false) return;
    if (typeof tank.hp !== "number") tank.hp = tank.maxHp || 1;
    tank.hp -= dmg == null ? 1 : dmg;
    if (tank.hp <= 0) {
      this._kill(tank, shell);
    } else {
      this._explode(tank.x, tank.y, 0.5); // small puff on a non-lethal hit
      if (this.onHit) this.onHit(tank, shell);
    }
  }

  _kill(tank, shell) {
    // Mutate the snapshot-friendly field directly so the world stays simple.
    if (tank.alive !== false) {
      tank.alive = false;
      tank.hp = 0;
      tank.vx = 0;
      tank.vy = 0;
    }
    this._explode(tank.x, tank.y, 1.4);
    if (this.onKill) this.onKill(tank, shell);
  }

  _explode(x, y, scale) {
    if (this.onExplosion) this.onExplosion(x, y, scale);
  }

  // Render every live shell. cam maps world -> screen via a single uniform
  // scale: screenX = world.x * cam.scale + cam.offsetX (matching the project's
  // fixed full-arena camera). We set the canvas transform once and draw in
  // world units so sprite sizing stays consistent with the rest of the game.
  render(ctx, cam) {
    if (!ctx) return;
    const scale = (cam && cam.scale) || 1;
    const ox = (cam && cam.offsetX) || 0;
    const oy = (cam && cam.offsetY) || 0;
    const imgs = this.images || {};
    const r = this.cfg.RADIUS;

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    for (const s of this.shells) {
      // Per-color bullet sprite matching the firing tank; fall back to generic.
      const img = (s.bulletKey && imgs[s.bulletKey]) || imgs.shell;
      const spec = BULLET_RENDER[s.bulletKey];
      ctx.save();
      ctx.translate(s.x, s.y);
      if (img) {
        if (spec && spec.spin) {
          // Special projectile (e.g. the Windows Me logo): spin instead of
          // orienting to flight, so the logo tumbles through the air.
          ctx.rotate(this.time * spec.spin);
        } else {
          // Sprite art points "up" (-Y); world angle 0 = +X, so add 90deg.
          ctx.rotate(Math.atan2(s.vy, s.vx) + Math.PI / 2);
        }
        // Default bullets are ~12px wide; specials override the width.
        const dw = spec ? spec.width : 12;
        const dh = dw * (img.height / img.width || 2.2);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      } else {
        // Procedural fallback: a chunky dark slug.
        ctx.fillStyle = "#2b2b2b";
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  // Serializable view of all live shells (snapshot-friendly for later netcode).
  snapshot() {
    return this.shells.map((s) => ({
      x: round(s.x),
      y: round(s.y),
      vx: round(s.vx),
      vy: round(s.vy),
      bounces: s.bounces,
      owner: s.owner,
      id: s.id,
    }));
  }
}

function round(v, dp = 2) {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

// Factory so callers can `create({ map, getTanks, ... })` without `new`.
export function create(opts) {
  return new ShellSystem(opts);
}

export default { create, ShellSystem, SHELL_CONFIG };
