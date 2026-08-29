"use strict";

// ---------------------------------------------------------------------------
// Synthesized tank audio (no assets, no build step).
//
// The diesel engine rumble is built from a low sawtooth + triangle pair
// through a lowpass, plus a looped white-noise bed through a bandpass. Both
// feed an engine gain -> SFX gain -> master gain -> output, and scale with
// the player's throttle and speed (throttle alone can rev the engine at a
// standstill). It idles on the title screen.
//
// One-shot effects (MG report, shell launch, explosion, crash, warning beep)
// are short oscillator/noise bursts through filters, distance-scaled so
// distant fire reads faint. The AudioContext is created on the first user
// gesture, per browser autoplay policy. If WebAudio is unavailable, every
// method is a silent no-op.
// ---------------------------------------------------------------------------

const EngineAudio = (() => {
  // --- Engine tuning ---------------------------------------------------------
  const ENGINE_FREQ_MIN = 55; // Hz at idle
  const ENGINE_FREQ_MAX = 90; // Hz at top speed
  const ENGINE_GAIN_IDLE = 0.22; // title-screen idle rumble
  const ENGINE_GAIN_MIN = 0.15; // in-game at a standstill
  const ENGINE_GAIN_MAX = 0.6; // in-game at top speed
  const ENGINE_EASE = 2.2; // frequency/gain easing rate (per second)

  // --- Prop tuning (plane vehicle; ported from the Arcade Plane game) --------
  const PROP_IDLE_RPM = 1200;
  const PROP_FULL_RPM = 2800;
  const PROP_BLADES = 2;
  const PROP_RPM_EASE = 2.2; // rpm easing rate (per second)

  const MASTER_VOL = 0.4;

  let ctx = null;
  let master = null;
  let sfxGain = null;
  let noiseBuf = null;
  let engineGain = null;
  let osc1 = null;
  let osc2 = null;
  let lowpass = null;
  let bandpass = null;
  let engineFreq = 0;
  let muted = false;
  let sfxVol = 1; // user SFX volume, 0..1 (engine + one-shot effects)
  let started = false;
  let engineMode = "diesel"; // "diesel" (tank) or "prop" (plane)
  let propGain = null;
  let propOsc1 = null;
  let propOsc2 = null;
  let propLowpass = null;
  let propBandpass = null;
  let propRpm = 0;

  function makeNoiseBuffer() {
    const len = ctx.sampleRate; // 1 second
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function build() {
    noiseBuf = makeNoiseBuffer();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_VOL;
    master.connect(ctx.destination);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = sfxVol;
    sfxGain.connect(master);

    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineGain.connect(sfxGain);

    // --- diesel "chug": detuned low sawtooth + triangle through a lowpass ----
    lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 300;
    lowpass.Q.value = 0.7;
    lowpass.connect(engineGain);

    const g1 = ctx.createGain();
    g1.gain.value = 0.5;
    g1.connect(lowpass);
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;
    g2.connect(lowpass);

    osc1 = ctx.createOscillator();
    osc1.type = "sawtooth";
    osc1.frequency.value = ENGINE_FREQ_MIN;
    osc1.connect(g1);
    osc1.start();

    osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.value = ENGINE_FREQ_MIN * 2.03; // detuned octave
    osc2.connect(g2);
    osc2.start();

    // --- diesel "bed": looped noise through a bandpass ------------------------
    bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 250;
    bandpass.Q.value = 0.8;
    const gN = ctx.createGain();
    gN.gain.value = 0.3;
    gN.connect(engineGain);

    const noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer();
    noise.loop = true;
    noise.connect(bandpass);
    bandpass.connect(gN);
    noise.start();

    // --- prop "thump" (plane vehicle): two detuned sawtooths at the blade-pass
    // frequency (RPM * blades / 60) and its octave, through a lowpass --------
    propGain = ctx.createGain();
    propGain.gain.value = 0;
    propGain.connect(sfxGain);

    propLowpass = ctx.createBiquadFilter();
    propLowpass.type = "lowpass";
    propLowpass.frequency.value = 400;
    propLowpass.Q.value = 0.7;
    propLowpass.connect(propGain);

    const pg1 = ctx.createGain();
    pg1.gain.value = 0.5;
    pg1.connect(propLowpass);
    const pg2 = ctx.createGain();
    pg2.gain.value = 0.22;
    pg2.connect(propLowpass);

    propOsc1 = ctx.createOscillator();
    propOsc1.type = "sawtooth";
    propOsc1.frequency.value = 40;
    propOsc1.connect(pg1);
    propOsc1.start();

    propOsc2 = ctx.createOscillator();
    propOsc2.type = "sawtooth";
    propOsc2.frequency.value = 81; // detuned octave
    propOsc2.connect(pg2);
    propOsc2.start();

    // --- prop "whoosh": looped noise through a bandpass tracking RPM ---------
    propBandpass = ctx.createBiquadFilter();
    propBandpass.type = "bandpass";
    propBandpass.frequency.value = 300;
    propBandpass.Q.value = 0.8;
    const pgN = ctx.createGain();
    pgN.gain.value = 0.35;
    pgN.connect(propGain);

    const propNoise = ctx.createBufferSource();
    propNoise.buffer = makeNoiseBuffer();
    propNoise.loop = true;
    propNoise.connect(propBandpass);
    propBandpass.connect(pgN);
    propNoise.start();
  }

  /** Create/resume the context. Must be called from a user gesture. */
  function start() {
    if (started) {
      if (ctx && ctx.state === "suspended") ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no WebAudio: stay silent forever
    try {
      ctx = new AC();
    } catch (err) {
      return;
    }
    build();
    started = true;
    if (ctx.state === "suspended") ctx.resume();
  }

  /** Per-frame update: the active engine voice scales with throttle and
   *  speed (diesel for the tank, prop for the plane). `unit` is the player's
   *  vehicle; `state` is the game state string; `throttle` is the player's
   *  throttle input (-1..1 for the tank, 0..1 for the plane; 0 outside of
   *  playing). */
  function update(dt, unit, state, throttle) {
    if (!started) return;

    if (engineMode === "diesel") {
      let targetFreq = 0;
      let targetGain = 0;
      if (state === "ready") {
        targetFreq = ENGINE_FREQ_MIN;
        targetGain = ENGINE_GAIN_IDLE;
      } else if (state === "playing" && unit) {
        const speedRatio = clamp(Math.abs(unit.speed) / MAX_SPEED_FWD, 0, 1);
        // Throttle and speed both rev the engine: at a standstill the throttle
        // alone can rev it, and coasting keeps a little rumble under the wheels.
        const drive = clamp(Math.max(speedRatio, Math.abs(clamp(throttle || 0, -1, 1)) * 0.8), 0, 1);
        targetFreq = lerp(ENGINE_FREQ_MIN, ENGINE_FREQ_MAX, drive);
        targetGain = lerp(ENGINE_GAIN_MIN, ENGINE_GAIN_MAX, drive);
      }
      // paused / destroyed: frequency and gain ease to 0 (engine cut).

      engineFreq = easeToward(engineFreq, targetFreq, ENGINE_EASE, dt);
      osc1.frequency.value = Math.max(1, engineFreq);
      osc2.frequency.value = Math.max(2, engineFreq * 2.03);
      lowpass.frequency.value = 120 + engineFreq * 3;
      bandpass.frequency.value = 100 + engineFreq * 2.5;
      engineGain.gain.value = easeToward(engineGain.gain.value, targetGain, ENGINE_EASE, dt);
      propGain.gain.value = easeToward(propGain.gain.value, 0, PROP_RPM_EASE, dt);
    } else {
      let targetRpm = 0;
      let targetGain = 0;
      if (state === "ready") {
        targetRpm = PROP_IDLE_RPM;
        targetGain = 0.32;
      } else if (state === "playing" && unit) {
        targetRpm = PROP_IDLE_RPM + (PROP_FULL_RPM - PROP_IDLE_RPM) * clamp(unit.throttle, 0, 1);
        targetGain = 0.2 + 0.55 * clamp(propRpm / PROP_FULL_RPM, 0, 1);
      }
      // paused / destroyed: rpm and gain ease to 0 (engine cut).

      propRpm = easeToward(propRpm, targetRpm, PROP_RPM_EASE, dt);
      const bladePass = (propRpm / 60) * PROP_BLADES; // Hz
      propOsc1.frequency.value = Math.max(1, bladePass);
      propOsc2.frequency.value = Math.max(2, bladePass * 2.03);
      propLowpass.frequency.value = 200 + bladePass * 6;
      propBandpass.frequency.value = 120 + bladePass * 9;
      propGain.gain.value = easeToward(propGain.gain.value, targetGain, PROP_RPM_EASE, dt);
      engineGain.gain.value = easeToward(engineGain.gain.value, 0, ENGINE_EASE, dt);
    }
  }

  /** Select the engine voice: "diesel" (tank) or "prop" (plane). The
   *  inactive voice eases to silence on the next update(). */
  function setEngineMode(mode) {
    engineMode = mode === "prop" ? "prop" : "diesel";
  }

  /** One-shot MG report: a short falling-bandpass noise crack plus a low
   *  sine thump. `dist` = meters from the listener (player); distant CPU
   *  fire reads as faint crackle. */
  function mgFire(dist) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.3 / (1 + dist / 120), 0.1, 1);

    // --- crack: short noise burst through a falling bandpass -----------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1800, t0);
    bp.frequency.exponentialRampToValueAtTime(300, t0 + 0.08);
    bp.Q.value = 0.9;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.5 * vol, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    noise.connect(bp);
    bp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.15);

    // --- thump: low sine with a fast pitch drop ------------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.15);
  }

  /** One-shot shell launch: a low thump (sine sweep ~120->40 Hz) plus a
   *  noise crack. `dist` = meters from the listener (player); 0 (the default)
   *  is a launch right next to the player, so the player's own shells keep
   *  full volume while distant AI launches read softer. */
  function shellLaunch(dist = 0) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.6 / (1 + dist / 160), 0.08, 1);

    // --- thump: low sine with a fast pitch drop --------------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.3);

    // --- crack: noise burst through a rising bandpass --------------------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(400, t0);
    bp.frequency.exponentialRampToValueAtTime(1200, t0 + 0.2);
    bp.Q.value = 0.8;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.001, t0);
    gn.gain.exponentialRampToValueAtTime(0.4 * vol, t0 + 0.05);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    noise.connect(bp);
    bp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.3);
  }

  /** One-shot shell explosion: a filtered-noise boom with a lowpass sweep
   *  down, plus a deep sub thump. `dist` = meters from the listener (player),
   *  so a distant detonation reads as a muffled thump. */
  function shellBoom(dist) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.6 / (1 + dist / 160), 0.08, 1);

    // --- boom: noise burst through a falling lowpass ---------------------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1200, t0);
    lp.frequency.exponentialRampToValueAtTime(80, t0 + 0.5);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.9 * vol, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
    noise.connect(lp);
    lp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.65);

    // --- sub thump: deep sine with a fast pitch drop ----------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(90, t0);
    osc.frequency.exponentialRampToValueAtTime(28, t0 + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.55);
  }

  /** One-shot aircraft cannon report (plane / AA gun). `dist` = meters from
   *  the listener (player), so distant fire reads as faint crackle. */
  function fire(dist) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.3 / (1 + dist / 120), 0.1, 1);

    // --- crack: short noise burst through a falling bandpass ----------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1800, t0);
    bp.frequency.exponentialRampToValueAtTime(300, t0 + 0.08);
    bp.Q.value = 0.9;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.5 * vol, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    noise.connect(bp);
    bp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.15);

    // --- thump: low sine with a fast pitch drop ------------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.15);
  }

  /** One-shot rocket launch (plane / AA gun): a heavy low thump plus a rising
   *  whoosh. `dist` = meters from the listener (player). */
  function rocketLaunch(dist = 0) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.6 / (1 + dist / 160), 0.08, 1);

    // --- deep thump: sine with a fast pitch drop ----------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.exponentialRampToValueAtTime(50, t0 + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.3);

    // --- whoosh: noise through a rising bandpass ----------------------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(500, t0);
    bp.frequency.exponentialRampToValueAtTime(1600, t0 + 0.25);
    bp.Q.value = 0.8;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.001, t0);
    gn.gain.exponentialRampToValueAtTime(0.4 * vol, t0 + 0.06);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
    noise.connect(bp);
    bp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.35);
  }

  /** One-shot rocket explosion (plane / AA gun). `dist` = meters from the
   *  listener (player), so a distant detonation reads as a muffled thump. */
  function rocketBoom(dist) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.6 / (1 + dist / 160), 0.08, 1);

    // --- boom: noise burst through a falling lowpass ------------------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1200, t0);
    lp.frequency.exponentialRampToValueAtTime(80, t0 + 0.5);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.9 * vol, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
    noise.connect(lp);
    lp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.65);

    // --- sub thump: deep sine with a fast pitch drop -------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(90, t0);
    osc.frequency.exponentialRampToValueAtTime(28, t0 + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.55);
  }

  /** One-shot destruction boom (M5): a bigger version of the shell boom.
   *  `dist` = meters from the listener (player). */
  function crash(dist = 0) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.8 / (1 + dist / 200), 0.1, 1);

    // --- boom: noise burst through a falling lowpass ---------------------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1500, t0);
    lp.frequency.exponentialRampToValueAtTime(60, t0 + 0.7);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(1.0 * vol, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);
    noise.connect(lp);
    lp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.85);

    // --- sub thump: deep sine with a fast pitch drop ----------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(100, t0);
    osc.frequency.exponentialRampToValueAtTime(25, t0 + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.65);
  }

  /** One-shot human scream ("AARGH"): a pitch-dropping sawtooth voice through
   *  a formant bandpass, with vibrato and a breathy noise edge. `dist` =
   *  meters from the listener (player). */
  function scream(dist) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.4 / (1 + dist / 140), 0.1, 1);
    const f0 = 260 + Math.random() * 80;

    // --- voice: sawtooth with a falling pitch (the scream dying out) ---------
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.45, t0 + 0.42);

    // Vibrato: wobble the pitch while the scream is up.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 11 + Math.random() * 4;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = f0 * 0.12;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    // Formant bandpass: shapes the buzz into a voice-like cry.
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(850, t0);
    bp.frequency.exponentialRampToValueAtTime(420, t0 + 0.45);
    bp.Q.value = 1.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t0);
    g.gain.exponentialRampToValueAtTime(0.7 * vol, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
    osc.connect(bp);
    bp.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.55);
    lfo.start(t0);
    lfo.stop(t0 + 0.55);

    // --- breathy noise edge ---------------------------------------------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bpN = ctx.createBiquadFilter();
    bpN.type = "bandpass";
    bpN.frequency.value = 1400;
    bpN.Q.value = 0.7;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.001, t0);
    gn.gain.exponentialRampToValueAtTime(0.15 * vol, t0 + 0.04);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
    noise.connect(bpN);
    bpN.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.45);
  }

  /** One-shot felled-tree thud: a low sine thump plus a short lowpassed
   *  noise crunch. `dist` = meters from the listener (player). */
  function treeThud(dist) {
    if (!started) return;
    const t0 = ctx.currentTime;
    const vol = clamp(1.2 / (1 + dist / 100), 0.08, 1);

    // --- thump: low sine with a fast pitch drop --------------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(100, t0);
    osc.frequency.exponentialRampToValueAtTime(35, t0 + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.3);

    // --- crunch: short noise burst through a falling lowpass -------------------
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(600, t0);
    lp.frequency.exponentialRampToValueAtTime(120, t0 + 0.2);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.35 * vol, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    noise.connect(lp);
    lp.connect(gn);
    gn.connect(sfxGain);
    noise.start(t0);
    noise.stop(t0 + 0.3);
  }

  /** One-shot warning beep (overheat): a short high-pitched blip. */
  function warnBeep() {
    if (!started) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 880;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t0);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.2);
  }

  function toggleMute() {
    muted = !muted;
    if (master) master.gain.value = muted ? 0 : MASTER_VOL;
    return muted;
  }

  /** Set the mute flag directly (used to restore a persisted setting). */
  function setMuted(v) {
    muted = !!v;
    if (master) master.gain.value = muted ? 0 : MASTER_VOL;
  }

  function isMuted() {
    return muted;
  }

  /** Set the SFX volume (0..1): engine + one-shot effects. Safe before
   *  start(); the node is updated once it exists. */
  function setSfxVolume(v) {
    sfxVol = clamp(v, 0, 1);
    if (sfxGain) sfxGain.gain.value = sfxVol;
  }

  // Background tabs stop requestAnimationFrame but not audio: silence the
  // engine while hidden; the next visible frame's update() restores it.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (engineGain) engineGain.gain.value = 0;
      if (propGain) propGain.gain.value = 0;
    }
  });

  /** The shared AudioContext (null until start() succeeds). Other audio
   *  modules (Music) build on it so everything shares one context, one
   *  gesture unlock, and one mute. */
  function context() {
    return ctx;
  }

  /** The master gain node (null until start() succeeds). */
  function masterGain() {
    return master;
  }

  return {
    start,
    update,
    setEngineMode,
    toggleMute,
    setMuted,
    isMuted,
    setSfxVolume,
    crash,
    scream,
    mgFire,
    shellLaunch,
    shellBoom,
    fire,
    rocketLaunch,
    rocketBoom,
    treeThud,
    warnBeep,
    context,
    masterGain,
  };
})();
