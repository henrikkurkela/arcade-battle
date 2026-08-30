"use strict";

// ---------------------------------------------------------------------------
// The ballistic computer: a player-only fire-control overlay. It draws the
// arcing ordnance's trajectory (the arc the shell/rocket would follow if fired
// right now) and a ground marker at the impact point, both updated every frame.
// It also reports whether an enemy is "zeroed" — sitting in the blast of the
// impact or on the arc (the proximity fuse) — so the HUD can call it out.
//
// It's weapon-agnostic: configure() sets the ordnance's physics (speed,
// gravity, fuse, blast and proximity radii) for the active weapon — the tank's
// main-gun shell (combat.js) or the plane's rocket (aircombat.js). The
// trajectory reuses that physics and the real terrain, so the line always
// matches the shot exactly. The ordnance inherits the shooter's motion, so the
// arc shifts as the vehicle moves.
// ---------------------------------------------------------------------------

const BALLISTIC_MAX_POINTS = 72; // trajectory buffer (the arc is short)
const BALLISTIC_STEP = 1 / 30; // s, integration step for the arc

class BallisticComputer {
  constructor(scene) {
    this.scene = scene;
    this.enabled = false;
    this.zeroed = false;
    // Ordnance physics (set by configure() for the active weapon).
    this._speed = SHELL_SPEED;
    this._gravity = SHELL_GRAVITY;
    this._life = SHELL_LIFE;
    this._blastRadius = BLAST_RADIUS;
    this._fuseRadius = SHELL_FUSE_RADIUS;

    // Pre-allocated trajectory buffer (no per-frame allocation).
    this._positions = new Float32Array(BALLISTIC_MAX_POINTS * 3);
    this._geo = new THREE.BufferGeometry();
    this._geo.setAttribute("position", new THREE.BufferAttribute(this._positions, 3));
    this._geo.setDrawRange(0, 0);
    this._line = new THREE.Line(
      this._geo,
      new THREE.LineBasicMaterial({ color: 0x5fe0ff, transparent: true, opacity: 0.55 })
    );
    this._line.visible = false;
    this._line.frustumCulled = false; // the arc can be far; never cull it
    scene.add(this._line);

    // Impact marker: a flat ring on the ground at the blast center.
    this._marker = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.3, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x5fe0ff,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
      })
    );
    this._marker.visible = false;
    this._marker.frustumCulled = false;
    scene.add(this._marker);

    // Scratch (no per-frame allocation).
    this._dir = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._pos = new THREE.Vector3();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.clear();
  }

  clear() {
    this._line.visible = false;
    this._marker.visible = false;
    this.zeroed = false;
  }

  /** Set the ordnance physics for the active weapon (the tank's shell or the
   *  plane's rocket). Call it when the loadout/vehicle changes. */
  configure(speed, gravity, life, blastRadius, fuseRadius) {
    this._speed = speed;
    this._gravity = gravity;
    this._life = life;
    this._blastRadius = blastRadius;
    this._fuseRadius = fuseRadius;
  }

  /** Simulate the ordnance's path from the shooter's muzzle and update the
   *  line + marker. Returns true if an enemy is "zeroed" (in the blast of the
   *  impact or on the arc within the proximity-fuse stand-off). `shooter` is
   *  the player unit (tank or plane); it is skipped in the zeroed check. */
  update(shooter, terrain, units) {
    if (!this.enabled) {
      this.clear();
      return false;
    }
    // Muzzle position + aim direction; the ordnance inherits the shooter's
    // motion. The tank aims with its barrel (barrelDir); the plane with its nose.
    const p0 = shooter.muzzleWorld(this._pos);
    const dir = shooter.barrelDir
      ? shooter.barrelDir(this._dir)
      : this._dir.copy(shooter.forward);
    this._vel.copy(shooter.velocity).addScaledVector(dir, this._speed);
    this._pos.copy(p0);

    // Integrate under gravity until ground impact or the fuse runs out.
    let count = 0;
    const setPt = (i) => {
      this._positions[i * 3] = this._pos.x;
      this._positions[i * 3 + 1] = this._pos.y;
      this._positions[i * 3 + 2] = this._pos.z;
    };
    setPt(count++);
    for (let t = 0; t < this._life; t += BALLISTIC_STEP) {
      this._vel.y -= this._gravity * BALLISTIC_STEP;
      this._pos.addScaledVector(this._vel, BALLISTIC_STEP);
      if (count < BALLISTIC_MAX_POINTS) setPt(count++);
      if (this._pos.y < terrain.heightAt(this._pos.x, this._pos.z)) break;
    }

    this._geo.setDrawRange(0, count);
    this._geo.attributes.position.needsUpdate = true;
    this._geo.computeBoundingSphere();
    this._line.visible = true;
    // Impact marker at the last point, sunk slightly into the ground.
    this._marker.position.set(this._pos.x, this._pos.y + 0.15, this._pos.z);
    this._marker.visible = true;

    // Zeroed: an enemy in the blast of the impact, or on the arc (proximity
    // fuse). The shooter itself is skipped.
    let zeroed = false;
    const fuseSq = this._fuseRadius * this._fuseRadius;
    const blastSq = this._blastRadius * this._blastRadius;
    for (const u of units) {
      if (u === shooter || !u.alive) continue;
      const dx = u.position.x - this._pos.x;
      const dy = u.position.y - this._pos.y;
      const dz = u.position.z - this._pos.z;
      if (dx * dx + dy * dy + dz * dz < blastSq) {
        zeroed = true;
        break;
      }
      for (let i = 0; i < count; i++) {
        const ax = u.position.x - this._positions[i * 3];
        const ay = u.position.y - this._positions[i * 3 + 1];
        const az = u.position.z - this._positions[i * 3 + 2];
        if (ax * ax + ay * ay + az * az < fuseSq) {
          zeroed = true;
          break;
        }
      }
      if (zeroed) break;
    }
    this.zeroed = zeroed;
    return zeroed;
  }
}
