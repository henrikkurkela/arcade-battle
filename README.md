# A FULLY VIBE CODED ARCADE BATTLE GAME

This game was made as a test if the Arcade Plane game 
(https://github.com/henrikkurkela/arcade-plane/)
could be pushed even further, when taking into account the native context
limit of 262144 tokens on the Qwen 3.8 27B model.

In hindsight, the way this was vibed was not the most elegant strategy,
as the planes were first ripped out and replaced with tanks, and later
the planes were added back... Well, at least that provided a good chance
to test the large context situations since both this and the old plane
game had to be accessed simultaneously. Large additions often used over
200k tokens for a session, but the model was able to navigate this with
relative ease.

# Arcade Battle

A 3D arcade combat game. Pick a vehicle on the title screen — a tank or a
fighter plane — and fight over procedurally generated terrain dotted with
trees and rocks. The map is shared with a fleet of hostile CPU tanks (which
hunt you **and each other**), a squad of riflemen, a fleet of CPU planes, and
a ring of anti-aircraft guns. Fight back with your guns, retreat to the
garage to repair, and rack up kills.

## Run

No build step. Just open `index.html` in a browser (double-click works — the
code uses classic scripts and a local copy of Three.js in `lib/`, so no server
or internet is needed at runtime).

A dev server also works fine if you prefer one:

```
npx serve .
```

## Controls

The title screen has a VEHICLE toggle (TANK / PLANE); the start button reads
"Drive" or "Fly" to match. M, P, R and Enter/Space work in both vehicles
(mute, pause, restart, start/restart).

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
down). A short warning beep sounds when the OVERHEAT warning appears (both
vehicles) and when the plane's STALL warning appears.

## Gameplay

- **Vehicles:** the title screen's VEHICLE toggle switches between the tank
  and the plane. Your best score is shared between the two.
- **Title screen:** the world idles behind the overlay (engine ticking over).
   Set the counts with the title-screen controls — TANKS (CPU tanks, 0–16,
   four by default; 0 shows "TANKS 0"), RIFLEMEN (0–16, four
  by default), PLANES (CPU planes, 0–16, four by default; 0 = "NO PLANES"),
  and AA GUNS (0–16, sixteen by default; 0 = "NO AA") — then press Enter/Space
  or click the start button (the pointer locks for aiming; Esc pauses and
  releases it). The title screen also has MUSIC and SFX volume controls
  (0–100, in steps of 10) and a TIME toggle for day/night. All of these
  settings — plus the mute flag and your best score — persist across page
  reloads (localStorage); the best score is shown on the title screen once you
  have one.
- **The HUD** shows a compass tape, an HP bar, speed (km/h), heading (degrees
  and compass point), kills, score, a crosshair marking your line of fire, a
  message feed of combat events, and the control hints. In the tank it also
  shows the shell status (READY or the reload countdown) and an MG heat bar;
  in the plane it shows altitude, throttle, the rocket count, and the STALL
  warning.
- **Tank — MG heat:** sustained fire heats your gun; after about 100 rounds it
  overheates and cannot fire until fully cooled. The heat bar appears at half
  heat (50%) and stays visible until the gun is fully cool, and an OVERHEAT
  warning stays up (with a beep) while locked out. Muzzle flashes blink at the
  barrel for each shot.
- **Tank — main gun:** hold **right click / X** to fire a shell — one in the
  breech, reloaded over 2.5 s. Shells are slower than tracers and **arc under
  gravity**, so you must lead the target. Each one detonates on proximity (or
  on the ground / when its fuse runs out) and deals **splash damage to every
  unit in a ~12 m blast** — 60 HP at the center falling to 15 at the edge
  against a tank. You are immune to your own blast. CPU tanks also carry the
  main gun and launch one rarely (no ammo limit — just a long cooldown), so
  the occasional arcing splash can come at you from anywhere.
- **Plane — flight:** W/S pitch, A/D bank (turns come from banking), Q/E
  rudder, Shift/Ctrl/C throttle; the pointer-locked mouse is the "stick".
  Below about 12 m/s of forward speed the plane **stalls** (the nose drops);
  point the nose down into the velocity vector to recover. A STALL warning
  (with a beep) appears as you approach it.
- **Plane — cannon + rockets:** hold **left click / Space** to spray the cannon
  (it heats and overheates just like the tank's MG). Hold **right click / X**
  to fire rockets — arcing splash ordnance (~15 m blast, 35 HP at the center
  falling to 12 at the edge). Rockets are finite: you start with 6, and every
  100 HP of damage you deal (cannon or rocket) earns one more, up to the cap.
- **Riflemen:** foot infantry (four by default) with 40 HP and no armor. They
  walk toward the nearest tank, stop at firing range, and lay down burst fire;
  pressed up close they turn and walk away. Tank MG fire, shell splashes, and
  plane cannon/rockets all kill them fast.
- **CPU planes:** a fleet of fighters (four by default) that dogfights each
  other and the ground forces, spraying cannon and launching rare rockets.
  Shoot one down for a kill; colliding with one (or hitting the ground or
  scenery) destroys your plane.
- **AA guns:** a ring of turrets (sixteen by default) around the map center.
  They engage **planes only** — never tanks or riflemen — with cannon tracers
  and rare rockets. They are heavily armored but can be **knocked out** (they
  stay disabled for a while, then re-enable); knocking one out is called out in
  the message feed but scores nothing. At night each gun sweeps a searchlight.
- **Collisions (tank):** driving into a tree or rock stops the tank at the
  trunk and chips 2 HP on a hard impact (not instant death). Ramming another
  tank at speed damages **both** tanks (speed-based) and pushes the hulls
  apart. Destroyed tanks break into a burst of tumbling debris (hull slab,
  track section, turret chunk) that falls to the ground, rests for a few
  seconds, and shrinks away.
- **Damage smoke:** at 50% HP or below a unit trails light smoke; at 20% or
  below it burns heavily (dark, fast smoke). Moving tanks kick up dust puffs
  behind their tracks, scaled by speed, with an extra burst on hard turns.
- **Garage:** the flat concrete pad at your spawn point is the repair zone. In
  the tank, drive inside it and your HP climbs 20/s back to full (a "GARAGE —
  REPAIRING" hint shows while you are inside); CPU tanks drive through it
  unchanged — it only helps you. In the plane, the pad is the runway: a clean
  landing on it (wheels down, level-ish, gentle sink) restores your HP to full
  (a "LANDED — HP RESTORED" hint shows); a hard landing or a crash into the
  ground/scenery destroys you.
- **Day / night:** the TIME toggle on the title screen switches between day
  and night (the sky, fog, lights, clouds, and horizon fade all ease over
  ~1 s). Night brings a dark sky with procedural stars, dim moonlight,
  tighter fog, and tinted clouds — and the AA searchlights come on. The choice
  persists across reloads.
- **Score** = damage you deal (1 pt per 1 HP) + 500 per kill. Only damage and
  kills *you* cause count. The map is generated once per session. When you are
  destroyed, a panel appears after a short delay with the reason, distance
  driven, kills, and score, plus a scoreboard of every shooter — you and each
  CPU callsign (tanks, planes, the riflemen, and the AA guns) — with kills and
  score, best first. The same scoreboard is shown on the pause screen. Your
  best score is recorded on every destruction, persisted across reloads, and
  shown on the title screen. R (or Enter/Space) starts a new run on the same
  map.
- **HP:** tanks, planes, and AA guns all have 100 HP; riflemen have 40.
- **Damage & armor:** every hit is classified as **soft** (small arms — the
  tank's MG, the plane's cannon, riflemen's burst fire) or **hard** (heavy
  ordnance — the main-gun shell and rockets). Each target carries two armor
  values, one per kind, that act as divisors: incoming damage is divided by
  the matching armor and floored, so a higher value soaks more (an armor of 1
  is no protection at all). Tanks are heavily armored against small arms
  (soft armor 10 — a 30-damage MG tracer gets through to just 3 HP) but only
  lightly against the main gun (hard armor 1.25 — a shell still lands ~60 at
  the blast center, ~15 at the edge). Riflemen have no armor at all (1/1) and
  die fast to anything. Planes are armored against cannon (soft armor 3 — a
  tracer deals ~7) but not against rockets (hard armor 1). AA guns are the
  toughest (soft 10, hard 2), so they soak most hits and, when their 100 HP
  finally runs out, are only knocked out for a while before re-enabling.
- **Trees:** ~2000 per map, placed deterministically from the map seed (same
  seed => same layout), about half pine, half broadleaf. They avoid the garage
  pad and near-vertical slopes. Driving into a trunk stops you and chips a
  little HP.
- **Rocks:** ~200 boulders per map, placed the same way (seeded, garage
  clear). They tolerate steeper ground, so they also sit on cliffs. Driving
  into one stops you and chips a little HP.

## How it works

- `js/main.js` — scene setup (sky dome, fog, lights, shadows), game state
  (ready / playing / paused / destroyed), main loop, HUD (incl. HP bar, speed,
  heading + compass point, kills, score, compass tape, shell/rocket status,
  heat bar, crosshair, stall/overheat/repair/landing hints), overlays (incl.
  the scoreboard), the vehicle toggle, the AI tank fleet (respawn, kill
  attribution, per-shooter score tallies), the rifleman squad, the CPU plane
  fleet, the AA-gun ring, the garage base zone (flat zone, painted concrete
  decal with hazard border, tank repair hint, plane landing), tank-tank and
  tank-obstacle collisions, plane crash/ram checks, dust puffs, damage smoke,
  the day/night environment blend, and the persisted settings (localStorage:
  vehicle, enemy/rifleman/plane/AA counts, volumes, mute, day/night, best
  score).
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
- `js/plane.js` — the plane (primitive-based low-wing single-seater: fuselage,
  tapered tail, spinner + propeller, canopy, wing with ailerons, tailplane +
  elevator, fin + rudder, fixed landing gear) and the arcade flight model:
  pitch/bank/rudder/throttle, turning from banking, "sticky" lift that fades
  out at low forward speed (stall), thrust/gravity/drag, and a branch fix that
  keeps the control law right through loops. `takeDamage()` applies soft
  (cannon) and hard (rocket) armor.
- `js/rifleman.js` — the rifleman (low-poly infantry with an assault rifle):
  a walking pace (no reverse), free in-place turning, the same terrain
  following and slope limit as the tank, and a leg-swing walk animation.
  `takeDamage()` applies (deliberately low) soft and hard armor.
- `js/aagun.js` — the AA-gun ring: fixed ground turrets around the map center
  that engage planes only, slew the turret with lead, fire pooled tracers and
  rare rockets, can be knocked out (disabled for a while, then re-enabled),
  and sweep a night searchlight (visual only).
- `js/ai.js` — the controllers. `PlayerController` maps the keyboard and the
  pointer-locked mouse to a tank control vector (W/S throttle, A/D steer,
  Shift brake, LMB/Space fire MG, RMB/X fire shell). `PlanePlayerController`
   does the same for the plane (mouse pitch/bank, W/S pitch, A/D bank, Q/E
   rudder, Shift/Ctrl/C or mouse wheel throttle, LMB/Space cannon, RMB/X
   rockets). `TankAI`
  steers a CPU tank: nearest-enemy target selection (you, other CPUs, riflemen,
  and planes), lead pursuit, hull steering with a slope-avoidance override, a
  preferred engagement range, a battle-area leash (they never stray far beyond
  ~1.2 km of the map center), turret slewing, and firing decisions (MG spray
  plus a rare arced shell on a long cooldown). `RiflemanAI` drives a rifleman
  (advance to firing range, burst fire, back off when pressed). `PlaneAI`
  steers a CPU plane (nearest-enemy pursuit, collision avoidance, terrain and
  altitude limits, cannon spray plus a rare arced rocket). All behavior is
  driven by named tuning constants at the top of the file.
- `js/combat.js` — pooled ground weapons shared by the player tank and the CPU
  tanks. `Tracers` is a fixed pool of MG tracer meshes (no per-shot
  allocation): tracers inherit the shooter's velocity, and hits apply damage
  to any unit that does not share the shooter's team. Each CPU gets its own
  unique team, so friendly fire between CPUs is on (your tracers never hit
  you). `Shells` is the pooled main-gun system: each shell inherits the
  shooter's velocity plus its own speed, arcs under gravity, and detonates on
  proximity/ground/fuse, applying splash damage with distance falloff to every
  unit in the blast radius except the shooter (owner immunity). The same file
  holds the ballistic launch-direction solver the AI uses to arc shells onto a
  target.
- `js/aircombat.js` — pooled aerial weapons shared by the CPU planes and the
  AA guns. `Projectiles` is a fixed pool of cannon tracers (SOFT damage) that
  inherit the shooter's velocity. `Rockets` is the pooled arcing ordnance
  (HARD damage): unguided, they arc under gravity and detonate on
  proximity/ground/fuse, applying splash damage with distance falloff to every
  unit in the blast radius except the shooter. Both pools are target-agnostic
  (they hit any unit or AA gun except same-team and the shooter); the AI
  decides what to aim at. The file also holds the ballistic rocket
  launch-direction solver.
- `js/debris.js` — pooled debris: when a tank is destroyed, a burst of
  tumbling tank-shaped pieces (hull slab, track section, turret chunk) flies
  out inheriting the tank's velocity, falls under gravity with drag, lands on
  the terrain, rests for a few seconds, then shrinks away. Fixed pool of
  meshes, no per-kill allocation.
- `js/muzzle.js` — pooled muzzle flashes: a bright additive sprite blinks at
  the muzzle for a few frames each time any gun fires. Fixed pool of
  sprites, same pattern as `Tracers`, `Shells`, and `Debris`.
- `js/terrain.js` — infinite terrain. The ground is a seeded height function
  `heightAt(x, z)` (sine octaves) rendered by a mesh that re-centers on the
  player unit. The same function drives collision, so mesh and physics always
  agree. Vertex colors blend by height (valley grass → brown → peak), by slope
  (rock), plus a hash mottling. `flatZones` flattens rectangles of the height
  function (the garage pad uses one); the edge fade color is shared so the
  day/night switch can re-tint it.
- `js/scenery.js` — registry for non-terrain world objects. Clouds (drifting,
  wrapping billboard sprites), trees (static, collidable vegetation), and
  rocks (static, collidable boulders) live here, all with a shared radial
  edge fade that matches the terrain's horizon blend. `collidesWith(pos, r)`
  (bool) and `overlapping(pos, r, out)` (fills `out`) drive the tank blocking
  and the plane crash checks.
- `js/camera.js` — the chase camera (sits behind and above the hull, follows
  with a small lead in the direction of travel, widens the FOV at speed,
  shakes on hits and destruction) for the tank, and the plane camera (behind
  and above the fuselage) for the plane.
- `js/audio.js` — synthesized engine audio (diesel rumble for the tank from a
  low sawtooth/triangle pair and filtered noise; a propeller "thump" and
  "whoosh" for the plane; the pitch and volume scale with throttle and speed,
  and the engine ticks over on the title screen), distance-scaled MG/cannon
  reports, shell/rocket launch and explosion sounds, and a warning beep for
  the OVERHEAT and STALL warnings. Everything feeds a user-adjustable SFX gain
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
  pointer-lock handling for aiming).
- `lib/three.min.js` — Three.js r150 (local copy, no CDN needed).

Rendering notes: the sun (and its shadow camera) follows the player unit, so
the unit and trees cast soft PCF shadows onto the terrain. A gradient sky dome
is exempt from the fog (450–2300 m by day, 300–1500 m by night) and gains
procedural stars in night mode. If WebGL is unavailable, the game shows a
message instead of crashing.
