"use strict";

// ---------------------------------------------------------------------------
// Tank audio (M1 stub).
//
// Same API surface and mix structure as the plane's EngineAudio: a shared
// AudioContext (created on the first user gesture, per autoplay policy), a
// master gain, and an SFX gain that one-shot effects and the engine feed.
// Music builds on the same context and master gain, so M mutes everything.
//
// The one-shot effects (MG report, shell launch, explosion, warning beep) and
// the diesel engine rumble are SILENT PLACEHOLDERS for now; they are filled
// in M3 (weapons) and M6 (engine). If WebAudio is unavailable, every method
// is a silent no-op.
// ---------------------------------------------------------------------------

const EngineAudio = (() => {
  const MASTER_VOL = 0.4;

  let ctx = null;
  let master = null;
  let sfxGain = null;
  let muted = false;
  let sfxVol = 1; // user SFX volume, 0..1 (engine + one-shot effects)
  let started = false;

  function build() {
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_VOL;
    master.connect(ctx.destination);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = sfxVol;
    sfxGain.connect(master);
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

  /** Per-frame update. `state` is the game state string. The diesel engine
   *  rumble lands here in M6; nothing to do yet. */
  function update(dt, tank, state) {
    // (engine sound: M6)
  }

  // --- One-shot effects (silent placeholders until M3/M5) -------------------
  function crash() {}
  function mgFire() {}
  function shellLaunch() {}
  function shellBoom() {}
  function warnBeep() {}

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

  /** Set the SFX volume (0..1). Safe before start(); the node is updated once
   *  it exists. */
  function setSfxVolume(v) {
    sfxVol = clamp(v, 0, 1);
    if (sfxGain) sfxGain.gain.value = sfxVol;
  }

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
