"use strict";

// ---------------------------------------------------------------------------
// The airplane: a low-wing single-seater built from primitives, plus an
// arcade flight model. (Copied from the Arcade Plane game; the player flies
// one of these when the PLANE vehicle is selected, otherwise all planes are
// CPU.)
//
// Model: units are meters, +Y is up, the nose points down -Z.
//
// Flight model (deliberately simple, tuned to feel "arcade"):
//  - W/S pitch, A/D bank (turns come from banking: yaw follows roll),
//    Q/E rudder, Shift/Ctrl throttle.
//  - "Stickiness": the velocity vector rotates toward the nose direction at a
//    rate proportional to FORWARD airspeed (the nose-aligned component of
//    velocity). Lift fades out between 9 and 18 m/s of forward speed; with no
//    forward speed there is no lift and the plane falls ballistically (stall).
//    Pointing the nose down into the velocity vector recovers it.
//  - Thrust along the nose, gravity, quadratic + linear drag.
//
// Armor: a plane is UNARMORED — it takes full small-arms (soft) and
// rocket/main-gun (hard) damage (both armor levels are 1).
// ---------------------------------------------------------------------------

const PLANE_HP = 100; // CPU planes
const PLANE_GRAVITY = 9.8;
const PLANE_THRUST = 16; // m/s^2 at full throttle
const PLANE_PITCH_RATE = 1.3; // rad/s
const PLANE_ROLL_RATE = 2.4; // rad/s
const PLANE_RUDDER_RATE = 0.6; // rad/s
const PLANE_DRAG_Q = 0.006; // quadratic drag coeff (per second, per m/s)
const PLANE_DRAG_L = 0.015; // linear drag coeff
const STALL_SPEED = 12; // below this the nose drops
const STALL_WARN = 13; // HUD warning threshold (m/s)
const MAX_DEFLECT = THREE.MathUtils.degToRad(45); // control-surface max deflection
const SURFACE_EASE = 8; // deflection easing rate (per second)
const TAXI_PITCH = THREE.MathUtils.degToRad(8); // natural nose-up attitude while on the gear (small tailwheel)
const GROUND_LEVEL_RATE = 10; // how fast pitch/roll settle to the taxi attitude while grounded (per second)
// Armor: a multiplier dividing incoming damage of the matching kind
// (effective = raw / armor, floored). A plane carries light soft armor (3)
// but no hard armor (1): it shrugs off cannon fire but not rockets.
const PLANE_SOFT_ARMOR = 3; // vs SOFT damage (cannon / small arms)
const PLANE_HARD_ARMOR = 1; // vs HARD damage (rockets / main gun)

/** Exponential ease toward a target (frame-rate independent). */
function easeToward(current, target, rate, dt) {
  const t = 1 - Math.exp(-rate * dt);
  return current + (target - current) * t;
}

class Plane {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.position = new THREE.Vector3(0, 160, 0);
    this.velocity = new THREE.Vector3(0, 0, -28);
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.throttle = 1;
    this.quaternion = new THREE.Quaternion();

    // Combat state.
    this.hp = this.maxHp = PLANE_HP;
    this.alive = true;
    this.team = "plane1"; // "planeN": unique per CPU (no friendly fire among them)
    this.callsign = "PLANE";
    // Armor levels (divisors for takeDamage by kind).
    this.softArmor = PLANE_SOFT_ARMOR;
    this.hardArmor = PLANE_HARD_ARMOR;

    // Grounded on the garage pad (managed by main.js when the player flies).
    this.grounded = false;

    // Damage-smoke emission accumulator (s); driven by main.js while hp is low.
    this._smokeTimer = 0;

    // Muzzle: just ahead of the nose spinner (local 0, 0, -2.45).
    this._muzzleLocal = new THREE.Vector3(0, -0.05, -2.6);
    this._muzzleWorld = new THREE.Vector3();

    // Control-surface deflections (radians), eased toward input.
    this.aileronDefl = 0;
    this.elevatorDefl = 0;
    this.rudderDefl = 0;

    // Scratch objects (avoid per-frame allocations).
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._velDir = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._qAlign = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, "YXZ");

    this.group = this._buildModel(opts.livery ?? 0x8a8f94);
    scene.add(this.group);
    this._syncGroup();
  }

  /** Unit vector pointing out of the nose. */
  get forward() {
    this._fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    return this._fwd;
  }

  /** Unit vector of the plane's "up". */
  get up() {
    this._up.set(0, 1, 0).applyQuaternion(this.quaternion);
    return this._up;
  }

  get speed() {
    return this.velocity.length();
  }

  /** Speed along the nose direction. Drives lift; what the HUD shows. */
  get forwardSpeed() {
    return Math.max(0, this.velocity.dot(this.forward));
  }

  /** World-space muzzle point (write into `out` to avoid allocation). */
  muzzleWorld(out) {
    return out
      .copy(this._muzzleLocal)
      .applyQuaternion(this.quaternion)
      .add(this.position);
  }

  /** Apply damage. `kind` selects the armor divisor: "soft" (cannon / small
   *  arms) or "hard" (rockets / main gun); omit it for unarmored physical
   *  damage (collision). Returns the HP actually deducted (0 if dead or fully
   *  soaked by armor); the plane is destroyed when that leaves hp at 0. */
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

  reset(x, y, z, yaw) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, -28); // 100 km/h north
    this.pitch = 0;
    this.roll = 0;
    this.yaw = yaw || 0;
    this.throttle = 1;
    this.quaternion.setFromEuler(this._euler.set(0, this.yaw, 0));
    this.hp = this.maxHp;
    this.alive = true;
    this.grounded = false;
    this.group.visible = true;
    this._smokeTimer = 0;
    this.aileronDefl = 0;
    this.elevatorDefl = 0;
    this.rudderDefl = 0;
    this.aileronL.rotation.z = 0;
    this.aileronR.rotation.z = 0;
    this.elevator.rotation.x = 0;
    this.rudder.rotation.y = 0;
    this._syncGroup();
  }

  /** Called while on the "ready" screen: idle prop, no flight. */
  idleProp(dt) {
    this.prop.rotation.z -= 7 * dt;
  }

  /**
   * One physics step. `control = { pitch, roll, rudder, throttle }`, each a
   * continuous value in [-1, 1] (throttle is a rate). Produced by a
   * Controller (PlaneAI for CPU planes).
   */
  update(dt, control) {
    const pitchIn = clamp(control.pitch, -1, 1);
    const rollIn = clamp(control.roll, -1, 1);
    const rudderIn = clamp(control.rudder, -1, 1);
    const throttleIn = clamp(control.throttle, -1, 1);

    const speed = this.speed;

    // Visual control-surface deflection (mirrors input, no physics).
    // On the gear, pitch/roll are disabled so those surfaces settle neutral;
    // the rudder still works for taxi steering.
    const rollDefl = this.grounded ? 0 : rollIn;
    const pitchDefl = this.grounded ? 0 : pitchIn;
    this.aileronDefl = easeToward(this.aileronDefl, rollDefl * MAX_DEFLECT, SURFACE_EASE, dt);
    this.elevatorDefl = easeToward(this.elevatorDefl, pitchDefl * MAX_DEFLECT, SURFACE_EASE, dt);
    this.rudderDefl = easeToward(this.rudderDefl, rudderIn * MAX_DEFLECT, SURFACE_EASE, dt);
    this.aileronL.rotation.x = -this.aileronDefl;
    this.aileronR.rotation.x = +this.aileronDefl;
    this.elevator.rotation.x = -this.elevatorDefl;
    this.rudder.rotation.y = -this.rudderDefl;

    // Control surfaces.
    if (this.grounded) {
      // On the gear the airframe settles to its natural nose-up taxi attitude
      // with level wings; pitch/roll input is ignored (you can't lean a plane
      // that's sitting on its gear). Rudder below still steers the taxi.
      this.pitch = easeToward(this.pitch, TAXI_PITCH, GROUND_LEVEL_RATE, dt);
      this.roll = easeToward(this.roll, 0, GROUND_LEVEL_RATE, dt);
    } else {
      this.pitch += pitchIn * PLANE_PITCH_RATE * dt;
      this.roll += rollIn * PLANE_ROLL_RATE * dt;
    }
    this.yaw += rudderIn * PLANE_RUDDER_RATE * dt;

    // Turning comes from banking.
    this.yaw += Math.sin(this.roll) * 1.7 * clamp(speed / 32, 0.2, 1.15) * dt;

    // Stall: below STALL_SPEED the nose drops (not while grounded on the strip).
    if (!this.grounded && speed < STALL_SPEED) this.pitch -= 0.125 * (1 - speed / STALL_SPEED) * dt;

    this.throttle = clamp(this.throttle + throttleIn * 0.7 * dt, 0, 1);

    this.quaternion.setFromEuler(this._euler.set(this.pitch, this.yaw, this.roll));

    // Branch fix: the Euler triple (pitch, roll, yaw) is not unique in SO(3).
    // Continuous W/A input can drift it onto the equivalent "inverted" branch
    // where cos(pitch) < 0, which makes W/S pitch the nose the wrong way even
    // though the plane is right-side up (and leaves the heading off by 180 deg).
    // When that happens, remap the triple onto the equivalent right-side-up
    // branch via the identity
    //   Ry(y)Rx(p)Rz(r) = Ry(y+PI)Rx(PI-p)Rz(r+PI)
    // which preserves the rotation exactly (no visual pop) and restores the
    // control law, without clamping |pitch| (full loops still work).
    if (Math.cos(this.pitch) < 0 && this.up.y > 0) {
      this.pitch = Math.PI - this.pitch;
      this.roll += Math.PI;
      this.yaw += Math.PI;
      this.quaternion.setFromEuler(this._euler.set(this.pitch, this.yaw, this.roll));
    }

    // Lift: rotate velocity toward the nose direction (needs forward speed).
    const v = this.velocity;
    const sFwd = Math.max(0, v.dot(this.forward));
    if (sFwd > 0.001) {
      const lift = clamp((sFwd - 9) / 9, 0, 1.35);
      const align = 2.8 * lift;
      if (align > 0.001) {
        this._velDir.copy(v).normalize();
        const fwd = this.forward;
        const ang = Math.acos(clamp(this._velDir.dot(fwd), -1, 1));
        if (ang > 1e-4) {
          this._axis.crossVectors(this._velDir, fwd);
          if (this._axis.lengthSq() > 1e-10) {
            this._axis.normalize();
            this._qAlign.setFromAxisAngle(this._axis, Math.min(ang, align * dt));
            v.applyQuaternion(this._qAlign);
          }
        }
      }
    }

    // Forces: thrust, gravity, drag.
    v.addScaledVector(this.forward, PLANE_THRUST * this.throttle * dt);
    v.y -= PLANE_GRAVITY * dt;
    const sp = v.length();
    v.multiplyScalar(Math.max(0, 1 - (PLANE_DRAG_Q * sp + PLANE_DRAG_L) * dt));

    this.position.addScaledVector(v, dt);

    // Propeller spin + sync the mesh.
    this.prop.rotation.z -= (8 + 26 * this.throttle) * dt;
    this._syncGroup();
  }

  _syncGroup() {
    this.group.position.copy(this.position);
    this.group.quaternion.copy(this.quaternion);
  }

  _buildModel(livery) {
    const g = new THREE.Group();

    const cream = new THREE.MeshLambertMaterial({ color: livery });
    const red = new THREE.MeshLambertMaterial({ color: 0xb3372f });
    const dark = new THREE.MeshLambertMaterial({ color: 0x26282c });
    const glass = new THREE.MeshPhongMaterial({
      color: 0x22384a,
      shininess: 90,
      specular: 0x88aacc,
    });
    const discMat = new THREE.MeshBasicMaterial({
      color: 0xdddddd,
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Fuselage (cylinder axis rotated onto Z).
    const fuselage = new THREE.Mesh(
      new THREE.CylinderGeometry(0.52, 0.52, 3.0, 24).rotateX(Math.PI / 2),
      cream
    );
    fuselage.position.set(0, 0, -0.5);
    g.add(fuselage);

    // Nose cowl (red, tapered toward the front).
    const cowl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.34, 0.8, 14).rotateX(Math.PI / 2),
      red
    );
    cowl.position.set(0, 0, -1.95);
    g.add(cowl);

    // Tapered tail: lathe with a curved (S-shaped) profile, blending from
    // the full fuselage radius down to a rounded tip. Axis is +Y before
    // rotation; rotateX(PI/2) maps it onto +Z (toward the tail).
    const tailProfile = [
      [0.0, 0.52],
      [0.2, 0.505],
      [0.4, 0.47],
      [0.6, 0.4],
      [0.8, 0.3],
      [1.0, 0.2],
      [1.1, 0.13],
      [1.16, 0.08],
      [1.2, 0.0],
    ].map(([y, r]) => new THREE.Vector2(r, y));
    const tailCone = new THREE.Mesh(
      new THREE.LatheGeometry(tailProfile, 24).rotateX(Math.PI / 2),
      cream
    );
    tailCone.position.set(0, 0.05, 1.0);
    g.add(tailCone);

    // Spinner + propeller.
    const spinner = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.5, 12).rotateX(-Math.PI / 2),
      red
    );
    spinner.position.set(0, 0, -2.45);
    g.add(spinner);

    this.prop = new THREE.Group();
    const blades = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.15, 0.05), dark);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), dark);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.12, 24), discMat);
    disc.position.z = -0.04;
    disc.castShadow = false;
    this.prop.add(blades, hub, disc);
    this.prop.position.set(0, 0, -2.66);
    g.add(this.prop);

    // Canopy (single seat).
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), glass);
    canopy.scale.set(0.75, 0.62, 1.7);
    canopy.position.set(0, 0.55, 0.35);
    g.add(canopy);

    // Low wing with red tips.
    const wing = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.12, 0.7), cream);
    wing.position.set(0, -0.42, 0.0);
    g.add(wing);
    for (const side of [1, -1]) {
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 1.05), red);
      tip.position.set(side * 3.55, -0.42, 0.15);
      g.add(tip);
    }

    // Ailerons: trailing-edge panels on the outer span (hinge on leading edge).
    for (const side of [1, -1]) {
      const hinge = new THREE.Group();
      hinge.position.set(side * 2.7, -0.42, 0.35);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.35), cream);
      panel.position.set(0, 0, 0.175);
      hinge.add(panel);
      g.add(hinge);
      if (side < 0) this.aileronL = hinge;
      else this.aileronR = hinge;
    }

    // Tailplane + elevator.
    const hStab = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.08, 0.4), cream);
    hStab.position.set(0, 0.12, 1.95);
    g.add(hStab);
    const elevHinge = new THREE.Group();
    elevHinge.position.set(0, 0.12, 2.225);
    const elevPanel = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.08, 0.25), cream);
    elevPanel.position.set(0, 0, 0.125);
    elevHinge.add(elevPanel);
    this.elevator = elevHinge;

    // Fin + rudder (grouped so the rudder inherits the fin tilt).
    const finGroup = new THREE.Group();
    finGroup.position.set(0, 0.78, 2.15);
    finGroup.rotation.x = 0.22;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.05, 0.4), red);
    fin.position.set(0, 0, -0.1);
    finGroup.add(fin);
    const rudderHinge = new THREE.Group();
    rudderHinge.position.set(0, 0, 0.2);
    const rudderPanel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.05, 0.2), red);
    rudderPanel.position.set(0, 0, 0.1);
    rudderHinge.add(rudderPanel);
    finGroup.add(rudderHinge);
    g.add(finGroup);
    this.rudder = rudderHinge;

    // Fixed landing gear (visual; the wheels define the crash/landing height).
    for (const side of [1, -1]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.55, 0.09), dark);
      strut.position.set(side * 1.05, -0.72, 0.55);
      strut.rotation.z = -side * 0.25;
      g.add(strut);
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.26, 0.26, 0.16, 14).rotateZ(Math.PI / 2),
        dark
      );
      wheel.position.set(side * 1.15, -0.95, 0.55);
      g.add(wheel);
    }
    const tailStrut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.06), dark);
    tailStrut.position.set(0, -0.45, 1.95);
    tailStrut.rotation.x = -0.6;
    g.add(tailStrut);
    const tailWheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.1, 10).rotateZ(Math.PI / 2),
      dark
    );
    tailWheel.position.set(0, -0.7, 1.95);
    g.add(tailWheel);

    g.traverse((o) => {
      if (o.isMesh && o !== disc) o.castShadow = true;
    });

    return g;
  }
}
