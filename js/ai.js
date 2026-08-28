"use strict";

// ---------------------------------------------------------------------------
// Controllers. Each produces `control = { throttle, steer, brake, turretDX,
// turretDY, firing, shellFiring }` (throttle/steer in [-1, 1], brake 0/1,
// turretDX/turretDY raw pointer deltas) plus the fire flags.
//   PlayerController: keyboard + mouse -> control.
//   TankAI:           ground steering + targeting + firing (M4).
// `ctx` = { player, tanks, terrain } (built by main.js).
// ---------------------------------------------------------------------------

class PlayerController {
  constructor() {
    this.control = {
      throttle: 0,
      steer: 0,
      brake: 0,
      turretDX: 0,
      turretDY: 0,
      firing: false,
      shellFiring: false,
    };
  }

  update(dt, tank, ctx) {
    const c = this.control;
    c.throttle =
      (Input.isDown("KeyW", "ArrowUp") ? 1 : 0) -
      (Input.isDown("KeyS", "ArrowDown") ? 1 : 0);
    c.steer =
      (Input.isDown("KeyA", "ArrowLeft") ? 1 : 0) -
      (Input.isDown("KeyD", "ArrowRight") ? 1 : 0);
    c.brake = Input.isDown("ShiftLeft", "ShiftRight") ? 1 : 0;
    // Left click (or Space) fires the MG; right click (or X) the shell.
    c.firing = Input.isMouseDown("left") || Input.isDown("Space");
    c.shellFiring = Input.isMouseDown("right") || Input.isDown("KeyX");
    // Consume the pointer deltas accumulated since the last frame.
    const d = Input.consumeMouseDelta();
    c.turretDX = d.dx;
    c.turretDY = d.dy;
    return this.control;
  }
}
