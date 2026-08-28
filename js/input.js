"use strict";

// ---------------------------------------------------------------------------
// Keyboard state. `isDown(...codes)` accepts a list of codes (logical OR).
// Game-level key events (start / pause / restart) are routed to `Game`.
// ---------------------------------------------------------------------------

const Input = {
  keys: new Set(),

  init() {
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
    window.addEventListener("blur", () => this.keys.clear());
  },

  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  },
};
