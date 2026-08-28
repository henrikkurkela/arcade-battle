"use strict";

// ---------------------------------------------------------------------------
// Shared math & utility helpers.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite smoothstep on [0, 1]. */
function smoothstep(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle in radians to [-PI, PI]. */
function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/**
 * Deterministic PRNG (mulberry32).
 * Same seed -> same number stream, so a seed defines a whole map.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap deterministic 2D hash in [0, 1) — used for mottled terrain color. */
function hash2(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967296;
}

/** Random 32-bit seed. */
function randomSeed() {
  return (Math.random() * 0x7fffffff) | 0;
}
