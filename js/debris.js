"use strict";

// ---------------------------------------------------------------------------
// Pooled debris system: when a tank is destroyed, a burst of tumbling
// tank-shaped pieces (hull slabs, track sections, turret chunks) flies out
// (inheriting the tank's velocity), falls under gravity, lands on the
// terrain, rests there for a while, then shrinks away. A killed rifleman
// instead breaks into small body pieces (limb/torso/head chunks) with the
// same flight-and-rest behavior.
// Fixed-size pool of meshes: no per-kill allocation, no GC churn.
// ---------------------------------------------------------------------------

const DEBRIS_PER_KILL = 10; // pieces per destroyed tank
const DEBRIS_POOL_SIZE = 96; // pooled meshes (~9 simultaneous kills in flight)
const FOLIAGE_PER_FELL = 12; // pieces per felled tree
const FOLIAGE_POOL_SIZE = 48; // pooled meshes (~4 simultaneous fellings in flight)
const BODY_PER_KILL = 6; // pieces per killed rifleman
const BODY_POOL_SIZE = 48; // pooled meshes (~8 simultaneous kills in flight)
const PLANE_DEBRIS_PER_KILL = 10; // pieces per destroyed plane
const PLANE_DEBRIS_POOL_SIZE = 96; // pooled meshes (~9 simultaneous kills in flight)
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
    // Foliage chunks for felled trees: leaf clumps, a pine tuft, a twig.
    this.foliage = [];
    this._nextFreeF = 0;
    const fGeos = [
      new THREE.BoxGeometry(0.34, 0.09, 0.3), // leaf clump
      new THREE.ConeGeometry(0.18, 0.5, 6), // pine tuft
      new THREE.BoxGeometry(0.07, 0.5, 0.07), // twig
      new THREE.BoxGeometry(0.28, 0.1, 0.24), // leaf clump
    ];
    const fMats = [
      new THREE.MeshLambertMaterial({ color: 0x2d5a27 }), // pine green
      new THREE.MeshLambertMaterial({ color: 0x3a7a2e }), // broadleaf green
      new THREE.MeshLambertMaterial({ color: 0x6b4226 }), // bark brown
      new THREE.MeshLambertMaterial({ color: 0x8a6a3a }), // light wood
    ];
    for (let i = 0; i < FOLIAGE_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(fGeos[i % fGeos.length], fMats[i % fMats.length]);
      mesh.visible = false;
      mesh.castShadow = true;
      scene.add(mesh);
      this.foliage.push({
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
    // Body pieces for killed riflemen: limb, torso and head chunks in
    // uniform/skin tones.
    this.body = [];
    this._nextFreeB = 0;
    const bGeos = [
      new THREE.BoxGeometry(0.16, 0.5, 0.18), // leg
      new THREE.BoxGeometry(0.14, 0.4, 0.16), // arm
      new THREE.BoxGeometry(0.2, 0.34, 0.22), // torso chunk
      new THREE.BoxGeometry(0.24, 0.26, 0.24), // head
    ];
    const bMats = [
      new THREE.MeshLambertMaterial({ color: 0x4a5240 }), // coat
      new THREE.MeshLambertMaterial({ color: 0x3a4034 }), // pants
      new THREE.MeshLambertMaterial({ color: 0xc9a582 }), // skin
      new THREE.MeshLambertMaterial({ color: 0x2b2e30 }), // dark
    ];
    for (let i = 0; i < BODY_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(bGeos[i % bGeos.length], bMats[i % bMats.length]);
      mesh.visible = false;
      mesh.castShadow = true;
      scene.add(mesh);
      this.body.push({
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
    // Plane-shaped chunks (ported from the Arcade Plane game): wing panels,
    // fuselage tube, fin, flat plate.
    this.plane = [];
    this._nextFreeP = 0;
    const pGeos = [
      new THREE.BoxGeometry(0.55, 0.09, 0.4), // wing panel
      new THREE.BoxGeometry(0.4, 0.09, 0.55), // wing panel
      new THREE.CylinderGeometry(0.17, 0.17, 0.8, 8).rotateX(Math.PI / 2), // fuselage tube
      new THREE.BoxGeometry(0.1, 0.55, 0.35), // fin
      new THREE.BoxGeometry(0.45, 0.07, 0.45), // flat plate
    ];
    const pMats = [
      new THREE.MeshLambertMaterial({ color: 0x8a8f94 }), // airframe grey
      new THREE.MeshLambertMaterial({ color: 0xb3372f }), // red
      new THREE.MeshLambertMaterial({ color: 0x26282c }), // dark metal
    ];
    for (let i = 0; i < PLANE_DEBRIS_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(pGeos[i % pGeos.length], pMats[i % pMats.length]);
      mesh.visible = false;
      mesh.castShadow = true;
      scene.add(mesh);
      this.plane.push({
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

  /** Spawn a rifleman-death burst at `pos`, inheriting the unit's velocity
   *  `vel`. */
  spawnBody(pos, vel) {
    this._burst(this.body, "_nextFreeB", BODY_PER_KILL, pos, vel);
  }

  /** Spawn a tank-destruction burst at `pos`, inheriting the tank's
   *  velocity `vel`. */
  spawn(pos, vel) {
    this._burst(this.pool, "_nextFree", DEBRIS_PER_KILL, pos, vel);
  }

  /** Spawn a felled-tree burst at `pos`, inheriting the tank's velocity
   *  `vel`. */
  spawnFoliage(pos, vel) {
    this._burst(this.foliage, "_nextFreeF", FOLIAGE_PER_FELL, pos, vel);
  }

  /** Spawn a plane-destruction burst at `pos`, inheriting the plane's
   *  velocity `vel`. */
  spawnPlane(pos, vel) {
    this._burst(this.plane, "_nextFreeP", PLANE_DEBRIS_PER_KILL, pos, vel);
  }

  _burst(list, idx, count, pos, vel) {
    for (let i = 0; i < count; i++) {
      const e = this._acquire(list, idx);
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

  _acquire(list, idx) {
    for (let i = 0; i < list.length; i++) {
      const e = list[(this[idx] + i) % list.length];
      if (e.active) continue;
      this[idx] = (this[idx] + i + 1) % list.length;
      return e;
    }
    return null;
  }

  /** Integrate: gravity + drag in flight, rest + shrink on the ground. */
  update(dt, terrain) {
    for (const e of this.pool) this._step(e, dt, terrain);
    for (const e of this.foliage) this._step(e, dt, terrain);
    for (const e of this.body) this._step(e, dt, terrain);
    for (const e of this.plane) this._step(e, dt, terrain);
  }

  _step(e, dt, terrain) {
    if (!e.active) return;
    if (e.resting) {
      e.restTimer += dt;
      if (e.restTimer > DEBRIS_REST_TIME) {
        e.scale = Math.max(0, e.scale - dt / DEBRIS_FADE_TIME);
        if (e.scale <= 0) {
          e.active = false;
          e.mesh.visible = false;
          return;
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

  /** Deactivate everything (used on restart). */
  clear() {
    for (const e of this.pool) {
      e.active = false;
      e.mesh.visible = false;
    }
    for (const e of this.foliage) {
      e.active = false;
      e.mesh.visible = false;
    }
    for (const e of this.body) {
      e.active = false;
      e.mesh.visible = false;
    }
    for (const e of this.plane) {
      e.active = false;
      e.mesh.visible = false;
    }
  }
}
