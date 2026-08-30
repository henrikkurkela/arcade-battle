"use strict";

// ---------------------------------------------------------------------------
// Special tank-destruction effects (the "cool" 20% of CPU tank kills).
//
// Each effect is a self-contained function in the SPECIALS registry; the 80%
// "normal" kill path (debris + smoke + crash) is unchanged and lives in
// main.js. Effects compose from shared FX primitives (fireball, fire burst,
// smoke burst, dust ring, light flash, heavy shake, deep boom) so future
// effects can be added and picked-and-mixed.
//
// The current effect, turretBlowoff, launches a coherent turret+gun assembly
// (built once, pooled) off the wreck: it arcs up and toward the hull's rear,
// flips end-over-end, settles on the terrain, then fades away (like debris).
// The hull itself reads as the normal debris chunks.
// ---------------------------------------------------------------------------

// --- Tuning -----------------------------------------------------------------
const TURRET_FLY_POOL = 4; // pooled flying turret assemblies (rare, ~1 at a time)
const TURRET_UP = 15; // m/s launch, straight up
const TURRET_BACK = 8; // m/s launch, toward the hull's rear
const TURRET_INHERIT = 0.5; // fraction of the tank's velocity inherited
const TURRET_FLIP = 7; // rad/s end-over-end flip (around the hull's right axis)
const TURRET_FLIP_JITTER = 2.5; // rad/s of random tumble added on top

const WING_FLY_POOL = 4; // pooled flying wing assemblies
const WING_OUT = 8; // m/s launch, out along the wing span
const WING_UP = 12; // m/s launch, straight up
const WING_INHERIT = 0.5; // fraction of the plane's velocity inherited
const WING_TUMBLE = 6; // rad/s of random tumble (all axes)

const BODY_FLY_POOL = 4; // pooled flying body assemblies
const BODY_OUT = 7; // m/s launch, away from the killer
const BODY_UP = 6; // m/s launch, straight up
const BODY_INHERIT = 0.4; // fraction of the unit's velocity inherited
const BODY_FLIP = 6; // rad/s backward flip (over the heels)
const BODY_FLIP_JITTER = 2.5; // rad/s of random tumble added on top
const BODY_LIE_LIFT = 0.14; // m; half the body's depth, so it lies flat (not sunk)

// Shared physics for the coherent flying assemblies (turret + wing).
const FLY_GRAVITY = 9.8;
const FLY_AIR_DRAG = 0.5; // per second
const FLY_REST_TIME = 5; // s the assembly sits before it starts to fade
const FLY_FADE_TIME = 1.5; // s to shrink away

const FIREBALL_POOL = 4;
const FIREBALL_LIFE = 0.5; // s
const FIREBALL_SIZE_MIN = 3; // m
const FIREBALL_SIZE_MAX = 15; // m

const DUST_RING_POINTS = 48;
const DUST_RING_LIFE = 0.8; // s
const DUST_RING_RADIUS = 1.6; // m starting ring radius
const DUST_RING_SPEED = 15; // m/s outward
const DUST_RING_RISE = 2.5; // m/s upward

const LIGHT_POOL = 3;
const LIGHT_LIFE = 0.35; // s
const LIGHT_INTENSITY = 4.5;
const LIGHT_DISTANCE = 40;

/** Radial fireball glow: hot white core fading to orange to transparent. */
function makeFireballTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,240,1)");
  grad.addColorStop(0.2, "rgba(255,235,170,0.95)");
  grad.addColorStop(0.45, "rgba(255,160,60,0.6)");
  grad.addColorStop(0.75, "rgba(230,90,30,0.22)");
  grad.addColorStop(1, "rgba(180,50,20,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

class Destruction {
  constructor(ctx) {
    this.scene = ctx.scene;
    this.terrain = ctx.terrain;
    this.camera = ctx.camera; // a camera with a .shake property (chaseCam)
    this.audio = ctx.audio;
    this.spawnSmoke = ctx.spawnSmoke;
    this.debris = ctx.debris;

    // --- Fireball pool (expanding additive sprites) -------------------------
    this.fireballs = [];
    this._nextFireball = 0;
    const fbTex = makeFireballTexture();
    for (let i = 0; i < FIREBALL_POOL; i++) {
      const mat = new THREE.SpriteMaterial({
        map: fbTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.fireballs.push({ sprite, mat, life: 0, maxLife: 1, size0: 1, size1: 1 });
    }

    // --- Dust rings (one-shot THREE.Points: a ring of kicked-up dust) -------
    this.rings = [];

    // --- Light flashes (pooled point lights) --------------------------------
    this.lights = [];
    this._nextLight = 0;
    for (let i = 0; i < LIGHT_POOL; i++) {
      const light = new THREE.PointLight(0xffb060, 0, LIGHT_DISTANCE, 2);
      light.visible = false;
      this.scene.add(light);
      this.lights.push({ light, life: 0, maxLife: 1 });
    }

    // --- Flying turret assemblies (built once, pooled) ----------------------
    this.turrets = [];
    this._nextTurret = 0;
    for (let i = 0; i < TURRET_FLY_POOL; i++) {
      const group = this._buildTurretAssembly(0x8a8f94);
      group.visible = false;
      this.scene.add(group);
      this.turrets.push({
        group,
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

    // --- Flying wing assemblies (built once, pooled) -------------------------
    this.wings = [];
    this._nextWing = 0;
    for (let i = 0; i < WING_FLY_POOL; i++) {
      const group = this._buildWingAssembly(0x8a8f94, 0xb3372f);
      group.visible = false;
      this.scene.add(group);
      this.wings.push({
        group,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: 1,
        resting: false,
        restTimer: 0,
        impactFired: false,
      });
    }

    // --- Flying body assemblies (built once, pooled) -------------------------
    this.bodies = [];
    this._nextBody = 0;
    for (let i = 0; i < BODY_FLY_POOL; i++) {
      const group = this._buildBodyAssembly(RIFLEMAN_UNIFORMS[i % RIFLEMAN_UNIFORMS.length]);
      group.visible = false;
      this.scene.add(group);
      this.bodies.push({
        group,
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        restQuat: new THREE.Quaternion(), // the lying-down pose (set on launch)
        scale: 1,
        resting: false,
        restTimer: 0,
      });
    }

    this._axis = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._right = new THREE.Vector3();
    this._back = new THREE.Vector3();
    this._wingOut = new THREE.Vector3();
    this._wingUp = new THREE.Vector3();
    this._bodyDir = new THREE.Vector3();
    this._bodyFlip = new THREE.Vector3();
    this._bloodPt = new THREE.Vector3();
    // +90 deg around the local X axis: tips a standing body onto its back
    // (face up), so it lies flat instead of standing.
    this._lieQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), Math.PI / 2
    );

    // --- Effect registries: each is its own self-contained function ----------
    this.SPECIALS = [this.turretBlowoff]; // CPU tanks
    this.SPECIALS_PLANE = [this.wingBlowoff]; // CPU planes
    this.SPECIALS_RIFLEMAN = [this.ragdollFling]; // riflemen
  }

  /** Build a coherent turret+gun assembly (the same shapes as the live tank's
   *  turret) for the blow-off, centered at the turret pivot (origin). */
  _buildTurretAssembly(livery) {
    const g = new THREE.Group();
    const turretMat = new THREE.MeshLambertMaterial({ color: livery });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x3a3d40 });

    const turretBox = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 2.0), turretMat);
    g.add(turretBox);
    const bustle = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 0.7), turretMat);
    bustle.position.set(0, -0.05, 1.15);
    g.add(bustle);
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.5), darkMat);
    hatch.position.set(0.45, 0.42, 0.35);
    g.add(hatch);
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.13, 4.5, 10).rotateX(Math.PI / 2), darkMat
    );
    barrel.position.set(0, 0, -1.95);
    g.add(barrel);
    const brake = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.17, 0.5, 10).rotateX(Math.PI / 2), darkMat
    );
    brake.position.set(0, 0, -3.95);
    g.add(brake);
    const mgBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.06, 1.8, 8).rotateX(Math.PI / 2), darkMat
    );
    mgBarrel.position.set(0.28, -0.12, -1.1);
    g.add(mgBarrel);
    const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.85), darkMat);
    mantlet.position.set(0.1, -0.02, -0.875);
    g.add(mantlet);

    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    return g;
  }

  /** Build a coherent wing assembly (the same shapes as the live plane's wing)
   *  for the blow-off, centered at the wing's midline (origin). */
  _buildWingAssembly(livery, red) {
    const g = new THREE.Group();
    const cream = new THREE.MeshLambertMaterial({ color: livery });
    const redMat = new THREE.MeshLambertMaterial({ color: red });

    const wing = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.12, 0.7), cream);
    g.add(wing);
    for (const side of [1, -1]) {
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 1.05), redMat);
      tip.position.set(side * 3.55, 0, 0.15);
      g.add(tip);
    }

    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    return g;
  }

  /** Build a coherent rifleman body (the same shapes as the live unit), origin
   *  at the feet, for the ragdoll fling. */
  _buildBodyAssembly(uniform) {
    const g = new THREE.Group();
    const coatMat = new THREE.MeshLambertMaterial({ color: uniform.coat });
    const pantsMat = new THREE.MeshLambertMaterial({ color: uniform.pants });
    const skinMat = new THREE.MeshLambertMaterial({ color: uniform.skin });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x2b2e30 });

    // Legs (pivots at the hips, hanging down) with boots.
    const legGeo = new THREE.BoxGeometry(0.16, 0.72, 0.2).translate(0, -0.36, 0);
    const bootGeo = new THREE.BoxGeometry(0.18, 0.12, 0.3);
    for (const side of [-0.13, 0.13]) {
      const leg = new THREE.Mesh(legGeo, pantsMat);
      leg.position.set(side, 0.74, 0);
      const boot = new THREE.Mesh(bootGeo, darkMat);
      boot.position.set(0, -0.68, -0.05);
      leg.add(boot);
      g.add(leg);
    }
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
    // Arms (static, angled forward to hold the rifle).
    const armGeo = new THREE.BoxGeometry(0.12, 0.46, 0.14).translate(0, -0.18, 0);
    for (const side of [-0.31, 0.31]) {
      const arm = new THREE.Mesh(armGeo, coatMat);
      arm.position.set(side, 1.26, 0);
      arm.rotation.x = 1.05;
      g.add(arm);
    }
    // Assault rifle (receiver + barrel + stock), held by the right hand.
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
    g.add(rifle);

    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    return g;
  }

  // --- Shared FX primitives (reusable across effects) -----------------------

  /** A big expanding fireball flash at `pos`. */
  fireball(pos) {
    const e = this._acquire(this.fireballs, "_nextFireball", (x) => x.life > 0);
    if (!e) return;
    e.maxLife = FIREBALL_LIFE * (0.8 + Math.random() * 0.4);
    e.life = e.maxLife;
    e.size0 = FIREBALL_SIZE_MIN;
    e.size1 = FIREBALL_SIZE_MAX * (0.85 + Math.random() * 0.3);
    e.sprite.position.copy(pos);
    e.sprite.position.y += 0.5; // lift the flash a touch above the ground
    e.sprite.scale.set(e.size0, e.size0, 1);
    e.sprite.visible = true;
    e.mat.opacity = 1;
  }

  /** A burst of bright fire particles (orange/white) at `pos`. */
  fireBurst(pos) {
    this.spawnSmoke(pos, {
      count: 60, size: 1.4, color: 0xffb347, opacity: 0.95, life: 0.7,
      sx: 1.6, sy: 1.0, sz: 1.6, vh: 11, vyLo: 3, vyHi: 10, drift: 1.5, grav: 4,
    });
    this.spawnSmoke(pos, {
      count: 30, size: 1.0, color: 0xffe0a0, opacity: 0.9, life: 0.45,
      sx: 1.0, sy: 0.8, sz: 1.0, vh: 8, vyLo: 2, vyHi: 7, drift: 1.5, grav: 4,
    });
  }

  /** A dark rising smoke burst at `pos` (the fire's smoke). */
  smokeBurst(pos) {
    this.spawnSmoke(pos, {
      count: 90, size: 3.0, color: 0x3a3a3a, opacity: 0.9, life: 3.5,
      sx: 2.5, sy: 1.5, sz: 2.5, vh: 6, vyLo: 1.5, vyHi: 7,
    });
  }

  /** A radial dust/shockwave ring kicked out at ground level around `pos`. */
  dustRing(pos) {
    const N = DUST_RING_POINTS;
    const positions = new Float32Array(N * 3);
    const vels = [];
    const groundY = this.terrain.heightAt(pos.x, pos.z) + 0.15;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const r = DUST_RING_RADIUS * (0.7 + Math.random() * 0.6);
      positions[i * 3] = pos.x + Math.cos(a) * r;
      positions[i * 3 + 1] = groundY + Math.random() * 0.3;
      positions[i * 3 + 2] = pos.z + Math.sin(a) * r;
      const sp = DUST_RING_SPEED * (0.7 + Math.random() * 0.6);
      vels.push(
        new THREE.Vector3(
          Math.cos(a) * sp,
          DUST_RING_RISE * (0.5 + Math.random()),
          Math.sin(a) * sp
        )
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x8a7a5a, size: 1.6, transparent: true, opacity: 0.85, depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.rings.push({ points, vels, life: DUST_RING_LIFE, maxLife: DUST_RING_LIFE });
  }

  /** A brief point-light flare at `pos` (lights up the blast). */
  lightFlash(pos) {
    const e = this._acquire(this.lights, "_nextLight", (x) => x.life > 0);
    if (!e) return;
    e.maxLife = LIGHT_LIFE;
    e.life = e.maxLife;
    e.light.position.copy(pos);
    e.light.position.y += 0.5;
    e.light.intensity = LIGHT_INTENSITY;
    e.light.visible = true;
  }

  /** Distance-scaled camera shake (heavier than a normal kill). */
  heavyShake(dist) {
    const v = clamp(3.5 / (1 + dist / 120), 0.8, 3.5);
    if (this.camera) this.camera.shake = Math.max(this.camera.shake, v);
  }

  /** The deep, long boom. */
  deepBoom(dist) {
    if (this.audio) this.audio.deepBoom(dist);
  }

  /** Launch the coherent turret+gun assembly off the wreck at `tank`, seeded
   *  from the live turret's world transform. */
  launchTurret(tank) {
    const e = this._acquire(this.turrets, "_nextTurret", (x) => x.active);
    if (!e) return;
    // Capture the live turret's world position + orientation (valid even while
    // the group is hidden — visibility does not zero the matrix).
    tank.group.updateMatrixWorld(true);
    e.pos.copy(tank.turret.getWorldPosition(new THREE.Vector3()));

    // Launch up and toward the hull's rear (the hull nose points down -Z).
    this._back.set(Math.sin(tank.yaw), 0, Math.cos(tank.yaw));
    this._right.set(Math.cos(tank.yaw), 0, -Math.sin(tank.yaw));
    e.vel
      .set(0, 0, 0)
      .addScaledVector(this._back, TURRET_BACK)
      .addScaledVector(tank.velocity, TURRET_INHERIT);
    e.vel.y += TURRET_UP;

    // End-over-end flip around the hull's right axis, plus a little tumble.
    e.angVel
      .copy(this._right)
      .multiplyScalar(TURRET_FLIP * (Math.random() < 0.5 ? -1 : 1));
    e.angVel.x += (Math.random() - 0.5) * TURRET_FLIP_JITTER;
    e.angVel.y += (Math.random() - 0.5) * TURRET_FLIP_JITTER;
    e.angVel.z += (Math.random() - 0.5) * TURRET_FLIP_JITTER;

    e.quat.copy(tank.turret.getWorldQuaternion(new THREE.Quaternion()));
    e.active = true;
    e.resting = false;
    e.restTimer = 0;
    e.scale = 1;
    e.group.visible = true;
    e.group.position.copy(e.pos);
    e.group.quaternion.copy(e.quat);
    e.group.scale.setScalar(1);
  }

  /** Launch the coherent wing assembly off the airframe at `plane`, seeded from
   *  the live wing's world transform (the wing sits at local (0, -0.42, 0)). */
  launchWing(plane) {
    const e = this._acquire(this.wings, "_nextWing", (x) => x.active);
    if (!e) return;
    // The wing's world center = the plane's position + its up-axis offset.
    e.pos.set(0, -0.42, 0).applyQuaternion(plane.quaternion).add(plane.position);
    e.quat.copy(plane.quaternion); // the wing is axis-aligned with the airframe

    // Launch out along the wing span (a random side) + up, inheriting velocity.
    this._wingOut.set(1, 0, 0).multiplyScalar(Math.random() < 0.5 ? 1 : -1).applyQuaternion(plane.quaternion);
    this._wingUp.set(0, 1, 0).applyQuaternion(plane.quaternion);
    e.vel
      .set(0, 0, 0)
      .addScaledVector(this._wingOut, WING_OUT)
      .addScaledVector(this._wingUp, WING_UP)
      .addScaledVector(plane.velocity, WING_INHERIT);

    // A chaotic tumble across all axes (a tumbling wing).
    e.angVel.set(
      (Math.random() - 0.5) * 2 * WING_TUMBLE,
      (Math.random() - 0.5) * 2 * WING_TUMBLE,
      (Math.random() - 0.5) * 2 * WING_TUMBLE
    );

    e.active = true;
    e.resting = false;
    e.restTimer = 0;
    e.impactFired = false;
    e.scale = 1;
    e.group.visible = true;
    e.group.position.copy(e.pos);
    e.group.quaternion.copy(e.quat);
    e.group.scale.setScalar(1);
  }

  /** Launch the coherent body assembly off the unit at `unit`, flung away from
   *  the `killer` (or backward if there is none), with a backward flip. */
  launchBody(unit, killer) {
    const e = this._acquire(this.bodies, "_nextBody", (x) => x.active);
    if (!e) return;
    // The body's origin is the feet; the unit's position is the feet.
    e.pos.copy(unit.position);
    e.quat.copy(unit.group.quaternion); // the body is axis-aligned with the unit

    // Fling away from the killer (horizontal); fall back to the unit's back.
    if (killer) {
      this._bodyDir.copy(unit.position).sub(killer.position);
      this._bodyDir.y = 0;
      if (this._bodyDir.lengthSq() < 1e-4) this._bodyDir.set(Math.sin(unit.yaw), 0, Math.cos(unit.yaw));
      else this._bodyDir.normalize();
    } else {
      this._bodyDir.set(Math.sin(unit.yaw), 0, Math.cos(unit.yaw));
    }
    e.vel
      .set(0, 0, 0)
      .addScaledVector(this._bodyDir, BODY_OUT)
      .addScaledVector(unit.velocity, BODY_INHERIT);
    e.vel.y += BODY_UP;

    // Backward flip: rotate around the horizontal axis perpendicular to the
    // fling direction (the body tips over its heels), plus a little tumble.
    this._bodyFlip.set(-this._bodyDir.z, 0, this._bodyDir.x).normalize();
    e.angVel
      .copy(this._bodyFlip)
      .multiplyScalar(BODY_FLIP * (Math.random() < 0.5 ? -1 : 1));
    e.angVel.x += (Math.random() - 0.5) * BODY_FLIP_JITTER;
    e.angVel.y += (Math.random() - 0.5) * BODY_FLIP_JITTER;
    e.angVel.z += (Math.random() - 0.5) * BODY_FLIP_JITTER;

    // The lying-down pose: the unit's orientation tipped onto its back (face
    // up), so the body rests flat on the ground instead of standing.
    e.restQuat.copy(unit.group.quaternion).multiply(this._lieQuat);

    e.active = true;
    e.resting = false;
    e.restTimer = 0;
    e.scale = 1;
    e.group.visible = true;
    e.group.position.copy(e.pos);
    e.group.quaternion.copy(e.quat);
    e.group.scale.setScalar(1);
  }

  // --- The effects (each is its own self-contained function) -----------------

  /** Turret blow-off: the hull reads as the normal debris; the turret+gun
   *  assembly launches off the wreck and tumbles; a fireball, fire + smoke
   *  burst, dust ring, light flash, heavy shake and deep boom sell the hit. */
  turretBlowoff(tank, dist) {
    this.debris.spawn(tank.position, tank.velocity);
    this.launchTurret(tank);
    this.fireball(tank.position);
    this.fireBurst(tank.position);
    this.smokeBurst(tank.position);
    this.dustRing(tank.position);
    this.lightFlash(tank.position);
    this.heavyShake(dist);
    this.deepBoom(dist);
  }

  /** Wing blow-off: the airframe reads as the plane debris; the wing launches
   *  off and tumbles. Phase 1 (in the air) sells the hit with a fireball, fire
   *  + smoke burst, light flash, heavy shake and deep boom; phase 2 fires a
   *  dust ring at the ground impact (when the tumbling wing lands, in update). */
  wingBlowoff(plane, dist) {
    this.debris.spawnPlane(plane.position, plane.velocity);
    this.launchWing(plane);
    this.fireball(plane.position);
    this.fireBurst(plane.position);
    this.smokeBurst(plane.position);
    this.lightFlash(plane.position);
    this.heavyShake(dist);
    this.deepBoom(dist);
  }

  /** Ragdoll fling: the coherent body is knocked away from the killer and
   *  tumbles over its heels; the blood splash + scattered body pieces and the
   *  scream sell the hit. */
  ragdollFling(unit, dist, killer) {
    this.debris.spawnBody(unit.position, unit.velocity);
    this.launchBody(unit, killer);
    // Blood splash at torso height (the "hit" feedback).
    this._bloodPt.copy(unit.position);
    this._bloodPt.y += 1;
    this.spawnSmoke(this._bloodPt, {
      count: 30, size: 0.6, color: 0x7a1010, opacity: 0.9, life: 0.9,
      sx: 0.6, sy: 0.8, sz: 0.6, vh: 3, vyLo: -0.5, vyHi: 2.5,
      drift: 0, grav: 9.8,
    });
    this.audio.scream(dist);
  }

  // --- Dispatch (the special path) --------------------------------------------

  /** Run one tank special effect (picked from SPECIALS). `dist` = meters from
   *  the player, for the distance-scaled feedback. */
  special(tank, dist) {
    const fx = this.SPECIALS[(Math.random() * this.SPECIALS.length) | 0];
    fx.call(this, tank, dist);
  }

  /** Run one plane special effect (picked from SPECIALS_PLANE). */
  specialPlane(plane, dist) {
    const fx = this.SPECIALS_PLANE[(Math.random() * this.SPECIALS_PLANE.length) | 0];
    fx.call(this, plane, dist);
  }

  /** Run one rifleman special effect (picked from SPECIALS_RIFLEMAN). */
  specialRifleman(unit, dist, killer) {
    const fx = this.SPECIALS_RIFLEMAN[(Math.random() * this.SPECIALS_RIFLEMAN.length) | 0];
    fx.call(this, unit, dist, killer);
  }

  // --- Integration -----------------------------------------------------------

  /** Step the flying turret, the fireballs, the dust rings and the lights. */
  update(dt) {
    // Flying turret: gravity + drag in flight, rest + shrink on the ground.
    for (const e of this.turrets) {
      if (!e.active) continue;
      if (e.resting) {
        e.restTimer += dt;
        if (e.restTimer > FLY_REST_TIME) {
          e.scale = Math.max(0, e.scale - dt / FLY_FADE_TIME);
          if (e.scale <= 0) {
            e.active = false;
            e.group.visible = false;
            continue;
          }
        }
      } else {
        e.vel.y -= FLY_GRAVITY * dt;
        e.vel.multiplyScalar(Math.max(0, 1 - FLY_AIR_DRAG * dt));
        e.pos.addScaledVector(e.vel, dt);
        if (e.pos.y <= this.terrain.heightAt(e.pos.x, e.pos.z)) {
          e.pos.y = this.terrain.heightAt(e.pos.x, e.pos.z);
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
      e.group.position.copy(e.pos);
      e.group.quaternion.copy(e.quat);
      e.group.scale.setScalar(e.scale);
    }

    // Flying wing: same flight/settle as the turret, plus a phase-2 dust ring
    // at the ground impact (the "crash" mark).
    for (const e of this.wings) {
      if (!e.active) continue;
      if (e.resting) {
        e.restTimer += dt;
        if (e.restTimer > FLY_REST_TIME) {
          e.scale = Math.max(0, e.scale - dt / FLY_FADE_TIME);
          if (e.scale <= 0) {
            e.active = false;
            e.group.visible = false;
            continue;
          }
        }
      } else {
        e.vel.y -= FLY_GRAVITY * dt;
        e.vel.multiplyScalar(Math.max(0, 1 - FLY_AIR_DRAG * dt));
        e.pos.addScaledVector(e.vel, dt);
        if (e.pos.y <= this.terrain.heightAt(e.pos.x, e.pos.z)) {
          e.pos.y = this.terrain.heightAt(e.pos.x, e.pos.z);
          e.resting = true;
          e.vel.set(0, 0, 0);
          e.angVel.set(0, 0, 0);
          if (!e.impactFired) {
            e.impactFired = true;
            this.dustRing(e.pos); // phase 2: crash dust at the impact point
          }
        }
      }
      // Tumble.
      const w = e.angVel.length();
      if (w > 1e-4) {
        this._axis.copy(e.angVel).divideScalar(w);
        this._q.setFromAxisAngle(this._axis, w * dt);
        e.quat.premultiply(this._q);
      }
      e.group.position.copy(e.pos);
      e.group.quaternion.copy(e.quat);
      e.group.scale.setScalar(e.scale);
    }

    // Flying body: same flight/settle as the turret (a ground-level event).
    for (const e of this.bodies) {
      if (!e.active) continue;
      if (e.resting) {
        e.restTimer += dt;
        if (e.restTimer > FLY_REST_TIME) {
          e.scale = Math.max(0, e.scale - dt / FLY_FADE_TIME);
          if (e.scale <= 0) {
            e.active = false;
            e.group.visible = false;
            continue;
          }
        }
      } else {
        e.vel.y -= FLY_GRAVITY * dt;
        e.vel.multiplyScalar(Math.max(0, 1 - FLY_AIR_DRAG * dt));
        e.pos.addScaledVector(e.vel, dt);
        if (e.pos.y <= this.terrain.heightAt(e.pos.x, e.pos.z)) {
          // Settle lying flat on the ground (on its back), lifted so it doesn't
          // sink: snap to the lying-down pose and rest the body's depth up.
          e.pos.y = this.terrain.heightAt(e.pos.x, e.pos.z) + BODY_LIE_LIFT;
          e.quat.copy(e.restQuat);
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
      e.group.position.copy(e.pos);
      e.group.quaternion.copy(e.quat);
      e.group.scale.setScalar(e.scale);
    }

    // Fireballs: expand and fade over their short life.
    for (const e of this.fireballs) {
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) {
        e.sprite.visible = false;
        e.mat.opacity = 0;
        continue;
      }
      const t = 1 - e.life / e.maxLife; // 0 -> 1
      e.mat.opacity = 1 - t;
      const s = e.size0 + (e.size1 - e.size0) * (1 - (1 - t) * (1 - t));
      e.sprite.scale.set(s, s, 1);
    }

    // Dust rings: kick outward, rise, fade.
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.life -= dt;
      const attr = ring.points.geometry.attributes.position;
      for (let j = 0; j < ring.vels.length; j++) {
        const v = ring.vels[j];
        v.multiplyScalar(Math.max(0, 1 - 1.5 * dt));
        v.y -= 4 * dt; // dust settles
        attr.setXYZ(
          j,
          attr.getX(j) + v.x * dt,
          attr.getY(j) + v.y * dt,
          attr.getZ(j) + v.z * dt
        );
      }
      attr.needsUpdate = true;
      ring.points.material.opacity = clamp(ring.life / ring.maxLife, 0, 1) * 0.85;
      if (ring.life <= 0) {
        this.scene.remove(ring.points);
        ring.points.geometry.dispose();
        ring.points.material.dispose();
        this.rings.splice(i, 1);
      }
    }

    // Light flashes: flare then decay to zero.
    for (const e of this.lights) {
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) {
        e.light.intensity = 0;
        e.light.visible = false;
        continue;
      }
      e.light.intensity = LIGHT_INTENSITY * (e.life / e.maxLife);
    }
  }

  /** Deactivate everything (used on restart). */
  clear() {
    for (const e of this.turrets) {
      e.active = false;
      e.group.visible = false;
    }
    for (const e of this.wings) {
      e.active = false;
      e.group.visible = false;
    }
    for (const e of this.bodies) {
      e.active = false;
      e.group.visible = false;
    }
    for (const e of this.fireballs) {
      e.life = 0;
      e.sprite.visible = false;
      e.mat.opacity = 0;
    }
    for (const e of this.lights) {
      e.life = 0;
      e.light.intensity = 0;
      e.light.visible = false;
    }
    for (const ring of this.rings) {
      this.scene.remove(ring.points);
      ring.points.geometry.dispose();
      ring.points.material.dispose();
    }
    this.rings.length = 0;
  }

  // --- Pool helper -----------------------------------------------------------

  /** Find a free entry in `list` (index stored under `idx`), where `isBusy(e)`
   *  marks it in use. Returns the entry, or null if the pool is exhausted. */
  _acquire(list, idx, isBusy) {
    for (let i = 0; i < list.length; i++) {
      const e = list[(this[idx] + i) % list.length];
      if (isBusy(e)) continue;
      this[idx] = (this[idx] + i + 1) % list.length;
      return e;
    }
    return null;
  }
}
