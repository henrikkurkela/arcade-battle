# PLAN — Playable Rifleman (third vehicle)

## Identity

The third vehicle on the title screen: a ghost with a hitscan AT sniper and a
handful of grenades. The tank is the brawler, the plane is the dogfighter, the
rifleman is the **hunter** — and always potentially the hunted. The "opposite
play" of Assault Gun / Tank Buster: instead of strolling in with massive
weaponry, you stay on your toes at all times. The CPUs' free-for-all is your
bread and butter: they fight each other, you harvest the wounded (damage smoke
marks your targets).

## Final numbers

| Parameter | Value |
| --- | --- |
| HP / armor | 100 / soft 1, hard 1 (no armor) |
| Walk / sprint / reverse | 5 / 8 / 5 m/s (sprint = Shift; reverse at walk pace) |
| Sniper | HARD damage 40, hitscan, 2 m hit radius (ray proximity), 800 m max range, 3 s reload |
| Grenade | HARD 40 center / 15 edge, 8 m blast, 20 m/s throw (~40 m range), 5 s fuse backstop (detonates on ground contact), start 4, +1 per 100 damage dealt (sniper or grenade), cap 6 |
| Reveal (triggered by your sniper shot or grenade throw) | 400 m radius, 10 s |
| Rifleman senses | eyes: 70 m always; ears: 400 m when you fire |
| Tank / plane aggro | engage the player rifleman ONLY while revealed, at their normal engage ranges |
| AA guns | never engage the player rifleman (planes only, unchanged) |
| Garage | walk onto the pad: repair 20/s, same "GARAGE — REPAIRING" hint |
| Run-over | a moving tank running over the player rifleman is lethal (speed-based, unchanged) |
| Score | damage dealt + 500/kill, best score shared across all three vehicles |

Sniper damage curve (HARD, floored): rifleman 40 (1 shot), tank 32
(4 shots healthy / 2 at light smoke ≤50 HP / 1 at heavy smoke ≤20 HP),
plane 40 (3 shots), AA gun 20 (5 shots). A healthy tank is not a realistic
target; a smoking one is a decision.

## Stealth / aggro model

- **Pure ghost:** while not revealed, no CPU unit targets the player
  rifleman. Tanks, planes, and riflemen behave exactly as today (they hunt
  each other).
- **Reveal:** firing the sniper or throwing a grenade sets a 10 s reveal
  timer and broadcasts the player's position to all CPU units within 400 m.
  While revealed, tanks and planes may target the player at their normal
  engage ranges; riflemen within 400 m come in ("they heard the shot").
- **Rifleman eyes:** independent of the reveal, any CPU rifleman within
  70 m targets the player (burst fire at normal rifleman damage). This is the
  anti-camp rule: no spot is safe forever.
- **SPOTTED warning:** HUD warning (with the shared warn beep) while the
  reveal timer is active, showing the remaining seconds.

## Weapons

### Sniper (primary, hitscan)

- Instant ray from the muzzle along the aim direction; hits the first unit
  whose center is within 2 m of the ray, up to 800 m. HARD damage 40.
- 3 s reload; HUD row "SNIPER" shows READY or the countdown (same pattern as
  the tank's SHELL row).
- **Ballistic computer (v1 = straight reuse, tune later):** `configure()`
  with gravity 0, a large speed, blast radius 2, fuse radius 2. The arc
  degenerates to a straight line; the existing proximity-fuse ZEROED test
  becomes the hitscan hit test (unit within 2 m of the line = ZEROED).
  Always on, like the Assault Gun / Tank Buster loadouts. Known v1 rough
  edges (backlog): the line runs to the terrain instead of stopping at the
  first unit; aiming above the horizon needs the 800 m clamp; the ground
  marker sits behind a targeted unit.

### Grenade (secondary)

- Thrown along the aim direction at 20 m/s, arcs under gravity, detonates on
  ground contact / proximity / fuse. Splash 40/15 over 8 m, HARD.
- Reuses the `Rockets` pool: extend it with per-projectile blast/fuse
  values (defaulting to the rocket constants) so grenades share the pool.
- Ammo: start 4, +1 per 100 damage dealt (reuses the rocket banking code),
  cap 6. HUD row "GRENADES" (reuses the rocket row pattern; no "∞" case).

## Controls (rifleman)

| Key | Action |
| --- | --- |
| W / ↑ , S / ↓ | Walk forward / back (back at walk pace) |
| A / ← , D / → | Turn in place |
| Shift | Sprint (8 m/s) |
| Mouse (pointer locked) | Aim (body yaw + pitch) |
| Left click / Space | Fire sniper (3 s reload) |
| Right click / X | Throw grenade |
| 1 / 2 | Camera: over-the-shoulder / scope |
| M, P, R, H, Enter/Space | As in the other vehicles |

## Camera

New rifleman camera in `camera.js`, same two-mode pattern as the others:

- **1 — over-the-shoulder:** behind and to the side of the head, looking
  down the rifle; the ballistic line and crosshair are visible.
- **2 — scope:** tight FOV (~20–25) from the eye, looking down the barrel;
  the line + ZEROED readout are the aiming tools. In v1 the scope is a zoom
  only — it does NOT lock movement (backlog).

## HUD

- SPOTTED warning with remaining seconds (beep on appear, like STALL/OVERHEAT).
- SNIPER row (READY / reload countdown), GRENADES row (count, red at 0).
- ZEROED callout (existing element, reused).
- Compass tape, HP bar, speed (km/h), heading + compass point, kills, score,
  message feed, control hints: all unchanged (new rifleman hints block).

## CPU behavior changes (`ai.js`)

- `TankAI` / `PlaneAI`: the player rifleman is a valid target **only while
  the player is revealed** (check the reveal flag in target selection).
- `RiflemanAI`: the player rifleman is a valid target within 70 m always, or
  within 400 m while the player is revealed (ears).
- `AAGun`: unchanged (planes only).
- New named tuning constants at the top of the file: `RIFLEMAN_PLAYER_EYE`
  (70), `RIFLEMAN_PLAYER_EAR` (400), `PLAYER_REVEAL_RADIUS` (400),
  `PLAYER_REVEAL_TIME` (10) — plus the weapon constants in `main.js`.

## Title screen / persistence

- VEHICLE toggle becomes 3-way: TANK / PLANE / RIFLEMAN. Start button reads
  "Drive" / "Fly" / "Move".
- LOADOUT: the rifleman has a single "STANDARD" loadout in v1 (toggle shows
  STANDARD, disabled or inert).
- Persistence: the vehicle value gains the third option; all other persisted
  settings unchanged. Best score stays shared.

## Audio (`audio.js`)

- Sniper shot: a sharp crack, distance-scaled (louder and sharper close).
- Reload click on reload complete (optional, small).
- Grenade: throw whoosh + the existing rocket boom (distance-scaled).
- SPOTTED: the existing warn beep.
- No footsteps in v1 (backlog).

## Implementation phases

**Phase 1 — the vehicle exists.**
`main.js`: third vehicle slot, player rifleman spawn/reset, reveal timer
state, title-screen 3-way toggle, persistence. `camera.js`: over-the-shoulder
+ scope. `index.html`/`style.css`: rifleman hints block, SNIPER/GRENADES
rows, SPOTTED element. Result: you can walk, sprint, turn, aim, and switch
cameras; the world idles as before.

**Phase 2 — the ghost.**
`ai.js`: target-selection changes (tanks/planes only-while-revealed,
riflemen eyes/ears) + tuning constants. `main.js`: reveal trigger points,
SPOTTED HUD warning + beep. Result: the stealth identity works end to end —
you are invisible until you shoot, then hunted for 10 s.

**Phase 3 — the weapons.**
`main.js`: hitscan sniper (ray vs units, damage, reload, reveal trigger),
ballistic computer in hitscan mode (gravity 0, 800 m clamp), grenade throws
via the extended `Rockets` pool + ammo banking. `ballistic.js`: the small
hitscan-mode tweaks. Result: fully playable combat.

**Phase 4 — the finish.**
`audio.js`: sniper crack, reload click, SPOTTED beep wiring. Death panel +
scoreboard (rifleman callsign row already exists for CPUs), garage repair for
the rifleman, message-feed callouts (e.g. a knocked-out AA or a spotted
warning line if useful), README update (controls table, gameplay bullet,
How-it-works entries).

## Tuning backlog (explicitly out of v1)

- Scope readout: target distance + shots-to-kill ("LETHAL" / "2 SHOTS").
- Ballistic line stops at the first unit instead of running to the terrain.
- Scope locks (or slows) movement while aiming.
- Stealth-kill score bonus (e.g. +250 if the target never spotted you).
- Footsteps / breathing audio.
- A rifleman loadout or two (e.g. "Scout": more grenades, faster sprint,
  weaker sniper; "Marksman": longer max range, 2-shot rifleman kills,
  slower sprint).
