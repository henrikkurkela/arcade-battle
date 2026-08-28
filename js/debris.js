"use strict";

// ---------------------------------------------------------------------------
// Pooled debris system: when a tank is destroyed, a burst of tumbling
// tank-shaped pieces (hull slabs, track sections, turret chunks) flies out
// (inheriting the tank's velocity), falls under gravity, lands on the
// terrain, rests there for a while, then shrinks away.
// Fixed-size pool of meshes: no per-kill allocation, no GC churn.
// ---------------------------------------------------------------------------

const DEBRIS_PER_KILL = 10; // pieces per destroyed tank
const DEBRIS_POOL_SIZE = 96; // pooled meshes (~9 simultaneous kills in flight)
const DEBRIS_GRAVITY = 9.8;
const DEBRIS_AIR_DRAG = 0.5; // per second
const DEBRIS_KICK = 12; // m/s max random scatter speed
const DEBRIS_REST_TIME = 7; // s the wreck pieces sit on the ground
const DEBRIS_FADE_TIME = 1.5; // s to shrink away after resting

class Debris {
  constructor(scene) {
    this.pool = [];
    this._nextFree = 0;
    // Tank-shaped chunks: a hull slab, a track section, a turret chunk.
    const geos = [
      new THREE.BoxGeometry(0.9, 0.22, 0.7), // hull slab
      new THREE.BoxGeometry(0.34, 0.28, 1.1), // track section
      new THREE.BoxGeometry(0.55, 0.34, 0.5), // turret chunk
      new THREE.BoxGeometry(0.7, 0.14, 0.45), // hull plate
      new THREE.BoxGeometry(0.3, 0.3, 0.6), // track segment
      new THREE.CylinderGeometry(0.1, 0.12, 1.1, 8).rotateX(Math.PI / 2), // barrel stub
    ];
    const mats = [
      new THREE.MeshLambertMaterial({ color: 0x4a5240 }), // hull green
      new THREE.MeshLambertMaterial({ color: 0x2b2e30 }), // track dark
      new THREE.MeshLambertMaterial({ color: 0x8a8f94 }), // turret grey
    ];
    for (let i = 0; i < DEBRIS_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(geos[i % geos.length], mats[i % mats.length]);
      mesh.visible = false;
      mesh.castShadow = true;
      scene.add(mesh);
      this.pool.push({
        mesh,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: 1,
        resting: false,
        restTimer: 0,
      });
    }
    this._axis = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  /** Spawn a burst at `pos`, inheriting the tank's velocity `vel`. */
  spawn(pos, vel) {
    for (let i = 0; i < DEBRIS_PER_KILL; i++) {
      const e = this._acquire();
      if (!e) return; // pool exhausted: drop the extra piece
      e.active = true;
      e.resting = false;
      e.restTimer = 0;
      e.scale = 1;
      e.pos.copy(pos);
      e.vel.copy(vel);
      e.vel.x += (Math.random() - 0.5) * DEBRIS_KICK;
      e.vel.y += (Math.random() - 0.5) * DEBRIS_KICK;
      e.vel.z += (Math.random() - 0.5) * DEBRIS_KICK;
      e.angVel.set(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14
      );
      e.quat.setFromEuler(
        new THREE.Euler(
          Math.random() * TAU,
          Math.random() * TAU,
          Math.random() * TAU
        )
      );
      e.mesh.visible = true;
      e.mesh.position.copy(e.pos);
      e.mesh.quaternion.copy(e.quat);
      e.mesh.scale.setScalar(1);
    }
  }

  _acquire() {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[(this._nextFree + i) % this.pool.length];
      if (e.active) continue;
      this._nextFree = (this._nextFree + i + 1) % this.pool.length;
      return e;
    }
    return null;
  }

  /** Integrate: gravity + drag in flight, rest + shrink on the ground. */
  update(dt, terrain) {
    for (const e of this.pool) {
      if (!e.active) continue;
      if (e.resting) {
        e.restTimer += dt;
        if (e.restTimer > DEBRIS_REST_TIME) {
          e.scale = Math.max(0, e.scale - dt / DEBRIS_FADE_TIME);
          if (e.scale <= 0) {
            e.active = false;
            e.mesh.visible = false;
            continue;
          }
        }
      } else {
        e.vel.y -= DEBRIS_GRAVITY * dt;
        e.vel.multiplyScalar(Math.max(0, 1 - DEBRIS_AIR_DRAG * dt));
        e.pos.addScaledVector(e.vel, dt);
        if (e.pos.y <= terrain.heightAt(e.pos.x, e.pos.z)) {
          e.pos.y = terrain.heightAt(e.pos.x, e.pos.z);
          e.resting = true;
          e.vel.set(0, 0, 0);
          e.angVel.set(0, 0, 0);
        }
      }
      // Tumble.
      const w = e.angVel.length();
      if (w > 1e-4) {
        this._axis.copy(e.angVel).divideScalar(w);
        this._q.setFromAxisAngle(this._axis, w * dt);
        e.quat.premultiply(this._q);
      }
      e.mesh.position.copy(e.pos);
      e.mesh.quaternion.copy(e.quat);
      e.mesh.scale.setScalar(e.scale);
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
