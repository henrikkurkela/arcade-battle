"use strict";

// ---------------------------------------------------------------------------
// Synthesized tank audio (no assets, no build step).
//
// The diesel engine rumble (the basic M3 version; M6 refines it) is built
// from a low sawtooth + triangle pair through a lowpass, plus a looped
// white-noise bed through a bandpass. Both feed an engine gain -> SFX gain ->
// master gain -> output, and scale with the tank's speed.
//
// One-shot effects (MG report, shell launch, explosion, crash, warning beep)
// are short oscillator/noise bursts through filters, distance-scaled so
// distant fire reads faint. The AudioContext is created on the first user
// gesture, per browser autoplay policy. If WebAudio is unavailable, every
// method is a silent no-op.
// ---------------------------------------------------------------------------

const EngineAudio = (() => {
  // --- Engine tuning (basic M3 version; M6 refines) ------------------------
  const ENGINE_FREQ_MIN = 55; // Hz at idle
  const ENGINE_FREQ_MAX = 90; // Hz at top speed
  const ENGINE_GAIN_IDLE = 0.22; // title-screen idle rumble
  const ENGINE_GAIN_MIN = 0.15; // in-game at a standstill
  const ENGINE_GAIN_MAX = 0.6; // in-game at top speed
  const ENGINE_EASE = 2.2; // frequency/gain easing rate (per second)

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

  /** Per-frame update: the diesel rumble scales with the tank's speed.
   *  `state` is the game state string. */
  function update(dt, tank, state) {
    if (!started) return;

    let targetFreq = 0;
    let targetGain = 0;
    if (state === "ready") {
      targetFreq = ENGINE_FREQ_MIN;
      targetGain = ENGINE_GAIN_IDLE;
    } else if (state === "playing" && tank) {
      const ratio = clamp(Math.abs(tank.speed) / MAX_SPEED_FWD, 0, 1);
      targetFreq = lerp(ENGINE_FREQ_MIN, ENGINE_FREQ_MAX, ratio);
      targetGain = lerp(ENGINE_GAIN_MIN, ENGINE_GAIN_MAX, ratio);
    }
    // paused / destroyed: frequency and gain ease to 0 (engine cut).

    engineFreq = easeToward(engineFreq, targetFreq, ENGINE_EASE, dt);
    osc1.frequency.value = Math.max(1, engineFreq);
    osc2.frequency.value = Math.max(2, engineFreq * 2.03);
    lowpass.frequency.value = 120 + engineFreq * 3;
    bandpass.frequency.value = 100 + engineFreq * 2.5;
    engineGain.gain.value = easeToward(engineGain.gain.value, targetGain, ENGINE_EASE, dt);
  }

  /** One-shot MG report: a short filtered-noise crack plus a click.
   *  `dist` = meters from the listener (player); distant CPU fire reads as
   *  faint crackle. */
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

    // --- click: short high sine blip ------------------------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(2200, t0);
    osc.frequency.exponentialRampToValueAtTime(900, t0 + 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15 * vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    osc.connect(g);
    g.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.06);
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
    if (engineGain && document.hidden) engineGain.gain.value = 0;
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
    toggleMute,
    setMuted,
    isMuted,
    setSfxVolume,
    crash,
    mgFire,
    shellLaunch,
    shellBoom,
    warnBeep,
    context,
    masterGain,
  };
})();
