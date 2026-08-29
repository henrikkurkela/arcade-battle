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
const MG_HIT_RADIUS = 3.5; // m, 3D distance to the tank center point
const TANK_CENTER_HEIGHT = 1.2; // m above the hull, where a tank "is" for hits
const TRACER_POOL_SIZE = 512; // pooled tracers (player + CPU volleys in flight)

class Tracers {
  constructor(scene, poolSize = TRACER_POOL_SIZE) {
    this.pool = [];
    this._nextFree = 0;
    const geo = new THREE.BoxGeometry(0.12, 0.12, 2.4);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe066 });
    for (let i = 0; i < poolSize; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.castShadow = false;
      scene.add(mesh);
      this.pool.push({
        mesh,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        damage: 0,
        team: "",
        owner: null,
        life: 0,
      });
    }
    // Set by main.js: (owner, victim) => void, called on a lethal hit.
    this.onKill = null;
    // Set by main.js: (owner, victim, dealt) => void, called on every hit.
    this.onDamage = null;
  }

  /** Activate one pooled tracer. Drops the shot if the pool is full. */
  fire(owner, muzzleWorld, dir, damage) {
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
      e.life = MG_BULLET_LIFE;
      e.mesh.visible = true;
      e.mesh.position.copy(e.pos);
      e.mesh.lookAt(e.pos.x + e.dir.x, e.pos.y + e.dir.y, e.pos.z + e.dir.z);
      return;
    }
  }

  /** Integrate + collide (ground, tanks) + apply damage. */
  update(dt, tanks, terrain) {
    for (const e of this.pool) {
      if (!e.active) continue;
      e.pos.addScaledVector(e.vel, dt);
      e.life -= dt;
      if (e.life <= 0 || e.pos.y < terrain.heightAt(e.pos.x, e.pos.z)) {
        e.active = false;
        e.mesh.visible = false;
        continue;
      }
      let hit = false;
      for (const t of tanks) {
        if (!t.alive || t.team === e.team) continue;
        _center.set(t.position.x, t.position.y + TANK_CENTER_HEIGHT, t.position.z);
        if (e.pos.distanceTo(_center) < MG_HIT_RADIUS) {
          const hpBefore = t.hp;
          const killed = t.takeDamage(e.damage);
          if (this.onDamage) this.onDamage(e.owner, t, Math.min(e.damage, hpBefore));
          if (killed && this.onKill) this.onKill(e.owner, t);
          hit = true;
          break;
        }
      }
      if (hit) {
        e.active = false;
        e.mesh.visible = false;
        continue;
      }
      e.mesh.position.copy(e.pos);
    }
  }

  /** Deactivate everything (used on restart). */
  clear() {
    for (const e of this.pool) {
      e.active = false;
      e.mesh.visible = false;
    }
  }
}
// Scratch for the tank center-point hit test (no per-frame allocation).
const _center = new THREE.Vector3();

// --- Main-gun shells ----------------------------------------------------------
const SHELL_SPEED = 90; // m/s (slower than tracers so the arc reads)
const SHELL_LIFE = 8; // s fuse
const SHELL_GRAVITY = 9.8; // m/s^2 (arcs the shell)
const SHELL_FUSE_RADIUS = 5; // m; proximity stand-off that triggers detonation
const BLAST_RADIUS = 12; // m; splash damage radius
const SHELL_DAMAGE = 60; // HP at the blast center
const SHELL_DAMAGE_MIN = 15; // HP at the blast edge
const SHELL_POOL_SIZE = 32; // pooled shells (player + CPU volleys in flight)

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
      });
    }
    // Set by main.js: (owner, victim, dealt) => void, called on every splash hit.
    this.onDamage = null;
    // Set by main.js: (owner, victim) => void, called on a lethal splash hit.
    this.onKill = null;
  }

  /** Launch one shell. Drops it if the pool is full. Returns true if launched. */
  fire(owner, muzzleWorld, dir) {
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
      e.group.visible = true;
      e.group.position.copy(e.pos);
      return true;
    }
    return false;
  }

  /** Detonate: splash damage to every tank in the blast radius (with falloff),
   *  skipping the shooter (owner immunity). Calls `onBoom(pos, hitCount)`. */
  _detonate(e, tanks, onBoom) {
    let hitCount = 0;
    for (const t of tanks) {
      if (!t.alive) continue;
      if (t === e.owner || t.team === e.team) continue; // owner immunity
      _center.set(t.position.x, t.position.y + TANK_CENTER_HEIGHT, t.position.z);
      const d = e.pos.distanceTo(_center);
      if (d > BLAST_RADIUS) continue;
      const tFall = 1 - d / BLAST_RADIUS; // 1 at center -> 0 at edge
      const dealt = Math.round(lerp(SHELL_DAMAGE_MIN, SHELL_DAMAGE, smoothstep(tFall)));
      const hpBefore = t.hp;
      const killed = t.takeDamage(dealt);
      if (this.onDamage) this.onDamage(e.owner, t, Math.min(dealt, hpBefore));
      if (killed && this.onKill) this.onKill(e.owner, t);
      hitCount++;
    }
    if (onBoom) onBoom(e.pos, hitCount);
  }

  /** Integrate (gravity) + proximity/ground/fuse detonation. */
  update(dt, tanks, terrain, onBoom) {
    for (const e of this.pool) {
      if (!e.active) continue;
      e.vel.y -= SHELL_GRAVITY * dt;
      e.pos.addScaledVector(e.vel, dt);
      e.life -= dt;

      let detonate = e.life <= 0 || e.pos.y < terrain.heightAt(e.pos.x, e.pos.z);
      if (!detonate) {
        // Proximity fuse: detonate when a hittable tank is within the stand-off
        // radius (smaller than the blast, so a direct hit lands near the blast
        // center rather than at its edge).
        for (const t of tanks) {
          if (!t.alive) continue;
          if (t === e.owner || t.team === e.team) continue;
          _center.set(t.position.x, t.position.y + TANK_CENTER_HEIGHT, t.position.z);
          if (e.pos.distanceTo(_center) < SHELL_FUSE_RADIUS) {
            detonate = true;
            break;
          }
        }
      }
      if (detonate) {
        this._detonate(e, tanks, onBoom);
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
