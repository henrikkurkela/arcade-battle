"use strict";

// ---------------------------------------------------------------------------
// Pooled weapons, shared by the player and every CPU tank.
//
// Tracers: fast straight-line MG rounds. Fixed-size pool of tracer meshes:
// no per-shot allocation, no GC churn. Damage-agnostic: the caller decides
// how much damage each shot does.
//
// Shells: arcing main-gun rounds with splash. They inherit the shooter's
// velocity plus SHELL_SPEED, arc under gravity, and detonate on proximity to
// a tank, on ground impact, or when the fuse runs out — dealing splash damage
// to EVERY tank in the blast radius (with distance falloff) except the
// shooter (owner immunity). rocketLaunchDir() solves the launch direction for
// a ballistic arc onto a target point (used by the AI in M4).
// ---------------------------------------------------------------------------

// --- MG tracers -------------------------------------------------------------
const MG_BULLET_SPEED = 160; // m/s
const MG_BULLET_LIFE = 3; // s (~480 m range)
const MG_HIT_RADIUS = 3.5; // m, 3D distance to a unit's center point
const TRACER_POOL_SIZE = 1024; // pooled tracers (player + CPU volleys in flight)

class Tracers {
  constructor(scene, poolSize = TRACER_POOL_SIZE) {
    this.pool = [];
    this._nextFree = 0;
    const geo = new THREE.BoxGeometry(0.12, 0.12, 2.4);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe066 });
    // One instanced mesh for the whole pool: ~1024 individual draw calls become
    // one. Inactive slots are zero-scale (degenerate, culled by the rasterizer).
    this.im = new THREE.InstancedMesh(geo, mat, poolSize);
    this.im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // updated every frame
    this.im.castShadow = false;
    this.im.frustumCulled = false; // instances span the whole map
    const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < poolSize; i++) {
      this.im.setMatrixAt(i, _zero);
      this.pool.push({
        idx: i,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        damage: 0,
        kind: "soft",
        team: "",
        owner: null,
        life: 0,
      });
    }
    this.im.count = poolSize;
    this.im.instanceMatrix.needsUpdate = true;
    scene.add(this.im);
    // Set by main.js: (owner, victim) => void, called on a lethal hit.
    this.onKill = null;
    // Set by main.js: (owner, victim, dealt) => void, called on every hit.
    this.onDamage = null;
    // Set by main.js: (gun) => void, called when a tracer knocks out an AA gun.
    this.onAADisabled = null;
    // Temp objects for instance-matrix composition (no per-shot allocation).
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._zAxis = new THREE.Vector3(0, 0, 1);
    this._scale = new THREE.Vector3(1, 1, 1);
    this._zero = _zero;
  }

  /** Position + orient instance `e` (box long axis along e.dir). */
  _place(e) {
    this._q.setFromUnitVectors(this._zAxis, e.dir);
    this._m.compose(e.pos, this._q, this._scale);
    this.im.setMatrixAt(e.idx, this._m);
  }

  /** Hide instance `e` (zero-scale). */
  _hide(e) {
    this.im.setMatrixAt(e.idx, this._zero);
  }

  /** Activate one pooled tracer. Drops the shot if the pool is full.
   *  `kind` is the damage kind ("soft" for MG fire). */
  fire(owner, muzzleWorld, dir, damage, kind = "soft") {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[(this._nextFree + i) % this.pool.length];
      if (e.active) continue;
      this._nextFree = (this._nextFree + i + 1) % this.pool.length;
      e.active = true;
      e.owner = owner;
      e.team = owner.team;
      e.pos.copy(muzzleWorld);
      e.dir.copy(dir).normalize();
      // Tracers inherit the shooter's motion.
      e.vel.copy(owner.velocity).addScaledVector(e.dir, MG_BULLET_SPEED);
      e.damage = damage;
      e.kind = kind;
      e.life = MG_BULLET_LIFE;
      this._place(e);
      this.im.instanceMatrix.needsUpdate = true;
      return;
    }
  }

  /** Integrate + collide (ground, all units, AA guns) + apply damage.
   *  `units` = every hittable unit (tanks + riflemen + planes). The pool is
   *  target-agnostic: any tracer can hit any unit (and any AA gun) except
   *  same-team (friendly fire). Which units an AI *aims at* is the AI's choice. */
  update(dt, units, terrain, aaGuns) {
    let changed = false;
    for (const e of this.pool) {
      if (!e.active) continue;
      e.pos.addScaledVector(e.vel, dt);
      e.life -= dt;
      if (e.life <= 0 || e.pos.y < terrain.heightAt(e.pos.x, e.pos.z)) {
        e.active = false;
        this._hide(e);
        changed = true;
        continue;
      }
      let hit = false;
      for (const u of units) {
        if (!u.alive || u.team === e.team) continue;
        if (e.pos.distanceTo(u.position) < MG_HIT_RADIUS) {
          const dealt = u.takeDamage(e.damage, e.kind);
          if (dealt > 0 && this.onDamage) this.onDamage(e.owner, u, dealt);
          if (dealt > 0 && u.hp <= 0 && this.onKill) this.onKill(e.owner, u);
          hit = true;
          break;
        }
      }
      if (hit) {
        e.active = false;
        this._hide(e);
        changed = true;
        continue;
      }
      // AA guns: a tracer within the structure's stand-off chips the gun.
      // AA team weapons never damage AA guns (no friendly fire).
      if (aaGuns && e.team !== "aa") {
        for (const g of aaGuns) {
          if (g.disabled) continue;
          if (e.pos.distanceTo(g.position) < AA_HIT_RADIUS) {
            if (g.takeDamage(e.damage, e.kind) && this.onAADisabled) this.onAADisabled(g);
            e.active = false;
            this._hide(e);
            changed = true;
            break;
          }
        }
      }
      if (!e.active) continue;
      this._place(e);
      changed = true;
    }
    if (changed) this.im.instanceMatrix.needsUpdate = true;
  }

  /** Deactivate everything (used on restart). */
  clear() {
    for (const e of this.pool) {
      e.active = false;
      this.im.setMatrixAt(e.idx, this._zero);
    }
    this.im.instanceMatrix.needsUpdate = true;
  }
}

// --- Main-gun shells ----------------------------------------------------------
const SHELL_SPEED = 140; // m/s (slower than tracers so the arc reads)
const SHELL_LIFE = 8; // s fuse
const SHELL_GRAVITY = 9.8; // m/s^2 (arcs the shell)
const SHELL_FUSE_RADIUS = 5; // m; proximity stand-off that triggers detonation
const BLAST_RADIUS = 12; // m; splash damage radius
// HARD damage (main gun). Boosted 1.25x over the pre-armor values (60/15);
// a tank's TANK_HARD_ARMOR (1.25) cancels it, so a tank still takes 60 at
// the blast center and 15 at the edge.
const SHELL_DAMAGE = 75; // HP at the blast center
const SHELL_DAMAGE_MIN = 18.75; // HP at the blast edge
const SHELL_POOL_SIZE = 64; // pooled shells (player + CPU volleys in flight)

/**
 * Compute the launch direction (unit vector, written into `out`) for a shell
 * fired from `from` at SHELL_SPEED so it arcs under SHELL_GRAVITY onto the
 * point `to`. Uses the low-trajectory solution of the projectile equations.
 * Returns false (leaving `out` unchanged) when `to` is beyond the flat-earth
 * ballistic range. Assumes the shell's initial velocity is SHELL_SPEED along
 * the launch direction (true for a stationary shooter; a moving shooter adds
 * its own velocity on top, a small error at arcade speed).
 */
function rocketLaunchDir(from, to, out) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dh = Math.hypot(dx, dz); // horizontal distance
  if (dh < 1e-3) {
    out.set(0, 1, 0); // target dead ahead vertically: best effort straight up
    return true;
  }
  const k = (SHELL_GRAVITY * dh * dh) / (2 * SHELL_SPEED * SHELL_SPEED);
  const disc = dh * dh - 4 * k * (k + dy);
  if (disc < 0) return false; // out of ballistic range
  const u = (dh - Math.sqrt(disc)) / (2 * k); // tan(elevation), low arc
  const s = Math.sqrt(1 + u * u);
  out.set(dx / dh / s, u / s, dz / dh / s);
  return true;
}

class Shells {
  constructor(scene, poolSize = SHELL_POOL_SIZE) {
    this.pool = [];
    this._nextFree = 0;
    // Shell body: a small cylinder along Z with an ogive tip at the nose (+Z).
    const bodyGeo = new THREE.CylinderGeometry(0.14, 0.14, 1.8, 8).rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x8f9296 });
    const tipGeo = new THREE.ConeGeometry(0.14, 0.5, 8).rotateX(Math.PI / 2);
    const tipMat = new THREE.MeshLambertMaterial({ color: 0x3a3d40 });
    for (let i = 0; i < poolSize; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      const tip = new THREE.Mesh(tipGeo, tipMat);
      tip.position.z = 1.15; // nose at +Z (lookAt points +Z along travel)
      group.add(body, tip);
      group.visible = false;
      scene.add(group);
      this.pool.push({
        group,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        owner: null,
        team: "",
        life: 0,
        damage: SHELL_DAMAGE,
        damageMin: SHELL_DAMAGE_MIN,
      });
    }
    // Base splash damage, exposed so main.js can scale the player's shells
    // (loadouts) and pass the scaled value into fire().
    this.baseDamage = SHELL_DAMAGE;
    this.baseDamageMin = SHELL_DAMAGE_MIN;
    // Set by main.js: (owner, victim, dealt) => void, called on every splash hit.
    this.onDamage = null;
    // Set by main.js: (owner, victim) => void, called on a lethal splash hit.
    this.onKill = null;
    // Set by main.js: (gun) => void, called when a shell splash knocks out an AA gun.
    this.onAADisabled = null;
  }

  /** Launch one shell. Drops it if the pool is full. Returns true if launched.
   *  `damage`/`damageMin` override the base splash damage (loadouts); omit for
   *  the standard value. */
  fire(owner, muzzleWorld, dir, damage, damageMin) {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[(this._nextFree + i) % this.pool.length];
      if (e.active) continue;
      this._nextFree = (this._nextFree + i + 1) % this.pool.length;
      e.active = true;
      e.owner = owner;
      e.team = owner.team;
      e.pos.copy(muzzleWorld);
      e.vel.copy(owner.velocity).addScaledVector(dir, SHELL_SPEED);
      e.life = SHELL_LIFE;
      e.damage = damage ?? this.baseDamage;
      e.damageMin = damageMin ?? this.baseDamageMin;
      e.group.visible = true;
      e.group.position.copy(e.pos);
      return true;
    }
    return false;
  }

  /** Detonate: splash damage to every unit in the blast radius (with falloff),
   *  skipping the shooter (owner immunity), plus any AA guns in the blast.
   *  Calls `onBoom(pos, hitCount)`. */
  _detonate(e, units, aaGuns, onBoom) {
    let hitCount = 0;
    for (const u of units) {
      if (!u.alive) continue;
      if (u === e.owner || u.team === e.team) continue; // owner immunity
      const d = e.pos.distanceTo(u.position);
      if (d > BLAST_RADIUS) continue;
      const tFall = 1 - d / BLAST_RADIUS; // 1 at center -> 0 at edge
      const raw = Math.round(lerp(e.damageMin, e.damage, smoothstep(tFall)));
      const dealt = u.takeDamage(raw, "hard");
      if (dealt > 0 && this.onDamage) this.onDamage(e.owner, u, dealt);
      if (dealt > 0 && u.hp <= 0 && this.onKill) this.onKill(e.owner, u);
      hitCount++;
    }
    // AA guns in the blast take the same falloff splash (no score/rockets).
    // AA team shells never damage AA guns (no friendly fire).
    if (aaGuns && e.team !== "aa") {
      for (const g of aaGuns) {
        if (g.disabled) continue;
        const d = e.pos.distanceTo(g.position);
        if (d > BLAST_RADIUS) continue;
        const tFall = 1 - d / BLAST_RADIUS;
        const raw = Math.round(lerp(e.damageMin, e.damage, smoothstep(tFall)));
        if (g.takeDamage(raw, "hard") && this.onAADisabled) this.onAADisabled(g);
      }
    }
    if (onBoom) onBoom(e.pos, hitCount);
  }

  /** Integrate (gravity) + proximity/ground/fuse detonation. `units` = every
   *  hittable unit (tanks + riflemen + planes); the pool is target-agnostic. */
  update(dt, units, terrain, aaGuns, onBoom) {
    for (const e of this.pool) {
      if (!e.active) continue;
      e.vel.y -= SHELL_GRAVITY * dt;
      e.pos.addScaledVector(e.vel, dt);
      e.life -= dt;

      let detonate = e.life <= 0 || e.pos.y < terrain.heightAt(e.pos.x, e.pos.z);
      if (!detonate) {
        // Proximity fuse: detonate when a hittable unit is within the stand-off
        // radius (smaller than the blast, so a direct hit lands near the blast
        // center rather than at its edge).
        for (const u of units) {
          if (!u.alive) continue;
          if (u === e.owner || u.team === e.team) continue;
          if (e.pos.distanceTo(u.position) < SHELL_FUSE_RADIUS) {
            detonate = true;
            break;
          }
        }
        // ...or when an AA gun is within the blast (a shell that misses the
        // units but lands on a gun still knocks it out).
        if (!detonate && aaGuns) {
          for (const g of aaGuns) {
            if (g.disabled) continue;
            if (e.pos.distanceTo(g.position) < BLAST_RADIUS) {
              detonate = true;
              break;
            }
          }
        }
      }
      if (detonate) {
        this._detonate(e, units, aaGuns, onBoom);
        e.active = false;
        e.group.visible = false;
        continue;
      }
      e.group.position.copy(e.pos);
      // Point the body along its velocity (the tip cone sits at local +Z).
      e.group.lookAt(e.pos.x + e.vel.x, e.pos.y + e.vel.y, e.pos.z + e.vel.z);
    }
  }

  /** Deactivate everything (used on restart). */
  clear() {
    for (const e of this.pool) {
      e.active = false;
      e.group.visible = false;
    }
  }
}
