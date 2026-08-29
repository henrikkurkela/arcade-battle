"use strict";

// ---------------------------------------------------------------------------
// Game bootstrap, state machine, main loop, HUD and overlays.
//
// States: ready -> playing <-> paused; playing -> destroyed -> (restart)
// The terrain is generated ONCE per session and kept for every run; a
// restart (M5) spawns a fresh tank on the SAME map.
//
// M2: the player drives a primitive tank over the map (WASD + Shift), the
// chase camera follows from behind the hull, and the pointer-locked mouse
// aims the turret. "Drive" spawns the tank and locks the pointer; Esc
// (pointer-lock loss) auto-pauses; R respawns the tank on the same map.
//
// M3: the player fires the MG (LMB/Space, heat + overheat) and arcing splash
// shells (RMB/X, one in the breech, 2.5 s reload), with muzzle flashes,
// synthesized distance-scaled sound, camera shake, the combat HUD subset
// (heat bar, shell status, crosshair) and the plane's smoke-burst recipe for
// shell detonations.
//
// M4: a fleet of AI tanks (TankAI) hunts the player and each other — nearest-
// enemy targeting, lead pursuit, slope-aware steering, a battle-area leash,
// MG sprays and rare arced shells. The ENEMIES control (0-16) grows and
// shrinks the fleet live. Kill attribution feeds the message feed and the
// scoreboard (per-AI tallies keyed by the Tank object, which persists across
// respawns).
//
// M5: the full combat loop. Destroyed tanks break into tumbling debris (a
// pooled burst) and respawn (AI) or end the run (player: the DESTROYED
// overlay shows the reason, distance, kills, score and the scoreboard). The
// garage base zone (flat pad + concrete decal at the spawn point) repairs
// the player over time. Tanks block on trees/rocks (small chip damage on a
// hard impact) and damage each other on body collision (speed-based, both
// take a hit, push apart). Score = damage dealt + 500 per kill; the best
// score persists across sessions.
//
// M6: the HUD is fully wired (HP bar, speed, heading + compass point, kills,
// score, compass tape driven by the hull heading) and stays up after the
// player is destroyed. Dust puffs kick up behind the tracks of any moving
// tank, and the diesel engine rumble scales with throttle and speed.
// ---------------------------------------------------------------------------

const Game = (() => {
  // --- Menu / fleet constants ------------------------------------------------
  const CPU_COUNT = 4; // default fleet size (menu allows 0-16)
  const CPU_MAX = 16; // max enemy tanks
  const KILL_SCORE = 500; // score per kill (scoreboard, M5)

  // --- Combat (M3) -----------------------------------------------------------
  const MG_FIRE_INTERVAL = 0.08; // s between player MG shots
  // SOFT damage (small arms). Boosted 10x over the pre-armor value (3); a
  // tank's TANK_SOFT_ARMOR (10) cancels it, so a tank still takes 3 per hit.
  const MG_DAMAGE_PLAYER = 30; // raw damage per player tracer
  const GUN_HEAT_PER_SHOT = 1; // % heat per shot; 100 shots = overheat
  const GUN_COOL_RATE = 10; // %/s while not firing
  const GUN_MAX_TEMP = 100; // overheat: no fire until the gun cools back to 0
  const SHELL_RELOAD = 2.5; // s to reload the one shell in the breech
  const CAM_SHAKE_FIRE = 0.02; // camera shake per shell fired
  const CAM_SHAKE_HIT = 0.04; // camera shake per HP the player takes

  // --- AI fleet (M4) ---------------------------------------------------------
  const CPU_RESPAWN_DELAY = 3; // s before a destroyed CPU reappears
  // SOFT damage (small arms). Boosted 10x over the pre-armor value (2); a
  // tank's TANK_SOFT_ARMOR (10) cancels it, so a tank still takes 2 per hit.
  const MG_DAMAGE_AI = 20; // raw damage per AI tracer
  const CAM_SHAKE_DESTROYED = 1.6; // camera shake when the player is destroyed
  const OVERLAY_DELAY = 0.8; // s the destruction registers before the panel appears
  // Damage smoke: a tank at or below these HP ratios trails smoke (checked
  // each frame) — light at <=50%, heavy (burning) at <=20%.
  const SMOKE_LIGHT_RATIO = 0.5;
  const SMOKE_HEAVY_RATIO = 0.2;
  const SMOKE_EMIT_OFFSET = 1.5; // m behind the hull nose to spawn puffs
  const SMOKE_LIGHT = { interval: 0.18, count: 5, size: 1.4, color: 0x6a6a6a, opacity: 0.5, life: 1.6 };
  const SMOKE_HEAVY = { interval: 0.07, count: 9, size: 2.2, color: 0x2e2e2e, opacity: 0.8, life: 2.2 };
  // Dust (M6): tan puffs behind the tracks while driving, scaled by speed.
  const DUST_SPEED_MIN = 2; // m/s; dust puffs start above this
  const DUST_INTERVAL = 0.08; // s between puff batches (faster at speed)
  const DUST_COLOR = 0x8a7a5a; // tan
  // 16 distinct liveries (tank-flavored).
  const CPU_LIVERIES = [
    0x3a4150, 0x556b2f, 0x8a4b3a, 0x3f5d7a, 0x6b5b95, 0x2f6f6f,
    0xb3372f, 0xc96a2b, 0xbf9b30, 0x7a9a2f, 0x3f7a33, 0x3585a0,
    0x2a3f6e, 0x8e3b6e, 0x7a2f4f, 0x9a7a4a,
  ];
  // Callsigns named after each livery's main color.
  const CPU_NAMES = {
    0x3a4150: "Slate Boar",
    0x556b2f: "Olive Brawler",
    0x8a4b3a: "Rust Ram",
    0x3f5d7a: "Blue Bastion",
    0x6b5b95: "Purple Raider",
    0x2f6f6f: "Teal Terrier",
    0xb3372f: "Red Rammer",
    0xc96a2b: "Orange Onslaught",
    0xbf9b30: "Gold Goliath",
    0x7a9a2f: "Lime Lasher",
    0x3f7a33: "Green Grendel",
    0x3585a0: "Cyan Crusher",
    0x2a3f6e: "Navy Nightstalker",
    0x8e3b6e: "Magenta Mauler",
    0x7a2f4f: "Maroon Marauder",
    0x9a7a4a: "Sand Scorpion",
  };

  // --- Rifleman squad (M7) ---------------------------------------------------
  const RIFLEMAN_COUNT = 4; // default squad size (menu allows 0-16)
  const RIFLEMAN_MAX = 16; // max riflemen
  const RIFLEMAN_RESPAWN_DELAY = 3; // s before a downed rifleman reappears

  // --- Garage base (M5) ------------------------------------------------------
  const BASE_HALF = 20; // m; the pad is 40 x 40 centered on the spawn point
  const BASE_REPAIR_RATE = 20; // HP/s while the player tank is inside (player only)
  // The ground is flattened over a region this much larger than the pad, one
  // full terrain cell beyond each edge (== TERRAIN_CELL). The coarse mesh grid
  // then has no vertex inside the blend ramp under the decal, so no z-fighting.
  const FLAT_MARGIN = 18.75;

  // --- Collisions (M5) ---------------------------------------------------------
  const TANK_RAM_RANGE = 5; // m horizontal between two tanks => collision
  const TANK_RAM_SPEED_MIN = 5; // m/s relative speed; faster deals damage
  const TANK_RAM_DMG_PER = 2; // HP per (m/s above the min), to both tanks
  const TANK_RAM_COOLDOWN = 1; // s per pair before damage may apply again
  const OBSTACLE_SPEED_MIN = 3; // m/s impact speed; faster chips HP
  const OBSTACLE_DMG = 2; // HP chipped on a hard impact with a tree/rock
  const OBSTACLE_COOLDOWN = 0.5; // s per obstacle before damage may apply again
  const TREE_FELL_SPEED = 12; // m/s; at/above this a tree in the way is felled
  const TREE_FELL_SPEED_CUT = 0.3; // fraction of speed lost plowing through
  const CAM_SHAKE_FELL = 0.15; // camera shake when the player fells a tree

  // --- Title-screen camera ---------------------------------------------------
  const ORBIT_RADIUS = 60; // m from the map center
  const ORBIT_HEIGHT = 30; // m above the ground at the map center
  const ORBIT_RATE = 0.05; // rad/s

  // --- DOM -------------------------------------------------------------------
  const canvas = document.getElementById("game");
  const compassTape = document.getElementById("compass-tape");
  const msgFeed = document.getElementById("msg-feed");
  const mutedBadge = document.getElementById("muted");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayText = document.getElementById("overlay-text");
  const overlayBtn = document.getElementById("overlay-btn");
  const scoreboard = document.getElementById("scoreboard");
  const scoreboardBody = document.getElementById("scoreboard-body");
  const cpuControl = document.getElementById("cpu-control");
  const cpuLabel = document.getElementById("cpu-label");
  const cpuCountEl = document.getElementById("cpu-count");
  const cpuMinus = document.getElementById("cpu-minus");
  const cpuPlus = document.getElementById("cpu-plus");
  const rifleControl = document.getElementById("rifle-control");
  const rifleLabel = document.getElementById("rifle-label");
  const rifleCountEl = document.getElementById("rifle-count");
  const rifleMinus = document.getElementById("rifle-minus");
  const riflePlus = document.getElementById("rifle-plus");
  const musicCountEl = document.getElementById("music-count");
  const musicMinus = document.getElementById("music-minus");
  const musicPlus = document.getElementById("music-plus");
  const sfxCountEl = document.getElementById("sfx-count");
  const sfxMinus = document.getElementById("sfx-minus");
  const sfxPlus = document.getElementById("sfx-plus");
  const timeToggle = document.getElementById("time-toggle");
  const hudCombat = document.getElementById("hud-combat");
  const hpFill = document.getElementById("hpfill");
  const hudSpeed = document.getElementById("hud-speed");
  const hudHeading = document.getElementById("hud-heading");
  const hudKills = document.getElementById("hud-kills");
  const hudScore = document.getElementById("hud-score");
  const hudShell = document.getElementById("hud-shell");
  const crosshair = document.getElementById("crosshair");
  const gunHeat = document.getElementById("gun-heat");
  const gunHeatFill = document.getElementById("gun-heat-fill");
  const overheat = document.getElementById("overheat");
  const garageHint = document.getElementById("garage-hint");

  // --- Message feed ----------------------------------------------------------
  const MSG_LIFE_MS = 5000; // matches the msg-fade animation
  const MSG_MAX = 6;

  /** Post a message to the feed (bottom-left); it fades out on its own. */
  function addMessage(text) {
    const el = document.createElement("div");
    el.className = "msg";
    el.textContent = text;
    msgFeed.appendChild(el);
    while (msgFeed.children.length > MSG_MAX) msgFeed.firstChild.remove();
    setTimeout(() => el.remove(), MSG_LIFE_MS);
  }

  // --- Renderer --------------------------------------------------------------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (err) {
    overlayTitle.textContent = "WEBGL UNAVAILABLE";
    overlayText.textContent = "This game needs WebGL, which is not available in this browser.";
    overlayBtn.style.display = "none";
    return {};
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // --- Scene -----------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xc9dff5, 450, 2300);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 6000);

  // Sky dome (gradient shader, unaffected by fog). Stars are procedural: a
  // 3D grid over the direction sphere, a random subset of cells holds one
  // small dot. uStars fades them in for night mode (0 = day, 1 = night).
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4200, 32, 15),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x2f74c9) },
        bottom: { value: new THREE.Color(0xc9dff5) },
        uStars: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 top;
        uniform vec3 bottom;
        uniform float uStars;
        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.55));
          if (uStars > 0.001 && vDir.y > 0.02) {
            float grid = 100.0;
            vec3 id = floor(vDir * grid);
            float rnd = hash13(id);
            if (rnd > 0.96) {
              vec3 jit = vec3(hash13(id + 17.3), hash13(id + 29.7), hash13(id + 41.1)) - 0.5;
              vec3 starDir = normalize((id + 0.5 + jit * 0.8) / grid);
              float d = distance(vDir, starDir);
              float size = 0.0012 + 0.0018 * hash13(id + 53.9);
              float bright = 0.35 + 0.65 * hash13(id + 67.7);
              col += vec3(0.85, 0.9, 1.0) * smoothstep(size, 0.0, d) * bright
                   * uStars * smoothstep(0.0, 0.12, vDir.y);
            }
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  scene.add(sky);

  // Lights.
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b5f4a, 0.75);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dc, 1.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -140;
  sun.shadow.camera.right = 140;
  sun.shadow.camera.top = 140;
  sun.shadow.camera.bottom = -140;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 700;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);
  const _sunOffset = new THREE.Vector3(120, 170, -90);

  // --- Day / night -----------------------------------------------------------
  // Two palettes; nightMix (0 = day, 1 = night) eases toward the selected
  // mode and the environment (sky, fog, lights, edge fade, clouds, stars) is
  // re-blended each frame while the transition is in flight.
  const ENV_DAY = {
    skyTop: new THREE.Color(0x2f74c9),
    horizon: new THREE.Color(0xc9dff5), // fog + sky horizon + edge-fade color
    fogNear: 450,
    fogFar: 2300,
    hemiSky: new THREE.Color(0xcfe8ff),
    hemiGround: new THREE.Color(0x6b5f4a),
    hemiIntensity: 0.75,
    sunColor: new THREE.Color(0xfff2dc),
    sunIntensity: 1.15,
    stars: 0,
    cloudTint: new THREE.Color(0xffffff),
  };
  const ENV_NIGHT = {
    skyTop: new THREE.Color(0x0a1026),
    horizon: new THREE.Color(0x131a2c),
    fogNear: 300,
    fogFar: 1500,
    hemiSky: new THREE.Color(0x22304a),
    hemiGround: new THREE.Color(0x0e1013),
    hemiIntensity: 0.3,
    sunColor: new THREE.Color(0x9db4d6), // moonlight
    sunIntensity: 0.25,
    stars: 1,
    cloudTint: new THREE.Color(0x59637a),
  };
  let nightMode = false; // initialized from saved settings below
  let nightMix = 0;
  let clouds = null;
  const _envTop = new THREE.Color();
  const _envHorizon = new THREE.Color();
  const _envHemiSky = new THREE.Color();
  const _envHemiGround = new THREE.Color();
  const _envSun = new THREE.Color();
  const _envCloud = new THREE.Color();

  /** Blend the whole environment between the two palettes at mix t (0..1). */
  function applyEnvironment(t) {
    sky.material.uniforms.top.value.copy(_envTop.copy(ENV_DAY.skyTop).lerp(ENV_NIGHT.skyTop, t));
    sky.material.uniforms.bottom.value.copy(_envHorizon.copy(ENV_DAY.horizon).lerp(ENV_NIGHT.horizon, t));
    sky.material.uniforms.uStars.value = lerp(ENV_DAY.stars, ENV_NIGHT.stars, t);
    scene.fog.color.copy(_envHorizon);
    scene.fog.near = lerp(ENV_DAY.fogNear, ENV_NIGHT.fogNear, t);
    scene.fog.far = lerp(ENV_DAY.fogFar, ENV_NIGHT.fogFar, t);
    hemi.color.copy(_envHemiSky.copy(ENV_DAY.hemiSky).lerp(ENV_NIGHT.hemiSky, t));
    hemi.groundColor.copy(_envHemiGround.copy(ENV_DAY.hemiGround).lerp(ENV_NIGHT.hemiGround, t));
    hemi.intensity = lerp(ENV_DAY.hemiIntensity, ENV_NIGHT.hemiIntensity, t);
    sun.color.copy(_envSun.copy(ENV_DAY.sunColor).lerp(ENV_NIGHT.sunColor, t));
    sun.intensity = lerp(ENV_DAY.sunIntensity, ENV_NIGHT.sunIntensity, t);
    EDGE_FADE.color.copy(_envHorizon);
    if (terrain) terrain.fadeColor.copy(_envHorizon);
    if (clouds) clouds.tint(_envCloud.copy(ENV_DAY.cloudTint).lerp(ENV_NIGHT.cloudTint, t));
  }

  /** Toggle day/night from the menu. The environment eases over ~1 s. */
  function setNightMode(on) {
    nightMode = !!on;
    timeToggle.textContent = nightMode ? "NIGHT" : "DAY";
    saveSettings();
  }

  // --- World -----------------------------------------------------------------
  let terrain = null;
  let scenery = null;
  // Where the action is: the spawn point while ready, the player tank once playing.
  const focus = new THREE.Vector3();

  // --- Garage base (M5) --------------------------------------------------------
  // The repair pad: a flat 40 x 40 m rectangle centered on the spawn point.
  const BASE = { x0: -BASE_HALF, x1: BASE_HALF, z0: -BASE_HALF, z1: BASE_HALF, y: 0 };
  let inGarage = false; // the player tank is inside the pad (hint + repair)

  // Player tank + chase camera + controller (M2). `ctx` is extended in M4.
  let tank = null;
  let chaseCam = null;
  let playerController = null;
  let ctx = null;

  // --- Combat (M3) -----------------------------------------------------------
  let tracers = null;
  let shells = null;
  let debris = null; // M5: pooled tank-shaped wreck pieces
  let flashes = null;
  const smokes = [];
  let mgCooldown = 0; // s until the next MG shot may fire
  let gunTemp = 0; // gun temperature, 0..GUN_MAX_TEMP
  let gunOverheated = false; // latched at GUN_MAX_TEMP until temp cools to 0
  let gunHeatShown = false; // bar appears at 50% temp, stays visible until temp is 0
  let overheatWarned = false; // latched while the OVERHEAT warning is showing (beep on appear)
  let shellReload = 0; // s until the shell is ready again (0 = READY)
  let kills = 0;
  let damageDealt = 0; // total HP the player has dealt (score)
  let rifleKills = 0; // squad tally: one "RIFLEMEN" row on the scoreboard
  let rifleDamage = 0;
  let fleet = []; // M4: [{ tank, ai, respawnTimer }]
  let rifleFleet = []; // M7: [{ unit, ai, respawnTimer }]
  const felledTrees = []; // trees felled this run (restored on restart)
  // Scoreboard tallies for AI shooters: keyed by the Tank object, which
  // persists across respawns (the same object is reset, not rebuilt).
  const shooterStats = new Map(); // Tank -> { kills, damage }
  let distance = 0; // meters driven this run (game-over text, M5)
  let destroyReason = ""; // how the player was destroyed (M5)
  let overlayDelay = 0; // s until the destroyed overlay appears
  const _muzzle = new THREE.Vector3();
  const _barrel = new THREE.Vector3();
  const _aimPt = new THREE.Vector3();
  const _smokePt = new THREE.Vector3();
  const _foliagePt = new THREE.Vector3(); // felled-tree burst point (mid-trunk)
  const _prevPos = new THREE.Vector3(); // position before a tank's movement step (M5)
  const _obHits = []; // scenery items overlapping a tank (M5, reused per call)

  /** Build the world ONCE: terrain, the garage pad, trees, rocks, clouds,
   *  and the player tank. */
  function buildWorld() {
    // Hardcode a seed here to reproduce the identical map (e.g. `12345`).
    const seed = randomSeed();
    terrain = new Terrain(seed, scene);
    // Garage base (M5): flatten the pad to the average ground height
    // underneath it, then rebuild the mesh (the constructor's initial build
    // predates the flat zone).
    let sum = 0;
    const SAMPLES = 7;
    for (let i = 0; i < SAMPLES; i++)
      for (let j = 0; j < SAMPLES; j++) {
        const x = lerp(BASE.x0, BASE.x1, i / (SAMPLES - 1));
        const z = lerp(BASE.z0, BASE.z1, j / (SAMPLES - 1));
        sum += terrain.heightAt(x, z);
      }
    BASE.y = sum / (SAMPLES * SAMPLES);
    // Flatten a region FLAT_MARGIN larger than the pad (see FLAT_MARGIN);
    // the repair BASE rectangle and the decal stay exactly the pad size.
    terrain.flatZones.push({
      x0: BASE.x0 - FLAT_MARGIN, x1: BASE.x1 + FLAT_MARGIN,
      z0: BASE.z0 - FLAT_MARGIN, z1: BASE.z1 + FLAT_MARGIN,
      y: BASE.y,
    });
    terrain.rebuild();
    scenery = new Scenery(scene);
    scenery.add({ mesh: makeBaseDecal(BASE.y) });
    clouds = new Clouds(scenery, 36);
    // Keep trees/rocks off the garage pad (25 m margin beyond the pad edges).
    const keepOut = {
      x0: BASE.x0 - 25, x1: BASE.x1 + 25,
      z0: BASE.z0 - 25, z1: BASE.z1 + 25,
    };
    new Trees(scenery, terrain, seed, keepOut);
    new Rocks(scenery, terrain, seed, keepOut);
    focus.set(0, terrain.heightAt(0, 0), 0);

    tank = new Tank(scene, { livery: 0x8a8f94 });
    tank.team = "player";
    tank.callsign = "YOU";
    chaseCam = new ChaseCamera(camera);
    playerController = new PlayerController();
    ctx = { player: tank, tanks: [tank], units: [tank], terrain };
    tracers = new Tracers(scene);
    shells = new Shells(scene);
    debris = new Debris(scene);
    flashes = new MuzzleFlashes(scene);
    // Both weapons share the same kill/damage attribution (M4: the AI fleet
    // feeds the same tallies; the player's shots never hit the player).
    tracers.onKill = shells.onKill = (owner, victim) => {
      if (victim === tank) {
        destroyReason = "You were shot down by " + owner.callsign + ".";
        return; // death itself is handled via !tank.alive below
      }
      const slot = fleet.find((s) => s.tank === victim);
      if (slot) {
        destroyAiTank(slot, owner);
        return;
      }
      const rslot = rifleFleet.find((s) => s.unit === victim);
      if (rslot) destroyRifleman(rslot, owner);
    };
    tracers.onDamage = shells.onDamage = recordDamage;
    spawnPlayerTank();
    // Apply the persisted counts (the player tank must exist first).
    setCpuCount(cpuCount);
    setRiflemanCount(riflemanCount);
  }

  /** Concrete pad with a yellow hazard border and painted "GARAGE" text,
   *  painted on a flat canvas and laid on the (flattened) base zone. */
  function makeBaseDecal(y) {
    const S = 256; // canvas px across the pad (40 m)
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const PXM = S / (BASE_HALF * 2); // px per meter
    g.fillStyle = "#5a5c60"; // concrete
    g.fillRect(0, 0, S, S);
    // Subtle mottling.
    for (let i = 0; i < 260; i++) {
      g.fillStyle = "rgba(255,255,255," + (0.015 + Math.random() * 0.03) + ")";
      g.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 6, 1 + Math.random() * 3);
    }
    // Yellow hazard border band around the pad edge.
    const BW = 2.5 * PXM; // border width (2.5 m)
    g.fillStyle = "#d8b32a";
    g.fillRect(0, 0, S, BW);
    g.fillRect(0, S - BW, S, BW);
    g.fillRect(0, 0, BW, S);
    g.fillRect(S - BW, 0, BW, S);
    // Diagonal black hazard stripes over the border band only.
    g.save();
    g.beginPath();
    g.rect(0, 0, S, BW);
    g.rect(0, S - BW, S, BW);
    g.rect(0, 0, BW, S);
    g.rect(S - BW, 0, BW, S);
    g.clip();
    g.fillStyle = "#1e1f22";
    const stripe = 8 * PXM; // stripe period along the edge
    for (let d = -S; d < S * 2; d += stripe * 2) {
      g.beginPath();
      g.moveTo(d, 0);
      g.lineTo(d + stripe, 0);
      g.lineTo(d + stripe - S, S);
      g.lineTo(d - S, S);
      g.closePath();
      g.fill();
    }
    g.restore();
    // Painted "GARAGE" text.
    g.fillStyle = "#e8e6df";
    g.font = "700 " + Math.floor(6 * PXM) + "px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("GARAGE", S / 2, S / 2);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    // Decal sits 0.05 m above the flattened ground so it wins the depth test
    // up close; polygonOffset additionally biases its depth toward the camera
    // so it also wins at range, where the 0.05 m gap is sub-pixel.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(BASE_HALF * 2, BASE_HALF * 2).rotateX(-Math.PI / 2),
      mat
    );
    mesh.position.set(0, y + 0.05, 0);
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Pick a spawn heading that faces the flattest drivable ground. */
  function spawnYaw() {
    let bestYaw = 0;
    let bestSlope = Infinity;
    for (let i = 0; i < 8; i++) {
      const yaw = (i / 8) * TAU;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const slope =
        (terrain.heightAt(fx * SLOPE_AHEAD, fz * SLOPE_AHEAD) -
          terrain.heightAt(0, 0)) /
        SLOPE_AHEAD;
      if (Math.abs(slope) < Math.abs(bestSlope)) {
        bestSlope = slope;
        bestYaw = yaw;
      }
    }
    return bestYaw;
  }

  /** Place the player tank at the spawn point and snap the chase camera.
   *  Also resets the combat state (M3) and clears all in-flight effects. */
  function spawnPlayerTank() {
    tank.reset(0, 0, spawnYaw(), terrain);
    chaseCam.snap(tank);
    focus.copy(tank.position);
    mgCooldown = 0;
    gunTemp = 0;
    gunOverheated = false;
    gunHeatShown = false;
    overheatWarned = false;
    shellReload = 0;
    kills = 0;
    damageDealt = 0;
    rifleKills = 0;
    rifleDamage = 0;
    distance = 0;
    destroyReason = "";
    overlayDelay = 0;
    shooterStats.clear();
    tracers.clear();
    shells.clear();
    debris.clear();
    flashes.clear();
    clearSmokes();
  }

  // --- AI fleet (M4) ---------------------------------------------------------
  /** Remove a Tank's mesh from the scene and free its GPU resources. */
  function disposeTank(t) {
    if (!t) return;
    scene.remove(t.group);
    t.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }

  /** Find a drivable spawn point 400-800 m from the player: the ground there
    *  must be flatter than the slope limit (retry sampling until it is). */
  function findAiSpawn() {
    for (let i = 0; i < 24; i++) {
      const ang = Math.random() * TAU;
      const dist = 400 + Math.random() * 400;
      const x = tank.position.x + Math.cos(ang) * dist;
      const z = tank.position.z + Math.sin(ang) * dist;
      const h0 = terrain.heightAt(x, z);
      let ok = true;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        const slope =
          (terrain.heightAt(x + Math.cos(a) * SLOPE_AHEAD, z + Math.sin(a) * SLOPE_AHEAD) - h0) /
          SLOPE_AHEAD;
        if (Math.abs(slope) > SLOPE_TAN) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, z };
    }
    // The map is mostly drivable; fall back to the last sample.
    const ang = Math.random() * TAU;
    const dist = 400 + Math.random() * 400;
    return { x: tank.position.x + Math.cos(ang) * dist, z: tank.position.z + Math.sin(ang) * dist };
  }

  /** Spawn a hostile CPU tank 400-800 m from the player, facing it. */
  function spawnAiTank(livery) {
    const p = findAiSpawn();
    const t = new Tank(scene, { livery });
    // Unique team per CPU so their tracers/shells hit each other (friendly
    // fire); the shared weapon pools only skip same-team targets.
    t.team = "cpu" + (fleet.length + 1);
    t.callsign = CPU_NAMES[livery];
    // Nose (-sin(yaw), 0, -cos(yaw)) should point at the player.
    const yaw = Math.atan2(-(tank.position.x - p.x), -(tank.position.z - p.z));
    t.reset(p.x, p.z, yaw, terrain);
    fleet.push({ tank: t, ai: new TankAI(), respawnTimer: 0 });
  }

  /** Get (creating if needed) the scoreboard tally for an AI shooter. */
  function shooterStatsFor(shooter) {
    let s = shooterStats.get(shooter);
    if (!s) {
      s = { kills: 0, damage: 0 };
      shooterStats.set(shooter, s);
    }
    return s;
  }

  /** A CPU tank was destroyed: hide it, debris burst + boom, start respawn. */
  function destroyAiTank(slot, killer) {
    const cp = slot.tank;
    if (slot.respawnTimer > 0) return; // already destroyed, respawn pending
    cp.alive = false;
    cp.hp = 0;
    cp.group.visible = false;
    const dist = cp.position.distanceTo(tank.position);
    debris.spawn(cp.position, cp.velocity);
    spawnSmoke(cp.position);
    EngineAudio.crash(dist);
    slot.respawnTimer = CPU_RESPAWN_DELAY;
    slot.ai.reset();
    if (killer === tank) {
      kills++;
      addMessage("You destroyed " + cp.callsign);
    } else {
      shooterStatsFor(killer).kills++;
      addMessage(killer.callsign + " destroyed " + cp.callsign);
    }
  }

  /** Bring a downed CPU back at a new spawn point (same Tank object). */
  function respawnAiTank(slot) {
    const p = findAiSpawn();
    const yaw = Math.atan2(-(tank.position.x - p.x), -(tank.position.z - p.z));
    slot.tank.group.visible = true;
    slot.tank.reset(p.x, p.z, yaw, terrain);
    slot.ai.reset();
  }

  /** Grow/shrink the fleet to `n` tanks (0 = training mode, a peaceful map).
    *  Called from the menu (before a run) and on the title screen. */
  function setFleetCount(n) {
    n = clamp(Math.round(n), 0, CPU_LIVERIES.length);
    while (fleet.length > n) {
      disposeTank(fleet.pop().tank);
    }
    while (fleet.length < n) {
      spawnAiTank(CPU_LIVERIES[fleet.length % CPU_LIVERIES.length]);
    }
    return n;
  }

  /** Respawn the whole fleet at fresh points (restart). */
  function respawnFleet() {
    for (const slot of fleet) {
      slot.respawnTimer = 0;
      respawnAiTank(slot);
    }
  }

  // --- Rifleman squad (M7) ---------------------------------------------------
  /** Spawn a rifleman 400-800 m from the player, facing it (walks in on foot). */
  function spawnRifleman() {
    const p = findAiSpawn();
    const u = new Rifleman(scene, { uniform: RIFLEMAN_UNIFORMS[rifleFleet.length % RIFLEMAN_UNIFORMS.length] });
    u.callsign = "RIFLEMAN " + (rifleFleet.length + 1);
    // Body front (-sin(yaw), 0, -cos(yaw)) should point at the player.
    const yaw = Math.atan2(-(tank.position.x - p.x), -(tank.position.z - p.z));
    u.reset(p.x, p.z, yaw, terrain);
    rifleFleet.push({ unit: u, ai: new RiflemanAI(), respawnTimer: 0 });
  }

  /** A rifleman was killed: hide him, smoke burst, start the respawn timer. */
  function destroyRifleman(slot, killer) {
    const r = slot.unit;
    if (slot.respawnTimer > 0) return; // already down, respawn pending
    r.alive = false;
    r.hp = 0;
    r.group.visible = false;
    const dist = r.position.distanceTo(tank.position);
    spawnSmoke(r.position, {
      count: 20, size: 1.4, color: 0x4a4a4a, opacity: 0.7, life: 1.6,
      sx: 0.8, sy: 0.8, sz: 0.8, vh: 3, vyLo: 1, vyHi: 3,
    });
    EngineAudio.crash(dist);
    slot.respawnTimer = RIFLEMAN_RESPAWN_DELAY;
    slot.ai.reset();
    if (killer === tank) {
      kills++;
      addMessage("You killed " + r.callsign);
    } else if (killer) {
      if (killer.team === "riflemen") rifleKills++;
      else shooterStatsFor(killer).kills++;
      addMessage(killer.callsign + " killed " + r.callsign);
    }
  }

  /** Bring a downed rifleman back at a fresh spawn point (same object). */
  function respawnRifleman(slot) {
    const p = findAiSpawn();
    const yaw = Math.atan2(-(tank.position.x - p.x), -(tank.position.z - p.z));
    slot.unit.reset(p.x, p.z, yaw, terrain);
    slot.ai.reset();
  }

  /** Grow/shrink the squad to `n` riflemen (0 = none). Called from the menu
   *  and on the title screen; the squad is adjusted live. */
  function setRiflemanCount(n) {
    n = clamp(Math.round(n), 0, RIFLEMAN_MAX);
    while (rifleFleet.length > n) {
      const slot = rifleFleet.pop();
      scene.remove(slot.unit.group);
      slot.unit.group.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    }
    while (rifleFleet.length < n) spawnRifleman();
    riflemanCount = rifleFleet.length;
    rifleCountEl.textContent = riflemanCount;
    rifleLabel.textContent = "RIFLEMEN";
    rifleMinus.disabled = riflemanCount <= 0;
    riflePlus.disabled = riflemanCount >= RIFLEMAN_MAX;
    saveSettings();
    return riflemanCount;
  }

  /** Respawn the whole squad at fresh points (restart). */
  function respawnRifleFleet() {
    for (const slot of rifleFleet) {
      slot.respawnTimer = 0;
      respawnRifleman(slot);
    }
  }

  /** Tank vs rifleman: a moving tank that overlaps a rifleman runs him over
   *  (unarmored physical damage, per-pair cooldown); the rifleman is pushed
   *  clear of the hull so he can route around it. */
  function runOverRiflemen(tanks, riflemen) {
    for (const t of tanks) {
      if (!t.alive) continue;
      for (const r of riflemen) {
        if (!r.alive) continue;
        const dx = r.position.x - t.position.x;
        const dz = r.position.z - t.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= TANK_RAM_RANGE) continue;
        // Push the rifleman to the edge of the hull's space (he yields).
        if (d > 1e-3) {
          r.position.x = t.position.x + (dx / d) * TANK_RAM_RANGE;
          r.position.z = t.position.z + (dz / d) * TANK_RAM_RANGE;
        } else {
          r.position.x = t.position.x + TANK_RAM_RANGE;
        }
        r.group.position.copy(r.position);
        // Only a moving tank deals damage (per-pair cooldown).
        if (Math.abs(t.speed) < 2) continue;
        t._roCd = t._roCd || new Map();
        const cd = t._roCd.get(r);
        if (cd !== undefined && cd > 0) continue;
        t._roCd.set(r, TANK_RAM_COOLDOWN);
        const raw = Math.round(10 + Math.abs(t.speed) * 2);
        const dealt = r.takeDamage(raw);
        if (dealt > 0) recordDamage(t, r, dealt);
        if (dealt > 0 && r.hp <= 0) {
          const slot = rifleFleet.find((s) => s.unit === r);
          if (slot) destroyRifleman(slot, t);
        }
      }
    }
  }

  /** Re-add the trees felled this run (restart keeps the same map, so the
   *  vegetation comes back). */
  function restoreFelledTrees() {
    for (const item of felledTrees) scenery.add(item);
    felledTrees.length = 0;
  }

  /** The player was destroyed: hide the tank, debris burst + big smoke +
   *  boom, shake, delayed overlay with the reason, distance, kills, score
   *  and the full scoreboard. */
  function destroyPlayer(reason) {
    state = "destroyed";
    destroyReason = reason;
    tank.alive = false;
    const finalScore = damageDealt + kills * KILL_SCORE;
    if (finalScore > bestScore) {
      bestScore = finalScore;
      saveSettings();
    }
    tank.group.visible = false;
    debris.spawn(tank.position, tank.velocity);
    spawnSmoke(tank.position, {
      count: 120, size: 3.0, color: 0x3a3a3a, opacity: 0.9, life: 3.5,
      sx: 2.5, sy: 1.5, sz: 2.5, vh: 6, vyLo: 1.5, vyHi: 7,
    });
    EngineAudio.crash(0);
    chaseCam.shake = CAM_SHAKE_DESTROYED;
    overlayDelay = OVERLAY_DELAY; // let the impact register before the panel appears
  }

  // --- Smoke ------------------------------------------------------------------
  // One burst of `THREE.Points` particles (the plane's spawnSmoke pattern).
  function spawnSmoke(pos, o = {}) {
    const N = o.count ?? 90;
    const sx = o.sx ?? 1.6, sy = o.sy ?? 1.0, sz = o.sz ?? 1.6;
    const vh = o.vh ?? 4; // horizontal velocity magnitude
    const vyLo = o.vyLo ?? 1, vyHi = o.vyHi ?? 6; // vertical velocity range
    const color = o.color ?? 0x5a5a5a;
    const size = o.size ?? 2.4;
    const opacity = o.opacity ?? 0.9;
    const life = o.life ?? 3.0;
    const positions = new Float32Array(N * 3);
    const vels = [];
    for (let i = 0; i < N; i++) {
      positions[i * 3] = pos.x + (Math.random() - 0.5) * sx;
      positions[i * 3 + 1] = pos.y + (Math.random() - 0.5) * sy;
      positions[i * 3 + 2] = pos.z + (Math.random() - 0.5) * sz;
      vels.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * vh,
          vyLo + Math.random() * (vyHi - vyLo),
          (Math.random() - 0.5) * vh
        )
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);
    smokes.push({ points, vels, life, maxLife: life, maxOpacity: opacity });
  }

  function updateSmoke(dt) {
    for (let i = smokes.length - 1; i >= 0; i--) {
      const smoke = smokes[i];
      smoke.life -= dt;
      const attr = smoke.points.geometry.attributes.position;
      for (let j = 0; j < smoke.vels.length; j++) {
        const v = smoke.vels[j];
        v.multiplyScalar(Math.max(0, 1 - 0.8 * dt));
        v.y += 0.5 * dt; // smoke drifts up
        attr.setXYZ(j, attr.getX(j) + v.x * dt, attr.getY(j) + v.y * dt, attr.getZ(j) + v.z * dt);
      }
      attr.needsUpdate = true;
      smoke.points.material.opacity = clamp(smoke.life / smoke.maxLife, 0, 1) * smoke.maxOpacity;
      if (smoke.life <= 0) {
        scene.remove(smoke.points);
        smoke.points.geometry.dispose();
        smoke.points.material.dispose();
        smokes.splice(i, 1);
      }
    }
  }

  /** Remove every smoke burst (used on restart). */
  function clearSmokes() {
    for (const s of smokes) {
      scene.remove(s.points);
      s.points.geometry.dispose();
      s.points.material.dispose();
    }
    smokes.length = 0;
  }

  // --- Damage smoke (M4) -------------------------------------------------------
  // While a tank's HP is low it trails smoke: light at <=50%, heavy (burning)
  // at <=20%. Puffs spawn behind the hull; the tank moves on, leaving a trail.
  function emitDamageSmoke(t, dt) {
    if (!t.alive) return;
    const ratio = t.hp / t.maxHp;
    const tier = ratio <= SMOKE_HEAVY_RATIO ? SMOKE_HEAVY
                : ratio <= SMOKE_LIGHT_RATIO ? SMOKE_LIGHT
                : null;
    if (!tier) return;
    t._smokeTimer = (t._smokeTimer || 0) + dt;
    if (t._smokeTimer < tier.interval) return;
    t._smokeTimer = 0;
    // Puff origin: behind the hull nose, at hull height.
    _smokePt.copy(t.position).addScaledVector(t.forward, -SMOKE_EMIT_OFFSET);
    spawnSmoke(_smokePt, {
      count: tier.count, size: tier.size, color: tier.color,
      opacity: tier.opacity, life: tier.life,
      sx: 0.8, sy: 0.5, sz: 0.8, vh: 1.5, vyLo: 0.5, vyHi: 2.0,
    });
  }

  // --- Dust (M6) ---------------------------------------------------------------
  // While a tank drives faster than DUST_SPEED_MIN it kicks up small tan
  // puffs behind the tracks: 3-6 particles every ~0.08 s, with the rate and
  // size scaling with speed and an extra burst on hard turns.
  function emitDust(t, dt, steer) {
    if (!t.alive) return;
    const speed = Math.abs(t.speed);
    if (speed <= DUST_SPEED_MIN) return;
    const rate = clamp(speed / MAX_SPEED_FWD, 0, 1);
    t._dustTimer = (t._dustTimer || 0) + dt;
    const interval = DUST_INTERVAL * (1.6 - 0.6 * rate); // faster at speed
    if (t._dustTimer < interval) return;
    t._dustTimer = 0;
    // Puff origin: behind the hull, on one of the track centerlines (the
    // sides alternate so the trail reads as both tracks working).
    const fwd = t.forward;
    const rx = -fwd.z, rz = fwd.x; // right vector (perpendicular to fwd)
    t._dustSide = t._dustSide === 1 ? -1 : 1;
    const off = HULL_WIDE / 2 + 0.28; // track centerline offset
    _smokePt.copy(t.position);
    _smokePt.x += fwd.x * -HULL_LEN * 0.5 + rx * off * t._dustSide;
    _smokePt.z += fwd.z * -HULL_LEN * 0.5 + rz * off * t._dustSide;
    _smokePt.y -= 0.35; // near the ground
    spawnSmoke(_smokePt, {
      count: 3 + Math.round(rate * 3), // 3-6 particles
      size: 1.2 * (0.8 + 0.5 * rate),
      color: DUST_COLOR,
      opacity: 0.45,
      life: 1.2,
      sx: 1.4, sy: 0.4, sz: 0.9,
      vh: 0.6, vyLo: 0.2, vyHi: 1.0,
    });
    // Extra burst on a hard turn at speed.
    if (Math.abs(steer) > 0.7 && speed > 8) {
      spawnSmoke(_smokePt, {
        count: 6, size: 1.6, color: DUST_COLOR,
        opacity: 0.5, life: 1.4,
        sx: 2.0, sy: 0.5, sz: 1.2,
        vh: 1.0, vyLo: 0.3, vyHi: 1.4,
      });
    }
  }

  // --- Collisions (M5) -------------------------------------------------------
  /** Credit damage to its shooter (player or AI) for the scoreboard. */
  function recordDamage(owner, victim, dealt) {
    if (owner === tank) {
      damageDealt += dealt;
    } else if (owner.team === "riflemen") {
      rifleDamage += dealt;
    } else {
      shooterStatsFor(owner).damage += dealt;
    }
    // Small camera shake when the player is hit.
    if (victim === tank && chaseCam) {
      chaseCam.shake = Math.max(chaseCam.shake, CAM_SHAKE_HIT * dealt);
    }
  }

  /** Tank vs obstacle: if the tank's new position overlaps a tree/rock,
   *  cancel the movement step (the tank stops at the obstacle) and chip a
   *  little HP on a hard impact (per-obstacle cooldown). A hard impact
   *  (>= TREE_FELL_SPEED) fells any trees in the way: the tank plows
   *  through them (with a speed cut), while rocks still stop it. */
  function blockObstacle(t, prev) {
    const hit = scenery.overlapping(t.position, COLLIDE_RADIUS, _obHits);
    if (!hit.length) return;
    const impact = Math.abs(t.speed);
    // Hard impact: fell any trees in the way (rocks stay solid).
    const felled = [];
    if (impact >= TREE_FELL_SPEED) {
      for (let i = hit.length - 1; i >= 0; i--) {
        if (hit[i].kind !== "tree") continue;
        scenery.remove(hit[i]);
        felled.push(hit[i]);
        felledTrees.push(hit[i]); // track for restoration on restart
        hit.length = i; // drop the felled tree from the hit list
      }
    }
    if (felled.length) {
      if (t === tank) chaseCam.shake = Math.max(chaseCam.shake, CAM_SHAKE_FELL);
      EngineAudio.treeThud(t.position.distanceTo(tank.position));
      for (const item of felled) {
        _foliagePt.copy(item.mesh.position);
        _foliagePt.y += 2.5; // mid-trunk: the burst reads as the tree coming apart
        debris.spawnFoliage(_foliagePt, t.velocity);
      }
      // Only felled trees in the way: plow through with a speed cut.
      if (!hit.length) t.speed *= 1 - TREE_FELL_SPEED_CUT;
    }
    if (hit.length) {
      t.position.copy(prev); // still blocked (by a rock): stop at the obstacle
      t.speed = 0;
    }
    t.group.position.copy(t.position);
    if (impact <= OBSTACLE_SPEED_MIN) return;
    t._obCd = t._obCd || new Map();
    let canChip = false;
    for (const item of hit) {
      const cd = t._obCd.get(item);
      if (cd === undefined || cd <= 0) canChip = true;
      t._obCd.set(item, OBSTACLE_COOLDOWN);
    }
    for (const item of felled) {
      const cd = t._obCd.get(item);
      if (cd === undefined || cd <= 0) canChip = true;
      t._obCd.set(item, OBSTACLE_COOLDOWN);
    }
    if (!canChip) return;
    // No kind: unarmored physical damage (armor does not stop a collision).
    if (t.takeDamage(OBSTACLE_DMG) > 0 && t.hp <= 0 && t === tank) {
      destroyReason = "You crashed into a " + (hit.length ? hit[0] : felled[0]).kind + ".";
    }
  }

  /** Tank vs tank: for each alive pair within TANK_RAM_RANGE, push the hulls
   *  apart and (per-pair cooldown) damage both by the excess approach speed. */
  function collideTanks(tanks) {
    for (let i = 0; i < tanks.length; i++) {
      for (let j = i + 1; j < tanks.length; j++) {
        const a = tanks[i], b = tanks[j];
        if (!a.alive || !b.alive) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= TANK_RAM_RANGE) continue;
        // Push apart so the hulls don't overlap.
        if (d > 1e-3) {
          const push = (TANK_RAM_RANGE - d) / 2;
          const nx = dx / d, nz = dz / d;
          a.position.x -= nx * push;
          a.position.z -= nz * push;
          b.position.x += nx * push;
          b.position.z += nz * push;
          a.group.position.copy(a.position);
          b.group.position.copy(b.position);
        } else {
          a.position.x -= TANK_RAM_RANGE / 2;
          b.position.x += TANK_RAM_RANGE / 2;
          a.group.position.copy(a.position);
          b.group.position.copy(b.position);
        }
        // Speed-based damage to both (per-pair 1 s cooldown).
        const rel = Math.hypot(
          a.velocity.x - b.velocity.x,
          a.velocity.z - b.velocity.z
        );
        const dmg = Math.max(0, (rel - TANK_RAM_SPEED_MIN) * TANK_RAM_DMG_PER);
        if (dmg <= 0) continue;
        const raw = Math.round(dmg);
        a._ramCd = a._ramCd || new Map();
        b._ramCd = b._ramCd || new Map();
        const cd = a._ramCd.get(b);
        if (cd !== undefined && cd > 0) continue;
        a._ramCd.set(b, TANK_RAM_COOLDOWN);
        b._ramCd.set(a, TANK_RAM_COOLDOWN);
        // No kind: unarmored physical damage (armor does not stop a collision).
        const dealtA = a.takeDamage(raw);
        const dealtB = b.takeDamage(raw);
        if (dealtA > 0) recordDamage(b, a, dealtA);
        if (dealtB > 0) recordDamage(a, b, dealtB);
        if (dealtA > 0 && a.hp <= 0 && a === tank) destroyReason = "You were rammed.";
        if (dealtB > 0 && b.hp <= 0 && b === tank) destroyReason = "You were rammed.";
        if (dealtA > 0 && a.hp <= 0) {
          const slot = fleet.find((s) => s.tank === a);
          if (slot) destroyAiTank(slot, b);
        }
        if (dealtB > 0 && b.hp <= 0) {
          const slot = fleet.find((s) => s.tank === b);
          if (slot) destroyAiTank(slot, a);
        }
      }
    }
  }

  /** Tick the per-obstacle, per-pair and per-rifleman collision cooldowns
   *  for a tank. */
  function tickCooldowns(t, dt) {
    if (t._obCd) {
      for (const [item, cd] of t._obCd) {
        const n = cd - dt;
        if (n <= 0) t._obCd.delete(item);
        else t._obCd.set(item, n);
      }
    }
    if (t._ramCd) {
      for (const [other, cd] of t._ramCd) {
        const n = cd - dt;
        if (n <= 0) t._ramCd.delete(other);
        else t._ramCd.set(other, n);
      }
    }
    if (t._roCd) {
      for (const [other, cd] of t._roCd) {
        const n = cd - dt;
        if (n <= 0) t._roCd.delete(other);
        else t._roCd.set(other, n);
      }
    }
  }

  // --- Persisted user settings (localStorage) --------------------------------
  // Enemy count, volumes, mute, night and best score survive a page reload.
  // Storage may be unavailable (private mode, file://, quota) — every access
  // is guarded so the game still runs, just without persistence.
  const SETTINGS_KEY = "arcadeTank.settings";
  const savedSettings = (() => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch (err) {
      return {};
    }
  })();
  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          cpuCount,
          riflemanCount,
          muted: EngineAudio.isMuted(),
          musicVol,
          sfxVol,
          night: nightMode,
          bestScore,
        })
      );
    } catch (err) {
      /* persistence unavailable: ignore */
    }
  }
  let cpuCount =
    typeof savedSettings.cpuCount === "number"
      ? clamp(Math.round(savedSettings.cpuCount), 0, CPU_MAX)
      : CPU_COUNT;
  let riflemanCount =
    typeof savedSettings.riflemanCount === "number"
      ? clamp(Math.round(savedSettings.riflemanCount), 0, RIFLEMAN_MAX)
      : RIFLEMAN_COUNT;
  nightMode = !!savedSettings.night;
  nightMix = nightMode ? 1 : 0;
  // Volumes are percentages (0-100); 100 = the original mix.
  const VOL_STEP = 10;
  let musicVol =
    typeof savedSettings.musicVol === "number"
      ? clamp(Math.round(savedSettings.musicVol), 0, 100)
      : 100;
  let sfxVol =
    typeof savedSettings.sfxVol === "number"
      ? clamp(Math.round(savedSettings.sfxVol), 0, 100)
      : 100;
  let bestScore =
    typeof savedSettings.bestScore === "number"
      ? Math.max(0, Math.round(savedSettings.bestScore))
      : 0;
  EngineAudio.setMuted(!!savedSettings.muted);
  mutedBadge.classList.toggle("hidden", !EngineAudio.isMuted());
  // Apply the persisted volumes and sync the overlay controls. (The enemy
  // count is applied in buildWorld(), once the player tank exists.)
  setMusicVolume(musicVol);
  setSfxVolume(sfxVol);

  // --- Camera ----------------------------------------------------------------
  let orbitAngle = 0; // title-screen orbit angle (rad)
  const _camPos = new THREE.Vector3();
  const _camLook = new THREE.Vector3();

  /** Title screen: orbit the map center from 30 m up. */
  function updateReadyCamera(dt) {
    orbitAngle += ORBIT_RATE * dt;
    _camPos.set(
      Math.cos(orbitAngle) * ORBIT_RADIUS,
      focus.y + ORBIT_HEIGHT,
      Math.sin(orbitAngle) * ORBIT_RADIUS
    );
    _camLook.set(0, focus.y, 0);
    camera.position.copy(_camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(_camLook);
  }

  // --- State -----------------------------------------------------------------
  let state = "ready"; // ready | playing | paused | destroyed

  /** Build the scoreboard rows (callsign / kills / score), best score first. */
  function renderScoreboard() {
    const rows = [{ name: "YOU", kills, damage: damageDealt, cls: "player" }];
    for (const slot of fleet) {
      const s = shooterStats.get(slot.tank) || { kills: 0, damage: 0 };
      rows.push({ name: slot.tank.callsign, kills: s.kills, damage: s.damage, cls: "" });
    }
    rows.push({ name: "RIFLEMEN", kills: rifleKills, damage: rifleDamage, cls: "rifle" });
    rows.forEach((r) => (r.score = r.damage + r.kills * KILL_SCORE));
    rows.sort((a, b) => b.score - a.score);
    scoreboardBody.textContent = "";
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement("tr");
      if (r.cls) tr.className = r.cls;
      const name = document.createElement("td");
      name.textContent = r.name;
      const k = document.createElement("td");
      k.className = "kills";
      k.textContent = r.kills;
      const s = document.createElement("td");
      s.className = "score";
      s.textContent = r.score;
      tr.append(name, k, s);
      frag.appendChild(tr);
    }
    scoreboardBody.appendChild(frag);
  }

  function showOverlay(title, text, btnLabel) {
    overlayTitle.textContent = title;
    overlayText.innerHTML = text;
    overlayBtn.textContent = btnLabel;
    // The count controls are only useful before a run (ready/destroyed).
    cpuControl.classList.toggle("hidden", state === "paused");
    rifleControl.classList.toggle("hidden", state === "paused");
    // The scoreboard only makes sense mid-run (paused) or after destruction.
    const showBoard = state === "paused" || state === "destroyed";
    scoreboard.classList.toggle("hidden", !showBoard);
    if (showBoard) renderScoreboard();
    overlay.classList.remove("hidden");
    Input.unlockPointer(); // overlay states run without a locked pointer
  }

  function hideOverlay() {
    overlay.classList.add("hidden");
  }

  function start() {
    const resuming = state === "paused";
    state = "playing";
    hideOverlay();
    EngineAudio.start(); // user gesture: allowed to create the AudioContext
    Music.start();
    if (!resuming) {
      Music.newFlight(); // fresh random combat track per run
      spawnPlayerTank(); // fresh tank at the spawn point
      respawnFleet(); // fresh fleet at fresh points (M4)
      respawnRifleFleet(); // fresh squad at fresh points (M7)
    }
    Input.lockPointer();
  }

  function pause() {
    state = "paused";
    showOverlay("PAUSED", "Engagement suspended. The enemy fleet will hold its fire - barely.", "Resume");
  }

  /** An unintended pointer-lock loss (Esc) auto-pauses the game. */
  function onPointerUnlock() {
    if (state === "playing") pause();
  }

  function restart() {
    // Fresh tank on the same map, fleet respawned, score reset.
    state = "playing";
    hideOverlay();
    EngineAudio.start();
    Music.start();
      Music.newFlight();
      spawnPlayerTank();
      respawnFleet();
      respawnRifleFleet();
      restoreFelledTrees();
      Input.lockPointer();
  }

  // --- Menu controls ---------------------------------------------------------
  /** Grow/shrink the enemy count (0 = training mode, a peaceful map). The
    *  fleet is adjusted live, so the title screen shows the tanks. */
  function setCpuCount(n) {
    n = clamp(Math.round(n), 0, CPU_MAX);
    cpuCount = setFleetCount(n);
    cpuCountEl.textContent = cpuCount;
    cpuLabel.textContent = cpuCount === 0 ? "TRAINING" : "ENEMIES";
    cpuMinus.disabled = cpuCount <= 0;
    cpuPlus.disabled = cpuCount >= CPU_MAX;
    saveSettings();
  }

  /** Set the music volume (0-100%). Applied live and persisted. */
  function setMusicVolume(pct) {
    pct = clamp(Math.round(pct), 0, 100);
    musicVol = pct;
    Music.setMusicVolume(pct / 100);
    musicCountEl.textContent = pct;
    musicMinus.disabled = pct <= 0;
    musicPlus.disabled = pct >= 100;
    saveSettings();
  }

  /** Set the SFX volume (0-100%): engine, gunfire and effects. */
  function setSfxVolume(pct) {
    pct = clamp(Math.round(pct), 0, 100);
    sfxVol = pct;
    EngineAudio.setSfxVolume(pct / 100);
    sfxCountEl.textContent = pct;
    sfxMinus.disabled = pct <= 0;
    sfxPlus.disabled = pct >= 100;
    saveSettings();
  }

  // --- Input -----------------------------------------------------------------
  function onKeyDown(code) {
    if (code === "KeyP" && (state === "playing" || state === "paused")) {
      if (state === "playing") pause();
      else start();
      return;
    }
    if (code === "KeyR" && state !== "ready") {
      restart();
      return;
    }
    if (code === "KeyM") {
      mutedBadge.classList.toggle("hidden", !EngineAudio.toggleMute());
      saveSettings();
      return;
    }
    if (code === "Enter" || code === "Space") {
      if (state === "ready") start();
      else if (state === "destroyed") restart();
    }
  }

  // Any title-screen click is a user gesture: unlock audio so the menu music
  // can play before the run starts.
  const unlockAudio = () => {
    EngineAudio.start();
    Music.start();
  };
  cpuMinus.addEventListener("click", () => { unlockAudio(); setCpuCount(cpuCount - 1); });
  cpuPlus.addEventListener("click", () => { unlockAudio(); setCpuCount(cpuCount + 1); });
  rifleMinus.addEventListener("click", () => { unlockAudio(); setRiflemanCount(riflemanCount - 1); });
  riflePlus.addEventListener("click", () => { unlockAudio(); setRiflemanCount(riflemanCount + 1); });
  musicMinus.addEventListener("click", () => { unlockAudio(); setMusicVolume(musicVol - VOL_STEP); });
  musicPlus.addEventListener("click", () => { unlockAudio(); setMusicVolume(musicVol + VOL_STEP); });
  sfxMinus.addEventListener("click", () => { unlockAudio(); setSfxVolume(sfxVol - VOL_STEP); });
  sfxPlus.addEventListener("click", () => { unlockAudio(); setSfxVolume(sfxVol + VOL_STEP); });
  timeToggle.addEventListener("click", () => { unlockAudio(); setNightMode(!nightMode); });

  overlayBtn.addEventListener("click", () => {
    if (state === "ready") start();
    else if (state === "paused") start();
    else if (state === "destroyed") restart();
  });

  // --- HUD -------------------------------------------------------------------
  const COMPASS_PX_PER_DEG = 2.2;

  /** Build the static compass tape once: 3 copies of the 0-360 scale so the
   *  visible window never runs out of ticks at the wraparound edges. */
  function buildCompassTape() {
    const SPAN = 1080;
    const frag = document.createDocumentFragment();
    for (let d = 0; d <= SPAN; d += 5) {
      const heading = d % 360;
      let cls = "tick";
      let label = "";
      if (d % 30 === 0) {
        cls += " major";
        if (heading === 0) label = "N";
        else if (heading === 90) label = "E";
        else if (heading === 180) label = "S";
        else if (heading === 270) label = "W";
        else label = String(heading);
      } else if (d % 15 === 0) {
        cls += " medium";
      } else {
        cls += " minor";
      }
      const tick = document.createElement("div");
      tick.className = cls;
      tick.style.left = d * COMPASS_PX_PER_DEG + "px";
      if (label) {
        const lab = document.createElement("span");
        lab.textContent = label;
        tick.appendChild(lab);
      }
      frag.appendChild(tick);
    }
    compassTape.appendChild(frag);
  }

  /** M6 HUD: HP bar, speed, heading (degrees + compass point), kills, score,
   *  shell status, MG heat bar, OVERHEAT warning, and the compass tape
   *  (driven by the hull heading). Visible while playing and after the
   *  player is destroyed (the last readout stays up under the overlay). */
  function updateHud() {
    if (state !== "playing" && state !== "destroyed") return;
    // HP bar: green above 50%, amber above 25%, red below.
    const hpPct = Math.max(0, (tank.hp / tank.maxHp) * 100);
    hpFill.style.width = hpPct + "%";
    hpFill.style.background = hpPct > 50 ? "#4caf50" : hpPct > 25 ? "#ffb300" : "#f44336";
    // Speed (km/h) and heading (degrees + compass point).
    hudSpeed.textContent = Math.round(Math.abs(tank.speed) * 3.6);
    const bearing = ((360 - THREE.MathUtils.radToDeg(tank.yaw)) % 360 + 360) % 360;
    const card = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(bearing / 45) % 8];
    hudHeading.textContent = Math.round(bearing) + "\u00B0 " + card;
    // Slide the tape so the current bearing sits under the center caret.
    const center = compassTape.parentElement.clientWidth / 2;
    compassTape.style.transform =
      "translateX(" + (center - (bearing + 360) * COMPASS_PX_PER_DEG) + "px)";
    hudKills.textContent = kills;
    hudScore.textContent = damageDealt + kills * KILL_SCORE;
    // Shell status: READY, or the reload countdown (red while reloading).
    if (shellReload > 0) {
      hudShell.textContent = shellReload.toFixed(1) + "s";
      hudShell.classList.add("empty");
    } else {
      hudShell.textContent = "READY";
      hudShell.classList.remove("empty");
    }
    // MG heat bar: appears at 50% temp, stays visible until fully cool;
    // red while the gun is locked out.
    if (gunTemp >= 50) gunHeatShown = true;
    else if (gunTemp <= 0) gunHeatShown = false;
    gunHeat.classList.toggle("hidden", !(state === "playing" && gunHeatShown));
    const heatPct = (gunTemp / GUN_MAX_TEMP) * 100;
    gunHeatFill.style.width = heatPct + "%";
    gunHeatFill.style.background = gunOverheated ? "#f44336" : heatPct > 75 ? "#ff5722" : "#ffb300";
    // OVERHEAT warning: a beep the moment it appears.
    const overheating = state === "playing" && gunOverheated;
    overheat.classList.toggle("hidden", !overheating);
    if (overheating && !overheatWarned) EngineAudio.warnBeep();
    overheatWarned = overheating;
  }

  /** Project the barrel direction (the true line of fire) onto the screen. */
  function updateCrosshair() {
    if (state !== "playing") {
      crosshair.classList.add("hidden");
      return;
    }
    _aimPt.copy(tank.position).addScaledVector(tank.barrelDir(_barrel), 1000).project(camera);
    if (_aimPt.z > 1) {
      crosshair.classList.add("hidden");
      return;
    }
    crosshair.classList.remove("hidden");
    const x = ((_aimPt.x + 1) / 2) * canvas.clientWidth;
    const y = ((1 - _aimPt.y) / 2) * canvas.clientHeight;
    crosshair.style.transform = "translate3d(" + x + "px," + y + "px,0)";
  }

  // --- Main loop ---------------------------------------------------------------
  let last = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (state === "playing") {
      // All alive tanks (player + fleet): the weapon pools and the AI share
      // this list for hit tests and targeting.
      const aliveTanks = [tank];
      for (const slot of fleet) if (slot.tank.alive) aliveTanks.push(slot.tank);
      ctx.tanks = aliveTanks;
      // All alive units (tanks + riflemen): the weapon pools hit-test this
      // list, so tracers and shell splashes reach the infantry too.
      const aliveRiflemen = [];
      for (const slot of rifleFleet) if (slot.unit.alive) aliveRiflemen.push(slot.unit);
      ctx.units = aliveTanks.concat(aliveRiflemen);

      // Player: keyboard + mouse -> control -> physics.
      const control = playerController.update(dt, tank, ctx);
      _prevPos.copy(tank.position);
      tank.update(dt, control, terrain);
      blockObstacle(tank, _prevPos);
      emitDamageSmoke(tank, dt);
      emitDust(tank, dt, control.steer);
      tickCooldowns(tank, dt);
      focus.copy(tank.position);

      // Garage (M5): while the player's center is inside the pad, repair over
      // time (player only; AI tanks drive through it unchanged).
      inGarage =
        tank.alive &&
        tank.position.x > BASE.x0 && tank.position.x < BASE.x1 &&
        tank.position.z > BASE.z0 && tank.position.z < BASE.z1;
      if (inGarage && tank.hp < tank.maxHp) {
        tank.hp = Math.min(tank.maxHp, tank.hp + BASE_REPAIR_RATE * dt);
      }

      // MG: hold LMB/Space. Sustained fire heats the gun; at GUN_MAX_TEMP it
      // overheates and cannot fire until fully cool.
      mgCooldown -= dt;
      if (control.firing && mgCooldown <= 0 && !gunOverheated) {
        mgCooldown = MG_FIRE_INTERVAL;
        gunTemp = Math.min(GUN_MAX_TEMP, gunTemp + GUN_HEAT_PER_SHOT);
        if (gunTemp >= GUN_MAX_TEMP) gunOverheated = true;
        tracers.fire(tank, tank.muzzleWorld(_muzzle), tank.barrelDir(_barrel), MG_DAMAGE_PLAYER);
        flashes.flash(_muzzle);
        EngineAudio.mgFire(0);
      }
      if (!control.firing || gunOverheated) {
        gunTemp = Math.max(0, gunTemp - GUN_COOL_RATE * dt);
        if (gunOverheated && gunTemp <= 0) gunOverheated = false;
      }

      // Main gun: hold RMB/X. One shell in the breech; it reloads over
      // SHELL_RELOAD, so holding the button fires again once it is ready.
      shellReload = Math.max(0, shellReload - dt);
      if (control.shellFiring && shellReload <= 0) {
        if (shells.fire(tank, tank.muzzleWorld(_muzzle), tank.barrelDir(_barrel))) {
          shellReload = SHELL_RELOAD;
          flashes.flash(_muzzle);
          EngineAudio.shellLaunch(0);
          chaseCam.shake = Math.max(chaseCam.shake, CAM_SHAKE_FIRE);
        }
      }

      // AI fleet: AI -> physics -> firing -> respawn (M4).
      for (const slot of fleet) {
        const cp = slot.tank;
        if (!cp.alive) {
          slot.respawnTimer -= dt;
          if (slot.respawnTimer <= 0) respawnAiTank(slot);
          continue;
        }
        const ac = slot.ai.update(dt, cp, ctx);
        _prevPos.copy(cp.position);
        cp.update(dt, ac, terrain);
        blockObstacle(cp, _prevPos);
        emitDamageSmoke(cp, dt);
        emitDust(cp, dt, ac.steer);
        tickCooldowns(cp, dt);
        if (ac.firing) {
          tracers.fire(cp, cp.muzzleWorld(_muzzle), cp.barrelDir(_barrel), MG_DAMAGE_AI);
          flashes.flash(_muzzle);
          EngineAudio.mgFire(cp.position.distanceTo(tank.position));
        }
        // Rare AI shells: unguided splash on a ballistic arc (dir from the AI).
        if (ac.shellFiring) {
          if (shells.fire(cp, cp.muzzleWorld(_muzzle), slot.ai.shellDir)) {
            flashes.flash(_muzzle);
            EngineAudio.shellLaunch(cp.position.distanceTo(tank.position));
          }
        }
      }

      // Rifleman squad: AI -> physics -> burst fire (M7).
      for (const slot of rifleFleet) {
        const r = slot.unit;
        if (!r.alive) {
          slot.respawnTimer -= dt;
          if (slot.respawnTimer <= 0) respawnRifleman(slot);
          continue;
        }
        const rc = slot.ai.update(dt, r, ctx);
        _prevPos.copy(r.position);
        r.update(dt, rc, terrain);
        blockObstacle(r, _prevPos);
        if (!r.alive) destroyRifleman(slot, null); // e.g. died to obstacle chip damage
        if (rc.firing && r.alive) {
          tracers.fire(r, r.muzzleWorld(_muzzle), slot.ai.aimDir, MG_DAMAGE_AI);
          flashes.flash(_muzzle);
          EngineAudio.mgFire(r.position.distanceTo(tank.position));
        }
      }

      // Tank vs tank: push apart + speed-based damage to both (M5).
      collideTanks(ctx.tanks);

      // Tank vs rifleman: a moving tank runs over the infantry (M7).
      runOverRiflemen(ctx.tanks, aliveRiflemen);

      if (state === "playing") {
        // Tracers: integrate, collide, damage.
        tracers.update(dt, ctx.units, terrain);

        // Shells: integrate (arc), detonate (splash), boom + blast effect.
        shells.update(dt, ctx.units, terrain, (pos) => {
          EngineAudio.shellBoom(pos.distanceTo(tank.position));
          flashes.flash(pos);
          spawnSmoke(pos, {
            count: 26, size: 2.6, color: 0x3a3a3a, opacity: 0.85, life: 1.4,
            sx: 2.5, sy: 1.5, sz: 2.5, vh: 9, vyLo: 1, vyHi: 5,
          });
        });

        // Player destroyed? (the reason was set by the killer: gunfire,
        // a ram, or an obstacle).
        if (!tank.alive) destroyPlayer(destroyReason || "You were destroyed.");
      }

      if (state === "playing") {
        distance += Math.abs(tank.speed) * dt;
        chaseCam.update(dt, tank);
        terrain.update(focus);
        scenery.update(dt, focus);
      }
    } else if (state === "destroyed") {
      // Frozen: keep the last camera, let the world stay alive, and show the
      // overlay once the impact has registered.
      scenery.update(dt, tank.position);
      chaseCam.update(dt, tank);
      if (overlayDelay > 0) {
        overlayDelay -= dt;
        if (overlayDelay <= 0) {
          const km = (distance / 1000).toFixed(1);
          const score = damageDealt + kills * KILL_SCORE;
          showOverlay(
            "DESTROYED",
            destroyReason +
              "<br />You drove " +
              km +
              " km. Kills: " +
              kills +
              ". Score: " +
              score +
              ".",
            "Drive again (R)"
          );
        }
      }
    } else if (state === "ready") {
      // Idle scene: world gently alive, camera orbiting the map center.
      updateReadyCamera(dt);
      terrain.update(focus);
      scenery.update(dt, focus);
    } else if (state === "paused") {
      // Frozen: keep the last camera, but let the sky/fog keep blending.
    }

    // Sun (and its shadow camera) follows the focus point.
    sun.position.copy(focus).add(_sunOffset);
    sun.target.position.copy(focus);

    // Ease day/night toward the selected mode; re-blend the environment
    // each frame while the transition is in flight.
    {
      const target = nightMode ? 1 : 0;
      if (nightMix !== target) {
        nightMix += (target - nightMix) * Math.min(1, dt * 2.5);
        if (Math.abs(nightMix - target) < 0.002) nightMix = target;
        applyEnvironment(nightMix);
      }
    }

    EngineAudio.update(dt, tank, state, state === "playing" ? playerController.control.throttle : 0);
    Music.update(dt, state);

    // Effects + HUD (M6: visible while playing and after destruction).
    hudCombat.classList.toggle("hidden", !(state === "playing" || state === "destroyed"));
    updateSmoke(dt);
    debris.update(dt, terrain);
    flashes.update(dt);
    updateHud();
    updateCrosshair();
    // Garage hint: visible while the player tank is inside the pad (M5).
    garageHint.classList.toggle("hidden", !(state === "playing" && inGarage));

    // Keep the sky dome centered on the camera; otherwise its far side gets
    // clipped by the far plane once the camera moves farther than
    // (far - radius) from the origin, showing the black clear color.
    sky.position.copy(camera.position);
    renderer.render(scene, camera);
  }

  // --- Resize ------------------------------------------------------------------
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  // --- Go -----------------------------------------------------------------------
  Input.init(canvas);
  resize();
  buildCompassTape();
  buildWorld();
  timeToggle.textContent = nightMode ? "NIGHT" : "DAY";
  applyEnvironment(nightMix);
  showOverlay(
    "ARCADE TANK",
    "You&rsquo;re a lone tank in a free-for-all.<br />" +
      "Gun down the enemy fleet, arc your shells, retreat to the garage to repair." +
      (bestScore > 0 ? "<br /><br />BEST SCORE: " + bestScore : ""),
    "Drive"
  );
  requestAnimationFrame(frame);

  return { onKeyDown, onPointerUnlock };
})();
