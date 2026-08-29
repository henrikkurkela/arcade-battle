"use strict";

// ---------------------------------------------------------------------------
// Rifleman: low-poly infantry unit with an assault rifle (the shared tracer
// pool). Walks on foot toward the nearest tank, stops at firing range, and
// sprays burst fire (RiflemanAI, ai.js).
//
// Model: units are meters, +Y is up, the nose (and rifle) point down -Z,
// origin at the feet.
//
// Armor: deliberately LOW — a rifleman takes full small-arms (soft) and
// main-gun (hard) damage, so tank MG fire and shell splashes kill fast.
//
// Ground model: a walking pace along the body heading (no reverse), the same
// terrain following and slope limit as the tank, and free in-place turning
// (a soldier can pivot, a tank cannot).
// ---------------------------------------------------------------------------

const RIFLEMAN_HP = 40;
const RIFLEMAN_SOFT_ARMOR = 1; // no armor: full small-arms damage
const RIFLEMAN_HARD_ARMOR = 1; // no armor: full main-gun damage
const RIFLEMAN_SPEED = 5; // m/s on foot
const RIFLEMAN_TURN_RATE = 2.6; // rad/s (in-place pivot)
const RIFLEMAN_ACCEL = 8; // m/s^2 up to the walking pace
const RIFLEMAN_DECEL = 10; // m/s^2 slowing down
const WALK_FREQ = 1.8; // leg swing cycles per meter

// A few uniform palettes so a squad doesn't read as one clone.
const RIFLEMAN_UNIFORMS = [
  { coat: 0x4a5240, pants: 0x3a4034, skin: 0xc9a582 },
  { coat: 0x556b2f, pants: 0x3f4a2a, skin: 0xb58e6b },
  { coat: 0x6b5b4a, pants: 0x4a4036, skin: 0xd2b08c },
  { coat: 0x4f5a52, pants: 0x39413a, skin: 0xc49a76 },
];

class Rifleman {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3(); // 2D motion (x, z); y stays 0
    this.speed = 0; // scalar along the body heading (no reverse on foot)
    this.yaw = 0;
    this.hullPitch = 0;
    this.hullRoll = 0;

    // Combat state (same shape as Tank, so the shared weapon pools work).
    this.hp = this.maxHp = RIFLEMAN_HP;
    this.alive = true;
    this.team = "riflemen"; // one shared team: no friendly fire in the squad
    this.callsign = "RIFLEMAN";
    this.softArmor = RIFLEMAN_SOFT_ARMOR;
    this.hardArmor = RIFLEMAN_HARD_ARMOR;

    // Scratch objects (avoid per-frame allocations).
    this._fwd = new THREE.Vector3();
    this._ahead = new THREE.Vector3();

    // Walk animation state (filled by _buildModel).
    this._legL = null;
    this._legR = null;
    this._walkPhase = 0; // radians of leg swing

    this.group = this._buildModel(opts.uniform ?? RIFLEMAN_UNIFORMS[0]);
    scene.add(this.group);
    this._syncGroup();
  }

  /** Unit vector pointing out of the body front (and down the rifle). */
  get forward() {
    this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return this._fwd;
  }

  /** World-space muzzle point (write into `out` to avoid allocation). */
  muzzleWorld(out) {
    this.group.updateMatrixWorld(true);
    return this.muzzleObj.getWorldPosition(out);
  }

  /** World-space rifle direction (horizontal, along the body front). */
  barrelDir(out) {
    return out.copy(this.forward);
  }

  /** Apply damage. `kind` selects the armor divisor: "soft" (small arms /
   *  MG) or "hard" (main gun); omit it for unarmored physical damage
   *  (collision). Returns the HP actually deducted (0 if dead or fully
   *  soaked by armor); the rifleman is destroyed when that leaves hp at 0. */
  takeDamage(amount, kind) {
    if (!this.alive) return 0;
    let dealt = amount;
    if (kind === "soft") dealt = amount / this.softArmor;
    else if (kind === "hard") dealt = amount / this.hardArmor;
    dealt = Math.floor(dealt);
    if (dealt <= 0) return 0;
    this.hp -= dealt;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return dealt;
  }

  /** Place the rifleman at (x, z) facing `yaw`; y is computed from the
   *  terrain (feet on the ground). */
  reset(x, z, yaw, terrain) {
    this.position.set(x, 0, z);
    this.position.y = terrain.heightAt(x, z);
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.yaw = yaw || 0;
    this.hullPitch = 0;
    this.hullRoll = 0;
    this.hp = this.maxHp;
    this.alive = true;
    this.group.visible = true;
    this._syncGroup();
  }

  /**
   * One physics step. `control = { throttle: 0..1, steer: -1..1, firing }`
   * (produced by RiflemanAI). `terrain` provides heightAt for ground-following.
   */
  update(dt, control, terrain) {
    const throttleIn = clamp(control.throttle, 0, 1);
    const steerIn = clamp(control.steer, -1, 1);

    // Longitudinal: ease toward the walking pace (no reverse on foot).
    const target = throttleIn * RIFLEMAN_SPEED;
    if (this.speed < target) this.speed = Math.min(target, this.speed + RIFLEMAN_ACCEL * dt);
    else this.speed = Math.max(target, this.speed - RIFLEMAN_DECEL * dt);

    // Slope limit: ground steeper than the tank's limit ahead stops the climb.
    if (this.speed > 0) {
      this._ahead.copy(this.position).addScaledVector(this.forward, SLOPE_AHEAD);
      const slopeUp =
        (terrain.heightAt(this._ahead.x, this._ahead.z) -
          terrain.heightAt(this.position.x, this.position.z)) /
        SLOPE_AHEAD;
      if (slopeUp > SLOPE_TAN) this.speed = 0;
    }

    // Turning: free in-place pivot (a soldier can rotate on the spot).
    this.yaw += steerIn * RIFLEMAN_TURN_RATE * dt;

    // Move (2D; y is re-derived from the terrain below).
    const fwd = this.forward;
    this.velocity.set(fwd.x * this.speed, 0, fwd.z * this.speed);
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // Terrain following: the same four-corner average + eased pitch/roll as
    // the tank, sampled over a foot-sized footprint.
    const fx = fwd.x, fz = fwd.z;
    const rx = -fz, rz = fx; // right vector (perpendicular, +X when facing -Z)
    const px = this.position.x, pz = this.position.z;
    const CX = 0.25, CZ = 0.3; // half-width / half-depth of the footprint
    const fl = terrain.heightAt(px + rx * CX + fx * CZ, pz + rz * CX + fz * CZ);
    const fr = terrain.heightAt(px - rx * CX + fx * CZ, pz - rz * CX + fz * CZ);
    const bl = terrain.heightAt(px + rx * CX - fx * CZ, pz + rz * CX - fz * CZ);
    const br = terrain.heightAt(px - rx * CX - fx * CZ, pz - rz * CX - fz * CZ);
    this.position.y = (fl + fr + bl + br) / 4;
    const targetPitch = Math.atan2((fl + fr) / 2 - (bl + br) / 2, 2 * CZ);
    const targetRoll = Math.atan2((fl + bl) / 2 - (fr + br) / 2, 2 * CX);
    this.hullPitch = easeToward(this.hullPitch, targetPitch, HULL_EASE, dt);
    this.hullRoll = easeToward(this.hullRoll, targetRoll, HULL_EASE, dt);

    this._updateWalk(dt);
    this._syncGroup();
  }

  _syncGroup() {
    this.group.position.copy(this.position);
    this.group.rotation.set(this.hullPitch, this.yaw, this.hullRoll, "YXZ");
  }

  /** Swing the legs (opposite phase) with the current speed. */
  _updateWalk(dt) {
    if (!this._legL) return;
    this._walkPhase += this.speed * WALK_FREQ * dt;
    const swing = Math.sin(this._walkPhase) * 0.55 * clamp(this.speed / RIFLEMAN_SPEED, 0, 1);
    this._legL.rotation.x = swing;
    this._legR.rotation.x = -swing;
  }

  _buildModel(uniform) {
    const g = new THREE.Group();
    const coatMat = new THREE.MeshLambertMaterial({ color: uniform.coat });
    const pantsMat = new THREE.MeshLambertMaterial({ color: uniform.pants });
    const skinMat = new THREE.MeshLambertMaterial({ color: uniform.skin });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x2b2e30 });

    // Legs: pivots at the hips, meshes hanging down (swung by _updateWalk).
    // The boots are children of the legs so they swing along.
    const legGeo = new THREE.BoxGeometry(0.16, 0.72, 0.2);
    legGeo.translate(0, -0.36, 0); // pivot at the top of the leg
    const bootGeo = new THREE.BoxGeometry(0.18, 0.12, 0.3);
    this._legL = new THREE.Mesh(legGeo, pantsMat);
    this._legL.position.set(-0.13, 0.74, 0);
    const bootL = new THREE.Mesh(bootGeo, darkMat);
    bootL.position.set(0, -0.68, -0.05);
    this._legL.add(bootL);
    g.add(this._legL);
    this._legR = new THREE.Mesh(legGeo, pantsMat);
    this._legR.position.set(0.13, 0.74, 0);
    const bootR = new THREE.Mesh(bootGeo, darkMat);
    bootR.position.set(0, -0.68, -0.05);
    this._legR.add(bootR);
    g.add(this._legR);

    // Torso + belt.
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.28), coatMat);
    torso.position.set(0, 1.05, 0);
    g.add(torso);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.3), darkMat);
    belt.position.set(0, 0.8, 0);
    g.add(belt);

    // Head + helmet.
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), skinMat);
    head.position.set(0, 1.48, 0);
    g.add(head);
    const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.32), coatMat);
    helmet.position.set(0, 1.62, 0);
    g.add(helmet);

    // Arms: static, angled forward to hold the rifle.
    const armGeo = new THREE.BoxGeometry(0.12, 0.46, 0.14);
    armGeo.translate(0, -0.18, 0); // pivot near the shoulder
    const armL = new THREE.Mesh(armGeo, coatMat);
    armL.position.set(-0.31, 1.26, 0);
    armL.rotation.x = -1.05;
    g.add(armL);
    const armR = new THREE.Mesh(armGeo, coatMat);
    armR.position.set(0.31, 1.26, 0);
    armR.rotation.x = -1.05;
    g.add(armR);

    // Assault rifle: receiver + barrel + stock, held across the chest
    // pointing down -Z. The muzzle marker sits at the barrel tip.
    const rifle = new THREE.Group();
    rifle.position.set(0, 1.18, -0.35);
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.55), darkMat);
    rifle.add(receiver);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.4), darkMat);
    barrel.position.set(0, 0.02, -0.42);
    rifle.add(barrel);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.2), pantsMat);
    stock.position.set(0, -0.02, 0.32);
    rifle.add(stock);
    this.muzzleObj = new THREE.Object3D();
    this.muzzleObj.position.set(0, 0.02, -0.66);
    rifle.add(this.muzzleObj);
    g.add(rifle);

    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });

    return g;
  }
}
