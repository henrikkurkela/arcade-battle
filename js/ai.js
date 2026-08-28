"use strict";

// ---------------------------------------------------------------------------
// Controllers. Each produces `control = { throttle, steer, brake, turretDX,
// turretDY, firing, shellFiring }` (throttle/steer in [-1, 1], brake 0/1,
// turretDX/turretDY raw pointer deltas) plus the fire flags.
//   PlayerController: keyboard + mouse -> control.
//   TankAI:           ground steering + targeting + firing (M4).
// `ctx` = { player, tanks, terrain } (built by main.js).
// ---------------------------------------------------------------------------

class PlayerController {
  constructor() {
    this.control = {
      throttle: 0,
      steer: 0,
      brake: 0,
      turretDX: 0,
      turretDY: 0,
      firing: false,
      shellFiring: false,
    };
  }

  update(dt, tank, ctx) {
    const c = this.control;
    c.throttle =
      (Input.isDown("KeyW", "ArrowUp") ? 1 : 0) -
      (Input.isDown("KeyS", "ArrowDown") ? 1 : 0);
    c.steer =
      (Input.isDown("KeyA", "ArrowLeft") ? 1 : 0) -
      (Input.isDown("KeyD", "ArrowRight") ? 1 : 0);
    c.brake = Input.isDown("ShiftLeft", "ShiftRight") ? 1 : 0;
    // Left click (or Space) fires the MG; right click (or X) the shell.
    c.firing = Input.isMouseDown("left") || Input.isDown("Space");
    c.shellFiring = Input.isMouseDown("right") || Input.isDown("KeyX");
    // Consume the pointer deltas accumulated since the last frame.
    const d = Input.consumeMouseDelta();
    c.turretDX = d.dx;
    c.turretDY = d.dy;
    return this.control;
  }
}

// --- TankAI tuning -----------------------------------------------------------
const RETARGET_INTERVAL = 0.3; // s between target re-picks
const ENGAGE_RANGE = 1200; // m; nearest enemy within this is engaged
const MG_FIRE_RANGE = 800; // m; max MG firing distance
const MG_FIRE_CONE = 0.97; // barrel must be within ~14 deg of the aim point
const MG_FIRE_INTERVAL_AI = 0.15; // s between AI MG shots
const PREFERRED_RANGE = 250; // m; approach if farther than this
const BACKOFF_RANGE = 120; // m; closer than this -> back off (reverse)
const LOOKAHEAD = 25; // m ahead of the hull to sample the terrain
const BATTLE_RADIUS = 1200; // m from the map center (leash)
const AI_SHELL_COOLDOWN = 20; // s between a tank's shell launches
const AI_SHELL_RANGE = 500; // m; max range for a shell to arc onto the target
const AI_SHELL_CONE = 0.92; // barrel must be within ~23 deg of the aim point
const K_STEER = 1.5; // hull yaw servo gain (max turn = TURN_RATE, enforced in tank.js)
const TURRET_YAW_RATE = 1.5; // rad/s AI turret slew
const TURRET_PITCH_RATE = 4; // rad/s AI turret elevation slew

class TankAI {
  constructor() {
    this.control = {
      throttle: 0,
      steer: 0,
      brake: 0,
      turretDX: 0,
      turretDY: 0,
      firing: false,
      shellFiring: false,
    };
    this.target = null; // tank currently being engaged
    this.retargetTimer = 0;
    this.fireCooldown = 0;
    this.shellCooldown = 0;
    // Ballistic launch direction for the next shell (read by main.js when
    // control.shellFiring is set). Arcs the unguided shell onto the aim point.
    this.shellDir = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._toTgt = new THREE.Vector3();
    this._barrel = new THREE.Vector3();
  }

  /** Clear engagement state (used on respawn / restart). */
  reset() {
    this.target = null;
    this.retargetTimer = 0;
    this.fireCooldown = 0;
    this.shellCooldown = 0;
    this.control.firing = false;
    this.control.shellFiring = false;
  }

  update(dt, tank, ctx) {
    const c = this.control;
    c.throttle = 0;
    c.steer = 0;
    c.brake = 0;
    c.turretDX = 0;
    c.turretDY = 0;
    c.firing = false;
    c.shellFiring = false;

    // 1. Throttle: full while engaging, cruise when loitering; back off
    //    (reverse) when inside BACKOFF_RANGE of the target.
    const t = this.target;
    const engaging = t && t.alive;
    c.throttle =
      engaging && tank.position.distanceTo(t.position) < BACKOFF_RANGE
        ? -0.7
        : engaging
          ? 1.0
          : 0.7;

    // 2. Target selection (nearest alive enemy tank in range).
    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0 || !this.target || !this.target.alive) {
      this.retargetTimer = RETARGET_INTERVAL;
      this._pickTarget(tank, ctx);
    }

    // 3. Lead the target so tracers meet it (loiter: the player's position).
    // Tracers inherit the shooter's velocity (combat.js), so use the
    // component of the relative velocity along the line of sight as the
    // effective closing speed for the lead time.
    if (t && t.alive) {
      const dist = tank.position.distanceTo(t.position);
      this._toTgt.copy(t.position).sub(tank.position).normalize();
      const closing =
        MG_BULLET_SPEED +
        (tank.velocity.x - t.velocity.x) * this._toTgt.x +
        (tank.velocity.z - t.velocity.z) * this._toTgt.z;
      const leadTime = dist / Math.max(closing, 40);
      this._aim.copy(t.position).addScaledVector(t.velocity, leadTime);
    } else {
      this._aim.copy(ctx.player.position);
    }

    // 3b. Battle-area leash: never stray more than BATTLE_RADIUS from the map
    // center. If it does, pull the aim point back onto the boundary so the
    // hull steering drives it home.
    const horiz = Math.hypot(tank.position.x, tank.position.z);
    if (horiz > BATTLE_RADIUS) {
      const s = BATTLE_RADIUS / horiz;
      this._aim.x = tank.position.x * s;
      this._aim.z = tank.position.z * s;
      this._aim.y = tank.position.y;
    }

    // 4. Steer the hull toward the aim point (yaw servo; tank.js enforces the
    // max turn rate and inverts the steering while reversing).
    const dx = this._aim.x - tank.position.x;
    const dz = this._aim.z - tank.position.z;
    const desiredYaw = Math.atan2(-dx, -dz); // hull nose is (-sin, 0, -cos)
    c.steer = clamp(wrapAngle(desiredYaw - tank.yaw) * K_STEER, -1, 1);

    // 4b. Terrain avoidance: ground steeper than the slope limit directly
    // ahead overrides the aim — steer toward the clearer side (sample the
    // left/right flanks ahead). Positive steer turns left.
    {
      const fx = -Math.sin(tank.yaw), fz = -Math.cos(tank.yaw);
      const rx = -fz, rz = fx; // right vector
      const px = tank.position.x, pz = tank.position.z;
      const h0 = ctx.terrain.heightAt(px, pz);
      const hAhead = ctx.terrain.heightAt(px + fx * LOOKAHEAD, pz + fz * LOOKAHEAD);
      if ((hAhead - h0) / LOOKAHEAD > SLOPE_TAN) {
        const hLeft = ctx.terrain.heightAt(px - rx * LOOKAHEAD, pz - rz * LOOKAHEAD);
        const hRight = ctx.terrain.heightAt(px + rx * LOOKAHEAD, pz + rz * LOOKAHEAD);
        c.steer = hLeft - h0 < hRight - h0 ? 1 : -1;
      }
    }

    // 5. Turret: slew toward the aim point — the ballistic solution when a
    // shell is ready and in range (rare), the direct line for the MG.
    // (tank.js converts the returned deltas via MOUSE_SENS and clamps pitch.)
    let shellArc = false;
    if (t && t.alive && this.shellCooldown <= 0) {
      if (
        tank.position.distanceTo(this._aim) < AI_SHELL_RANGE &&
        rocketLaunchDir(tank.position, this._aim, this.shellDir)
      ) {
        shellArc = true;
      }
    }
    let desiredTurretYaw, desiredTurretPitch;
    if (shellArc) {
      desiredTurretYaw = Math.atan2(-this.shellDir.x, -this.shellDir.z);
      desiredTurretPitch = Math.asin(clamp(this.shellDir.y, -1, 1));
    } else {
      const hDist = Math.hypot(dx, dz);
      desiredTurretYaw = Math.atan2(-dx, -dz);
      desiredTurretPitch = Math.atan2(this._aim.y - tank.position.y, hDist);
    }
    const worldYaw = tank.yaw + tank.turretYaw;
    const yawStep = clamp(
      wrapAngle(desiredTurretYaw - worldYaw),
      -TURRET_YAW_RATE * dt,
      TURRET_YAW_RATE * dt
    );
    const pitchStep = clamp(
      desiredTurretPitch - tank.turretPitch,
      -TURRET_PITCH_RATE * dt,
      TURRET_PITCH_RATE * dt
    );
    c.turretDX = -yawStep / MOUSE_SENS;
    c.turretDY = -pitchStep / MOUSE_SENS;

    // 6. Fire the MG: target in range, the barrel (not the hull) within the
    // fire cone, cooldown elapsed.
    if (t && t.alive && this.fireCooldown <= 0) {
      this._toTgt.copy(this._aim).sub(tank.position);
      if (this._toTgt.length() < MG_FIRE_RANGE) {
        tank.barrelDir(this._barrel);
        if (this._barrel.dot(this._toTgt.normalize()) > MG_FIRE_CONE) {
          c.firing = true;
          this.fireCooldown = MG_FIRE_INTERVAL_AI;
        }
      }
    }

    // 6b. Shell decision: rare (long cooldown) and powerful. Needs the target
    // in range, the barrel roughly on it, and a solvable ballistic arc — the
    // shell is then launched on that arc (dir read by main.js).
    if (t && t.alive && this.shellCooldown <= 0 && shellArc) {
      this._toTgt.copy(this._aim).sub(tank.position).normalize();
      tank.barrelDir(this._barrel);
      if (this._barrel.dot(this._toTgt) > AI_SHELL_CONE) {
        c.shellFiring = true;
        this.shellCooldown = AI_SHELL_COOLDOWN;
      }
    }

    // 7. Timers.
    this.fireCooldown -= dt;
    this.shellCooldown -= dt;
    return this.control;
  }

  _pickTarget(tank, ctx) {
    let best = null;
    let bestD = ENGAGE_RANGE;
    const consider = (p) => {
      if (!p || !p.alive) return;
      const d = tank.position.distanceTo(p.position);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    consider(ctx.player);
    for (const p of ctx.tanks) if (p !== tank) consider(p);
    this.target = best;
  }
}
