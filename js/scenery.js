"use strict";

// ---------------------------------------------------------------------------
// Scenery registry.
//
// World objects that are NOT terrain live here. Each item is a plain object:
//
//   {
//     mesh:      optional THREE object added to the scene,
//     kind:      "tree" | "rock"   optional, for messages (M5),
//     update:    (dt, planePos) => {}   optional per-frame hook,
//     collidesWith: (pos, radius) => bool   optional; true => overlap.
//   }
//
// Future trees/rocks/buildings plug in here:
//
//   scenery.add({
//     mesh: treeMesh,                       // positioned on terrain.heightAt(x, z)
//     collidesWith: (pos, r) => pos.distanceTo(treePos) < r + treeRadius,
//   });
//
// Clouds are the first (decorative, non-colliding) items.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Radial edge fade for scenery (trees / rocks).
//
// The terrain mesh fades to the horizon color near its edge (see terrain.js).
// Trees and rocks are separate, static meshes, so they get the same fade via a
// world-space radial mask: a shared uniform holds the plane's position (updated
// once per frame in Scenery.update) and every faded material's shader blends to
// the horizon color as its distance from the plane grows. This keeps distant
// vegetation from standing out as hard objects against the faded ground.
// The start/end/color match terrain.js so ground and scenery fade together.
// ---------------------------------------------------------------------------

const EDGE_FADE = {
  start: 800, // m from the plane where the fade begins
  end: 1150, // m from the plane where it is fully fogged
  center: { value: new THREE.Vector3() }, // updated per frame to the plane pos
  color: new THREE.Color(0xc9dff5), // == fog color == sky horizon color
};

/** Apply the radial edge fade to a Lambert material (world-space mask). */
function applyEdgeFade(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeCenter = EDGE_FADE.center; // shared reference
    shader.uniforms.uFadeStart = { value: EDGE_FADE.start };
    shader.uniforms.uFadeEnd = { value: EDGE_FADE.end };
    shader.uniforms.uFadeColor = { value: EDGE_FADE.color };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\n varying float vFadeDist;\n uniform vec3 uFadeCenter;"
      )
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n" +
          " vec3 _fadeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n" +
          " #ifdef USE_INSTANCING\n" +
          " _fadeWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n" +
          " #endif\n" +
          " vFadeDist = distance(_fadeWorld.xz, uFadeCenter.xz);"
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n varying float vFadeDist;\n uniform float uFadeStart;\n uniform float uFadeEnd;\n uniform vec3 uFadeColor;"
      )
      .replace(
        "#include <fog_fragment>",
        "#include <fog_fragment>\n float edgeFade = smoothstep(uFadeStart, uFadeEnd, vFadeDist);\n gl_FragColor.rgb = mix(gl_FragColor.rgb, uFadeColor, edgeFade);"
      );
  };
}

class Scenery {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
  }

  add(item) {
    if (item.mesh) this.scene.add(item.mesh);
    this.items.push(item);
    if (item.onAdd) item.onAdd();
    return item;
  }

  /** Remove one item (e.g. a felled tree). The mesh is unparented from the
   *  scene; shared geometry/materials are NOT disposed (other items reuse
   *  them). Re-adding the same item restores it. */
  remove(item) {
    const i = this.items.indexOf(item);
    if (i === -1) return;
    this.items.splice(i, 1);
    if (item.onRemove) item.onRemove();
    if (item.mesh) this.scene.remove(item.mesh);
  }

  /** Remove everything (used when a new map is generated). */
  reset() {
    for (const it of this.items) {
      if (it.mesh) this.scene.remove(it.mesh);
    }
    this.items.length = 0;
  }

  update(dt, planePos) {
    // Keep the shared edge-fade center on the plane so distant scenery fades
    // out in step with the terrain (see EDGE_FADE above).
    EDGE_FADE.center.value.copy(planePos);
    for (const it of this.items) {
      if (it.update) it.update(dt, planePos);
    }
  }

  /** True if any item collides with the given position/radius. */
  collidesWith(pos, radius) {
    for (const it of this.items) {
      if (it.collidesWith && it.collidesWith(pos, radius)) return true;
    }
    return false;
  }

  /** All items whose collision circle overlaps the given position/radius
   *  (M5: tank blocking). Returns the shared `out` array, emptied first. */
  overlapping(pos, radius, out) {
    out.length = 0;
    for (const it of this.items) {
      if (it.collidesWith && it.collidesWith(pos, radius)) out.push(it);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Clouds: soft billboard sprites that drift and wrap around the plane, so the
// sky never runs out of them.
// ---------------------------------------------------------------------------

const CLOUD_WRAP = 2800; // wrap when farther than half of this from the plane

function makeCloudTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const blobs = [
    [64, 70, 46],
    [38, 78, 30],
    [92, 78, 32],
    [64, 52, 34],
  ];
  for (const [x, y, r] of blobs) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

class Clouds {
  constructor(scenery, count) {
    this.texture = makeCloudTexture();
    this.materials = [];
    const rand = mulberry32(1234567);

    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.texture,
        transparent: true,
        opacity: 0.5 + rand() * 0.35,
        depthWrite: false,
      });
      this.materials.push(mat);
      const sprite = new THREE.Sprite(mat);
      const s = 30 + rand() * 55;
      sprite.scale.set(s * (1.4 + rand()), s * (0.5 + rand() * 0.3), 1);
      sprite.position.set((rand() - 0.5) * 2400, 90 + rand() * 150, (rand() - 0.5) * 2400);
      const drift = 1 + rand() * 2; // m/s

      scenery.add({
        mesh: sprite,
        update: (dt, planePos) => {
          sprite.position.x += drift * dt;
          // Wrap around the plane so clouds are always somewhere ahead/behind.
          if (sprite.position.x - planePos.x > CLOUD_WRAP / 2) sprite.position.x -= CLOUD_WRAP;
          if (sprite.position.x - planePos.x < -CLOUD_WRAP / 2) sprite.position.x += CLOUD_WRAP;
          if (sprite.position.z - planePos.z > CLOUD_WRAP / 2) sprite.position.z -= CLOUD_WRAP;
          if (sprite.position.z - planePos.z < -CLOUD_WRAP / 2) sprite.position.z += CLOUD_WRAP;
        },
      });
    }
  }

  /** Tint every cloud sprite (day/night switch; white = no tint). */
  tint(color) {
    for (const m of this.materials) m.color.copy(color);
  }
}

// ---------------------------------------------------------------------------
// Trees: static, collidable vegetation. Placed deterministically from the map
// seed (same seed => same tree layout). Pine = cone canopy, broadleaf = sphere
// canopy. Flying low into a trunk crashes; flying over the canopy is safe.
// ---------------------------------------------------------------------------

const TREE_COUNT = 2000;
const TREE_REGION = 2400;
const TREE_SPAWN_CLEAR = 80;
const TREE_MAX_SLOPE = 1.2;

class Trees {
  constructor(scenery, terrain, seed, avoidRect) {
    const rand = mulberry32(seed);

    // Shared geometry and materials (created once, reused by every tree).
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.4, 3.9, 8);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4226 });
    const pineCanopyGeo = new THREE.ConeGeometry(2.2, 5, 8);
    const pineCanopyMat = new THREE.MeshLambertMaterial({ color: 0x2d5a27 });
    const broadCanopyGeo = new THREE.SphereGeometry(2.4, 10, 8);
    const broadCanopyMat = new THREE.MeshLambertMaterial({ color: 0x3a7a2e });
    applyEdgeFade(trunkMat);
    applyEdgeFade(pineCanopyMat);
    applyEdgeFade(broadCanopyMat);

    // Place every tree first (deterministic from the seed), collecting the data
    // needed to build the instanced meshes.
    const trees = [];
    let placed = 0;
    let guard = 0;
    while (placed < TREE_COUNT && guard < TREE_COUNT * 20) {
      guard++;
      const x = (rand() - 0.5) * TREE_REGION;
      const z = (rand() - 0.5) * TREE_REGION;

      // Keep the spawn point clear.
      if (Math.hypot(x, z) < TREE_SPAWN_CLEAR) continue;

      // Keep the runway strip (plus margin) clear.
      if (avoidRect && x > avoidRect.x0 && x < avoidRect.x1 &&
          z > avoidRect.z0 && z < avoidRect.z1) continue;

      // Skip near-vertical slopes (same finite-difference method as Terrain).
      const e = 2;
      const dx = (terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z)) / (2 * e);
      const dz = (terrain.heightAt(x, z + e) - terrain.heightAt(x - e, z)) / (2 * e);
      if (Math.sqrt(dx * dx + dz * dz) > TREE_MAX_SLOPE) continue;

      const groundY = terrain.heightAt(x, z);
      const isPine = rand() < 0.5;
      const s = 0.7 + rand() * 0.7;
      const treeHeight = isPine ? 8.0 : 7.2;
      trees.push({ x, z, groundY, s, isPine, treeHeight });
      placed++;
    }

    // Three instanced meshes, one per shared geometry (trunk / pine canopy /
    // broadleaf canopy). This collapses the ~2 draw calls per tree into three
    // total. Instances span the whole map, so per-object frustum culling does
    // not apply (frustumCulled = false).
    const trunkIM = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const pineIM = new THREE.InstancedMesh(pineCanopyGeo, pineCanopyMat, trees.length);
    const broadIM = new THREE.InstancedMesh(broadCanopyGeo, broadCanopyMat, trees.length);
    for (const im of [trunkIM, pineIM, broadIM]) {
      im.castShadow = true;
      im.frustumCulled = false;
    }

    // A tree instance matrix: scale by s, place at (x, groundY + yOffset*s, z).
    const _m = new THREE.Matrix4();
    const setTree = (im, idx, t, yOffset) => {
      _m.makeScale(t.s, t.s, t.s);
      _m.setPosition(t.x, t.groundY + yOffset * t.s, t.z);
      im.setMatrixAt(idx, _m);
    };
    const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

    // Assign instances: one trunk per tree; canopies packed per type.
    let pineIdx = 0;
    let broadIdx = 0;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      t.trunkIdx = i;
      setTree(trunkIM, i, t, 1.2); // trunk sunk 0.75 m so the base reaches the ground
      if (t.isPine) {
        setTree(pineIM, pineIdx, t, 5.5);
        t.canopyIM = pineIM;
        t.canopyIdx = pineIdx;
        t.canopyY = 5.5;
        pineIdx++;
      } else {
        setTree(broadIM, broadIdx, t, 4.8);
        t.canopyIM = broadIM;
        t.canopyIdx = broadIdx;
        t.canopyY = 4.8;
        broadIdx++;
      }
    }
    trunkIM.count = trees.length;
    pineIM.count = pineIdx;
    broadIM.count = broadIdx;
    trunkIM.instanceMatrix.needsUpdate = true;
    pineIM.instanceMatrix.needsUpdate = true;
    broadIM.instanceMatrix.needsUpdate = true;

    scenery.scene.add(trunkIM, pineIM, broadIM);

    // Register each tree as a scenery item (collidable + fellable). `mesh` is a
    // lightweight position holder so the foliage-burst reference (item.mesh.position)
    // keeps working; felling/restoring hides/shows the tree's instances.
    for (const t of trees) {
      const holder = new THREE.Object3D();
      holder.position.set(t.x, t.groundY, t.z);
      scenery.add({
        mesh: holder,
        kind: "tree",
        collidesWith: (pos, r) =>
          Math.hypot(pos.x - t.x, pos.z - t.z) < r + 0.4 * t.s &&
          pos.y < t.groundY + t.treeHeight * t.s,
        onRemove: () => {
          trunkIM.setMatrixAt(t.trunkIdx, _zero);
          t.canopyIM.setMatrixAt(t.canopyIdx, _zero);
          trunkIM.instanceMatrix.needsUpdate = true;
          t.canopyIM.instanceMatrix.needsUpdate = true;
        },
        onAdd: () => {
          setTree(trunkIM, t.trunkIdx, t, 1.2);
          setTree(t.canopyIM, t.canopyIdx, t, t.canopyY);
          trunkIM.instanceMatrix.needsUpdate = true;
          t.canopyIM.instanceMatrix.needsUpdate = true;
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rocks: static, collidable boulders. Placed deterministically from the map
// seed (same seed => same rock layout). A small set of shared, vertex-jittered
// icosahedron templates is reused with random scale/rotation, mirroring the
// "shared geometry + material" pattern used by Trees. Rocks tolerate steeper
// slopes than trees, so they also sit on cliffs.
// ---------------------------------------------------------------------------

const ROCK_COUNT = 200;
const ROCK_REGION = 2400;
const ROCK_SPAWN_CLEAR = 80;
const ROCK_MAX_SLOPE = 2.0;

/**
 * Build one lumpy rock: an icosahedron whose unique vertices are displaced
 * radially by a deterministic per-vertex amount. The icosahedron is
 * non-indexed (each face owns its 3 corners), so coincident corners are keyed
 * by rounded position to guarantee they move together (no cracks).
 */
function makeRockGeometry(rand) {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const pos = geo.attributes.position;
  const offsets = new Map();
  const v = new THREE.Vector3();
  let topY = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = v.x.toFixed(3) + "," + v.y.toFixed(3) + "," + v.z.toFixed(3);
    let j = offsets.get(key);
    if (j === undefined) {
      j = 0.72 + rand() * 0.55; // radius multiplier 0.72..1.27
      offsets.set(key, j);
    }
    v.normalize().multiplyScalar(j);
    pos.setXYZ(i, v.x, v.y, v.z);
    if (v.y > topY) topY = v.y;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return { geo, topY }; // topY = height of the tallest corner (unit space)
}

class Rocks {
  constructor(scenery, terrain, seed, avoidRect) {
    const rand = mulberry32(seed ^ 0x9e3779b9); // distinct stream from Trees

    // Shared templates + material (created once, reused by every rock).
    // Each template carries its own topY so a rock's collision height matches
    // its visual height (flying over the top is safe, like tree canopies).
    const TEMPLATES = 4;
    const templates = [];
    for (let i = 0; i < TEMPLATES; i++) templates.push(makeRockGeometry(rand));
    const rockMat = new THREE.MeshLambertMaterial({
      color: 0x8a8378,
      flatShading: true,
    });
    applyEdgeFade(rockMat);

    let placed = 0;
    let guard = 0;
    while (placed < ROCK_COUNT && guard < ROCK_COUNT * 20) {
      guard++;
      const x = (rand() - 0.5) * ROCK_REGION;
      const z = (rand() - 0.5) * ROCK_REGION;

      // Keep the spawn point clear.
      if (Math.hypot(x, z) < ROCK_SPAWN_CLEAR) continue;

      // Keep the runway strip (plus margin) clear.
      if (avoidRect && x > avoidRect.x0 && x < avoidRect.x1 &&
          z > avoidRect.z0 && z < avoidRect.z1) continue;

      // Rocks tolerate steep ground (they read well on cliffs).
      const e = 2;
      const dx = (terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z)) / (2 * e);
      const dz = (terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e)) / (2 * e);
      if (Math.sqrt(dx * dx + dz * dz) > ROCK_MAX_SLOPE) continue;

      const groundY = terrain.heightAt(x, z);
      const s = 0.6 + rand() * 1.4; // 0.6..2.0 m nominal radius
      const tpl = templates[(rand() * templates.length) | 0];
      const sy = s * (0.6 + rand() * 0.5); // vertical scale

      const mesh = new THREE.Mesh(tpl.geo, rockMat);
      mesh.position.set(x, groundY + s * 0.2, z);
      mesh.scale.set(s * (0.8 + rand() * 0.6), sy, s * (0.8 + rand() * 0.6));
      mesh.rotation.set(rand() * TAU, rand() * TAU, rand() * TAU);
      mesh.castShadow = true;

      // Top of the rock above ground (center offset + vertical scale * unit top).
      const rockTop = s * 0.2 + sy * tpl.topY;

      scenery.add({
        mesh,
        kind: "rock",
        collidesWith: (pos, r) =>
          Math.hypot(pos.x - x, pos.z - z) < r + s * 1.05 &&
          pos.y < groundY + rockTop,
      });
      placed++;
    }
  }
}
