"use strict";

// ---------------------------------------------------------------------------
// Controllers. Each produces `control = { throttle, steer, brake, turretDX,
// turretDY, firing, shellFiring }` (throttle/steer in [-1, 1], brake 0/1,
// turretDX/turretDY raw pointer deltas) plus the fire flags.
//   PlayerController:          tank keyboard + mouse -> control.
//   PlanePlayerController:     plane keyboard + mouse -> control.
//   RiflemanPlayerController:  on-foot keyboard + pointer aim -> control.
//   TankAI:                    ground steering + targeting + firing (M4).
// `ctx` = { player, tanks, terrain } (built by main.js).
// ---------------------------------------------------------------------------

// --- Difficulty (M1) ----------------------------------------------------------
// Per-difficulty AI tuning, chosen in the start / game-over menu. Error values
// are in degrees; converted to radians at the fire sites (main.js). `AI` is the
// active set; setDifficulty() (main.js) swaps it. Phase 1 covers tanks +
// riflemen; planes + AA guns get their own fields in phase 2.
const AI_DIFF = {
  easy: {
    tankErrorBase: 2.0, // deg; MG spread at close range
    tankErrorRange: 4.0, // deg; extra spread at max range
    rifleErrorBase: 2.5,
    rifleErrorRange: 5.0,
    aimWarmup: 3.0, // x; extra error while the target is not locked (M2)
    focusTime: 2.0, // s; focus needed for a full lock (M2)
    tankMgRange: 500, // m; max MG firing distance (M3)
    tankEngage: 800, // m; target pickup range (M3)
    tankShellRange: 350, // m; max shell arc range (M3)
    rifleFireRange: 100, // m; rifleman firing range (M3)
    rifleEngage: 120, // m; rifleman target pickup range (M3)
    rifleLead: 0.0, // s; extra lead built into the aim (M3)
    aiMgDamage: 12, // HP; AI MG shot damage (M4)
    aiShellDamage: 45, // HP; AI shell blast-center damage (M4)
    planeErrorBase: 0.6, // deg; plane cannon spread at close range (M5)
    planeErrorRange: 0.8, // deg; extra spread at max range (M5)
    planeEngage: 950, // m; plane target pickup range (M5)
    planeFireRange: 550, // m; plane cannon firing range (M5)
    planeRocketRange: 320, // m; plane rocket arc range (M5)
    aiPlaneBulletDamage: 16, // HP; AI plane tracer damage (M5)
    aiPlaneRocketDamage: 26, // HP; AI plane rocket blast-center damage (M5)
    aaErrorBase: 1.2, // deg; AA tracer spread at close range (M6)
    aaErrorRange: 2.4, // deg; extra spread at max range (M6)
    aaEngage: 550, // m; AA target pickup range (M6)
    aaBulletDamage: 18, // HP; AA tracer damage (M6)
    aaRocketDamage: 26, // HP; AA rocket blast-center damage (M6)
  },
  normal: {
    tankErrorBase: 1.0,
    tankErrorRange: 2.0,
    rifleErrorBase: 1.2,
    rifleErrorRange: 2.5,
    aimWarmup: 2.0,
    focusTime: 1.2,
    tankMgRange: 650,
    tankEngage: 1000,
    tankShellRange: 425,
    rifleFireRange: 125,
    rifleEngage: 140,
    rifleLead: 0.15,
    aiMgDamage: 16,
    aiShellDamage: 60,
    planeErrorBase: 0.4,
    planeErrorRange: 0.6,
    planeEngage: 1050,
    planeFireRange: 625,
    planeRocketRange: 350,
    aiPlaneBulletDamage: 19,
    aiPlaneRocketDamage: 32,
    aaErrorBase: 0.6,
    aaErrorRange: 1.2,
    aaEngage: 625,
    aaBulletDamage: 21,
    aaRocketDamage: 32,
  },
  hard: {
    tankErrorBase: 0.4,
    tankErrorRange: 0.8,
    rifleErrorBase: 0.5,
    rifleErrorRange: 1.0,
    aimWarmup: 1.0,
    focusTime: 0.6,
    tankMgRange: 800,
    tankEngage: 1200,
    tankShellRange: 500,
    rifleFireRange: 150,
    rifleEngage: 160,
    rifleLead: 0.3,
    aiMgDamage: 20,
    aiShellDamage: 75,
    planeErrorBase: 0.2,
    planeErrorRange: 0.4,
    planeEngage: 1200,
    planeFireRange: 700,
    planeRocketRange: 400,
    aiPlaneBulletDamage: 21,
    aiPlaneRocketDamage: 35,
    aaErrorBase: 0.4,
    aaErrorRange: 0.8,
    aaEngage: 700,
    aaBulletDamage: 24,
    aaRocketDamage: 35,
  },
};
let AI = Object.assign({}, AI_DIFF.normal); // active set (swapped by main.js)

const _SPREAD_UP = new THREE.Vector3(0, 1, 0);
const _SPREAD_RIGHT = new THREE.Vector3(1, 0, 0);

/** Rotate `dir` in place by a random angle <= the per-shot error (radians).
 *  The error grows with the shooter-target distance and is worse while the
 *  target is not locked (the focus ramp lands in M2). */
function applySpread(dir, dist, base, range, fireRange, lock, warmup) {
  const f = clamp(dist / fireRange, 0, 1);
  const ang = (base + range * f) * (1 + warmup * (1 - lock));
  if (ang <= 0) return;
  const a = Math.random() * ang;
  const phi = Math.random() * Math.PI * 2;
  // Random axis in the plane perpendicular to dir.
  const ref = Math.abs(dir.y) < 0.99 ? _SPREAD_UP : _SPREAD_RIGHT;
  const x = new THREE.Vector3().crossVectors(dir, ref).normalize();
  const y = new THREE.Vector3().crossVectors(dir, x);
  dir.addScaledVector(x, Math.cos(phi) * a)
    .addScaledVector(y, Math.sin(phi) * a)
    .normalize();
}

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

// --- PlanePlayerController (plane vehicle) -----------------------------------
// Flight controls: pointer-locked mouse (up/down = pitch, left/right = bank)
// plus keyboard (W/S pitch, A/D bank, Q/E rudder, Shift/Ctrl/C throttle) and
// the mouse wheel (throttle). Mouse and keyboard inputs are summed and
// clamped, so the keyboard remains a fallback if the pointer lock fails.
// Space/LMB fire the cannon, X/RMB rockets.
const PLANE_MOUSE_SENS = 1 / 10; // mouse px for full control deflection
const PLANE_WHEEL_THROTTLE_STEP = 0.05; // throttle change per wheel notch

class PlanePlayerController {
  constructor() {
    this.control = { pitch: 0, roll: 0, rudder: 0, throttle: 0, firing: false, rocketFiring: false };
  }

  update(dt, plane, ctx) {
    const c = this.control;
    // Mouse (pointer locked): up = pitch up, right = bank right.
    const d = Input.consumeMouseDelta();
    const kbPitch =
      (Input.isDown("KeyW", "ArrowUp") ? 1 : 0) -
      (Input.isDown("KeyS", "ArrowDown") ? 1 : 0);
    const kbRoll =
      (Input.isDown("KeyA", "ArrowLeft") ? 1 : 0) -
      (Input.isDown("KeyD", "ArrowRight") ? 1 : 0);
    c.pitch = clamp(kbPitch - d.dy * PLANE_MOUSE_SENS, -1, 1);
    c.roll = clamp(kbRoll - d.dx * PLANE_MOUSE_SENS, -1, 1);
    c.rudder = (Input.isDown("KeyQ") ? 1 : 0) - (Input.isDown("KeyE") ? 1 : 0);
    c.throttle =
      (Input.isDown("ShiftLeft", "ShiftRight") ? 1 : 0) -
      (Input.isDown("ControlLeft", "ControlRight", "KeyC") ? 1 : 0);
    // Mouse wheel adjusts the throttle directly (up = more). It is a discrete
    // input, so it bypasses the rate-based `c.throttle` and steps the plane's
    // throttle by a fixed amount per notch.
    const wheel = Input.consumeMouseWheel();
    if (wheel !== 0) {
      plane.throttle = clamp(plane.throttle - wheel * PLANE_WHEEL_THROTTLE_STEP, 0, 1);
    }
    // Left click (or Space) fires the cannon; right click (or X) rockets.
    c.firing = Input.isDown("Space") || Input.isMouseDown("left");
    c.rocketFiring = Input.isDown("KeyX") || Input.isMouseDown("right");
    return this.control;
  }
}

// --- RiflemanPlayerController (rifleman vehicle) -----------------------------
// On-foot controls: pointer-locked mouse aims the body (yaw) + rifle (pitch),
// W/S walk forward/back (back at the walk pace), A/D turn in place, Shift
// sprints. Left click / Space fires the sniper (phase 3); right click / X
// throws a grenade (phase 3). The fire flags are produced here but only acted
// on once the weapons land; phase 1 just walks, sprints, turns and aims.
class RiflemanPlayerController {
  constructor() {
    this.control = {
      throttle: 0,
      steer: 0,
      sprint: 0,
      aimDX: 0,
      aimDY: 0,
      firing: false,
      grenadeFiring: false,
    };
  }

  update(dt, rifleman, ctx) {
    const c = this.control;
    // Walk forward (W) / back (S, at the walk pace — the model caps reverse).
    c.throttle =
      (Input.isDown("KeyW", "ArrowUp") ? 1 : 0) -
      (Input.isDown("KeyS", "ArrowDown") ? 1 : 0);
    // Turn in place (A/D). The mouse also drives the body yaw (aimDX below).
    c.steer =
      (Input.isDown("KeyA", "ArrowLeft") ? 1 : 0) -
      (Input.isDown("KeyD", "ArrowRight") ? 1 : 0);
    c.sprint = Input.isDown("ShiftLeft", "ShiftRight") ? 1 : 0;
    // Left click (or Space) fires the sniper; right click (or X) a grenade.
    c.firing = Input.isMouseDown("left") || Input.isDown("Space");
    c.grenadeFiring = Input.isMouseDown("right") || Input.isDown("KeyX");
    // Consume the pointer deltas accumulated since the last frame (aim).
    const d = Input.consumeMouseDelta();
    c.aimDX = d.dx;
    c.aimDY = d.dy;
    return this.control;
  }
}

// --- TankAI tuning -----------------------------------------------------------
const RETARGET_INTERVAL = 0.3; // s between target re-picks
// Engage / fire ranges come from the active difficulty set (AI.tankEngage,
// AI.tankMgRange, AI.tankShellRange) so they can be swapped mid-session.
const MG_FIRE_CONE = 0.97; // barrel must be within ~14 deg of the aim point
  const MG_FIRE_INTERVAL_AI = 0.15; // s between AI MG shots
  const MG_BURST_ROUNDS = 5; // rounds per MG burst
  const MG_BURST_PAUSE = 0.5; // s pause between bursts (observe + re-aim)
const PREFERRED_RANGE = 250; // m; approach if farther than this
const BACKOFF_RANGE = 120; // m; closer than this -> back off (reverse)
const LOOKAHEAD = 25; // m ahead of the hull to sample the terrain
const BATTLE_RADIUS = 1200; // m from the map center (leash)
const AI_SHELL_COOLDOWN = 20; // s between a tank's shell launches
const AI_SHELL_CONE = 0.92; // barrel must be within ~23 deg of the aim point
const K_STEER = 1.5; // hull yaw servo gain (max turn = TURN_RATE, enforced in tank.js)
const TURRET_YAW_RATE = 1.5; // rad/s AI turret slew
const TURRET_PITCH_RATE = 2; // rad/s AI turret elevation slew

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
    this.burstLeft = 0; // rounds left in the current MG burst
    this.burstPause = 0; // s until the next MG burst may start
    this.focus = 0; // s the aim has held the target in the fire cone (M2)
    this.lock = 0; // focus / focusTime, clamped to [0, 1] (M2)
    // Ballistic launch direction for the next shell (read by main.js when
    // control.shellFiring is set). Arcs the unguided shell onto the aim point.
    this.shellDir = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._toTgt = new THREE.Vector3();
    this._barrel = new THREE.Vector3();
    this._aimWorld = new THREE.Vector3();
    this._aimHull = new THREE.Vector3();
    this._hullQInv = new THREE.Quaternion();
  }

  /** Clear engagement state (used on respawn / restart). */
  reset() {
    this.target = null;
    this.retargetTimer = 0;
    this.fireCooldown = 0;
    this.shellCooldown = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.focus = 0;
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
    const backingOff = engaging && tank.position.distanceTo(t.position) < BACKOFF_RANGE;
    c.throttle = backingOff ? -0.7 : engaging ? 1.0 : 0.7;

    // 2. Target selection (nearest alive enemy tank in range).
    const prevTarget = this.target;
    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0 || !this.target || !this.target.alive) {
      this.retargetTimer = RETARGET_INTERVAL;
      this._pickTarget(tank, ctx);
    }
    if (this.target !== prevTarget) this.focus = 0; // re-target: fresh tracking

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
        tank.position.distanceTo(this._aim) < AI.tankShellRange &&
        rocketLaunchDir(tank.position, this._aim, this.shellDir)
      ) {
        shellArc = true;
      }
    }
    // The turret is rigidly attached to the (possibly tilted) hull, so the
    // local yaw/pitch that point the barrel at the aim are the aim direction
    // expressed in hull space. On flat ground this reduces to the world
    // yaw/pitch.
    if (shellArc) this._aimWorld.copy(this.shellDir);
    else this._aimWorld.copy(this._aim).sub(tank.position);
    this._aimWorld.normalize();
    this._hullQInv.copy(tank.group.quaternion).invert();
    this._aimHull.copy(this._aimWorld).applyQuaternion(this._hullQInv);
    const desiredTurretYaw = Math.atan2(-this._aimHull.x, -this._aimHull.z);
    const desiredTurretPitch = Math.asin(clamp(this._aimHull.y, -1, 1));
    const yawStep = clamp(
      wrapAngle(desiredTurretYaw - tank.turretYaw),
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

    // 6. Fire the MG in bursts (real-world discipline: shoot a burst, observe
    // the tracers, re-aim, repeat). A burst is MG_BURST_ROUNDS rounds at the
    // inter-round interval, then a MG_BURST_PAUSE pause before the next burst.
    let inCone = false; // aim held on the target (the same condition that gates fire)
    if (t && t.alive) {
      this._toTgt.copy(this._aim).sub(tank.position);
      if (this._toTgt.length() < AI.tankMgRange) {
        tank.barrelDir(this._barrel);
        if (this._barrel.dot(this._toTgt.normalize()) > MG_FIRE_CONE) {
          inCone = true;
          // In a burst: fire the next round once the inter-round cooldown is up.
          if (this.burstLeft > 0 && this.fireCooldown <= 0) {
            c.firing = true;
            this.burstLeft--;
            this.fireCooldown = MG_FIRE_INTERVAL_AI;
            if (this.burstLeft === 0) this.burstPause = MG_BURST_PAUSE; // burst done
          }
          // Burst done (or not started): begin a new one once the pause is up.
          else if (this.burstLeft <= 0 && this.burstPause <= 0) {
            c.firing = true;
            this.burstLeft = MG_BURST_ROUNDS - 1; // fire the first round now
            this.fireCooldown = MG_FIRE_INTERVAL_AI;
          }
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
    this.burstPause -= dt;

    // 7b. Focus / lock (M2): accumulate while the aim is held on the target;
    // re-target, target death, backing off, or leaving the cone reset it.
    if (inCone && !backingOff) this.focus += dt;
    else this.focus = 0;
    this.lock = clamp(this.focus / AI.focusTime, 0, 1);
    return this.control;
  }

  _pickTarget(tank, ctx) {
    let best = null;
    let bestD = AI.tankEngage;
    const consider = (p) => {
      if (!p || !p.alive) return;
      const d = tank.position.distanceTo(p.position);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    // Tanks (player + CPU fleet), riflemen, and planes. AA guns are never
    // actively targeted by tank AI (they can still be hit by stray fire or a
    // shell splash — the weapon pools are target-agnostic).
    for (const p of ctx.tanks) if (p !== tank) consider(p);
    for (const p of ctx.riflemen) consider(p);
    for (const p of ctx.planes) consider(p);
    this.target = best;
  }
}

// --- RiflemanAI tuning -------------------------------------------------------
const RIFLEMAN_RETARGET = 0.5; // s between target re-picks
// Engage / fire ranges come from the active difficulty set (AI.rifleEngage,
// AI.rifleFireRange) so they can be swapped mid-session.
const RIFLEMAN_HOLD_RANGE = 110; // m; closer than this -> back off (reverse)
const RIFLEMAN_BURST_TIME = 0.9; // s of firing per burst
const RIFLEMAN_PAUSE_MIN = 1.0; // s between bursts (random up to MAX)
const RIFLEMAN_PAUSE_MAX = 2.4;
const RIFLEMAN_FIRE_INTERVAL = 0.12; // s between rifle shots in a burst
const RIFLEMAN_FIRE_CONE = 0.94; // body must be within ~20 deg of the aim point

class RiflemanAI {
  constructor() {
    this.control = { throttle: 0, steer: 0, firing: false };
    this.target = null; // tank currently being engaged
    this.retargetTimer = 0;
    this.fireCooldown = 0;
    this.burstLeft = 0; // s of the current burst still firing
    this.pauseLeft = 0; // s until the next burst may start
    this.backingOff = false; // turning and walking away (no fire while doing it)
    this.focus = 0; // s the aim has held the target in the fire cone (M2)
    this.lock = 0; // focus / focusTime, clamped to [0, 1] (M2)
    // Exact world direction of the next tracer (lead built in); main.js
    // fires along this, so the body only needs to be roughly aligned.
    this.aimDir = new THREE.Vector3(0, 0, -1);
    this._aim = new THREE.Vector3();
    this._toTgt = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /** Clear engagement state (used on respawn / restart). */
  reset() {
    this.target = null;
    this.retargetTimer = 0;
    this.fireCooldown = 0;
    this.burstLeft = 0;
    this.pauseLeft = 0;
    this.backingOff = false;
    this.focus = 0;
    this.control.firing = false;
  }

  update(dt, r, ctx) {
    const c = this.control;
    c.throttle = 0;
    c.steer = 0;
    c.firing = false;

    // 1. Target selection (nearest alive tank in range, any team).
    const prevTarget = this.target;
    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0 || !this.target || !this.target.alive) {
      this.retargetTimer = RIFLEMAN_RETARGET;
      this._pickTarget(r, ctx);
    }
    if (this.target !== prevTarget) this.focus = 0; // re-target: fresh tracking
    const t = this.target;
    const engaging = t && t.alive;

    // 2. Aim point + throttle: lead the target (tracers inherit the
    // shooter's velocity, so the closing speed along the line of sight
    // drives the lead time). Advance to firing range, hold at it, and —
    // when pressed up close — turn and walk away (a soldier won't walk
    // into the tracks, and can't reverse).
    let dist = 0;
    if (engaging) {
      dist = r.position.distanceTo(t.position);
      this._toTgt.copy(t.position).sub(r.position).normalize();
      if (dist < RIFLEMAN_HOLD_RANGE) {
        this.backingOff = true;
        this._aim.copy(r.position).addScaledVector(this._toTgt, -60);
        c.throttle = 1;
      } else {
        this.backingOff = false;
        const closing =
          MG_BULLET_SPEED +
          (r.velocity.x - t.velocity.x) * this._toTgt.x +
          (r.velocity.z - t.velocity.z) * this._toTgt.z;
        const leadTime = dist / Math.max(closing, 40) + AI.rifleLead;
        this._aim.copy(t.position).addScaledVector(t.velocity, leadTime);
        c.throttle = dist > AI.rifleFireRange ? 1 : 0;
      }
    } else {
      this.backingOff = false;
      this._aim.copy(ctx.player.position);
      c.throttle = 1; // no target: walk toward the player
    }

    // 3. Steer the body toward the aim point (yaw servo; in-place pivot).
    const dx = this._aim.x - r.position.x;
    const dz = this._aim.z - r.position.z;
    const desiredYaw = Math.atan2(-dx, -dz); // body front is (-sin, 0, -cos)
    c.steer = clamp(wrapAngle(desiredYaw - r.yaw) * 2.0, -1, 1);

    // 3b. Terrain avoidance: ground steeper than the slope limit directly
    // ahead overrides the aim — steer toward the clearer side.
    {
      const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw);
      const rx = -fz, rz = fx; // right vector
      const px = r.position.x, pz = r.position.z;
      const h0 = ctx.terrain.heightAt(px, pz);
      const hAhead = ctx.terrain.heightAt(px + fx * LOOKAHEAD, pz + fz * LOOKAHEAD);
      if ((hAhead - h0) / LOOKAHEAD > SLOPE_TAN) {
        const hLeft = ctx.terrain.heightAt(px - rx * LOOKAHEAD, pz - rz * LOOKAHEAD);
        const hRight = ctx.terrain.heightAt(px + rx * LOOKAHEAD, pz + rz * LOOKAHEAD);
        c.steer = hLeft - h0 < hRight - h0 ? 1 : -1;
      }
    }

    // 4. Burst fire: in range and the body roughly on the aim point. The
    // tracer flies along aimDir (exact lead, which may track UP at a plane),
    // not the body heading. Alignment is judged on the horizontal bearing, so
    // a rifleman can lay down fire on a plane overhead.
    this.fireCooldown -= dt;
    let canFire = false; // aim held on the target (the same condition that gates fire)
    if (engaging && !this.backingOff && dist <= AI.rifleFireRange) {
      this._toTgt.copy(this._aim).sub(r.position);
      const toLen = this._toTgt.length();
      let aligned = false;
      if (toLen > 1e-3) {
        const hLen = Math.hypot(this._toTgt.x, this._toTgt.z);
        if (hLen < 1e-3) {
          aligned = true; // target directly overhead: any bearing works
        } else {
          r.barrelDir(this._fwd); // horizontal body front
          aligned = (this._fwd.x * this._toTgt.x + this._fwd.z * this._toTgt.z) / hLen > RIFLEMAN_FIRE_CONE;
        }
      }
      if (aligned) {
        canFire = true;
        this.aimDir.copy(this._toTgt);
        if (this.burstLeft > 0) {
          this.burstLeft -= dt;
          if (this.fireCooldown <= 0) {
            c.firing = true;
            this.fireCooldown = RIFLEMAN_FIRE_INTERVAL;
          }
        } else if (this.pauseLeft <= 0) {
          this.burstLeft = RIFLEMAN_BURST_TIME;
          this.pauseLeft = RIFLEMAN_PAUSE_MIN + Math.random() * (RIFLEMAN_PAUSE_MAX - RIFLEMAN_PAUSE_MIN);
        }
      } else {
        this.burstLeft = 0;
      }
    } else {
      this.burstLeft = 0;
    }
    if (this.burstLeft <= 0) this.pauseLeft -= dt; // pause runs after the burst

    // Focus / lock (M2): accumulate while the aim is held on the target;
    // re-target, target death, backing off, or leaving the cone reset it.
    if (canFire) this.focus += dt;
    else this.focus = 0;
    this.lock = clamp(this.focus / AI.focusTime, 0, 1);
    return this.control;
  }

  _pickTarget(r, ctx) {
    let best = null;
    let bestD = AI.rifleEngage;
    const consider = (p) => {
      if (!p || !p.alive) return;
      const d = r.position.distanceTo(p.position);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    // Tanks (player + CPU fleet) and planes. AA guns are never targeted by
    // rifleman AI.
    for (const p of ctx.tanks) consider(p);
    for (const p of ctx.planes) consider(p);
    this.target = best;
  }
}

// --- PlaneAI tuning ------------------------------------------------------------
// (Copied from the Arcade Plane game's HostileAI; constants are renamed with a
// PLANE_ prefix so they don't collide with the tank/rifleman tuning above.)
const PLANE_RETARGET_INTERVAL = 0.3; // s between target re-picks
// Engage / fire ranges come from the active difficulty set (AI.planeEngage,
// AI.planeFireRange, AI.planeRocketRange) so they can be swapped mid-session.
const PLANE_FIRE_INTERVAL = 0.05; // s between shots (~20 rounds/s)
const PLANE_FIRE_CONE = 0.985; // nose must be within ~10 deg of the aim point
// Rockets: a powerful splash weapon the AI uses rarely. No ammo limit — a
// long cooldown between launches keeps them occasional instead of spammy.
const PLANE_ROCKET_COOLDOWN = 25; // s between a plane's rocket launches
const PLANE_ROCKET_CONE = 0.92; // nose must be within ~23 deg of the target
const PLANE_LOOKAHEAD = 60; // m ahead of the nose to sample the terrain
const PLANE_MIN_CLEARANCE = 25; // m; below this the AI pulls up
const PLANE_MAX_AI_ALT = 250; // m AGL; above this the AI pushes over
const PLANE_K_PITCH = 1.5; // pitch servo gain
const PLANE_K_ROLL = 1.5; // roll servo gain
const PLANE_MAX_AI_PITCH = THREE.MathUtils.degToRad(60); // never point far past this
const PLANE_MAX_AI_ROLL = THREE.MathUtils.degToRad(75); // max bank (no loops/inversions)
const PLANE_AVOID_RANGE = 80; // m; steer around other planes closer than this
const PLANE_AVOID_AHEAD = 0.45; // plane must be this directly ahead (dot) to trigger
const PLANE_MAX_BEHIND_AA = 200; // m; the AI never flies farther than this beyond the AA ring

class PlaneAI {
  constructor() {
    this.control = { pitch: 0, roll: 0, rudder: 0, throttle: 0, firing: false, rocketFiring: false };
    this.target = null; // unit currently being engaged
    this.retargetTimer = 0;
    this.fireCooldown = 0;
    this.rocketCooldown = 0;
    this.focus = 0; // s the nose has held the target in the fire cone (M5)
    this.lock = 0; // focus / focusTime, clamped to [0, 1] (M5)
    // Ballistic launch direction for the next rocket (read by main.js when
    // control.rocketFiring is set). Arcs the unguided rocket onto the aim point.
    this.rocketDir = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._toTgt = new THREE.Vector3();
    this._local = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    this._ahead = new THREE.Vector3();
    this._toPlane = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  /** Clear engagement state (used on respawn / restart). */
  reset() {
    this.target = null;
    this.retargetTimer = 0;
    this.fireCooldown = 0;
    this.rocketCooldown = 0;
    this.focus = 0;
    this.control.firing = false;
    this.control.rocketFiring = false;
  }

  update(dt, plane, ctx) {
    const c = this.control;
    c.pitch = 0;
    c.roll = 0;
    c.rudder = 0;
    c.firing = false;
    c.rocketFiring = false;

    // 1. Throttle: full while engaging, cruise when loitering.
    const engaging = this.target && this.target.alive;
    const targetThrottle = engaging ? 1.0 : 0.7;
    c.throttle =
      targetThrottle > plane.throttle + 0.02
        ? 1
        : targetThrottle < plane.throttle - 0.02
          ? -1
          : 0;

    // 2. Target selection (nearest alive enemy in range).
    const prevTarget = this.target;
    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0 || !this.target || !this.target.alive) {
      this.retargetTimer = PLANE_RETARGET_INTERVAL;
      this._pickTarget(plane, ctx);
    }
    if (this.target !== prevTarget) this.focus = 0; // re-target: fresh tracking

    // 3. Lead the target so bullets meet it (loiter: the player's position).
    const t = this.target;
    if (t) {
      const dist = plane.position.distanceTo(t.position);
      // Bullets inherit the shooter's velocity (aircombat.js), so a tracer
      // closes on the target faster (or slower) than BULLET_SPEED alone. Use
      // the component of the shooter-vs-target relative velocity along the
      // line of sight as the effective closing speed for the lead time.
      this._toTgt.copy(t.position).sub(plane.position).normalize();
      const closing =
        BULLET_SPEED +
        (plane.velocity.x - t.velocity.x) * this._toTgt.x +
        (plane.velocity.y - t.velocity.y) * this._toTgt.y +
        (plane.velocity.z - t.velocity.z) * this._toTgt.z;
      const leadTime = dist / Math.max(closing, 40);
      this._aim.copy(t.position).addScaledVector(t.velocity, leadTime);
    } else {
      this._aim.copy(ctx.player.position);
    }

    // 3b. Collision avoidance: steer around any plane we'd otherwise ram.
    // Offsets the aim point to the far side of nearby planes so the nose
    // steering (step 4) flies around them instead of through them.
    const fwd = plane.forward;
    const up = plane.up;
    this._right.crossVectors(fwd, up);
    for (const q of ctx.planes) {
      if (q === plane || !q.alive) continue;
      this._toPlane.copy(q.position).sub(plane.position);
      const d = this._toPlane.length();
      if (d >= PLANE_AVOID_RANGE || d < 1e-3) continue;
      if (fwd.dot(this._toPlane.multiplyScalar(1 / d)) < PLANE_AVOID_AHEAD) continue;
      // Which side is the plane on? Push the aim to the opposite side.
      const side = this._toPlane.dot(this._right) < 0 ? -1 : 1;
      const push = (1 - d / PLANE_AVOID_RANGE) * PLANE_AVOID_RANGE;
      this._aim.addScaledVector(this._right, -side * push);
      this._aim.addScaledVector(fwd, push * 0.5);
    }

    // 3c. Battle area: the AI must not fly more than PLANE_MAX_BEHIND_AA beyond
    // the AA ring. If it strays past the boundary, pull the aim point back onto
    // it (same altitude) so the nose steering flies it home.
    const horiz = Math.hypot(plane.position.x, plane.position.z);
    const boundary = AA_RADIUS + PLANE_MAX_BEHIND_AA;
    if (horiz > boundary) {
      const s = boundary / horiz;
      this._aim.x = plane.position.x * s;
      this._aim.z = plane.position.z * s;
      this._aim.y = plane.position.y;
    }

    // 4. Steer the nose toward the aim point.
    // Local frame: x = right, y = up, z = back (nose is -z).
    // Servo the actual angles toward the desired ones: the flight model has
    // no self-centering, so the AI must actively level the wings.
    this._toTgt.copy(this._aim).sub(plane.position);
    this._qInv.copy(plane.quaternion).invert();
    this._local.copy(this._toTgt).applyQuaternion(this._qInv);
    // Positive pitch raises the nose; positive roll banks left (yaw += sin(roll)).
    const desiredPitch = clamp(
      Math.atan2(this._local.y, -this._local.z),
      -PLANE_MAX_AI_PITCH,
      PLANE_MAX_AI_PITCH
    );
    const desiredRoll = -Math.atan2(this._local.x, -this._local.z);
    c.pitch = clamp((desiredPitch - plane.pitch) * PLANE_K_PITCH, -1, 1);
    c.roll = clamp((desiredRoll - plane.roll) * PLANE_K_ROLL, -1, 1);

    // 5. Terrain avoidance: a strong pull-up overrides aiming.
    this._ahead
      .copy(plane.position)
      .addScaledVector(plane.forward, PLANE_LOOKAHEAD);
    const clearance =
      this._ahead.y - ctx.terrain.heightAt(this._ahead.x, this._ahead.z);
    if (clearance < PLANE_MIN_CLEARANCE) c.pitch = 1;

    // 5b. Altitude ceiling: a strong push-over overrides aiming.
    const alt = plane.position.y - ctx.terrain.heightAt(plane.position.x, plane.position.z);
    if (alt > PLANE_MAX_AI_ALT) c.pitch = -1;

    // 6. Firing decision.
    let inCone = false; // nose held on the target (the same condition that gates fire)
    if (
      t &&
      this._toTgt.length() < AI.planeFireRange &&
      plane.forward.dot(this._local.copy(this._toTgt).normalize()) > PLANE_FIRE_CONE
    ) {
      inCone = true;
      if (this.fireCooldown <= 0) {
        c.firing = true;
        this.fireCooldown = PLANE_FIRE_INTERVAL;
      }
    }

    // 6b. Rocket decision: rare (long cooldown) and powerful. Needs a target
    //     in range and the nose roughly on it; the rocket is then launched on
    //     the ballistic arc that brings it down onto the aim point.
    if (
      t &&
      this.rocketCooldown <= 0 &&
      this._toTgt.length() < AI.planeRocketRange &&
      plane.forward.dot(this._local.copy(this._toTgt).normalize()) > PLANE_ROCKET_CONE &&
      rocketArcDir(plane.position, this._aim, this.rocketDir)
    ) {
      c.rocketFiring = true;
      this.rocketCooldown = PLANE_ROCKET_COOLDOWN;
    }

    // 7. Timers.
    this.fireCooldown -= dt;
    this.rocketCooldown -= dt;

    // 7b. Focus / lock (M5): accumulate while the nose is held on the target;
    // re-target or leaving the cone resets it.
    if (inCone) this.focus += dt;
    else this.focus = 0;
    this.lock = clamp(this.focus / AI.focusTime, 0, 1);
    return this.control;
  }

  _pickTarget(plane, ctx) {
    let best = null;
    let bestD = AI.planeEngage;
    const consider = (p) => {
      if (!p || !p.alive) return;
      const d = plane.position.distanceTo(p.position);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    // Other planes, tanks (player + CPU fleet), and riflemen. AA guns are
    // never targeted by plane AI.
    for (const p of ctx.planes) if (p !== plane) consider(p);
    for (const p of ctx.tanks) consider(p);
    for (const p of ctx.riflemen) consider(p);
    this.target = best;
  }
}
