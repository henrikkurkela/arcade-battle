"use strict";

// ---------------------------------------------------------------------------
// Aerial weapons (copied from the Arcade Plane game), shared by the CPU
// planes and the AA guns.
//
// Projectiles: fast straight-line cannon tracers. SOFT damage.
// Rockets:     arcing unguided ordnance with splash. HARD damage.
//
// Both pools are TARGET-AGNOSTIC: they hit any unit in `units` (tanks,
// riflemen, planes) and any AA gun, except same-team (friendly fire) and the
// shooter (owner immunity). Which units a given AI *aims at* is decided by
// the AI, not by these pools — so any weapon can still damage any target.
// ---------------------------------------------------------------------------

// --- Cannon tracers (SOFT) --------------------------------------------------
const BULLET_SPEED = 140; // m/s
const BULLET_LIFE = 4.5; // seconds (~630 m range)
const HIT_RADIUS = 3.5; // meters

class Projectiles {
  constructor(scene, poolSize = 1024) {
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
        kind: "soft",
        team: "",
        owner: null,
        life: 0,
      });
    }
    // Set by main.js: (owner, victim) => void, called on a lethal hit.
    this.onKill = null;
    // Set by main.js: (owner, victim, dealt) => void, called on every hit.
    this.onDamage = null;
    // Set by main.js: (gun) => void, called when a bullet knocks out an AA gun.
    this.onAADisabled = null;
  }

  /** Activate one pooled tracer. Drops the shot if the pool is full.
   *  `kind` is the damage kind ("soft" for cannon fire). */
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
      e.vel.copy(owner.velocity).addScaledVector(e.dir, BULLET_SPEED);
      e.damage = damage;
      e.kind = kind;
      e.life = BULLET_LIFE;
      e.mesh.visible = true;
      e.mesh.position.copy(e.pos);
      e.mesh.lookAt(e.pos.x + e.dir.x, e.pos.y + e.dir.y, e.pos.z + e.dir.z);
      return;
    }
  }

  /** Integrate + collide (ground, all units, AA guns) + apply damage. */
  update(dt, units, terrain, aaGuns) {
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
      for (const u of units) {
        if (!u.alive || u.team === e.team) continue;
        if (e.pos.distanceTo(u.position) < HIT_RADIUS) {
          const dealt = u.takeDamage(e.damage, e.kind);
          if (dealt > 0 && this.onDamage) this.onDamage(e.owner, u, dealt);
          if (dealt > 0 && u.hp <= 0 && this.onKill) this.onKill(e.owner, u);
          hit = true;
          break;
        }
      }
      if (hit) {
        e.active = false;
        e.mesh.visible = false;
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
            e.mesh.visible = false;
            break;
          }
        }
      }
      if (!e.active) continue;
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

// ---------------------------------------------------------------------------
// Rockets (HARD): unguided ordnance that arcs under gravity. Detonates on
// proximity to a unit, on ground impact, or when its fuse runs out, dealing
// splash damage to every unit in the blast radius (with distance falloff) —
// except the shooter (owner immunity).
// ---------------------------------------------------------------------------

const ROCKET_SPEED = 120; // m/s (slower than tracers so the arc reads)
const ROCKET_LIFE = 7; // s fuse
const ROCKET_GRAVITY = 9.8; // m/s^2 (arcs the rocket)
const ROCKET_FUSE_RADIUS = 6; // m; proximity stand-off that triggers detonation
const ROCKET_BLAST_RADIUS = 15; // m; splash damage radius
const ROCKET_DAMAGE = 35; // HP at the blast center
const ROCKET_DAMAGE_MIN = 12; // HP at the blast edge
const ROCKET_POOL_SIZE = 64; // pooled rockets (plane + AA volleys in flight)

/**
 * Compute the launch direction (unit vector, written into `out`) for an
 * unguided rocket fired from `from` at ROCKET_SPEED so it arcs under
 * ROCKET_GRAVITY onto the point `to`. Uses the low-trajectory solution of the
 * projectile equations. Returns false (leaving `out` unchanged) when `to` is
 * beyond the flat-earth ballistic range. Assumes the rocket's initial velocity
 * is ROCKET_SPEED along the launch direction (true for a stationary shooter;
 * a moving shooter adds its own velocity on top, a small error at arcade speed).
 */
function rocketArcDir(from, to, out) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dh = Math.hypot(dx, dz); // horizontal distance
  if (dh < 1e-3) {
    out.set(0, 1, 0); // target dead ahead vertically: best effort straight up
    return true;
  }
  const k = (ROCKET_GRAVITY * dh * dh) / (2 * ROCKET_SPEED * ROCKET_SPEED);
  const disc = dh * dh - 4 * k * (k + dy);
  if (disc < 0) return false; // out of ballistic range
  const u = (dh - Math.sqrt(disc)) / (2 * k); // tan(elevation), low arc
  const s = Math.sqrt(1 + u * u);
  out.set(dx / dh / s, u / s, dz / dh / s);
  return true;
}

/** Radial glow for the rocket motor: hot white-blue core fading out.
 *  Additive-blended so it reads as a bright thruster, especially at night. */
function makeMotorTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.2, "rgba(190,225,255,0.9)");
  grad.addColorStop(0.5, "rgba(120,175,255,0.4)");
  grad.addColorStop(1, "rgba(80,120,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class Rockets {
  constructor(scene, poolSize = ROCKET_POOL_SIZE) {
    this.pool = [];
    this._nextFree = 0;
    // Rocket body: a small cylinder along Z (nose at +Z) with a red tip.
    const bodyGeo = new THREE.CylinderGeometry(0.12, 0.12, 1.6, 8).rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x9a9da2 });
    const tipGeo = new THREE.ConeGeometry(0.12, 0.4, 8).rotateX(Math.PI / 2);
    const tipMat = new THREE.MeshLambertMaterial({ color: 0xb3372f });
    const motorTex = makeMotorTexture();
    for (let i = 0; i < poolSize; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      const tip = new THREE.Mesh(tipGeo, tipMat);
      tip.position.z = 1.0; // nose at +Z (lookAt points +Z along travel)
      // Motor glow: additive billboard sprite at the exhaust (-Z).
      const motorMat = new THREE.SpriteMaterial({
        map: motorTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const motor = new THREE.Sprite(motorMat);
      motor.position.z = -1.0;
      motor.scale.set(1.2, 1.2, 1);
      group.add(body, tip, motor);
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
        motor,
        motorMat,
      });
    }
    // Set by main.js: (owner, victim, dealt) => void, called on every splash hit.
    this.onDamage = null;
    // Set by main.js: (owner, victim) => void, called on a lethal splash hit.
    this.onKill = null;
    // Set by main.js: (gun) => void, called when a rocket knocks out an AA gun.
    this.onAADisabled = null;
  }

  /** Launch one rocket. Drops it if the pool is full. Returns true if launched.
   *  `kind` is the damage kind ("hard" for rockets). */
  fire(owner, muzzleWorld, dir, kind = "hard") {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[(this._nextFree + i) % this.pool.length];
      if (e.active) continue;
      this._nextFree = (this._nextFree + i + 1) % this.pool.length;
      e.active = true;
      e.owner = owner;
      e.team = owner.team;
      e.pos.copy(muzzleWorld);
      e.vel.copy(owner.velocity).addScaledVector(dir, ROCKET_SPEED);
      e.life = ROCKET_LIFE;
      e.group.visible = true;
      e.group.position.copy(e.pos);
      e.motorMat.opacity = 0.9;
      e.motor.scale.set(1.4, 1.4, 1);
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
      if (d > ROCKET_BLAST_RADIUS) continue;
      const t = 1 - d / ROCKET_BLAST_RADIUS; // 1 at center -> 0 at edge
      const raw = Math.round(lerp(ROCKET_DAMAGE_MIN, ROCKET_DAMAGE, smoothstep(t)));
      const dealt = u.takeDamage(raw, "hard");
      if (dealt > 0 && this.onDamage) this.onDamage(e.owner, u, dealt);
      if (dealt > 0 && u.hp <= 0 && this.onKill) this.onKill(e.owner, u);
      hitCount++;
    }
    // AA guns in the blast take the same falloff splash (no score/rockets).
    // AA team rockets never damage AA guns (no friendly fire).
    if (aaGuns && e.team !== "aa") {
      for (const g of aaGuns) {
        if (g.disabled) continue;
        const d = e.pos.distanceTo(g.position);
        if (d > ROCKET_BLAST_RADIUS) continue;
        const t = 1 - d / ROCKET_BLAST_RADIUS;
        const raw = Math.round(lerp(ROCKET_DAMAGE_MIN, ROCKET_DAMAGE, smoothstep(t)));
        if (g.takeDamage(raw, "hard") && this.onAADisabled) this.onAADisabled(g);
      }
    }
    if (onBoom) onBoom(e.pos, hitCount);
  }

  /** Integrate (gravity) + proximity/ground/fuse detonation. */
  update(dt, units, terrain, aaGuns, onBoom) {
    for (const e of this.pool) {
      if (!e.active) continue;
      e.vel.y -= ROCKET_GRAVITY * dt;
      e.pos.addScaledVector(e.vel, dt);
      e.life -= dt;

      let detonate = e.life <= 0 || e.pos.y < terrain.heightAt(e.pos.x, e.pos.z);
      if (!detonate) {
        // Proximity fuse: detonate when a hittable unit is within the
        // stand-off radius (smaller than the blast, so a direct hit lands
        // near the blast center rather than at its edge).
        for (const u of units) {
          if (!u.alive) continue;
          if (u === e.owner || u.team === e.team) continue;
          if (e.pos.distanceTo(u.position) < ROCKET_FUSE_RADIUS) {
            detonate = true;
            break;
          }
        }
        // ...or when an AA gun is within the blast (a rocket that misses the
        // units but lands on a gun still knocks it out).
        if (!detonate && aaGuns) {
          for (const g of aaGuns) {
            if (g.disabled) continue;
            if (e.pos.distanceTo(g.position) < ROCKET_BLAST_RADIUS) {
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
        e.motorMat.opacity = 0;
        continue;
      }
      e.group.position.copy(e.pos);
      // Point the body along its velocity (the tip cone sits at local -Z).
      e.group.lookAt(e.pos.x + e.vel.x, e.pos.y + e.vel.y, e.pos.z + e.vel.z);
      // Flicker the motor glow (brighter the faster it still burns).
      e.motorMat.opacity = 0.55 + Math.random() * 0.45;
      const ms = 1.1 + Math.random() * 0.6;
      e.motor.scale.set(ms, ms, 1);
    }
  }

  /** Deactivate everything (used on restart). */
  clear() {
    for (const e of this.pool) {
      e.active = false;
      e.group.visible = false;
      e.motorMat.opacity = 0;
    }
  }
}
