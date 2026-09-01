"use strict";

// ---------------------------------------------------------------------------
// Anti-aircraft (AA) guns: a fixed ring of ground turrets around the map
// center (copied from the Arcade Plane game). Each gun engages any PLANE
// (CPU) that flies within AI.aaEngage of it and fires pooled tracers
// (soft) and rare rockets (hard) at it. AA guns attack PLANES ONLY — they
// never target tanks or riflemen.
//
// The guns are static scenery (they never die permanently) but are hostile
// and can be knocked out: their weapons carry team "aa", so they damage
// planes (team "planeN") but never each other (no friendly fire). They reuse
// the shared Projectiles (cannon) and Rockets (ordnance) pools.
//
// Armor: an AA gun is well armored against small arms (SOFT armor 10) and
// moderately armored against rockets/main guns (HARD armor 2).
// ---------------------------------------------------------------------------

const AA_COUNT = 16; // turrets around the ring
const AA_RADIUS = 1000; // m from the map center (the spawn/garage point)
// Engage range + tracer/rocket damage come from the active difficulty set
// (AI.aaEngage, AI.aaBulletDamage, AI.aaRocketDamage) so they swap mid-session.
const AA_FIRE_INTERVAL = 0.1; // s between shots
const AA_HP = 100; // HP before a gun is disabled
const AA_DISABLE_TIME = 60; // s a gun stays disabled after being knocked out
const AA_HIT_RADIUS = 6; // m stand-off for a bullet to hit the structure
const AA_TRACK = 6; // turret aim easing rate (per second)
const AA_BEAM_LEN = 1000; // m, searchlight beam length
const AA_BEAM_RADIUS = 26; // m, beam radius at the far end
const AA_BEAM_SWEEP = 0.22; // rad/s, base beam sweep speed
const AA_BEAM_MIN_ELEV = Math.PI / 4; // rad; beams never point below 45° up
// Armor: divisors for takeDamage by kind (see AAGun.takeDamage).
const AA_SOFT_ARMOR = 10; // vs SOFT damage (cannon / small arms)
const AA_HARD_ARMOR = 2; // vs HARD damage (rockets / main gun)
// Rockets: a powerful splash weapon each gun uses rarely. No ammo limit — a
// long cooldown between launches keeps them occasional instead of spammy.
// A gun only launches when its barrel has finished slewing and is tracking
// the target steadily (reads as a deliberate "special shot").
const AA_ROCKET_COOLDOWN = 45; // s between a gun's rocket launches
const AA_ROCKET_ALIGN = 0.98; // barrel must be within ~11 deg of the aim point
const AA_FIRE_CONE = 0.94; // barrel within ~20 deg of the aim = "locked on" (focus ramp)

// Gradient for the beam cone: bright at the apex (v=1, the muzzle), fading
// to transparent at the far end (v=0).
function makeBeamTexture() {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, "rgba(255,246,216,0.5)");
  grad.addColorStop(0.35, "rgba(255,246,216,0.15)");
  grad.addColorStop(1, "rgba(255,246,216,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

// Radial glow for the lamp at the muzzle.
function makeGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,250,230,0.9)");
  grad.addColorStop(0.4, "rgba(255,246,216,0.35)");
  grad.addColorStop(1, "rgba(255,246,216,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// World-space elevation (radians, 0 = horizon) of the beam's pointing
// direction (its local -Z axis).
function beamElevation(beam) {
  beam.getWorldDirection(_beamDir); // local +Z in world space
  _beamDir.negate();
  const horiz = Math.hypot(_beamDir.x, _beamDir.z);
  return Math.atan2(_beamDir.y, horiz);
}
const _beamDir = new THREE.Vector3();

class AAGun {
  constructor(scene, terrain, x, z) {
    this.position = new THREE.Vector3(x, terrain.heightAt(x, z), z);
    this.team = "aa";
    this.velocity = new THREE.Vector3(); // static: bullets don't inherit motion
    this.fireCooldown = 0;
    this.rocketCooldown = 0;
    this.target = null;
    this.fired = false; // set by update() when this gun shot this frame
    this.rocketFired = false; // set by update() when this gun launched a rocket
    this.hp = AA_HP;
    this.disabled = false; // knocked out: no tracking/firing, searchlight off, smoking
    this.disableTimer = 0; // s until the gun re-enables
    this.focus = 0; // s the barrel has held the target in the fire cone (M6)
    this.lock = 0; // focus / focusTime, clamped to [0, 1] (M6)
    // Armor levels (divisors for takeDamage by kind).
    this.softArmor = AA_SOFT_ARMOR;
    this.hardArmor = AA_HARD_ARMOR;

    this.group = new THREE.Group();
    this.group.position.copy(this.position);

    const concrete = new THREE.MeshLambertMaterial({ color: 0x8b8d90 });
    const metal = new THREE.MeshLambertMaterial({ color: 0x4a4f57 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2b2e33 });

    // Concrete pad + pedestal.
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 5.0, 1.0, 16), concrete);
    pad.position.y = 0.5;
    this.group.add(pad);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.0, 1.8, 12), metal);
    pedestal.position.y = 1.9;
    this.group.add(pedestal);

    // Turret (yaws) -> elevation (pitches) -> barrel.
    this.turret = new THREE.Group();
    this.turret.position.y = 3.0;
    this.group.add(this.turret);
    this.elev = new THREE.Group();
    this.elev.position.y = 0.3;
    this.turret.add(this.elev);

    const housing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.4, 3.0), metal);
    housing.position.y = 0.2;
    this.elev.add(housing);
    // Barrel points -Z (matches the plane's nose convention).
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 4.0, 10).rotateX(Math.PI / 2), dark);
    barrel.position.set(0, 0.2, -2.0);
    this.elev.add(barrel);
    const muzzleCap = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.4, 10).rotateX(Math.PI / 2), dark);
    muzzleCap.position.set(0, 0.2, -3.9);
    this.elev.add(muzzleCap);

    // Empty marker at the barrel tip for the muzzle world position.
    this.muzzleObj = new THREE.Object3D();
    this.muzzleObj.position.set(0, 0.2, -4.1);
    this.elev.add(this.muzzleObj);

    this.group.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });

    // Night searchlight: a soft beam along the barrel axis plus a lamp glow
    // at the muzzle. Purely visual; visibility is driven by the day/night
    // mix in updateBeam() and it never affects aiming.
    this.beamMat = new THREE.MeshBasicMaterial({
      map: makeBeamTexture(),
      color: 0xfff3cf,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // ConeGeometry has its apex (narrow, r=0) at +Y and base (wide) at -Y,
    // centered on the origin. rotateX(+PI/2) maps the apex to +Z and the base
    // to -Z (the barrel points -Z, so the beam flares forward). Then
    // translate the apex to the mesh origin so the beam pivots around the
    // muzzle when it sweeps: the apex sits on the muzzle and the wide base
    // projects AA_BEAM_LEN forward along the barrel axis.
    this.beam = new THREE.Mesh(
      new THREE.ConeGeometry(AA_BEAM_RADIUS, AA_BEAM_LEN, 16, 1, true)
        .rotateX(Math.PI / 2)
        .translate(0, 0, -AA_BEAM_LEN / 2),
      this.beamMat
    );
    // Parented to `turret` (which only yaws), NOT `elev` (which pitches with
    // the target). That keeps the beam's local Y axis vertical in world space,
    // so the sweep is a true horizontal sweep and the elevation can be set
    // independently (clamped to >= AA_BEAM_MIN_ELEV) instead of being dragged
    // down by the barrel's pitch.
    this.beam.position.set(0, 0.3, -1.0);
    // 'YXZ' so rotation.x (elevation) is applied first, then rotation.y
    // (sweep) around the vertical: the beam keeps a constant elevation while
    // it sweeps, instead of the elevation collapsing to 0 at 90°/180° sweep.
    this.beam.rotation.order = "YXZ";
    this.turret.add(this.beam);

    this.glowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: 0xfff3cf,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.position.set(0, 0.3, -1.0);
    this.glow.scale.set(8, 8, 1);
    this.turret.add(this.glow);

    this._beamT = Math.random() * 100; // desynchronize the sweep between guns
    this._beamSpeed = AA_BEAM_SWEEP * (0.8 + Math.random() * 0.4);
    scene.add(this.group);

    this._muzzleWorld = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._lastDir = null;
    this._barrelDir = new THREE.Vector3();
    this._toTgt = new THREE.Vector3();
    this._rocketDir = new THREE.Vector3();
  }

  /** Write the barrel tip's world position into `out`. */
  muzzleWorld(out) {
    this.group.updateMatrixWorld(true);
    return this.muzzleObj.getWorldPosition(out);
  }

  /** Apply damage. `kind` selects the armor divisor: "soft" (cannon / small
   *  arms) or "hard" (rockets / main gun); omit it for unarmored physical
   *  damage. No-op while already disabled. Returns true the moment the gun
   *  transitions to disabled (so the caller can play the knock-out effect). */
  takeDamage(amount, kind) {
    if (this.disabled) return false;
    let dealt = amount;
    if (kind === "soft") dealt = amount / this.softArmor;
    else if (kind === "hard") dealt = amount / this.hardArmor;
    dealt = Math.floor(dealt);
    if (dealt <= 0) return false;
    this.hp -= dealt;
    if (this.hp <= 0) {
      this.hp = 0;
      this.disabled = true;
      this.disableTimer = AA_DISABLE_TIME;
      this.target = null;
      return true;
    }
    return false;
  }

  /** Tick the disable timer; re-enable (and restore HP) when it runs out. */
  updateDisable(dt) {
    if (!this.disabled) return;
    this.disableTimer -= dt;
    if (this.disableTimer <= 0) {
      this.disabled = false;
      this.hp = AA_HP;
    }
  }

  /**
   * One step: pick the nearest in-range PLANE, slew the turret toward it (with
   * lead), and fire when the cooldown allows. Returns the control-free result
   * via `this.fired` (true if a shot was launched this frame). AA guns engage
   * planes only — tanks and riflemen are never targeted.
   */
  update(dt, planes) {
    this.fired = false;
    this.rocketFired = false;
    if (this.disabled) return; // knocked out: turret frozen, no tracking, no fire
    this.fireCooldown -= dt;
    this.rocketCooldown -= dt;

    // Nearest alive plane in range.
    const prevTarget = this.target;
    let best = null;
    let bestD = AI.aaEngage;
    for (const p of planes) {
      if (!p.alive) continue;
      const d = this.position.distanceTo(p.position);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    this.target = best;
    if (this.target !== prevTarget) this.focus = 0; // re-target: fresh tracking

    if (!best) {
      this.lock = 0; // no target: no lock
      return;
    }

    // Lead the target so tracers meet it.
    this._aim.copy(best.position).addScaledVector(best.velocity, bestD / BULLET_SPEED);

    // Slew the turret toward the aim point (eased so it tracks, not snaps).
    const dx = this._aim.x - this.position.x;
    const dy = this._aim.y - this.position.y;
    const dz = this._aim.z - this.position.z;
    const horiz = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horiz);
    this.turret.rotation.y = easeToward(this.turret.rotation.y, yaw, AA_TRACK, dt);
    this.elev.rotation.x = easeToward(this.elev.rotation.x, pitch, AA_TRACK, dt);

    // Barrel alignment: how well the (slewing) barrel is on the aim point. This
    // drives the focus/lock ramp — a target that evades (barrel lags) drops it.
    this.group.updateMatrixWorld(true);
    this.elev.getWorldDirection(this._barrelDir); // local +Z in world space
    this._barrelDir.negate(); // the barrel points local -Z
    this._toTgt.copy(this._aim).sub(this.position).normalize();
    const inCone = this._barrelDir.dot(this._toTgt) > AA_FIRE_CONE;

    // Fire along the (now aimed) barrel at the lead point.
    if (this.fireCooldown <= 0) {
      this.fireCooldown = AA_FIRE_INTERVAL;
      this.muzzleWorld(this._muzzleWorld);
      this._dir.copy(this._aim).sub(this._muzzleWorld).normalize();
      this._lastDir = this._dir;
      this.fired = true;
    }

    // Rare rocket: a powerful splash shot. Only launch once the cooldown has
    // elapsed AND the barrel has caught up with the (moving) aim point — i.e.
    // the turret is tracking steadily, not mid-slew. The launch direction is
    // the ballistic arc that brings the unguided rocket down onto the lead
    // point (the gun is stationary, so the solution is exact).
    if (this.rocketCooldown <= 0 && this._lastDir) {
      if (
        this._barrelDir.dot(this._toTgt) > AA_ROCKET_ALIGN &&
        rocketArcDir(this.position, this._aim, this._rocketDir)
      ) {
        this.rocketCooldown = AA_ROCKET_COOLDOWN;
        this.rocketFired = true;
      }
    }

    // Focus / lock (M6): accumulate while the barrel is held on the target;
    // re-target or the target evading (barrel lagging) resets it.
    if (inCone) this.focus += dt;
    else this.focus = 0;
    this.lock = clamp(this.focus / AI.focusTime, 0, 1);
  }

  /**
   * Visual-only step for the searchlight. The beam is parented to the (yaw-only)
   * turret, so its local Y axis is always world-up: rotation.y is a true
   * horizontal sweep and rotation.x is the elevation. Real searchlights never
   * point below ~45° above the horizon, so the elevation is clamped to at
   * least AA_BEAM_MIN_ELEV. Does not touch aiming or firing.
   */
  updateBeam(dt, nightMix) {
    if (this.disabled) {
      // Knocked out: the searchlight is dead until the gun re-enables.
      this.beam.visible = false;
      this.glow.visible = false;
      this.beamMat.opacity = 0;
      this.glowMat.opacity = 0;
      return;
    }
    this._beamT += dt;
    const t = this._beamT;
    this.beam.rotation.y = t * this._beamSpeed;
    // Base elevation 45° with a gentle bob that never dips below the minimum.
    this.beam.rotation.x = AA_BEAM_MIN_ELEV + Math.abs(Math.sin(t * 0.37)) * 0.3;
    const on = nightMix > 0.01;
    this.beam.visible = on;
    this.glow.visible = on;
    if (on) {
      this.beamMat.opacity = nightMix;
      this.glowMat.opacity = nightMix;
    }
  }

  /** Launch one tracer through the shared pool (SOFT damage; called by the
    *  manager). Applies the difficulty aim error (M6) to the shot direction. */
  fire(projectiles) {
    if (!this._lastDir || !this.target) return;
    applySpread(
      this._lastDir,
      this.position.distanceTo(this.target.position),
      THREE.MathUtils.degToRad(AI.aaErrorBase),
      THREE.MathUtils.degToRad(AI.aaErrorRange),
      AI.aaEngage,
      this.lock,
      AI.aimWarmup
    );
    projectiles.fire(this, this._muzzleWorld, this._lastDir, AI.aaBulletDamage, "soft");
  }

  /** Launch one rocket through the shared pool (HARD damage; called by the
    *  manager). Applies the difficulty aim error (M6) + scaled splash damage. */
  fireRocket(rockets) {
    if (!this._rocketDir || !this.target) return;
    applySpread(
      this._rocketDir,
      this.position.distanceTo(this.target.position),
      THREE.MathUtils.degToRad(AI.aaErrorBase),
      THREE.MathUtils.degToRad(AI.aaErrorRange),
      AI.aaEngage,
      this.lock,
      AI.aimWarmup
    );
    rockets.fire(
      this,
      this._muzzleWorld,
      this._rocketDir,
      "hard",
      rockets.baseDamage * (AI.aaRocketDamage / ROCKET_DAMAGE),
      rockets.baseDamageMin * (AI.aaRocketDamage / ROCKET_DAMAGE)
    );
  }
}

/** Manages the whole ring of guns. */
class AAGuns {
  constructor(scene, terrain, projectiles, rockets) {
    this.projectiles = projectiles;
    this.rockets = rockets;
    this.scene = scene;
    this.terrain = terrain;
    this.guns = [];
    this.setCount(AA_COUNT);
  }

  /** Rebuild the ring with `n` turrets (0 = no AA). */
  setCount(n) {
    n = clamp(Math.round(n), 0, AA_COUNT);
    if (n === this.guns.length) return;
    for (const g of this.guns) {
      this.scene.remove(g.group);
      g.group.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        } else if (o.isSprite) {
          // Sprite geometry is shared by all sprites; only free its texture.
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
    }
    this.guns = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU;
      const x = Math.cos(ang) * AA_RADIUS;
      const z = Math.sin(ang) * AA_RADIUS;
      this.guns.push(new AAGun(this.scene, this.terrain, x, z));
    }
  }

  /** Step the (visual-only) searchlight beams; `nightMix` 0..1 scales them. */
  updateBeams(dt, nightMix) {
    for (const g of this.guns) g.updateBeam(dt, nightMix);
  }

  /** Restore every gun to full HP / enabled (used on restart). */
  reset() {
    for (const g of this.guns) {
      g.hp = AA_HP;
      g.disabled = false;
      g.disableTimer = 0;
      g.target = null;
      g.rocketCooldown = 0;
      g.focus = 0;
    }
  }

  /**
   * Step every gun. `planes` = all planes to consider (the CPU fleet). Fires
   * tracers (and rare rockets) and returns the guns that shot this frame:
   * { fired: [gun], rocketFired: [gun] } (for audio + flashes).
   */
  update(dt, planes) {
    const fired = [];
    const rocketFired = [];
    for (const g of this.guns) {
      g.updateDisable(dt);
      g.update(dt, planes);
      if (g.fired) {
        g.fire(this.projectiles);
        fired.push(g);
      }
      if (g.rocketFired) {
        g.fireRocket(this.rockets);
        rocketFired.push(g);
      }
    }
    return { fired, rocketFired };
  }
}
