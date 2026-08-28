"use strict";

// ---------------------------------------------------------------------------
// The tank: a tracked combat vehicle built from primitives, plus an arcade
// ground-vehicle model.
//
// Model: units are meters, +Y is up, the nose points down -Z.
//
// Ground model (deliberately simple, tuned to feel "arcade"):
//  - W/S throttle forward/reverse, A/D steer, Shift brake.
//  - Speed is a signed scalar along the hull heading (velocity is 2D, y comes
//    from the terrain). Throttle accelerates, brake decelerates hard, coast
//    bleeds speed off slowly.
//  - Steering scales with speed (the hull can't pivot in place, but still
//    turns slowly at a crawl) and inverts while reversing.
//  - The hull follows the terrain: y from the four hull corners, pitch/roll
//    eased to avoid jitter. Slopes steeper than SLOPE_LIMIT kill forward
//    motion (you can still reverse back down).
//  - The turret is mouse-driven (pointer lock): yaw is free 360 deg, pitch is
//    clamped between TURRET_PITCH_MIN and TURRET_PITCH_MAX.
// ---------------------------------------------------------------------------

const TANK_HP = 100; // player and CPU
const HULL_LEN = 4.5; // m, along local -Z (nose)
const HULL_WIDE = 2.6; // m
const HULL_HEIGHT = 1.3; // m, hull top above the tracks
const TRACK_H = 0.5; // m, hull center height above the ground
const COLLIDE_RADIUS = 2.6; // m, horizontal (tank-tank and tank-obstacle, M5)
const MAX_SPEED_FWD = 20; // m/s (~72 km/h)
const MAX_SPEED_REV = 8; // m/s
const ACCEL = 8; // m/s^2
const BRAKE_DECEL = 14; // m/s^2
const COAST_DECEL = 3; // m/s^2
const TURN_RATE = 1.4; // rad/s at full speed (scales with speed, see below)
const SLOPE_LIMIT = THREE.MathUtils.degToRad(35); // cannot climb steeper
const SLOPE_TAN = Math.tan(SLOPE_LIMIT); // ~0.70
const TURRET_PITCH_MIN = THREE.MathUtils.degToRad(-10);
const TURRET_PITCH_MAX = THREE.MathUtils.degToRad(30);
const MOUSE_SENS = 0.0022; // rad/px (player turret)
const HULL_EASE = 8; // pitch/roll easing rate (per second)
const CORNER_X = 1.3; // m, hull corner offset (left/right)
const CORNER_Z = 1.9; // m, hull corner offset (front/rear)
const SLOPE_AHEAD = 3; // m, how far ahead to sample the climb limit

/** Exponential ease toward a target (frame-rate independent). */
function easeToward(current, target, rate, dt) {
  const t = 1 - Math.exp(-rate * dt);
  return current + (target - current) * t;
}

class Tank {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3(); // 2D motion (x, z); y stays 0
    this.speed = 0; // signed scalar: + forward, - reverse
    this.yaw = 0;
    this.turretYaw = 0;
    this.turretPitch = 0;
    this.hullPitch = 0;
    this.hullRoll = 0;

    // Combat state.
    this.hp = this.maxHp = TANK_HP;
    this.alive = true;
    this.team = "player"; // "player" | "cpuN"
    this.callsign = "YOU";

    // Scratch objects (avoid per-frame allocations).
    this._fwd = new THREE.Vector3();
    this._ahead = new THREE.Vector3();
    this._muzzleWorld = new THREE.Vector3();

    this.group = this._buildModel(opts.livery ?? 0x8a8f94);
    scene.add(this.group);
    this._syncGroup();
  }

  /** Unit vector pointing out of the hull nose. */
  get forward() {
    this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return this._fwd;
  }

  /** World-space muzzle point (write into `out` to avoid allocation). */
  muzzleWorld(out) {
    this.group.updateMatrixWorld(true);
    return this.muzzleObj.getWorldPosition(out);
  }

  /** World-space barrel direction (write into `out` to avoid allocation).
   *  Hull yaw + turret yaw, pitched by the turret elevation. */
  barrelDir(out) {
    const a = this.yaw + this.turretYaw;
    const p = this.turretPitch;
    const cp = Math.cos(p);
    out.set(-cp * Math.sin(a), Math.sin(p), -cp * Math.cos(a));
    return out;
  }

  /** Apply damage. Returns true if this call destroyed the tank. */
  takeDamage(amount) {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;
    }
    return false;
  }

  /** Place the tank at (x, z) facing `yaw`; y is computed from the terrain. */
  reset(x, z, yaw, terrain) {
    this.position.set(x, 0, z);
    this.position.y = terrain.heightAt(x, z) + TRACK_H;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.yaw = yaw || 0;
    this.turretYaw = 0;
    this.turretPitch = 0;
    this.hullPitch = 0;
    this.hullRoll = 0;
    this.hp = this.maxHp;
    this.alive = true;
    this._syncGroup();
  }

  /**
   * One physics step. `control = { throttle: -1..1, steer: -1..1, brake: 0/1,
   * turretDX, turretDY, firing, shellFiring }` (produced by a Controller).
   * `terrain` provides heightAt for the ground-following.
   */
  update(dt, control, terrain) {
    const throttleIn = clamp(control.throttle, -1, 1);
    const steerIn = clamp(control.steer, -1, 1);
    const brake = control.brake ? 1 : 0;

    // Longitudinal: throttle accelerates, brake decelerates hard, coast bleeds.
    if (brake) {
      if (this.speed > 0) this.speed = Math.max(0, this.speed - BRAKE_DECEL * dt);
      else if (this.speed < 0) this.speed = Math.min(0, this.speed + BRAKE_DECEL * dt);
    } else if (throttleIn > 0) {
      this.speed = Math.min(MAX_SPEED_FWD, this.speed + ACCEL * throttleIn * dt);
    } else if (throttleIn < 0) {
      this.speed = Math.max(-MAX_SPEED_REV, this.speed + ACCEL * throttleIn * dt);
    } else {
      if (this.speed > 0) this.speed = Math.max(0, this.speed - COAST_DECEL * dt);
      else if (this.speed < 0) this.speed = Math.min(0, this.speed + COAST_DECEL * dt);
    }

    // Slope limit: ground steeper than SLOPE_LIMIT directly ahead kills forward
    // motion (the tank can still reverse back downhill).
    if (this.speed > 0) {
      this._ahead.copy(this.position).addScaledVector(this.forward, SLOPE_AHEAD);
      const slopeUp =
        (terrain.heightAt(this._ahead.x, this._ahead.z) -
          terrain.heightAt(this.position.x, this.position.z)) /
        SLOPE_AHEAD;
      if (slopeUp > SLOPE_TAN) this.speed = 0;
    }

    // Steering: scales with speed (no in-place pivot) and inverts in reverse.
    const speedFactor = clamp(Math.abs(this.speed) / 8, 0.15, 1);
    const reversing = this.speed < 0;
    this.yaw += steerIn * TURN_RATE * dt * speedFactor * (reversing ? -1 : 1);

    // Move (2D; y is re-derived from the terrain below).
    const fwd = this.forward;
    this.velocity.set(fwd.x * this.speed, 0, fwd.z * this.speed);
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // Terrain following: y from the four hull corners, pitch/roll eased.
    const fx = fwd.x, fz = fwd.z;
    const rx = -fz, rz = fx; // right vector (perpendicular, +X when facing -Z)
    const px = this.position.x, pz = this.position.z;
    const fl = terrain.heightAt(px + rx * CORNER_X + fx * CORNER_Z, pz + rz * CORNER_X + fz * CORNER_Z);
    const fr = terrain.heightAt(px - rx * CORNER_X + fx * CORNER_Z, pz - rz * CORNER_X + fz * CORNER_Z);
    const bl = terrain.heightAt(px + rx * CORNER_X - fx * CORNER_Z, pz + rz * CORNER_X - fz * CORNER_Z);
    const br = terrain.heightAt(px - rx * CORNER_X - fx * CORNER_Z, pz - rz * CORNER_X - fz * CORNER_Z);
    this.position.y = (fl + fr + bl + br) / 4 + TRACK_H;
    const targetPitch = Math.atan2((fl + fr) / 2 - (bl + br) / 2, 2 * CORNER_Z);
    // Roll: the +right corners (fl, bl) are the tank's RIGHT side and the
    // -right corners (fr, br) its LEFT side. A positive rotation.z lifts the
    // +X (right) side, so the left side rising must yield a negative roll.
    const targetRoll = Math.atan2((fl + bl) / 2 - (fr + br) / 2, 2 * CORNER_X);
    this.hullPitch = easeToward(this.hullPitch, targetPitch, HULL_EASE, dt);
    this.hullRoll = easeToward(this.hullRoll, targetRoll, HULL_EASE, dt);

    // Turret: mouse-driven (player). Yaw is free; pitch is clamped.
    this.turretYaw -= control.turretDX * MOUSE_SENS;
    this.turretPitch = clamp(
      this.turretPitch - control.turretDY * MOUSE_SENS,
      TURRET_PITCH_MIN,
      TURRET_PITCH_MAX
    );

    this._syncGroup();
  }

  _syncGroup() {
    this.group.position.copy(this.position);
    this.group.rotation.set(this.hullPitch, this.yaw, this.hullRoll, "YXZ");
    this.turret.rotation.y = this.turretYaw;
    this.elev.rotation.x = this.turretPitch;
  }

  _buildModel(livery) {
    const g = new THREE.Group();

    const hullMat = new THREE.MeshLambertMaterial({ color: 0x4a5240 });
    const trackMat = new THREE.MeshLambertMaterial({ color: 0x2b2e30 });
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1e2022 });
    const turretMat = new THREE.MeshLambertMaterial({ color: livery });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x3a3d40 });

    // Hull.
    const hull = new THREE.Mesh(new THREE.BoxGeometry(HULL_WIDE, HULL_HEIGHT, HULL_LEN), hullMat);
    hull.position.y = TRACK_H;
    g.add(hull);

    // Tracks (two boxes, one per side) + six road wheels each (static).
    for (const side of [1, -1]) {
      const track = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, HULL_LEN + 0.1), trackMat);
      track.position.set(side * (HULL_WIDE / 2 + 0.28), 0.25, 0);
      g.add(track);
      for (let i = 0; i < 6; i++) {
        const z = -2.0 + i * 0.8;
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.28, 0.5, 12).rotateZ(Math.PI / 2),
          wheelMat
        );
        wheel.position.set(side * (HULL_WIDE / 2 + 0.28), 0.28, z);
        g.add(wheel);
      }
    }

    // Turret (yaws) -> elevation (pitches) -> barrel.
    this.turret = new THREE.Group();
    this.turret.position.set(0, 1.5, 0);
    g.add(this.turret);
    this.elev = new THREE.Group();
    this.turret.add(this.elev);

    const turretBox = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 2.0), turretMat);
    this.turret.add(turretBox);
    // Rear bustle.
    const bustle = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 0.7), turretMat);
    bustle.position.set(0, -0.05, 1.15);
    this.turret.add(bustle);
    // Driver's hatch.
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.5), darkMat);
    hatch.position.set(0.45, 0.42, 0.35);
    this.turret.add(hatch);

    // Barrel (points -Z) with a muzzle brake near the tip. The rear end
    // extends past the elevation hinge (z = 0) so it stays buried inside the
    // turret box at all pitches — no visible gap when raising/lowering.
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 4.5, 10).rotateX(Math.PI / 2), darkMat);
    barrel.position.set(0, 0, -1.95);
    this.elev.add(barrel);
    const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 10).rotateX(Math.PI / 2), darkMat);
    brake.position.set(0, 0, -3.95);
    this.elev.add(brake);

    // Empty marker at the barrel tip for the muzzle world position.
    this.muzzleObj = new THREE.Object3D();
    this.muzzleObj.position.set(0, 0, -4.3);
    this.elev.add(this.muzzleObj);

    // Antenna on the rear hull.
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.2, 6), darkMat);
    antenna.position.set(0.8, 1.75, 1.8);
    antenna.rotation.z = 0.12;
    g.add(antenna);

    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });

    return g;
  }
}
