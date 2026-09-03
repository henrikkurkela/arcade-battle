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
const RIFLEMAN_SPEED = 5; // m/s on foot (walk pace; also the reverse pace)
const RIFLEMAN_SPRINT_SPEED = 8; // m/s while sprinting (Shift, forward only)
const RIFLEMAN_TURN_RATE = 2.6; // rad/s (in-place pivot, keyboard A/D)
const RIFLEMAN_ACCEL = 8; // m/s^2 up to the walking pace
const RIFLEMAN_DECEL = 10; // m/s^2 slowing down
const WALK_FREQ = 1.8; // leg swing cycles per meter
// Player aim (the body yaw + pitch, driven by the pointer-locked mouse). The
// CPU squad never sets these, so its aim stays horizontal (pitch = 0).
const RIFLEMAN_MOUSE_SENS = 0.0022; // rad/px (matches the tank turret)
const RIFLEMAN_AIM_PITCH_MIN = THREE.MathUtils.degToRad(-30); // aim pitch limits
const RIFLEMAN_AIM_PITCH_MAX = THREE.MathUtils.degToRad(60);

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
    this.speed = 0; // scalar along the body heading (+ forward, - reverse)
    this.yaw = 0;
    this.pitch = 0; // aim pitch (player only; the mouse looks up/down the rifle)
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

  /** World-space aim direction: the body heading (yaw) plus the aim pitch.
   *  This is where the player looks down the rifle (and where the sniper ray,
   *  the grenade throw, and the camera point). For the CPU squad the pitch is
   *  0, so this reduces to the horizontal body front. */
  aimDir(out) {
    const cp = Math.cos(this.pitch);
    out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    return out;
  }

  /** World-space head/eye point (write into `out` to avoid allocation). The
   *  rifleman camera (over-the-shoulder + scope) is anchored here. */
  headWorld(out) {
    this.group.updateMatrixWorld(true);
    return this.headCamObj.getWorldPosition(out);
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
    this.pitch = 0;
    this.hullPitch = 0;
    this.hullRoll = 0;
    this.hp = this.maxHp;
    this.alive = true;
    this.group.visible = true;
    this._syncGroup();
  }

  /**
   * One physics step. `control = { throttle: -1..1, steer: -1..1, firing }`
   * (produced by RiflemanAI for the squad, RiflemanPlayerController for the
   * player). The player's control also carries `sprint` (0/1) and the pointer
   * aim deltas `aimDX`/`aimDY`; the squad omits them (no sprint, no aim pitch).
   * `terrain` provides heightAt for ground-following.
   */
  update(dt, control, terrain) {
    const throttleIn = clamp(control.throttle, -1, 1);
    const steerIn = clamp(control.steer, -1, 1);
    // Player-only inputs (the CPU squad's control has none of these): sprint
    // (Shift) and the pointer-locked aim deltas (body yaw + pitch).
    const sprinting = control.sprint ? 1 : 0;
    const aimDX = control.aimDX || 0;
    const aimDY = control.aimDY || 0;

    // Longitudinal: ease toward the pace. Forward walks (5) or sprints (8);
    // reverse is at the walk pace (a soldier backs up slowly).
    const maxSpeed =
      throttleIn >= 0
        ? (sprinting ? RIFLEMAN_SPRINT_SPEED : RIFLEMAN_SPEED)
        : RIFLEMAN_SPEED;
    const target = throttleIn * maxSpeed;
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

    // Turning: free in-place pivot (a soldier can rotate on the spot). The
    // keyboard steers at a fixed rate; the pointer-locked mouse aims the body
    // directly (yaw) and the rifle (pitch) — the player's "turn in place".
    this.yaw += steerIn * RIFLEMAN_TURN_RATE * dt;
    this.yaw -= aimDX * RIFLEMAN_MOUSE_SENS;
    this.pitch += -aimDY * RIFLEMAN_MOUSE_SENS;
    this.pitch = clamp(this.pitch, RIFLEMAN_AIM_PITCH_MIN, RIFLEMAN_AIM_PITCH_MAX);

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
    // Tilt the rifle to the aim pitch (the player looks up/down the barrel).
    // The CPU squad's pitch is always 0, so this is a no-op for them.
    if (this.rifle) this.rifle.rotation.x = this.pitch;
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

    // Arms: static, angled forward (toward -Z) to hold the rifle. The pivot
    // stays at the shoulder so the hands stay connected to the body.
    const armGeo = new THREE.BoxGeometry(0.12, 0.46, 0.14);
    armGeo.translate(0, -0.18, 0); // pivot near the shoulder
    const armL = new THREE.Mesh(armGeo, coatMat);
    armL.position.set(-0.31, 1.26, 0);
    armL.rotation.x = 1.05;
    g.add(armL);
    const armR = new THREE.Mesh(armGeo, coatMat);
    armR.position.set(0.31, 1.26, 0);
    armR.rotation.x = 1.05;
    g.add(armR);

    // Assault rifle: receiver + barrel + stock, held by the RIGHT hand (offset
    // to +X, where the right hand reaches forward) pointing down -Z. The
    // muzzle marker sits at the barrel tip; tracers and the muzzle flash read
    // from it.
    const rifle = new THREE.Group();
    rifle.position.set(0.31, 1.1, -0.35);
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
    this.rifle = rifle; // kept so _syncGroup() can tilt it to the aim pitch

    // Head/eye anchor for the rifleman camera (over-the-shoulder + scope).
    this.headCamObj = new THREE.Object3D();
    this.headCamObj.position.set(0, 1.5, 0);
    g.add(this.headCamObj);

    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });

    return g;
  }
}
