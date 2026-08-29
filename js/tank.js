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
//    eased to avoid jitter.
//  - Traction falls off on climbs: the steeper the slope, the less top speed
//    and acceleration, until the tracks spin in place at SLOPE_TAN. Descents
//    are faster (capped), and gravity bleeds/boosts speed along the slope.
//  - The turret is mouse-driven (pointer lock): yaw is free 360 deg, pitch is
//    clamped between TURRET_PITCH_MIN and TURRET_PITCH_MAX.
// ---------------------------------------------------------------------------

const TANK_HP = 100; // player and CPU
// Armor: a multiplier dividing incoming damage of the matching kind
// (effective = raw / armor, floored). SOFT damage is small-arms/MG fire,
// HARD damage is main-gun fire. The weapons' raw values are boosted by the
// same factors, so a tank's effective damage taken is exactly what it was
// before armor existed; future units tune their own levels (infantry ~1,
// bunkers much higher).
const TANK_SOFT_ARMOR = 10; // vs SOFT damage (MG / small arms)
const TANK_HARD_ARMOR = 1.25; // vs HARD damage (main gun)
const HULL_LEN = 4.5; // m, along local -Z (nose)
const HULL_WIDE = 2.6; // m
const HULL_HEIGHT = 1.3; // m, hull top above the tracks
const TRACK_H = 0.5; // m, hull center height above the ground
const COLLIDE_RADIUS = 2.6; // m, horizontal (tank-tank and tank-obstacle, M5)
const MAX_SPEED_FWD = 20; // m/s (~72 km/h), the flat-ground base value
const MAX_SPEED_REV = 8; // m/s
const ACCEL = 8; // m/s^2
const BRAKE_DECEL = 14; // m/s^2
const COAST_DECEL = 3; // m/s^2
const TURN_RATE = 1.4; // rad/s at full speed (scales with speed, see below)
// Traction model: SLOPE_TAN is the gradient at which grip runs out (tracks
// spin in place). Below it, traction (and with it top speed and acceleration)
// falls off quadratically, so gentle hills barely register.
const SLOPE_LIMIT = THREE.MathUtils.degToRad(35); // spin-out gradient
const SLOPE_TAN = Math.tan(SLOPE_LIMIT); // ~0.70
const GRAV = 6; // m/s^2, arcade slope gravity while coasting
const DOWNHILL_BOOST = 0.3; // extra top-speed fraction on steep descents
const SLIP_SPIN = 10; // m/s of track spin at full slip (spinning-in-place)
const TURRET_PITCH_MIN = THREE.MathUtils.degToRad(-10);
const TURRET_PITCH_MAX = THREE.MathUtils.degToRad(30);
const MOUSE_SENS = 0.0022; // rad/px (player turret)
const PLAYER_TURRET_YAW_RATE = 1.5; // rad/s max player turret slew
const HULL_EASE = 8; // pitch/roll easing rate (per second)
const CORNER_X = 1.3; // m, hull corner offset (left/right)
const CORNER_Z = 1.9; // m, hull corner offset (front/rear)
const SLOPE_AHEAD = 3; // m, how far ahead to sample the slope

// Track assembly dimensions (used by _buildModel and the tread animation).
const WHEEL_TOP = 0.56; // common top plane of all wheels
const R_BIG = 0.28; // road wheel radius
const R_SMALL = 0.22; // sprocket/idler radius
const TRACK_W = 0.62; // track width (extrusion depth)
const BAND = 0.09; // track band thickness
const TRACK_DROP = 0.5; // assembly lowered so the track bottom (not the
                        // hull bottom, at y=-0.15) is the tank's lowest
                        // point, resting on the ground (y=-TRACK_H)
const WHEEL_Z = [-2.0, -1.2, -0.4, 0.4, 1.2, 2.0];

// Track band loop path, for the crawling tread links. The band is a stadium:
// bottom run at y=0 from z=-TRACK_END_Z to +TRACK_END_Z, end arcs of radius
// TRACK_R_OUT centered at (±TRACK_END_Z, TRACK_R_OUT), top run at
// y=2*TRACK_R_OUT. `s` runs the way treads flow when driving forward (bottom
// run toward +z). Heights are band-midline values, before the -TRACK_DROP
// shift applied in _buildModel.
const TRACK_END_Z = WHEEL_Z[WHEEL_Z.length - 1]; // 2.0
const TRACK_R_OUT = WHEEL_TOP - R_SMALL; // 0.34, end-arc (outer) radius
const TRACK_R_MID = TRACK_R_OUT - BAND / 2; // band midline radius on arcs
const TRACK_RUN_LEN = 2 * TRACK_END_Z; // 4.0
const TRACK_ARC_LEN = Math.PI * TRACK_R_OUT;
const TRACK_LOOP_LEN = 2 * TRACK_RUN_LEN + 2 * TRACK_ARC_LEN;
const TRACK_LINKS_PER_SIDE = 32;
const _trackPt = { z: 0, y: 0, rotX: 0 }; // scratch, no per-frame allocation

/** Write the band-midline point at arc length `s` (0..TRACK_LOOP_LEN) into
 *  `out` = { z, y, rotX }; rotX aligns a box's local +Z with the tread flow. */
function trackPointAt(s, out) {
  if (s < TRACK_RUN_LEN) {
    out.z = -TRACK_END_Z + s;
    out.y = BAND / 2;
    out.rotX = 0;
  } else if (s < TRACK_RUN_LEN + TRACK_ARC_LEN) {
    const a = -Math.PI / 2 + (s - TRACK_RUN_LEN) / TRACK_R_OUT;
    out.z = TRACK_END_Z + TRACK_R_MID * Math.cos(a);
    out.y = TRACK_R_OUT + TRACK_R_MID * Math.sin(a);
    out.rotX = Math.atan2(-Math.cos(a), -Math.sin(a));
  } else if (s < 2 * TRACK_RUN_LEN + TRACK_ARC_LEN) {
    out.z = TRACK_END_Z - (s - TRACK_RUN_LEN - TRACK_ARC_LEN);
    out.y = 2 * TRACK_R_OUT - BAND / 2;
    out.rotX = Math.PI;
  } else {
    const a = Math.PI / 2 + (s - 2 * TRACK_RUN_LEN - TRACK_ARC_LEN) / TRACK_R_OUT;
    out.z = -TRACK_END_Z + TRACK_R_MID * Math.cos(a);
    out.y = TRACK_R_OUT + TRACK_R_MID * Math.sin(a);
    out.rotX = Math.atan2(-Math.cos(a), -Math.sin(a));
  }
  return out;
}

/** Small radial bolt pattern for the wheel faces, so wheel spin is visible.
 *  Maps onto the cylinder cap UVs (circle centered in the unit square). */
function makeWheelCapTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1e2022";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "#2b2e31";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(64, 64, 50, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#33373b";
  ctx.beginPath();
  ctx.arc(64, 64, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4b5054";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(64 + Math.cos(a) * 32, 64 + Math.sin(a) * 32, 5.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}
const WHEEL_CAP_TEX = makeWheelCapTexture();

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
    this.trackSpeed = 0; // speed the treads actually spin at (includes slip)
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
    // Armor levels (divisors for takeDamage by kind).
    this.softArmor = TANK_SOFT_ARMOR;
    this.hardArmor = TANK_HARD_ARMOR;

    // Scratch objects (avoid per-frame allocations).
    this._fwd = new THREE.Vector3();
    this._turretFwd = new THREE.Vector3();
    this._ahead = new THREE.Vector3();
    this._muzzleWorld = new THREE.Vector3();

    // Track/wheel animation state (filled by _buildModel).
    this._links = [];
    this._wheels = [];
    this._trackPhase = 0; // m along the track loop

    this.group = this._buildModel(opts.livery ?? 0x8a8f94);
    scene.add(this.group);
    this._syncGroup();
  }

  /** Unit vector pointing out of the hull nose. */
  get forward() {
    this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return this._fwd;
  }

  /** Horizontal unit vector along the turret axis (hull yaw + turret yaw,
   *  pitch ignored). Used by the chase camera to orbit with the turret. */
  get turretForward() {
    const a = this.yaw + this.turretYaw;
    this._turretFwd.set(-Math.sin(a), 0, -Math.cos(a));
    return this._turretFwd;
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

  /** Apply damage. `kind` selects the armor divisor: "soft" (small arms /
   *  MG) or "hard" (main gun); omit it for unarmored physical damage
   *  (collision). Returns the HP actually deducted (0 if dead or fully
   *  soaked by armor); the tank is destroyed when that leaves hp at 0. */
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
    this.group.visible = true;
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

    // Slope along the direction of travel (positive = climbing). When
    // (nearly) stationary, sample along the way the throttle is about to
    // push: nose for forward, tail for reverse.
    const dir = this.speed > 0 ? 1 : this.speed < 0 ? -1 : throttleIn >= 0 ? 1 : -1;
    this._ahead.copy(this.position).addScaledVector(this.forward, SLOPE_AHEAD * dir);
    const slopeAlong =
      (terrain.heightAt(this._ahead.x, this._ahead.z) -
        terrain.heightAt(this.position.x, this.position.z)) /
      (SLOPE_AHEAD * dir);

    // Traction: full on flat/downhill, falling quadratically to zero at
    // SLOPE_TAN (the tracks spin in place). Steep descents raise the cap.
    const climb = Math.max(0, slopeAlong);
    const t = clamp(1 - (climb / SLOPE_TAN) * (climb / SLOPE_TAN), 0, 1);
    const maxFwd =
      MAX_SPEED_FWD * (t + Math.max(0, -slopeAlong) * DOWNHILL_BOOST / SLOPE_TAN);

    // Longitudinal: throttle scaled by traction, coasting feels the slope
    // (gravity bleeds uphill, boosts downhill), brake decelerates hard.
    const sign = this.speed > 0 ? 1 : this.speed < 0 ? -1 : 0;
    if (brake) {
      this.speed = this.speed > 0
        ? Math.max(0, this.speed - BRAKE_DECEL * dt)
        : Math.min(0, this.speed + BRAKE_DECEL * dt);
    } else if (throttleIn > 0) {
      this.speed = Math.min(maxFwd, this.speed + ACCEL * throttleIn * t * dt);
    } else if (throttleIn < 0) {
      this.speed = Math.max(-MAX_SPEED_REV, this.speed + ACCEL * throttleIn * t * dt);
    } else {
      const accel = -sign * (GRAV * slopeAlong + COAST_DECEL);
      this.speed = clamp(this.speed + accel * dt, -MAX_SPEED_REV, maxFwd);
    }

    // Track slip: with lost traction the treads spin faster than the hull
    // moves — the "spinning in place" read (also feeds the dust puffs).
    this.trackSpeed = this.speed + throttleIn * (1 - t) * SLIP_SPIN;

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

    // Turret: mouse-driven (player). Yaw is rate-limited; pitch is clamped.
    this.turretYaw += clamp(
      -control.turretDX * MOUSE_SENS,
      -PLAYER_TURRET_YAW_RATE * dt,
      PLAYER_TURRET_YAW_RATE * dt
    );
    this.turretPitch = clamp(
      this.turretPitch - control.turretDY * MOUSE_SENS,
      TURRET_PITCH_MIN,
      TURRET_PITCH_MAX
    );

    this._updateTracks(dt, this.trackSpeed);
    this._syncGroup();
  }

  _syncGroup() {
    this.group.position.copy(this.position);
    this.group.rotation.set(this.hullPitch, this.yaw, this.hullRoll, "YXZ");
    this.turret.rotation.y = this.turretYaw;
    this.elev.rotation.x = this.turretPitch;
  }

  /** Spin the wheels and crawl the tread links at the given track speed
   *  (includes slip, so the treads can spin while the hull stands still).
   *  Forward (+speed, motion along -Z) drives the wheels so their bottom
   *  runs toward +Z, and the treads flow the same way around the loop. */
  _updateTracks(dt, speed) {
    for (const w of this._wheels) w.mesh.rotation.x -= (speed / w.r) * dt;
    let phase = (this._trackPhase + speed * dt) % TRACK_LOOP_LEN;
    if (phase < 0) phase += TRACK_LOOP_LEN;
    this._trackPhase = phase;
    const spacing = TRACK_LOOP_LEN / TRACK_LINKS_PER_SIDE;
    for (let i = 0; i < this._links.length; i++) {
      let s = (phase + i * spacing) % TRACK_LOOP_LEN;
      if (s < 0) s += TRACK_LOOP_LEN;
      trackPointAt(s, _trackPt);
      const link = this._links[i];
      link.position.set(link.userData.cx, _trackPt.y - TRACK_DROP, _trackPt.z);
      link.rotation.x = _trackPt.rotX;
    }
  }

  _buildModel(livery) {
    const g = new THREE.Group();

    const hullMat = new THREE.MeshLambertMaterial({ color: 0x4a5240 });
    const trackMat = new THREE.MeshLambertMaterial({ color: 0x2b2e30 });
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1e2022 });
    const turretMat = new THREE.MeshLambertMaterial({ color: livery });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x3a3d40 });

    // Hull: an extruded side profile with a pointed front — the upper glacis
    // rakes up-and-back from the apex to the top front edge, the lower glacis
    // rakes down-and-back to the nose bottom, so the apex is the frontmost
    // point (side view: <==|). Built in the side-view plane (shape x = tank
    // z, y = up) and extruded across the hull width.
    const hTop = TRACK_H + HULL_HEIGHT / 2; // hull top (1.15)
    const hBot = TRACK_H - HULL_HEIGHT / 2; // hull bottom (-0.15)
    const nose = -HULL_LEN / 2; // front extent (-2.25)
    const hullShape = new THREE.Shape();
    hullShape.moveTo(nose + 0.4, hBot); // nose bottom
    hullShape.lineTo(HULL_LEN / 2, hBot); // bottom rear
    hullShape.lineTo(HULL_LEN / 2, hTop); // top rear
    hullShape.lineTo(nose + 0.55, hTop); // top front
    hullShape.lineTo(nose, 0.2); // apex (frontmost point)
    hullShape.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(hullShape, {
      depth: HULL_WIDE,
      bevelEnabled: false,
    });
    hullGeo.rotateY(-Math.PI / 2); // shape x -> tank z, extrusion -> tank x
    hullGeo.translate(HULL_WIDE / 2, 0, 0); // center the extrusion on x=0
    g.add(new THREE.Mesh(hullGeo, hullMat));

    // Driver's viewport: a small black slit on the upper glacis, tank's left
    // side, lying flush with the raked plate (half-embedded, no z-fighting).
    const glacisTilt = Math.atan2(0.55, hTop - 0.2); // apex->top-front tilt from vertical
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.07, 0.05), wheelMat);
    slit.rotation.x = glacisTilt;
    const dDown = 0.45; // down the plate from the top front edge
    const dOut = 0.01; // outward along the plate normal
    slit.position.set(
      -0.45,
      hTop - dDown * Math.cos(glacisTilt) + dOut * Math.sin(glacisTilt),
      nose + 0.55 - dDown * Math.sin(glacisTilt) - dOut * Math.cos(glacisTilt)
    );
    g.add(slit);

    // Fenders: thin plates over each track, tying the hull to the tracks.
    for (const side of [1, -1]) {
      const fender = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.05, 4.4), hullMat);
      fender.position.set(side * (HULL_WIDE / 2 + 0.28), 0.2, 0);
      g.add(fender);
    }

    // Tracks: an extruded loop wrapping the wheel line, one per side, with six
    // wheels inside (spun by _updateTracks). The first and last wheels (drive
    // sprocket / idler) are smaller than the four road wheels; every wheel's
    // topmost point lies on the same plane (WHEEL_TOP), so the track's bottom
    // run sags at the road wheels and rises around the smaller end wheels.
    const capMat = new THREE.MeshLambertMaterial({ map: WHEEL_CAP_TEX });
    const bigGeo = new THREE.CylinderGeometry(R_BIG, R_BIG, 0.5, 12).rotateZ(Math.PI / 2);
    const smallGeo = new THREE.CylinderGeometry(R_SMALL, R_SMALL, 0.5, 12).rotateZ(Math.PI / 2);
    for (const side of [1, -1]) {
      const cx = side * (HULL_WIDE / 2 + 0.28);
      for (let i = 0; i < WHEEL_Z.length; i++) {
        const end = i === 0 || i === WHEEL_Z.length - 1;
        const r = end ? R_SMALL : R_BIG;
        // [side, cap, cap]: the bolted cap texture makes the spin visible.
        const wheel = new THREE.Mesh(end ? smallGeo : bigGeo, [wheelMat, capMat, capMat]);
        wheel.position.set(cx, WHEEL_TOP - r - TRACK_DROP, WHEEL_Z[i]);
        g.add(wheel);
        this._wheels.push({ mesh: wheel, r });
      }
      // Track loop: a stadium outline (bottom run at y=0, top run tangent to
      // the end-wheel wrap arcs) with a stadium hole offset in by BAND, so the
      // wheels show through the window. Built in the side-view plane
      // (shape x = tank z, y = up) and extruded across the track width.
      const cEndY = WHEEL_TOP - R_SMALL; // end wheel center height (0.34)
      const rOut = cEndY; // outer arc radius: bottom at y=0, top at y=2*cEndY
      const rIn = rOut - BAND;
      const shape = new THREE.Shape();
      shape.moveTo(-WHEEL_Z[5], 0);
      shape.lineTo(WHEEL_Z[5], 0);
      shape.absarc(WHEEL_Z[5], cEndY, rOut, -Math.PI / 2, Math.PI / 2, false);
      shape.lineTo(-WHEEL_Z[5], 2 * cEndY);
      shape.absarc(-WHEEL_Z[5], cEndY, rOut, Math.PI / 2, (3 * Math.PI) / 2, false);
      const hole = new THREE.Path();
      hole.moveTo(WHEEL_Z[5], BAND);
      hole.lineTo(-WHEEL_Z[5], BAND);
      hole.absarc(-WHEEL_Z[5], cEndY, rIn, -Math.PI / 2, Math.PI / 2, true);
      hole.lineTo(WHEEL_Z[5], 2 * cEndY - BAND);
      hole.absarc(WHEEL_Z[5], cEndY, rIn, Math.PI / 2, (3 * Math.PI) / 2, true);
      shape.holes.push(hole);
      const trackGeo = new THREE.ExtrudeGeometry(shape, {
        depth: TRACK_W,
        bevelEnabled: false,
        curveSegments: 12,
      });
      trackGeo.rotateY(-Math.PI / 2); // shape x -> tank z, extrusion -> tank x
      trackGeo.translate(TRACK_W / 2, 0, 0); // center the extrusion on x=0
      const track = new THREE.Mesh(trackGeo, trackMat);
      track.position.set(cx, -TRACK_DROP, 0);
      g.add(track);
    }

    // Tread links: small plates riding on the band, repositioned each frame
    // by _updateTracks so the tracks visibly crawl with speed.
    const linkGeo = new THREE.BoxGeometry(TRACK_W + 0.03, BAND + 0.06, 0.16);
    const treadMat = new THREE.MeshLambertMaterial({ color: 0x212426 });
    for (const side of [1, -1]) {
      const cx = side * (HULL_WIDE / 2 + 0.28);
      for (let i = 0; i < TRACK_LINKS_PER_SIDE; i++) {
        const link = new THREE.Mesh(linkGeo, treadMat);
        link.userData.cx = cx;
        g.add(link);
        this._links.push(link);
      }
    }
    this._updateTracks(0, 0); // seat the links before the first update()

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
