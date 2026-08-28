"use strict";

// ---------------------------------------------------------------------------
// Infinite procedural terrain.
//
// The ground is a deterministic height function heightAt(x, z) built from a
// few seeded sine octaves. Because it is a function (not a stored grid), the
// world extends infinitely in every direction.
//
// Extensibility:
//  - RUNWAY: push { x0, x1, z0, z1, y } onto `this.flatZones`. The height
//    (and therefore the mesh and the collision check) flattens smoothly to
//    `y` inside that rectangle. Example:
//
//      const y = terrain.heightAt(1200, 0);
//      terrain.flatZones.push({ x0: 1050, x1: 1450, z0: -40, z1: 40, y });
//
//  - TREES / OBSTACLES: these do NOT belong here. Add them as Scenery items
//    (see scenery.js); use terrain.heightAt(x, z) to place them on the ground
//    and let their `collidesWith` hook feed the crash detection.
// ---------------------------------------------------------------------------

const TERRAIN_SIZE = 2400; // world units covered by the mesh
const TERRAIN_SEGS = 128; // mesh subdivisions per side
const TERRAIN_CELL = TERRAIN_SIZE / TERRAIN_SEGS; // vertex spacing

class Terrain {
  constructor(seed, scene) {
    this.seed = seed;
    const rand = mulberry32(seed);

    // Sine octaves: amplitude (m), x/z frequency, phase.
    // Gentler hills than the plane (33/15/6/2.2 vs 60/28/11/4) so most ground
    // stays under the tank's 35 deg climb limit; a few steep spots remain as
    // natural bottlenecks. Frequencies/phases are still seeded as in the plane.
    this.waves = [];
    const specs = [
      [33, 0.004, 0.005],
      [15, 0.011, 0.009],
      [6, 0.027, 0.031],
      [2.2, 0.06, 0.052],
    ];
    for (const [a, fx, fz] of specs) {
      this.waves.push({
        a: a * (0.8 + rand() * 0.4),
        fx: fx * (0.85 + rand() * 0.3),
        fz: fz * (0.85 + rand() * 0.3),
        p: rand() * TAU,
      });
    }

    // Flat sections (future runways). Empty for now.
    this.flatZones = [];

    // --- mesh ------------------------------------------------------------
    this.geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS);
    this.geo.rotateX(-Math.PI / 2); // lie it in XZ, +Y up
    this.positions = this.geo.attributes.position;
    this.colors = new Float32Array(this.positions.count * 3);
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));

    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Radial edge fade: blend the outer ring of the ground to the fog/horizon
    // color so the square mesh boundary dissolves into the sky instead of
    // showing as a hard edge (and popping when the mesh re-centers). The fade
    // is anchored to the mesh in object space, so it stays put on re-center.
    // The fog color (0xc9dff5) equals the sky dome's horizon color, so the
    // faded edge meets the sky seamlessly.
    const EDGE_FADE_START = 800; // m from mesh center where the fade begins
    const EDGE_FADE_END = 1150; // m from mesh center where it is fully fogged
    // Shared reference so the day/night switch can re-tint the fade (it must
    // track the fog/horizon color, see main.js applyEnvironment).
    this.fadeColor = new THREE.Color(0xc9dff5);
    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFadeStart = { value: EDGE_FADE_START };
      shader.uniforms.uFadeEnd = { value: EDGE_FADE_END };
      shader.uniforms.uFadeColor = { value: this.fadeColor };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\n varying float vRadial;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n vRadial = length(position.xz);"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\n varying float vRadial;\n uniform float uFadeStart;\n uniform float uFadeEnd;\n uniform vec3 uFadeColor;"
        )
        .replace(
          "#include <fog_fragment>",
          "#include <fog_fragment>\n float edgeFade = smoothstep(uFadeStart, uFadeEnd, vRadial);\n gl_FragColor.rgb = mix(gl_FragColor.rgb, uFadeColor, edgeFade);"
        );
    };
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.position.set(0, 0, 0);
    scene.add(this.mesh);

    // Precomputed color stops (avoid per-vertex allocations).
    this._cValley = new THREE.Color(0x3f7d33);
    this._cGrass = new THREE.Color(0x5a8f3e);
    this._cBrown = new THREE.Color(0x8a6b45);
    this._cPeak = new THREE.Color(0x9a8f7a);
    this._cRock = new THREE.Color(0x84796a);
    this._cTmp = new THREE.Color();

    this._rebuild(0, 0);
  }

  /**
   * Ground height (meters, y-up) at world position (x, z).
   * Used by BOTH the mesh and the collision check, so they always agree.
   */
  heightAt(x, z) {
    let h = 0;
    for (const w of this.waves) {
      h += w.a * Math.sin(w.fx * x + w.fz * z + w.p);
    }

    // Blend into flat zones (runway support).
    const BLEND = 160;
    for (const zone of this.flatZones) {
      if (x < zone.x0 - BLEND || x > zone.x1 + BLEND ||
          z < zone.z0 - BLEND || z > zone.z1 + BLEND) continue;
      const tx = smoothstep((x - (zone.x0 - BLEND)) / BLEND) *
                 (1 - smoothstep((x - zone.x1) / BLEND));
      const tz = smoothstep((z - (zone.z0 - BLEND)) / BLEND) *
                 (1 - smoothstep((z - zone.z1) / BLEND));
      const t = Math.min(tx, tz);
      if (t > 0) h = lerp(h, zone.y, t);
    }
    return h;
  }

  /** Rebuild the mesh in place (e.g. after a flat zone is added post-construction). */
  rebuild() {
    this._rebuild(this.mesh.position.x, this.mesh.position.z);
  }

  /** Re-center the mesh when the plane drifts away, then rebuild it. */
  update(planePos) {
    const margin = TERRAIN_CELL * 3;
    const targetX = Math.round(
      clamp(planePos.x, this.mesh.position.x - margin, this.mesh.position.x + margin) / TERRAIN_CELL
    ) * TERRAIN_CELL;
    const targetZ = Math.round(
      clamp(planePos.z, this.mesh.position.z - margin, this.mesh.position.z + margin) / TERRAIN_CELL
    ) * TERRAIN_CELL;
    if (Math.abs(targetX - this.mesh.position.x) > 1e-6 ||
        Math.abs(targetZ - this.mesh.position.z) > 1e-6) {
      this.mesh.position.set(targetX, 0, targetZ);
      this._rebuild(targetX, targetZ);
    }
  }

  /** Recompute vertex heights and colors for the mesh at offset (mx, mz). */
  _rebuild(mx, mz) {
    const pos = this.positions;
    const col = this.colors;
    const e = 2; // finite-difference step for slope
    const { _cValley, _cGrass, _cBrown, _cPeak, _cRock, _cTmp } = this;

    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + mx;
      const wz = pos.getZ(i) + mz;
      const h = this.heightAt(wx, wz);
      pos.setY(i, h);

      // Slope-based rock + height-based tint + hash mottling.
      const dx = (this.heightAt(wx + e, wz) - this.heightAt(wx - e, wz)) / (2 * e);
      const dz = (this.heightAt(wx, wz + e) - this.heightAt(wx, wz - e)) / (2 * e);
      const slope = Math.sqrt(dx * dx + dz * dz);

      const n = clamp((h + 60) / 240, 0, 1); // 0 = valley, 1 = peak
      if (n < 0.45) _cTmp.copy(_cValley).lerp(_cGrass, n / 0.45);
      else if (n < 0.75) _cTmp.copy(_cGrass).lerp(_cBrown, (n - 0.45) / 0.3);
      else _cTmp.copy(_cBrown).lerp(_cPeak, (n - 0.75) / 0.25);

      _cTmp.lerp(_cRock, clamp((slope - 0.5) / 0.45, 0, 1));
      const j = 0.93 + hash2(Math.round(wx * 0.7), Math.round(wz * 0.7)) * 0.14;
      _cTmp.multiplyScalar(j);

      col[i * 3] = _cTmp.r;
      col[i * 3 + 1] = _cTmp.g;
      col[i * 3 + 2] = _cTmp.b;
    }

    pos.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}
