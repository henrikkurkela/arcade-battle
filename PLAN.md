# ARCADE TANK — PROJECT PLAN

A 3D arcade tank combat game. You drive a tank in third person (chase camera
behind the hull) over a procedurally generated, seeded map dotted with trees,
rocks, and clouds. A fleet of hostile CPU tanks shares the map in a
free-for-all: they hunt and shoot you **and each other**. Fight with your
machine gun (fast tracers, heat/overheat) and your main gun (arcing shells
with splash damage), retreat to your garage to repair, and rack up kills.

The game is built by **reusing the code from the sibling `Arcade Plane`
folder** (same tech, same architecture) and adding tank-specific pieces.

## 0. Rules for every session executing this plan

1. Work **only** inside the `Arcade Tank` folder. The `Arcade Plane` folder
   is read-only reference material — copy from it, never modify it.
2. No build step, no package manager, no new dependencies. Classic
   `<script>` tags, a local copy of Three.js in `lib/`, must run by
   double-clicking `index.html` (file:// works, no server, no internet).
3. No tests, no test harnesses, no fixtures. Verification = open
   `index.html` in a browser and check the milestone's acceptance criteria.
4. Match the Arcade Plane code style: `"use strict"`, IIFE module pattern
   (`const Game = (() => { ... })();`), pooled particles (fixed pool, no
   per-shot allocation), scratch `THREE.Vector3` objects (no per-frame
   allocations), tuning constants with comments at the top of each file.
5. Execute **one milestone at a time**, in order. Verify that milestone's
   acceptance criteria before starting the next.
6. When a detail is not specified here, follow the closest Arcade Plane
   behavior (read that file first).
7. Keep a console free of errors and warnings at the end of every milestone.

## 1. Reuse map (Arcade Plane → Arcade Tank)

| Plane file | Tank file | What changes |
| --- | --- | --- |
| `lib/three.min.js` | copy as-is | — |
| `js/utils.js` | copy as-is | — |
| `js/input.js` | copy + extend | add mouse state + pointer-lock handling (M2) |
| `js/music.js` | copy as-is | same synthwave tracks, same API |
| `js/terrain.js` | copy + tune | wave amplitudes reduced for gentler hills (M1) |
| `js/scenery.js` | copy + extend | add `overlapping(pos, r)` query for tank blocking (M5); trees/rocks/clouds unchanged |
| `js/muzzle.js` | copy as-is | muzzle flashes work unchanged |
| `js/debris.js` | adapt | debris pieces become tank-shaped (hull slab, track, turret chunk) |
| `js/combat.js` | adapt | `Projectiles` → MG tracers (new numbers); `Rockets` → `Shells` (new numbers, same arc/splash/fuse/`rocketLaunchDir` solver) |
| `js/camera.js` | adapt | chase cam re-tuned: lower and closer (behind the hull) |
| `js/audio.js` | adapt | diesel engine rumble, MG report, shell thump, explosion boom, overheat beep — same synthesized approach, same master/SFX gain API |
| `js/aagun.js` | **do not port** | AA turrets are dropped; BUT its turret rig (yaw Group → pitch Group → barrel + muzzle `Object3D` marker) is the exact pattern to copy for the tank turret |
| `js/ai.js` | rewrite | `PlayerController` (keyboard + mouse) and `TankAI` (ground version of `HostileAI`) |
| `js/plane.js` | replaced by `js/tank.js` | new: primitive tank model + ground vehicle physics |
| `js/main.js` | adapt heavily | same state machine / HUD / overlay / scoreboard / settings / day-night / smoke architecture; runway → garage base zone; AA gun wiring removed; tank fleet instead of plane fleet |
| `index.html`, `style.css` | adapt | same layout; HUD rows and overlay controls re-labeled for tanks |

## 2. Agreed design decisions (the spec)

- **View:** third person, chase camera behind the hull.
- **Tanks:** drawn from primitives (boxes, cylinders, cones), like the planes.
- **Map:** infinite seeded terrain, generated **once per page load** with
  `randomSeed()`; restart (R) keeps the same map. Trees (~2000), rocks
  (~200), clouds (36) placed deterministically from the seed, as in the plane.
- **Terrain:** gentler hills than the plane (see constants). Tanks have a
  slope limit and cannot climb steeper ground.
- **Turret aim:** mouse with pointer lock. Mouse moves turret yaw/elevation;
  WASD drives the hull. Left click (or Space) fires the MG (hold);
  right click (or X) fires the main gun shell.
- **Weapons:**
  - MG: fast tracers, **heat + overheat** exactly like the plane (heat bar,
    overheat lockout until fully cool, warning beep).
  - Main gun: **arcing shells with splash** — the plane's `Rockets` system
    with tank numbers. Gravity arc, proximity/ground/fuse detonation, splash
    with distance falloff, owner immunity. Finite: one shell in the breech,
    reload timer.
- **HP:** 100 for every tank (player and AI).
- **Obstacles:** driving into a tree/rock **blocks** the tank and deals
  small damage.
- **FFA:** 4 AI tanks by default, 0–16 adjustable on the title screen, 3 s
  respawn, AI friendly fire is ON (each AI has a unique team), the player's
  shots never hit the player.
- **AA turrets:** dropped (no ground turrets).
- **HP recovery:** a flat **garage/base zone** at the spawn point; driving
  inside it restores player HP over time. AI tanks do not use it.
- **Tank vs tank:** body collision damages **both** tanks (speed-based).
- **Day/night + music:** kept, exactly like the plane (1 s environment blend,
  stars, night fog, synthwave menu/combat tracks, volume sliders, mute).
- **AI:** plane-style — nearest-enemy targeting, lead pursuit, fire MG when
  aligned + arc a shell when in range on a long cooldown, terrain avoidance
  (they don't drive up cliffs), battle-area leash.
- **Visual extras:** dust puffs behind the tracks while driving. (No track
  marks, no barrel recoil, no shell casings.)
- **Score:** 1 pt per 1 HP of damage dealt + 500 per kill (player-caused
  only). Best score persisted in localStorage, shown on the title screen.
- **Audio:** fully synthesized (no asset files), same master/SFX/music gain
  structure as the plane, created on first user gesture.

### Controls (final)

| Input | Action |
| --- | --- |
| W / ↑ | Throttle forward |
| S / ↓ | Reverse |
| A / ← , D / → | Steer |
| Mouse (pointer locked) | Turret yaw / elevation |
| Left click or Space | Fire MG (hold to spray) |
| Right click or X | Fire main gun shell |
| Shift | Brake |
| P | Pause |
| R | Restart (fresh tank, same map) |
| M | Mute / unmute |
| Enter / Space | Start (title) or restart (after destruction) |

## 3. File structure

```
Arcade Tank/
  index.html
  style.css
  README.md            (written in M6)
  PLAN.md              (this file)
  lib/three.min.js
  js/
    utils.js           (copy)
    input.js           (copy + mouse/pointer lock)
    music.js           (copy)
    terrain.js         (copy + gentler amplitudes)
    scenery.js         (copy + overlapping() query)
    muzzle.js          (copy)
    audio.js           (adapt)
    tank.js            (NEW: model + ground physics)
    camera.js          (adapt)
    combat.js          (adapt: Tracers + Shells)
    debris.js          (adapt: tank-shaped pieces)
    ai.js              (NEW: PlayerController + TankAI)
    main.js            (adapt: game core)
```

Script load order in `index.html` (same pattern as the plane):
`lib/three.min.js`, `utils.js`, `audio.js`, `music.js`, `input.js`,
`terrain.js`, `scenery.js`, `tank.js`, `camera.js`, `combat.js`,
`debris.js`, `muzzle.js`, `ai.js`, `main.js`.

## 4. Tuning constants (single source of truth)

### Tank (`js/tank.js`)

```
TANK_HP            = 100
HULL_LEN           = 4.5 m (along local -Z = nose)
HULL_WIDE          = 2.6 m
HULL_HEIGHT        = 1.3 m (hull top above tracks)
TRACK_H            = 0.5 m (hull center height above ground)
COLLIDE_RADIUS     = 2.6 m (horizontal, for tank-tank and tank-obstacle)
MAX_SPEED_FWD      = 20 m/s  (~72 km/h)
MAX_SPEED_REV      = 8 m/s
ACCEL              = 8 m/s^2
BRAKE_DECEL        = 14 m/s^2
COAST_DECEL        = 3 m/s^2
TURN_RATE          = 1.4 rad/s at full speed (scales with speed, see below)
SLOPE_LIMIT        = 35 deg  (tan ≈ 0.70); cannot climb steeper
TURRET_YAW_RATE    = 1.5 rad/s (AI slewing rate; player is mouse-driven)
TURRET_PITCH_MIN   = -10 deg
TURRET_PITCH_MAX   = +30 deg
MOUSE_SENS         = 0.0022 rad/px
```

Steering: `yaw += steer * TURN_RATE * dt * speedFactor * (reversing ? -1 : 1)`
where `speedFactor = clamp(speed / 8, 0.15, 1)` — the hull can't pivot in
place, but can still turn slowly at a crawl.

Terrain following: sample `terrain.heightAt` at the four hull corners
(±1.3 m x, ±1.9 m z); hull y = average + `TRACK_H`; pitch from
front-vs-rear height difference, roll from left-vs-right, both eased
(rate 8/s) to avoid jitter. If the slope directly ahead (sample 3 m in front,
up-slope component) exceeds `SLOPE_LIMIT` and the tank is moving forward,
forward speed is killed (the tank can still reverse downhill).

### MG tracers (`js/combat.js`, class `Tracers` — adapted from `Projectiles`)

```
MG_BULLET_SPEED    = 160 m/s
MG_BULLET_LIFE     = 3 s
MG_HIT_RADIUS      = 3.5 m (3D distance to tank center point: tank.position + 1.2 m up)
MG_FIRE_INTERVAL   = 0.08 s (player)
MG_DAMAGE_PLAYER   = 6
MG_DAMAGE_AI       = 5
MG_FIRE_INTERVAL_AI = 0.15 s
```

Heat (in `main.js`, same logic as the plane): `+1` heat per shot, overheat at
100, cool rate 10 %/s while not firing, latched lockout until temp reaches 0,
heat bar appears at 50 %, OVERHEAT warning + beep while locked out.

### Shells (`js/combat.js`, class `Shells` — adapted from `Rockets`)

```
SHELL_SPEED        = 90 m/s   (slower than tracers so the arc reads)
SHELL_LIFE         = 8 s fuse
SHELL_GRAVITY      = 9.8 m/s^2
SHELL_FUSE_RADIUS  = 5 m      (proximity stand-off)
BLAST_RADIUS       = 12 m
SHELL_DAMAGE       = 40 HP at blast center
SHELL_DAMAGE_MIN   = 15 HP at blast edge
SHELL_RELOAD       = 2.5 s (player: one shell in the breech)
AI_SHELL_COOLDOWN  = 20 s  (no ammo limit, long cooldown — like plane AI rockets)
AI_SHELL_RANGE     = 500 m
AI_SHELL_CONE      = 0.92 (nose within ~23 deg of aim)
```

The plane's `rocketLaunchDir(from, to, out)` ballistic solver is reused
unchanged (just reads `SHELL_SPEED`/`SHELL_GRAVITY`). Splash damage applies to
every tank in `BLAST_RADIUS` except the shooter (owner immunity), with the
same `smoothstep` falloff as the plane's rockets.

### AI (`js/ai.js`, class `TankAI` — ground version of `HostileAI`)

```
RETARGET_INTERVAL  = 0.3 s
ENGAGE_RANGE       = 1200 m
MG_FIRE_RANGE      = 800 m
MG_FIRE_CONE       = 0.97  (~14 deg)
PREFERRED_RANGE    = 250 m (approach if farther, back off if closer than 120 m)
LOOKAHEAD          = 25 m  (terrain sample ahead of the hull)
BATTLE_RADIUS      = 1200 m from map center (leash; there is no AA ring)
```

Behavior per frame (mirror the plane's `HostileAI` structure):
1. Throttle: full while engaging, 0.7 cruise when loitering; back off (reverse
   briefly) if inside 120 m of the target.
2. Target: nearest alive enemy tank (player or other AI) within
   `ENGAGE_RANGE`, re-picked every `RETARGET_INTERVAL`.
3. Aim point: lead the target using relative closing speed along the line of
   sight (same math as the plane, with `MG_BULLET_SPEED`).
4. Steer the hull toward the aim point (yaw servo toward the desired heading,
   gain ~1.5, max turn = `TURN_RATE`); if the terrain ahead is steeper than
   `SLOPE_LIMIT`, steer to the side with more clearance (sample left/right
   ahead) — this is the ground version of the plane's pull-up override.
5. Leash: if farther than `BATTLE_RADIUS` from the map center, pull the aim
   point back onto the boundary.
6. Turret: slew toward the lead point (yaw rate `TURRET_YAW_RATE`, pitch from
   the ballistic solution for shells / direct line for MG).
7. Fire MG when target in `MG_FIRE_RANGE`, turret within `MG_FIRE_CONE`,
   cooldown elapsed. Fire a shell (arced via `rocketLaunchDir`) when within
   `AI_SHELL_RANGE`, cone ok, and `AI_SHELL_COOLDOWN` elapsed.

### Garage base zone (`main.js`)

```
BASE_RECT          = 40 m x 40 m centered on the spawn point (0, 0)
BASE_REPAIR_RATE   = 20 HP/s while the player tank is inside (player only)
```

The zone is flattened with `terrain.flatZones` (same technique as the plane's
runway, including the `FLAT_MARGIN` = one terrain-cell trick to avoid
z-fighting) and painted with a concrete-pad decal (canvas texture: gray
concrete, yellow hazard border stripes, painted "GARAGE" text — same decal
technique as the plane's runway: `polygonOffset`, +0.05 m above ground).
Trees/rocks avoid the base rect (25 m margin, like the plane's runway
keep-out). A "GARAGE — REPAIRING" hint shows while inside.

### Collisions

- **Tank vs tank:** horizontal distance < 5 m between two alive tanks →
  damage both: `dmg = max(0, (relSpeed - 5) * 2)` HP, per-pair cooldown 1 s,
  plus a positional push-apart so they don't overlap.
- **Tank vs obstacle (tree/rock):** if the tank's next position would enter an
  obstacle's collision circle, cancel the movement step (the tank stops at
  the obstacle) and deal 2 HP damage if impact speed > 3 m/s (per-obstacle
  cooldown 0.5 s).
- **Player death:** HP 0 → "DESTROYED" (the plane's crash flow, re-labeled).

### Camera (`js/camera.js`)

```
CAM_BACK           = 12 m behind the hull
CAM_UP             = 4.5 m
CAM_LOOK_AHEAD     = 6 m ahead of the hull (plus small velocity lead, 0.08)
CAM_FOV            = 70 base, +10 kick at top speed
Shake: 0.02 per shell fired, 0.04 * damage when hit, 1.6 on destruction
```

No horizon banking (the tank stays level-ish); camera up stays world-up.

### Dust (in `main.js`, reuses the plane's `spawnSmoke` particle pattern)

While speed > 2 m/s, emit a small tan puff (color `0x8a7a5a`, size ~1.2,
life ~1.2 s, 3–6 particles) behind the tracks every 0.08 s; rate and size
scale with speed; extra burst on hard turns.

### Enemy fleet

16 liveries + callsigns (tank-flavored), same pattern as the plane's
`CPU_LIVERIES`/`CPU_NAMES`. Suggested set (implementer may refine names):

```
0x3a4150 "Slate Boar"      0x556b2f "Olive Brawler"   0x8a4b3a "Rust Ram"
0x3f5d7a "Blue Bastion"    0x6b5b95 "Purple Raider"   0x2f6f6f "Teal Terrier"
0xb3372f "Red Rammer"      0xc96a2b "Orange Onslaught" 0xbf9b30 "Gold Goliath"
0x7a9a2f "Lime Lasher"     0x3f7a33 "Green Grendel"   0x3585a0 "Cyan Crusher"
0x2a3f6e "Navy Nightstalker" 0x8e3b6e "Magenta Mauler" 0x7a2f4f "Maroon Marauder"
0x9a7a4a "Sand Scorpion"   0x5a5a5a "Gray Grunt"
```

AI tanks spawn 400–800 m from the player on drivable ground (slope under the
limit), facing the player. Respawn: 3 s, new point the same way, same
`Tank` object (so scoreboard tallies keyed by object keep working, exactly
like the plane's fleet slots).

### Terrain (gentler hills)

Same `terrain.js` code and structure; only the wave amplitudes change:

```
Plane: [60, 28, 11, 4]   →   Tank: [33, 15, 6, 2.2]
```

(frequencies/phases still seeded as in the plane). Max slope stays mostly
under the 35° tank limit; occasional steeper spots remain as natural
bottlenecks. Trees keep `TREE_MAX_SLOPE = 1.2`, rocks `2.0`.

## 5. Milestones

Each milestone ends in a verifiable state. Do them in order.

---

### M1 — Scaffold, world, day/night, title screen

**Goal:** the page boots to a title screen floating over the live, seeded
world (terrain + trees + rocks + clouds), with working menu controls and the
game state machine. No tank yet.

**Files:**
- copy: `lib/three.min.js`, `js/utils.js`, `js/music.js`, `js/muzzle.js`
  (muzzle now, used from M3), `js/terrain.js` (apply the gentler amplitudes),
  `js/scenery.js` (as-is for now)
- create: `index.html`, `style.css` (adapt the plane's), `js/audio.js`
  (stub: same API surface as the plane's — `start()`, `update(dt, tank,
  state)`, `setMuted/toggleMute/isMuted`, `setSfxVolume`, master gain shared
  with music — but engine/gun sounds can be silent placeholders until M3/M6),
  `js/main.js`

**Details:**
- `main.js` keeps the plane's architecture: `Game` IIFE, states
  `ready | playing | paused | destroyed`, `buildWorld()` (seed via
  `randomSeed()`, terrain, scenery, clouds), sky dome + stars shader, fog,
  hemi + sun lights (sun follows the player position), day/night palettes +
  1 s blend, edge-fade color sharing, localStorage settings
  (`arcadeTank.settings`: enemy count, music/SFX volume, mute, night, best
  score), message feed, overlay (title/pause/destroyed), scoreboard table,
  resize handling, WebGL-unavailable fallback message.
- Title screen: "ARCADE TANK", blurb ("You're a lone tank in a free-for-all.
  Gun down the enemy fleet, arc your shells, retreat to the garage to
  repair."), ENEMIES control (0–16, default 4, 0 = "TRAINING"), MUSIC/SFX
  sliders (steps of 10), TIME toggle (DAY/NIGHT), best score line, "Drive"
  button.
- While `ready`: camera sits 30 m above the spawn point looking at the map
  center, slowly orbiting (0.05 rad/s) so the world reads as alive.
- While `playing` (no tank yet): camera snaps to the chase position over the
  spawn point; world keeps updating (clouds, sun, day/night).
- HUD: create the full HUD DOM now (see M6 list) but it stays hidden until M6
  wires it; `msg-feed` and `muted` badge work from the start.

**Acceptance:**
- Double-click `index.html`: title screen over a hilly map with trees, rocks,
  drifting clouds, correct horizon fade, no console errors.
- ENEMIES/MUSIC/SFX/TIME controls work; values persist across reload.
- Enter/Space or "Drive" starts (state `playing`), P pauses with overlay,
  M mutes (badge shows), day/night eases over ~1 s and stars appear at night.
- Hardcoding the seed in `buildWorld` reproduces the identical map.

---

### M2 — Tank model, driving, chase camera, mouse aim

**Goal:** the player drives a primitive tank over the map with WASD, the
chase camera follows, and the mouse (pointer-locked) aims the turret.

**Files:**
- create: `js/tank.js`
- adapt: `js/camera.js` (tank chase cam per constants), `js/input.js`
  (mouse state + pointer lock), `js/ai.js` (create; `PlayerController` only
  for now)
- wire in `js/main.js`

**Details:**
- `Tank` class (replaces `Plane`):
  - Model from primitives, nose along local -Z, in meters: hull box + sloped
    glacis plate, two track boxes with 6 small road wheels each (cylinders,
    static), turret box + rear bustle on top (livery color), barrel cylinder
    with muzzle brake, driver's hatch, antenna. Turret is a yaw Group; the
    barrel sits in a pitch Group inside it; an empty `Object3D` muzzle marker
    at the barrel tip (the aagun.js pattern). `muzzleWorld(out)` resolves it.
    `castShadow` on all meshes.
  - Public state like `Plane`: `position`, `velocity` (2D motion, y from
    terrain), `yaw`, `turretYaw`, `turretPitch`, `hp`/`maxHp`/`alive`,
    `team`, `callsign`, `speed`, `forward` (hull nose), `takeDamage()`,
    `reset(x, z, yaw)` (y computed from terrain).
  - `update(dt, control)` with
    `control = { throttle: -1..1, steer: -1..1, brake: 0/1, turretDX,
    turretDY, firing, shellFiring }` — throttle/brake/coast per constants,
    steering per the speed-scaled formula, terrain-following y/pitch/roll,
    slope limit blocking forward motion, turret yaw += `turretDX *
    MOUSE_SENS` (player) clamped pitch to ±limits.
  - 16 livery colors supported via constructor option (like the plane).
- `ChaseCamera`: per constants; `snap(tank)` on spawn; no banking; FOV kick
  with speed; `shake` property.
- `input.js`: track mouse buttons; on game start request pointer lock on the
  canvas; `mousemove` deltas accumulated and consumed each frame by
  `PlayerController` (reset after read); pointer-lock loss (Esc) auto-pauses
  the game; while paused/overlay, release pointer lock. Suppress context menu
  on the canvas (right click = shell).
- `PlayerController.update(dt, tank, ctx)` maps keys + mouse to the control
  object (W/S throttle, A/D steer, Shift brake, LMB/Space firing,
  RMB/X shellFiring, mouse deltas for turret).
- `main.js`: spawn the player tank at (0, 0) facing a drivable direction,
  chase cam, drive loop in the `playing` state, R restarts (fresh tank, same
  map), damage smoke not yet (M5).

**Acceptance:**
- From the title screen, "Drive" locks the pointer; WASD drives the tank
  (forward, reverse, steering that fades at a standstill), Shift brakes.
- The tank climbs hills, tilts with the terrain, and **stops** at slopes
  above 35° (it can reverse back down).
- Mouse moves the turret (yaw free 360°, elevation clamped); camera chases
  from behind with smoothing and FOV kick; Esc pauses and releases the
  pointer; R respawns the tank on the same map. No console errors.

---

### M3 — Weapons: MG + shells, combat audio, combat HUD

**Goal:** the player fires the MG (heat/overheat) and arcing splash shells
(reload), with muzzle flashes, distance-scaled synthesized sound, and the
combat HUD (heat bar, reload indicator, crosshair).

**Files:**
- adapt: `js/combat.js` → `Tracers` (from `Projectiles`) + `Shells` (from
  `Rockets`) per the constants table; `js/audio.js` (real sounds)
- wire in `js/main.js`, `index.html`/`style.css` (heat bar, reload, crosshair)

**Details:**
- `Tracers`: pooled yellow tracer meshes, inherit shooter velocity +
  `MG_BULLET_SPEED`, hit test = 3D distance to tank center point
  (`tank.position` + 1.2 m up) < `MG_HIT_RADIUS`, team-based friendly-fire
  skip, ground impact kills the tracer, `onDamage`/`onKill` callbacks.
- `Shells`: pooled shell meshes (small cylinder + ogive tip, like the plane's
  rocket, no motor glow — or keep a faint one; implementer's choice, keep it
  cheap), inherit shooter velocity + `SHELL_SPEED`, gravity arc, detonate on
  proximity (`SHELL_FUSE_RADIUS` to any hittable tank center point) / ground /
  fuse; splash with falloff to all non-owner tanks; `onBoom(pos, hitCount)`
  callback for audio/flash/smoke. `rocketLaunchDir` reused for AI arcs (M4).
- `audio.js` (synthesized, plane's approach):
  - MG report: short filtered-noise burst + click, distance-scaled.
  - Shell launch: low thump (sine sweep ~120→40 Hz) + noise crack.
  - Explosion: filtered-noise boom with lowpass sweep down, distance-scaled.
  - Overheat warning beep (like the plane).
  - Engine (real version in M6; a basic throttle-scaled rumble is fine now).
- `main.js`: fire wiring (MG: cooldown + heat/overheat exactly like the
  plane; shell: single-shot with `SHELL_RELOAD` timer), muzzle flashes via
  `MuzzleFlashes`, explosion = flash + smoke burst + boom (plane's rocket-boom
  recipe), camera shake on fire/hit, OVERHEAT warning + beep, crosshair
  projected from the barrel direction (plane's crosshair technique, using the
  turret's world direction instead of the nose), HUD: MG heat bar (appears at
  50 %, red when locked), shell status ("READY" / reload seconds, red while
  reloading), message feed entries ("Shell away!" etc. optional).

**Acceptance:**
- Hold LMB/Space: tracers spray from the barrel tip with muzzle flashes and
  reports; heat bar appears at 50 %, OVERHEAT locks the gun with a beep until
  fully cool.
- RMB/X fires a shell: it visibly arcs under gravity, detonates on the
  ground with a flash, smoke burst, and distance-scaled boom; a tank in the
  12 m blast takes falloff damage; the shell cannot hit its own shooter;
  reload indicator counts down 2.5 s before the next shot.
- Crosshair tracks the barrel as the turret moves. No console errors.

---

### M4 — AI tanks and the free-for-all

**Goal:** a fleet of AI tanks hunts the player and each other with MGs and
arced shells, respawns when destroyed, and stays out of the hills.

**Files:**
- `js/ai.js`: add `TankAI` (per the AI spec in section 4)
- `js/main.js`: fleet management, teams, callsigns/liveries, kill
  attribution, AI firing, AI damage smoke, respawn

**Details:**
- `TankAI` mirrors `HostileAI`'s structure (named constants at top,
  `reset()`, `update(dt, tank, ctx)` returning the control object) with the
  ground behaviors from section 4: throttle management, nearest-enemy
  targeting (player + other AI), lead pursuit, hull steering with slope
  avoidance (steer toward the clearer side when the ground ahead is too
  steep), preferred engagement range (250 m; back off under 120 m),
  battle-area leash at `BATTLE_RADIUS`, turret slewing, MG fire decision,
  rare arced shell via `rocketLaunchDir` on `AI_SHELL_COOLDOWN`.
- `ctx` = `{ player, tanks, terrain }` (all alive tanks).
- `main.js`:
  - `spawnAiTank(livery)`: 400–800 m from the player, on drivable ground
    (retry sampling until slope < limit), facing the player, unique team
    `"cpuN"`, callsign from the table.
  - Fleet loop like the plane's: AI control → `tank.update` → firing (MG
    tracers + shells through the shared pools) → obstacle/terrain sanity →
    respawn timer (3 s) → respawn at a new point.
  - Kill attribution: `onKill`/`onDamage` callbacks from both pools feed the
    same scoreboard tallies as the plane (per-AI `shooterStats` map keyed by
    Tank object; player kills/damage separate). Message feed: "You destroyed
    Olive Brawler", "Red Rammer destroyed Blue Bastion", "Olive Brawler
    drove off a cliff", etc.
  - AI tanks take the same damage/HP rules; AI-vs-AI friendly fire is ON
    (unique teams); player shots never hit the player.
  - AI damage smoke: reuse the plane's `emitDamageSmoke` (light ≤50 %, heavy
    ≤20 %) on AI tanks too.
  - Title-screen ENEMIES control (0–16) grows/shrinks the fleet live, 0 =
    TRAINING (peaceful map), persisted.

**Acceptance:**
- With 4 enemies: AI tanks drive around the map, engage the nearest enemy
  (you included), spray MGs when aligned, and occasionally arc a shell that
  splashes on impact; they fight each other and the feed/scoreboard attribute
  kills correctly.
- A destroyed AI tank explodes (smoke burst + sound) and respawns after 3 s
  at a new point; the fleet size stays constant.
- AI tanks do not drive up cliffs (they steer around steep ground) and never
  stray far beyond ~1.2 km from the map center.
- ENEMIES 0 gives a peaceful map; 16 works. No console errors.

---

### M5 — Destruction, garage, collisions, scoring

**Goal:** the full combat loop: tanks die spectacularly, the player can be
destroyed (game-over flow + scoreboard), the garage repairs the player,
tank-tank and tank-obstacle collisions work, and score/best-score persist.

**Files:**
- adapt: `js/debris.js` (tank-shaped pieces: hull slab, track section, turret
  chunk — same pooled physics: burst, gravity, land on terrain, rest, shrink)
- extend: `js/scenery.js` (`overlapping(pos, radius)` returning colliding
  items; trees/rocks register their collision circles — the plane's
  `collidesWith` boolean can stay for reference but the tank uses the new
  query)
- `js/main.js`: destruction flow, garage, collisions, score

**Details:**
- **Destruction:** at 0 HP a tank is destroyed: hide the model, spawn the
  debris burst + a big smoke burst + explosion boom (distance-scaled),
  camera shake if it was the player. AI tanks go to their 3 s respawn timer;
  the player goes to the `destroyed` state: after a 0.8 s delay the overlay
  shows "DESTROYED", the reason ("You were shot down by Olive Brawler." /
  "Your shell hit the ground." is wrong — reasons: shot down by X, rammed,
  etc.), distance driven (km), kills, score, and the full scoreboard
  (YOU + each AI callsign, kills + score, best first). R/Enter restarts on
  the same map (fresh player tank, fleet respawned, score reset, projectiles/
  shells/debris cleared — the plane's `restart()` pattern).
- **Garage:** build in `buildWorld()`: flat zone via `terrain.flatZones`
  (40×40 m at origin + `FLAT_MARGIN` cell trick), concrete decal (canvas
  texture: gray concrete, yellow hazard border, "GARAGE" text,
  `polygonOffset` + 0.05 m), trees/rocks keep-out (25 m margin). While the
  player tank's center is inside the rect and alive: HP += 20/s (cap 100),
  "GARAGE — REPAIRING" hint visible; AI tanks ignore it.
- **Tank vs tank:** each frame, for each alive pair within 5 m horizontal:
  push apart, and (per-pair 1 s cooldown) damage both by
  `max(0, (relSpeed - 5) * 2)`.
- **Tank vs obstacle:** before committing a tank's movement step, test the
  new position against `scenery.overlapping(pos, COLLIDE_RADIUS)`; on
  overlap, cancel the step (tank stops at the obstacle) and, if impact speed
  > 3 m/s (per-obstacle 0.5 s cooldown), deal 2 HP damage.
- **Score:** `score = damageDealt + kills * 500` (player-caused only, plane's
  accounting). On player destruction, record best score (persist, show on
  title screen).

**Acceptance:**
- Shoot an AI tank to 0 HP: it breaks into tumbling tank debris that falls,
  rests, and shrinks; feed + scoreboard credit the kill; it respawns in 3 s.
- Die (let an AI kill you): after the delay the DESTROYED overlay shows
  reason, distance, kills, score, and a correct scoreboard; R restarts on the
  same map with a fresh tank and reset score.
- Drive into the garage: HP climbs 20/s to full with the hint visible; AI
  tanks drive through it unchanged.
- Ram an AI tank at speed: both take damage and get pushed apart.
- Drive into a tree: the tank stops at the trunk and chips 2 HP (not
  instant death). No console errors.

---

### M6 — HUD polish, dust, engine audio, README

**Goal:** the complete, polished game: full HUD, compass, dust, proper
diesel engine audio, and a README.

**Files:** `js/main.js`, `index.html`, `style.css`, `js/audio.js`,
create `README.md`

**Details:**
- **HUD (visible while playing/destroyed):** HP bar (green/amber/red),
  speed (km/h), heading (degrees + compass point), KILLS, SCORE, shell
  status, MG heat bar, compass tape (the plane's tape, driven by hull
  heading), crosshair, message feed, control-hint box (the plane's right-side
  box, re-labeled for tank controls), muted badge, OVERHEAT warning, garage
  hint.
- **Dust:** per section 4 (tan puffs behind the tracks while moving, scaled
  by speed, extra on hard turns) — reuse the `spawnSmoke` pattern.
- **Engine audio:** synthesized diesel rumble — low sawtooth/triangle
  oscillator (~55–90 Hz) + filtered noise bed, pitch and volume scale with
  throttle and speed; idles on the title screen (the plane's "engine ticking
  over" behavior); created on first user gesture; under the SFX gain (M
  mutes it).
- **Music:** verify the menu track on the title screen and a random combat
  track per run, ducking on pause, fade on destruction (already copied from
  the plane — just verify wiring).
- **README.md:** model the plane's README — what the game is, how to run
  (double-click index.html / `npx serve .`), the controls table, gameplay
  notes (FFA, garage, weapons, day/night, scoring), and a "How it works"
  file-by-file section.

**Acceptance (final checklist):**
- Full session: title → drive → fight AI (MG + shells, kills, feed) →
  garage repair → get destroyed → scoreboard → restart. No console errors.
- HUD elements all update live; compass tracks heading; crosshair tracks the
  barrel; heat/reload indicators correct.
- Dust trails behind moving tanks; engine rumble scales with throttle; music
  and SFX respond to the sliders and M.
- Day/night, persistence (enemy count, volumes, mute, night, best score) all
  work across reloads.
- README matches the shipped game.

---

## 6. Definition of done (whole project)

- `index.html` opens from file:// with no server, no console errors.
- Every agreed decision in section 2 is implemented.
- All six milestones' acceptance criteria pass.
- The Arcade Plane folder is untouched.
