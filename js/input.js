"use strict";

// ---------------------------------------------------------------------------
// Keyboard + mouse state.
//
//  - Keyboard: `isDown(...codes)` accepts a list of codes (logical OR).
//  - Mouse: `isMouseDown("left" | "right")` for the two fire buttons.
//  - Pointer lock: the turret is aimed with a pointer-locked mouse. Deltas are
//    accumulated while locked and consumed once per frame by the Player
//    Controller (`consumeMouseDelta`). An unintended lock loss (Esc) auto-
//    pauses the game; the overlay states release the lock.
//
// Game-level key events (start / pause / restart) are routed to `Game`.
// ---------------------------------------------------------------------------

const Input = {
  keys: new Set(),
  mouse: new Set(), // "left" | "right"
  _dx: 0,
  _dy: 0,
  _canvas: null,
  _wantLock: false,
  _locked: false,

  init(canvas) {
    this._canvas = canvas;

    window.addEventListener("keydown", (e) => {
      // Keep arrows/space from scrolling the page.
      if (
        e.code === "ArrowUp" ||
        e.code === "ArrowDown" ||
        e.code === "ArrowLeft" ||
        e.code === "ArrowRight" ||
        e.code === "Space"
      ) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      if (typeof Game !== "undefined" && Game.onKeyDown) Game.onKeyDown(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouse.clear();
    });

    // Mouse buttons: left = MG, right = shell.
    window.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouse.add("left");
      else if (e.button === 2) this.mouse.add("right");
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouse.delete("left");
      else if (e.button === 2) this.mouse.delete("right");
    });

    // Turret aiming: accumulate raw deltas only while the pointer is locked.
    window.addEventListener("mousemove", (e) => {
      if (this._locked) {
        this._dx += e.movementX;
        this._dy += e.movementY;
      }
    });

    // Right click = shell: suppress the context menu on the canvas.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Pointer lock: an unintended loss (Esc) auto-pauses the game.
    document.addEventListener("pointerlockchange", () => {
      this._locked = this._canvas === document.pointerLockElement;
      if (!this._locked && this._wantLock && typeof Game !== "undefined" && Game.onPointerUnlock) {
        Game.onPointerUnlock();
      }
    });
  },

  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  },

  isMouseDown(...which) {
    return which.some((w) => this.mouse.has(w));
  },

  /** Read and reset the accumulated mouse deltas (call once per frame). */
  consumeMouseDelta() {
    const d = { dx: this._dx, dy: this._dy };
    this._dx = 0;
    this._dy = 0;
    return d;
  },

  /** Request pointer lock on the canvas (call from a user gesture). */
  lockPointer() {
    this._wantLock = true;
    if (!this._canvas) return;
    const p = this._canvas.requestPointerLock();
    if (p && typeof p.catch === "function") p.catch(() => {});
  },

  /** Release pointer lock (overlay / pause states). */
  unlockPointer() {
    this._wantLock = false;
    this._locked = false;
    if (document.exitPointerLock) document.exitPointerLock();
  },

  isLocked() {
    return this._locked;
  },
};
