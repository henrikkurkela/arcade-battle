"use strict";

// ---------------------------------------------------------------------------
// Pooled muzzle flashes: a bright additive sprite blinks at the muzzle for a
// few frames each time a gun fires. Fixed-size pool of sprites: no per-shot
// allocation, no GC churn (same pattern as Projectiles and Debris).
// ---------------------------------------------------------------------------

const FLASH_LIFE = 0.05; // s a flash stays up (base; randomized per shot)
const FLASH_POOL_SIZE = 64; // pooled sprites (~12 simultaneous bursts in flight)
const FLASH_SIZE_MIN = 2.2; // m
const FLASH_SIZE_MAX = 4.2; // m

/** Radial glow: hot white-yellow core fading to transparent. */
function makeFlashTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,235,1)");
  grad.addColorStop(0.25, "rgba(255,224,140,0.8)");
  grad.addColorStop(0.6, "rgba(255,170,60,0.25)");
  grad.addColorStop(1, "rgba(255,150,40,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class MuzzleFlashes {
  constructor(scene) {
    this.pool = [];
    this._nextFree = 0;
    const tex = makeFlashTexture();
    for (let i = 0; i < FLASH_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this.pool.push({ sprite, mat, life: 0, maxLife: 1, size: 1, spin: 0 });
    }
  }

  /** Blink a flash at world position `pos`. Drops it if the pool is full. */
  flash(pos) {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[(this._nextFree + i) % this.pool.length];
      if (e.life > 0) continue;
      this._nextFree = (this._nextFree + i + 1) % this.pool.length;
      e.maxLife = FLASH_LIFE * (0.6 + Math.random() * 0.8);
      e.life = e.maxLife;
      e.size = FLASH_SIZE_MIN + Math.random() * (FLASH_SIZE_MAX - FLASH_SIZE_MIN);
      e.spin = (Math.random() - 0.5) * 12; // rad/s, random flash orientation drift
      e.mat.rotation = Math.random() * TAU;
      e.sprite.position.copy(pos);
      e.sprite.visible = true;
      return;
    }
  }

  /** Age every active flash; opacity and size decay over its short life. */
  update(dt) {
    for (const e of this.pool) {
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) {
        e.sprite.visible = false;
        e.mat.opacity = 0;
        continue;
      }
      const t = e.life / e.maxLife; // 1 -> 0
      e.mat.opacity = t;
      e.mat.rotation += e.spin * dt;
      const s = e.size * (0.6 + 0.4 * t);
      e.sprite.scale.set(s, s, 1);
    }
  }

  /** Deactivate everything (used on restart). */
  clear() {
    for (const e of this.pool) {
      e.life = 0;
      e.sprite.visible = false;
      e.mat.opacity = 0;
    }
  }
}
