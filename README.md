# Arcade Tank

A 3D arcade tank combat game. You drive a tank in third person (chase camera
behind the hull) over procedurally generated terrain dotted with trees and
rocks. A fleet of hostile CPU tanks shares the map in a free-for-all: they
hunt and shoot you **and each other** — fight back with your machine gun and
your arcing splash shells, retreat to the garage to repair, and rack up kills.

## Run

No build step. Just open `index.html` in a browser (double-click works — the
code uses classic scripts and a local copy of Three.js in `lib/`, so no server
or internet is needed at runtime).

A dev server also works fine if you prefer one:

```
npx serve .
```

## Controls

M, P, R and Enter/Space work in both vehicles (mute, pause, restart,
start/restart).

### Tank

| Key | Action |
| --- | --- |
| W / ↑ | Throttle forward |
| S / ↓ | Reverse |
| A / ← , D / → | Steer |
| Mouse (pointer locked) | Turret yaw / elevation |
| Left click / Space | Fire MG (hold to spray) |
| Right click / X | Fire main gun shell |
| Shift | Brake |

### Plane

| Input | Action |
| --- | --- |
| Mouse (pointer locked) | Pitch / bank (the "stick") |
| W / ↑ , S / ↓ | Pitch (keyboard fallback) |
| A / ← , D / → | Bank (keyboard fallback) |
| Q / E | Rudder |
| Shift / Ctrl or C | Throttle up / down |
| Left click / Space | Fire cannon (hold to spray) |
| Right click / X | Fire rockets |

Slopes steeper than 35° stop the tank going up (it can still reverse back
down). A short warning beep sounds when the OVERHEAT warning appears.

## Gameplay

- The title screen shows the world idling (engine ticking over). Set the enemy
  count (0–16; 0 = "TRAINING" mode, a peaceful map) with the title-screen
  controls, then press Enter/Space or click "Drive" to start (the pointer
  locks for turret aiming; Esc pauses and releases it). The title screen also
  has MUSIC and SFX volume controls (0–100, in steps of 10) and a TIME toggle
  for day/night. All of these settings — plus the mute flag and your best
  score — persist across page reloads (localStorage); the best score is shown
  on the title screen once you have one.
- The HUD shows a compass tape, an HP bar, speed (km/h), heading (degrees and
  compass point), kills, score, the shell status (READY or the reload
  countdown), an MG heat bar, a crosshair marking your line of fire (the
  barrel direction), a message feed of combat events, and the control hints.
- **Free-for-all:** a fleet of hostile CPU tanks (distinct liveries and
  callsigns, four by default) drives the same map. They actively hunt and
  shoot the nearest enemy — *you included* (friendly fire between CPUs is on;
  your shots never hit you). Hold **left click / Space** to spray your MG.
  Everyone has 100 HP — gunfire chips it, and at 0 you are destroyed.
- **MG heat:** sustained fire heats your gun; after about 100 rounds it
  overheates and cannot fire until fully cooled. The heat bar appears at half
  heat (50%) and stays visible until the gun is fully cool, and an OVERHEAT
  warning stays up (with a beep) while locked out. Muzzle flashes blink at the
  barrel for each shot.
- **Main gun:** hold **right click / X** to fire a shell — one in the breech,
  reloaded over 2.5 s. Shells are slower than tracers and **arc under
  gravity**, so you must lead the target. Each one detonates on proximity (or
  on the ground / when its fuse runs out) and deals **splash damage to every
  tank in a ~12 m blast** — 40 HP at the center falling to 15 at the edge.
  You are immune to your own blast. CPU tanks also carry the main gun and
  launch one rarely (no ammo limit — just a long cooldown), so the occasional
  arcing splash can come at you from anywhere.
- **Collisions:** driving into a tree or rock stops the tank at the trunk and
  chips 2 HP on a hard impact (not instant death). Ramming another tank at
  speed damages **both** tanks (speed-based) and pushes the hulls apart.
  Destroyed tanks break into a burst of tumbling debris (hull slab, track
  section, turret chunk) that falls to the ground, rests for a few seconds,
  and shrinks away.
- **Damage smoke:** at 50% HP or below a tank trails light smoke; at 20% or
  below it burns heavily (dark, fast smoke). Moving tanks kick up dust puffs
  behind their tracks, scaled by speed, with an extra burst on hard turns.
- **Garage:** the flat concrete pad at your spawn point is the only repair
  zone. Drive inside it and your HP climbs 20/s back to full (a "GARAGE —
  REPAIRING" hint shows while you are inside). CPU tanks drive through it
  unchanged — it only helps you.
- **Day / night:** the TIME toggle on the title screen switches between day
  and night (the sky, fog, lights, clouds, and horizon fade all ease over
  ~1 s). Night brings a dark sky with procedural stars, dim moonlight,
  tighter fog, and tinted clouds. The choice persists across reloads.
- **Score** = damage you deal (1 pt per 1 HP) + 500 per kill. Only damage and
  kills *you* cause count. The map is generated once per session. When you are
  destroyed, a panel appears after a short delay with the reason, distance
  driven, kills, and score, plus a scoreboard of every shooter — you and each
  CPU callsign — with kills and score, best first. The same scoreboard is
  shown on the pause screen. Your best score is recorded on every destruction,
  persisted across reloads, and shown on the title screen. R (or Enter/Space)
  starts a new run on the same map.
- Trees: ~2000 per map, placed deterministically from the map seed (same seed
  => same layout), about half pine, half broadleaf. They avoid the garage pad
  and near-vertical slopes. Driving into a trunk stops you and chips a little
  HP.
- Rocks: ~200 boulders per map, placed the same way (seeded, garage clear).
  They tolerate steeper ground, so they also sit on cliffs. Driving into one
  stops you and chips a little HP.

## How it works

- `js/main.js` — scene setup (sky dome, fog, lights, shadows), game state
  (ready / playing / paused / destroyed), main loop, HUD (incl. HP bar,
  speed, heading + compass point, kills, score, compass tape, shell status,
  heat bar, crosshair), overlays (incl. the scoreboard), the AI fleet
  (respawn, kill attribution, per-shooter score tallies), the garage base
  zone (flat zone, painted concrete decal with hazard border, HP-restore
  repair hint), tank-tank and tank-obstacle collisions, dust puffs, damage
  smoke, the day/night environment blend, and the persisted settings
  (localStorage: enemy count, volumes, mute, day/night, best score).
- `js/tank.js` — the tank (primitive-based model: hull, tracks with road
  wheels, yawing turret with a pitching barrel, muzzle marker, optional
  livery color) and the arcade ground-vehicle model: throttle/brake/coast,
  speed-scaled steering that inverts in reverse, terrain following (hull y
  from the four corners, eased pitch/roll), a slope limit that kills forward
  motion on steep ground, and the mouse-driven turret (free yaw, clamped
  pitch). `update(dt, control)` takes a continuous control vector from a
  controller rather than reading the keyboard, and exposes `hp`/`alive`/
  `team`, `takeDamage()`, and world-space muzzle/barrel directions for the
  weapon systems.
- `js/ai.js` — the controllers. `PlayerController` maps the keyboard and the
  pointer-locked mouse to a control vector (W/S throttle, A/D steer, Shift
  brake, LMB/Space fire MG, RMB/X fire shell). `TankAI` steers a CPU tank:
  nearest-enemy target selection (you and other CPUs), lead pursuit,
  hull steering with a slope-avoidance override (steer toward the clearer
  side when the ground ahead is too steep), a preferred engagement range
  (approach from far, back off when close), a battle-area leash (they never
  stray far beyond ~1.2 km of the map center), turret slewing, and firing
  decisions (MG spray plus a rare arced shell on a long cooldown, aimed
  along a ballistic arc). All behavior is driven by named tuning constants at
  the top of the file.
- `js/combat.js` — pooled weapon systems shared by player and CPUs. `Tracers`
  is a fixed pool of MG tracer meshes (no per-shot allocation): tracers
  inherit the shooter's velocity, and hits apply damage to any tank that does
  not share the shooter's team. Each CPU gets its own unique team, so
  friendly fire between CPUs is on (your tracers never hit you). `Shells` is
  the pooled main-gun system: each shell inherits the shooter's velocity plus
  its own speed, arcs under gravity, and detonates on proximity/ground/fuse,
  applying splash damage with distance falloff to every tank in the blast
  radius except the shooter (owner immunity). The same file holds the
  ballistic launch-direction solver the AI uses to arc shells onto a target.
- `js/debris.js` — pooled debris: when a tank is destroyed, a burst of
  tumbling tank-shaped pieces (hull slab, track section, turret chunk) flies
  out inheriting the tank's velocity, falls under gravity with drag, lands on
  the terrain, rests for a few seconds, then shrinks away. Fixed pool of
  meshes, no per-kill allocation.
- `js/muzzle.js` — pooled muzzle flashes: a bright additive sprite blinks at
  the muzzle for a few frames each time any gun fires. Fixed pool of
  sprites, same pattern as `Tracers`, `Shells`, and `Debris`.
- `js/terrain.js` — infinite terrain. The ground is a seeded height function
  `heightAt(x, z)` (sine octaves, gentler amplitudes than the plane game)
  rendered by a mesh that re-centers on the tank. The same function drives
  collision, so mesh and physics always agree. Vertex colors blend by height
  (valley grass → brown → peak), by slope (rock), plus a hash mottling.
  `flatZones` flattens rectangles of the height function (the garage pad uses
  one); the edge fade color is shared so the day/night switch can re-tint it.
- `js/scenery.js` — registry for non-terrain world objects. Clouds (drifting,
  wrapping billboard sprites), trees (static, collidable vegetation), and
  rocks (static, collidable boulders) live here, all with a shared radial
  edge fade that matches the terrain's horizon blend. `overlapping(pos, r)`
  returns the colliding items for the tank's blocking check.
- `js/camera.js` — chase camera (sits behind and above the hull, follows with
  a small lead in the direction of travel, widens the FOV at speed, shakes on
  hits and destruction). The tank stays level-ish, so the horizon is not
  banked — the camera up stays world-up.
- `js/audio.js` — synthesized engine audio (diesel rumble from a low
  sawtooth/triangle pair and filtered noise; the pitch and volume scale with
  throttle and speed, and the engine ticks over on the title screen),
  distance-scaled MG reports and shell launch/explosion sounds, and a warning
  beep for the OVERHEAT warning. Everything feeds a user-adjustable SFX gain
  under the shared master gain (M mutes it all); no audio assets, created on
  the first user gesture. It exposes the shared AudioContext and master gain
  so the music module can plug into the same mix.
- `js/music.js` — synthesized background music: three short synthwave loops
  (a calm title-screen menu track, and two combat tracks picked at random
  each run) defined as data tables and played by a lookahead note scheduler on
  the shared AudioContext (pad, bass, detuned-saw lead, and noise-based
  drums, with a feedback delay). It feeds a user-adjustable music gain (the
  title-screen MUSIC control) under the same master gain, so M mutes it too;
  it ducks while paused and fades out on destruction.
- `js/utils.js`, `js/input.js` — helpers and keyboard/mouse state (incl. the
  pointer-lock handling for turret aiming).
- `lib/three.min.js` — Three.js r150 (local copy, no CDN needed).

Rendering notes: the sun (and its shadow camera) follows the tank, so the
tank and trees cast soft PCF shadows onto the terrain. A gradient sky dome is
exempt from the fog (450–2300 m by day, 300–1500 m by night) and gains
procedural stars in night mode. If WebGL is unavailable, the game shows a
message instead of crashing.
