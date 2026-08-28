"use strict";

// ---------------------------------------------------------------------------
// Synthesized background music (no assets, no build step).
//
// Three short synthwave loops, defined as data tables:
//   - "menu":    calm title-screen loop (pad + soft arpeggio, no drums)
//   - "combatA": driving 126 BPM dogfight loop (kick/snare/hat, bass pump)
//   - "combatB": driving 132 BPM loop in D minor (syncopated feel)
//
// A lookahead scheduler (driven from the game loop, so hidden tabs stop it
// automatically) places notes ~0.15 s ahead on the shared AudioContext
// timeline. The mix feeds a user-adjustable music gain into EngineAudio's
// master gain, so M mutes everything.
// If WebAudio is unavailable, every method is a silent no-op.
// ---------------------------------------------------------------------------

const Music = (() => {
  // --- Track data -----------------------------------------------------------
  // Each track: bpm + a loop of bars. Each bar:
  //   chord: MIDI notes held for the whole bar (pad)
  //   bass:  16 entries (16th steps; 0 = rest)
  //   lead:  16 entries (16th steps; 0 = rest)
  // Drums are one 16-step pattern per track (0 = rest, 1 = hit).
  const TRACKS = {
    menu: {
      bpm: 92,
      bars: [
        { chord: [57, 60, 64], bass: [45, 0, 0, 0, 0, 0, 0, 0, 45, 0, 0, 0, 0, 0, 0, 0], lead: [64, 0, 69, 0, 72, 0, 69, 0, 64, 0, 69, 0, 72, 0, 76, 0] },
        { chord: [57, 60, 64], bass: [45, 0, 0, 0, 0, 0, 0, 0, 45, 0, 0, 0, 0, 0, 0, 0], lead: [64, 0, 69, 0, 72, 0, 69, 0, 67, 0, 69, 0, 72, 0, 74, 0] },
        { chord: [53, 57, 60], bass: [41, 0, 0, 0, 0, 0, 0, 0, 41, 0, 0, 0, 0, 0, 0, 0], lead: [60, 0, 65, 0, 69, 0, 65, 0, 60, 0, 65, 0, 69, 0, 72, 0] },
        { chord: [53, 57, 60], bass: [41, 0, 0, 0, 0, 0, 0, 0, 41, 0, 0, 0, 0, 0, 0, 0], lead: [60, 0, 65, 0, 69, 0, 65, 0, 64, 0, 65, 0, 69, 0, 71, 0] },
        { chord: [52, 55, 60], bass: [48, 0, 0, 0, 0, 0, 0, 0, 48, 0, 0, 0, 0, 0, 0, 0], lead: [60, 0, 64, 0, 67, 0, 64, 0, 60, 0, 64, 0, 67, 0, 72, 0] },
        { chord: [52, 55, 60], bass: [48, 0, 0, 0, 0, 0, 0, 0, 48, 0, 0, 0, 0, 0, 0, 0], lead: [60, 0, 64, 0, 67, 0, 64, 0, 65, 0, 67, 0, 72, 0, 74, 0] },
        { chord: [55, 59, 62], bass: [43, 0, 0, 0, 0, 0, 0, 0, 43, 0, 0, 0, 0, 0, 0, 0], lead: [62, 0, 67, 0, 71, 0, 67, 0, 62, 0, 67, 0, 71, 0, 74, 0] },
        { chord: [55, 59, 62], bass: [43, 0, 0, 0, 0, 0, 0, 0, 43, 0, 0, 0, 0, 0, 0, 0], lead: [62, 0, 67, 0, 71, 0, 67, 0, 64, 0, 67, 0, 71, 0, 76, 0] },
      ],
      drums: null,
    },
    combatA: {
      bpm: 126,
      bars: [
        { chord: [57, 60, 64], bass: [45, 0, 45, 0, 45, 0, 45, 0, 45, 0, 45, 0, 45, 0, 45, 0], lead: [69, 0, 72, 0, 76, 0, 72, 0, 69, 0, 72, 0, 76, 0, 72, 0] },
        { chord: [53, 57, 60], bass: [41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0], lead: [65, 0, 69, 0, 72, 0, 69, 0, 65, 0, 69, 0, 72, 0, 69, 0] },
        { chord: [52, 55, 60], bass: [48, 0, 48, 0, 48, 0, 48, 0, 48, 0, 48, 0, 48, 0, 48, 0], lead: [67, 0, 72, 0, 76, 0, 72, 0, 67, 0, 72, 0, 76, 0, 72, 0] },
        { chord: [55, 59, 62], bass: [43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0], lead: [67, 0, 71, 0, 74, 0, 71, 0, 67, 0, 71, 0, 74, 0, 71, 0] },
        { chord: [57, 60, 64], bass: [45, 0, 45, 0, 45, 0, 45, 0, 45, 0, 45, 0, 45, 0, 45, 0], lead: [76, 0, 0, 0, 74, 0, 72, 0, 69, 0, 0, 0, 72, 0, 71, 0] },
        { chord: [53, 57, 60], bass: [41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0], lead: [69, 0, 0, 0, 65, 0, 64, 0, 65, 0, 0, 0, 69, 0, 68, 0] },
        { chord: [55, 59, 62], bass: [43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0], lead: [74, 0, 71, 0, 67, 0, 71, 0, 74, 0, 0, 0, 71, 0, 0, 0] },
        { chord: [55, 59, 62], bass: [43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0, 43, 0], lead: [67, 0, 0, 0, 71, 0, 74, 0, 71, 0, 0, 0, 67, 0, 0, 0] },
      ],
      drums: {
        kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
        hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
      },
    },
    combatB: {
      bpm: 132,
      bars: [
        { chord: [62, 65, 69], bass: [38, 0, 38, 0, 38, 0, 38, 0, 38, 0, 38, 0, 38, 0, 38, 0], lead: [69, 0, 72, 0, 77, 0, 72, 0, 69, 0, 72, 0, 77, 0, 72, 0] },
        { chord: [58, 62, 65], bass: [34, 0, 34, 0, 34, 0, 34, 0, 34, 0, 34, 0, 34, 0, 34, 0], lead: [65, 0, 69, 0, 72, 0, 69, 0, 65, 0, 69, 0, 72, 0, 69, 0] },
        { chord: [53, 57, 60], bass: [41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0], lead: [60, 0, 65, 0, 69, 0, 65, 0, 60, 0, 65, 0, 69, 0, 65, 0] },
        { chord: [48, 52, 55], bass: [36, 0, 36, 0, 36, 0, 36, 0, 36, 0, 36, 0, 36, 0, 36, 0], lead: [60, 0, 64, 0, 67, 0, 64, 0, 60, 0, 64, 0, 67, 0, 64, 0] },
        { chord: [62, 65, 69], bass: [38, 0, 38, 0, 38, 0, 38, 0, 38, 0, 38, 0, 38, 0, 38, 0], lead: [77, 0, 0, 0, 74, 0, 72, 0, 69, 0, 0, 0, 72, 0, 71, 0] },
        { chord: [58, 62, 65], bass: [34, 0, 34, 0, 34, 0, 34, 0, 34, 0, 34, 0, 34, 0, 34, 0], lead: [69, 0, 0, 0, 65, 0, 62, 0, 65, 0, 0, 0, 69, 0, 67, 0] },
        { chord: [53, 57, 60], bass: [41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0, 41, 0], lead: [72, 0, 69, 0, 65, 0, 69, 0, 72, 0, 0, 0, 69, 0, 0, 0] },
        { chord: [48, 52, 55], bass: [36, 0, 36, 0, 36, 0, 36, 0, 36, 0, 36, 0, 36, 0, 36, 0], lead: [67, 0, 0, 0, 71, 0, 74, 0, 71, 0, 0, 0, 67, 0, 0, 0] },
      ],
      drums: {
        kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
        hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
      },
    },
  };
  const COMBAT_TRACKS = ["combatA", "combatB"];

  // --- Mix levels (the music bus gain, relative to the shared master) --------
  // Sized so the music leads the mix: it should stay clearly audible over the
  // engine rumble and one-shot SFX at the default slider values. The music bus
  // peaks ~0.9 (combat, drums included); with the master at 0.4 the sum stays
  // well under clipping.
  const MENU_VOL = 0.7;
  const PLAY_VOL = 0.85;
  const PAUSE_VOL = 0.25;
  const SCHED_AHEAD = 0.15; // s of notes scheduled ahead of "now"
  const FADE_SEC = 0.4; // track switch / stop fade

  let ctx = null;
  let bus = null; // music mix bus (state-based level)
  let musicGain = null; // user music volume, bus -> master
  let musicVol = 1; // 0..1
  let noiseBuf = null;
  let started = false;
  let trackName = null;
  let barIdx = 0;
  let step = 0; // 0..15 (16th steps within the current bar)
  let nextNoteTime = 0;
  let targetVol = 0;
  let curVol = 0;

  function midiHz(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  /** Build the music mix bus on the shared context. */
  function build() {
    const len = ctx.sampleRate; // 1 second of noise
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    bus = ctx.createGain();
    bus.gain.value = 0;
    musicGain = ctx.createGain();
    musicGain.gain.value = musicVol;
    musicGain.connect(EngineAudio.masterGain());
    // Gentle space: a feedback delay tapped off the bus.
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.28;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const wet = ctx.createGain();
    wet.gain.value = 0.18;
    bus.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(musicGain);
    bus.connect(musicGain);
  }

  /** Called from a user gesture, alongside EngineAudio.start(). */
  function start() {
    if (started) {
      if (ctx && ctx.state === "suspended") ctx.resume();
      return;
    }
    ctx = EngineAudio.context();
    if (!ctx) return; // no WebAudio: stay silent forever
    build();
    started = true;
  }

  /** Set the music volume (0..1). Safe before start(); the node is updated
   *  once it exists. */
  function setMusicVolume(v) {
    musicVol = clamp(v, 0, 1);
    if (musicGain) musicGain.gain.value = musicVol;
  }

  // --- Instruments (all one-shot, scheduled at absolute time `t`) -------------

  function playPad(t, midis, dur) {
    for (const m of midis) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = midiHz(m);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.08);
      g.gain.setValueAtTime(0.05, t + dur * 0.7);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(bus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }

  function playBass(t, m, dur) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = midiHz(m);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    lp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(lp);
    lp.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function playLead(t, m, dur) {
    // Two detuned saws through a lowpass: the classic synth lead.
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    lp.Q.value = 0.7;
    g.connect(lp);
    lp.connect(bus);
    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = midiHz(m);
      osc.detune.value = detune;
      osc.connect(g);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }

  function playKick(t) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  function playSnare(t) {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    noise.connect(bp);
    bp.connect(g);
    g.connect(bus);
    noise.start(t);
    noise.stop(t + 0.14);
  }

  function playHat(t) {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    noise.connect(hp);
    hp.connect(g);
    g.connect(bus);
    noise.start(t);
    noise.stop(t + 0.06);
  }

  // --- Sequencer ----------------------------------------------------------------

  /** Begin (or restart) a track from step 0. */
  function beginTrack(name) {
    trackName = name;
    barIdx = 0;
    step = 0;
    nextNoteTime = ctx.currentTime + 0.08;
  }

  /** Pick a fresh random combat track (called at the start of each flight). */
  function newFlight() {
    if (!started) return;
    const name = COMBAT_TRACKS[(Math.random() * COMBAT_TRACKS.length) | 0];
    if (name !== trackName) beginTrack(name);
  }

  /** Schedule one 16th step of the current track at absolute time `t`. */
  function scheduleStep(t) {
    const track = TRACKS[trackName];
    const bar = track.bars[barIdx];
    const s16 = 60 / track.bpm / 4; // s per 16th
    if (step === 0) playPad(t, bar.chord, s16 * 16);
    if (bar.bass[step]) playBass(t, bar.bass[step], s16 * 1.8);
    if (bar.lead[step]) playLead(t, bar.lead[step], s16 * 1.6);
    const d = track.drums;
    if (d) {
      if (d.kick[step]) playKick(t);
      if (d.snare[step]) playSnare(t);
      if (d.hat[step]) playHat(t);
    }
    step++;
    if (step >= 16) {
      step = 0;
      barIdx = (barIdx + 1) % track.bars.length;
    }
  }

  /** Per-frame update. `state` is the game state string. */
  function update(dt, state) {
    if (!started) return;

    // Target mix level per state (0 = stop scheduling).
    if (state === "ready") targetVol = MENU_VOL;
    else if (state === "playing") targetVol = PLAY_VOL;
    else if (state === "paused") targetVol = PAUSE_VOL;
    else targetVol = 0; // crashed: let the impact sound carry the moment

    // Ease the mix toward the target (full range in FADE_SEC); fading through
    // zero doubles as the track-switch / stop fade.
    const fadeRate = PLAY_VOL / FADE_SEC;
    if (curVol < targetVol) curVol = Math.min(targetVol, curVol + fadeRate * dt);
    else curVol = Math.max(targetVol, curVol - fadeRate * dt);
    bus.gain.value = curVol;

    // Pick the menu loop while on the title screen.
    if (state === "ready" && trackName !== "menu") beginTrack("menu");
    // Safety: never schedule without a track (e.g. newFlight never ran).
    if (state === "playing" && !trackName) beginTrack(COMBAT_TRACKS[0]);

    // Schedule ahead while audible.
    if (targetVol > 0 && curVol > 0.004) {
      // Resync if we fell behind (e.g. the tab was hidden and rAF stopped).
      if (nextNoteTime < ctx.currentTime) {
        const track = TRACKS[trackName];
        const s16 = 60 / track.bpm / 4;
        nextNoteTime = ctx.currentTime + s16;
      }
      while (nextNoteTime < ctx.currentTime + SCHED_AHEAD) {
        scheduleStep(nextNoteTime);
        nextNoteTime += 60 / TRACKS[trackName].bpm / 4;
      }
    }
  }

  return { start, update, newFlight, setMusicVolume };
})();
