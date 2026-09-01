"use strict";

// ---------------------------------------------------------------------------
// Rain: a pooled cloud of falling streaks that follows the camera.
//
// A single THREE.Points (no per-drop allocation) holds a fixed set of drops in
// a box around the camera. Each frame the box is re-centered on the camera and
// the drops fall; one that exits the bottom respawns at the top at a random
// x/z, so a steady stream always surrounds the player (the same wrap-around
// idea as Clouds in scenery.js). Intensity (0 = calm .. 1 = storm) scales the
// opacity, the fall speed, and visibility (0 = hidden).
// ---------------------------------------------------------------------------

function makeRainTexture() {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 32;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(2, 0, 4, 32); // a thin vertical streak in the center
  return new THREE.CanvasTexture(c);
}

class Rain {
  constructor(scene, camera) {
    this.camera = camera;
    const COUNT = 700;
    const W = 70; // box width (x)
    const H = 50; // box height (y)
    const D = 70; // box depth (z)
    this._w = W;
    this._d = D;
    this._halfH = H / 2;

    const pos = new Float32Array(COUNT * 3);
    this._speed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * W;
      pos[i * 3 + 1] = (Math.random() - 0.5) * H;
      pos[i * 3 + 2] = (Math.random() - 0.5) * D;
      this._speed[i] = 30 + Math.random() * 10; // m/s
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.4,
      map: makeRainTexture(),
      color: 0xbcd0e2,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.visible = false;
    this.points.frustumCulled = false; // the cloud always surrounds the camera
    scene.add(this.points);

    this.intensity = 0;
  }

  /** Set the rain intensity (0 = calm .. 1 = storm). */
  setIntensity(v) {
    this.intensity = v;
  }

  /** Advance the drops and keep the cloud centered on the camera. */
  update(dt, camPos) {
    this.points.position.copy(camPos);
    if (this.intensity <= 0.001) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    this.points.material.opacity = 0.5 * this.intensity;
    const speedScale = 1 + this.intensity * 0.6; // heavier, faster in a storm
    const arr = this.points.geometry.attributes.position.array;
    for (let i = 0; i < this._speed.length; i++) {
      let y = arr[i * 3 + 1] - this._speed[i] * dt * speedScale;
      if (y < -this._halfH) {
        // Exit the bottom: respawn at the top at a random x/z.
        arr[i * 3] = (Math.random() - 0.5) * this._w;
        y = this._halfH;
        arr[i * 3 + 2] = (Math.random() - 0.5) * this._d;
      }
      arr[i * 3 + 1] = y;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
