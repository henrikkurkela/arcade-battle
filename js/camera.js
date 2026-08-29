"use strict";

// ---------------------------------------------------------------------------
// Chase camera: sits behind and above the TURRET axis (so swinging the turret
// orbits the camera around the tank), follows with a little lead in the
// direction of travel, widens the FOV at speed, and can shake (hit /
// destruction feedback). The tank stays level-ish, so the horizon is NOT
// banked — the camera up stays world-up.
// ---------------------------------------------------------------------------

const CAM_BACK = 12; // m behind the turret axis
const CAM_UP = 4.5; // m
const CAM_LOOK_AHEAD = 6; // m ahead along the turret axis
const CAM_VEL_LEAD = 0.08; // small lead in the direction of motion
const CAM_FOV_BASE = 70;
const CAM_FOV_KICK = 10; // added at top speed
const CAM_FOV_SPAN = 10; // m/s over which the kick ramps in (10 -> 20 m/s)

class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.shake = 0;
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  /** Instantly place the camera (used on spawn/restart). */
  snap(tank) {
    const fwd = tank.turretForward;
    this._pos
      .copy(tank.position)
      .addScaledVector(fwd, -CAM_BACK)
      .add(this._tmp.set(0, CAM_UP, 0));
    this._look.copy(tank.position).addScaledVector(fwd, CAM_LOOK_AHEAD);
    this.camera.position.copy(this._pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._look);
  }

  update(dt, tank) {
    const fwd = tank.turretForward;
    const t = 1 - Math.pow(0.0005, dt); // frame-rate independent smoothing

    // Desired position: 12 m behind the turret axis, 4.5 m up.
    this._pos
      .copy(tank.position)
      .addScaledVector(fwd, -CAM_BACK)
      .add(this._tmp.set(0, CAM_UP, 0));
    this.camera.position.lerp(this._pos, t);

    // Look slightly ahead, with a small lead in the direction of motion.
    this._look
      .copy(tank.position)
      .addScaledVector(fwd, CAM_LOOK_AHEAD)
      .addScaledVector(tank.velocity, CAM_VEL_LEAD);

    // No banking: the camera up stays world-up.
    this.camera.up.set(0, 1, 0);

    // Hit / destruction shake.
    if (this.shake > 0.001) {
      const s = this.shake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.shake *= Math.pow(0.05, dt);
    }

    this.camera.lookAt(this._look);

    // Speed-sensitive FOV kick (no banking, just a wider view at speed).
    const fov = CAM_FOV_BASE + CAM_FOV_KICK * clamp((Math.abs(tank.speed) - 10) / CAM_FOV_SPAN, 0, 1);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

// ---------------------------------------------------------------------------
// Plane chase camera (ported from the Arcade Plane game): sits behind and
// slightly above the plane, follows with a little lead in the direction of
// travel, banks the horizon partially with the plane, widens the FOV at
// speed, and can shake (crash feedback).
// ---------------------------------------------------------------------------

const PCAM_BACK = 15; // m behind the nose
const PCAM_UP = 5.2; // m
const PCAM_LOOK_AHEAD = 7; // m ahead along the nose
const PCAM_VEL_LEAD = 0.12; // small lead in the direction of motion
const PCAM_BANK = 0.45; // fraction of the plane's up used as the camera up
const PCAM_FOV_BASE = 72;
const PCAM_FOV_KICK = 16; // added at top speed
const PCAM_FOV_SPAN = 40; // m/s over which the kick ramps in (25 -> 65 m/s)

class PlaneChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.shake = 0;
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  /** Instantly place the camera (used on spawn/restart). */
  snap(plane) {
    const fwd = plane.forward;
    this._pos
      .copy(plane.position)
      .addScaledVector(fwd, -PCAM_BACK)
      .add(this._tmp.set(0, PCAM_UP, 0));
    this._look.copy(plane.position).addScaledVector(fwd, PCAM_LOOK_AHEAD);
    this.camera.position.copy(this._pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._look);
  }

  update(dt, plane) {
    const fwd = plane.forward;
    const t = 1 - Math.pow(0.0005, dt); // frame-rate independent smoothing

    // Desired position: 15 m behind, 5.2 m up.
    this._pos
      .copy(plane.position)
      .addScaledVector(fwd, -PCAM_BACK)
      .add(this._tmp.set(0, PCAM_UP, 0));
    this.camera.position.lerp(this._pos, t);

    // Look slightly ahead, with a small lead in the direction of motion.
    this._look
      .copy(plane.position)
      .addScaledVector(fwd, PCAM_LOOK_AHEAD)
      .addScaledVector(plane.velocity, PCAM_VEL_LEAD);

    // Bank the horizon with the plane (partial, keeps it readable).
    this._up.set(0, 1, 0).lerp(plane.up, PCAM_BANK).normalize();
    this.camera.up.copy(this._up);

    // Crash shake.
    if (this.shake > 0.001) {
      const s = this.shake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.shake *= Math.pow(0.05, dt);
    }

    this.camera.lookAt(this._look);

    // Speed-sensitive FOV kick.
    const fov = PCAM_FOV_BASE + PCAM_FOV_KICK * clamp((plane.speed - 25) / PCAM_FOV_SPAN, 0, 1);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
