/* sounds.js — the game's sounds. CC0 clips picked in sounds/sounds-manifest.json (the audition page at
 * sounds/audition.html exports that same shape; paste its export over the file to re-pick), decoded
 * once into WebAudio and played with a cooldown per role, a little pitch and level variation where
 * asked, and a volume that falls with distance from the listener (your character), so a fight across
 * the arena is quiet and your own is loud. Two files under one role are variants the game alternates,
 * never the same one twice running: footsteps are a left and a right. Nothing plays until a gesture
 * unlocks the context (phones insist): the first touch, key, or the Step in button.
 */
var SFX = (function () {
  'use strict';
  var BASE = 'sounds/', NEAR = 6, FAR = 30, MASTER = 0.8;
  // Footsteps (Bobby 2026-10-17: the raw clips were "a tap dancer"; UO's were muffled, a shuffle, a
  // scuff). Each step is the clip slowed, its click rounded off by a fade-in and a lowpass, about
  // 9 dB under the impacts. One sound per step: the noise puff that was layered under it read as a
  // snare drum ("army percussion") and is off (scuff 0); it is now a slow low swell if turned on.
  // Tune by ear from the console: MYSTICA.SFX.tune({ level: 0.25, cutoff: { dirt: 600 } }).
  var STEP = {
    level: 0.28, rate: 0.8, attack: 0.035, cut: 0.34, decay: 0.08,
    cutoff: { grass: 850, dirt: 750, stone: 1300, wood: 950, sand: 600, water: 1400 },  // lowpass on the clip, Hz (water a little brighter than earth, no longer a sizzle: 2600 put its centroid at 2.4 kHz against a step's 300 Hz)
    levelOf: { water: 1.7 },                                                             // per-ground level factor: measured 2026-10-18 so a wet step's loudest 50 ms lands with a grass step's (the two wet clips were 6 dB apart; wet_02's manifest gain was raised to match)
    scuff: { grass: 0, dirt: 0, stone: 0, wood: 0, sand: 0, water: 0 },                 // the swell's level, off
    scuffHz: 550, scuffAttack: 0.09, scuffDecay: 0.12
  };
  var ctx = null, master = null, roles = {}, buffers = {}, decoding = {}, muted = false, listener = { x: 0, z: 0 }, noiseBuf = null;
  var lastAt = {}, lastVariant = {}, stats = { files: 0, loaded: 0, played: 0, byRole: {} };
  function load(url) {
    fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      if (!m || !m.sounds) return;
      m.sounds.forEach(function (s) { (roles[s.role] = roles[s.role] || []).push(s); });
      stats.files = m.sounds.length;
      if (ctx) decodeAll();
    }).catch(function () { /* no manifest: a silent game */ });
  }
  function decodeAll() {
    Object.keys(roles).forEach(function (role) {
      roles[role].forEach(function (s) {
        if (buffers[s.file] || decoding[s.file]) return;
        decoding[s.file] = true;
        fetch(BASE + 'candidates/' + s.file).then(function (r) { return r.arrayBuffer(); }).then(function (ab) { return ctx.decodeAudioData(ab); })
          .then(function (buf) { buffers[s.file] = buf; stats.loaded++; })
          .catch(function () { delete decoding[s.file]; });
      });
    });
  }
  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = muted ? 0 : MASTER; master.connect(ctx.destination);
      decodeAll();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function attenuation(o) {
    if (o.x === undefined) return 1;
    var d = Math.hypot(o.x - listener.x, o.z - listener.z);
    return d <= NEAR ? 1 : Math.max(0, 1 - (d - NEAR) / (FAR - NEAR));
  }
  // play a role. o: x, z (where; omitted = at the listener), rate, jitter (pitch, ±fraction), level,
  // levelJitter, cool (seconds before the same role plays again; key for a separate limiter), variant
  // (force one), cut (stop after this many seconds)
  function play(role, o) {
    o = o || {};
    if (!ctx || muted) return false;
    var list = roles[role]; if (!list || !list.length) return false;
    var vol = attenuation(o); if (vol <= 0.02) return false;
    var now = ctx.currentTime, key = o.key || role;
    if (o.cool && now - (lastAt[key] === undefined ? -1e9 : lastAt[key]) < o.cool) return false;
    lastAt[key] = now;
    var i = 0;
    if (o.variant !== undefined) i = o.variant % list.length;
    else if (list.length > 1) { do { i = Math.floor(Math.random() * list.length); } while (i === lastVariant[role]); }
    lastVariant[role] = i;
    var s = list[i], buf = buffers[s.file]; if (!buf) return false;
    var src = ctx.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = (o.rate || 1) * (o.jitter ? 1 + (Math.random() * 2 - 1) * o.jitter : 1);
    var g = ctx.createGain(), target = (s.gain || 1) * (o.level === undefined ? 1 : o.level) * vol * (o.levelJitter ? 1 + (Math.random() * 2 - 1) * o.levelJitter : 1);
    // o.lowpass (Hz) muffles; o.attack (s) rounds off a click: a jump or a landing should be a body,
    // not a hit (Bobby 2026-10-17: the jump sounded "like a hit or slingshot attack")
    if (o.attack) { g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(target, now + o.attack); } else g.gain.value = target;
    if (o.lowpass) { var lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = o.lowpass; lpf.Q.value = 0.7; src.connect(lpf); lpf.connect(g); } else src.connect(g);
    g.connect(master);
    src.start(now);
    if (o.cut) src.stop(now + o.cut);
    stats.played++; stats.byRole[role] = (stats.byRole[role] || 0) + 1;
    return true;
  }
  function noise() { // a third of a second of white noise, made once
    if (noiseBuf) return noiseBuf;
    var n = Math.floor(ctx.sampleRate * 0.3), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = b; return b;
  }
  var rnd = function (spread) { return 1 + (Math.random() * 2 - 1) * spread; };
  // a footstep on a ground: the role's two variants alternate (a left and a right foot), each a
  // little off in pitch and level, softened as STEP says, with the scuff under it. Sand uses the dirt
  // clips, duller and softer still.
  function step(ground, running, x, z) {
    if (!ctx || muted) return false;
    var role = 'footstep ' + (ground === 'sand' ? 'dirt' : ground), list = roles[role]; if (!list || !list.length) return false;
    var vol = attenuation({ x: x, z: z }); if (vol <= 0.02) return false;
    var i = 0; if (list.length > 1) { do { i = Math.floor(Math.random() * list.length); } while (i === lastVariant[role]); }
    lastVariant[role] = i;
    var s = list[i], buf = buffers[s.file]; if (!buf) return false;
    var now = ctx.currentTime, run = running ? 1.2 : 1, lvl = (s.gain || 1) * STEP.level * (STEP.levelOf[ground] || 1) * run * vol * rnd(0.2);
    var src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = (ground === 'water' ? 1 : STEP.rate) * rnd(0.08);
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = (STEP.cutoff[ground] || 1000) * rnd(0.15); lp.Q.value = 0.7;
    var env = ctx.createGain();
    env.gain.setValueAtTime(0, now); env.gain.linearRampToValueAtTime(lvl, now + STEP.attack); env.gain.setTargetAtTime(0, now + STEP.attack + 0.08, STEP.decay);
    src.connect(lp); lp.connect(env); env.connect(master); src.start(now); src.stop(now + STEP.cut);
    var sc = STEP.scuff[ground] || 0;
    if (sc > 0) { // optional: a slow, low swell of noise, the sole dragging; never a burst
      var ns = ctx.createBufferSource(); ns.buffer = noise(); ns.loop = true;
      var lpn = ctx.createBiquadFilter(); lpn.type = 'lowpass'; lpn.frequency.value = STEP.scuffHz * rnd(0.2); lpn.Q.value = 0.5;
      var ne = ctx.createGain();
      ne.gain.setValueAtTime(0, now); ne.gain.linearRampToValueAtTime(sc * run * vol * rnd(0.3), now + STEP.scuffAttack); ne.gain.setTargetAtTime(0, now + STEP.scuffAttack, STEP.scuffDecay);
      ns.connect(lpn); lpn.connect(ne); ne.connect(master); ns.start(now); ns.stop(now + 0.5);
    }
    stats.played++; stats.byRole[role] = (stats.byRole[role] || 0) + 1;
    return true;
  }
  // water: real clips when the manifest has them (roles "splash" for stepping in, "swim" for a
  // stroke; wading steps are the "footstep water" ground through step()), else a synthesized
  // stand-in (a puff of noise whose band sweeps down with a low plop; a slower swell through a
  // lowpass that sinks as it fades). Bobby 2026-10-17: the stand-in rang "like a flimsy metal oven
  // tray", hence the clips.
  var WATER = { splash: 0.26, swim: 0.16 };
  // The water clips, measured 2026-10-18 through this chain with ffmpeg (loudest 50 ms, spectral centroid):
  // as shipped the splash and the strokes came out 10 to 15 dB above a grass step, peaked over 0 dBFS
  // (clipping) and sat near 4 kHz against a step's 300 Hz (Bobby: "too high, it should be in line with the
  // footsteps"). Now lowpassed, rounded off and levelled so their loudest 50 ms lands within a dB of a
  // dry step, centroid about 1.5 kHz. Tune: MYSTICA.SFX.tune({ wet: { splash: { level: 0.4, lowpass: 1400 } } }).
  var WET = { splash: { level: 0.36, lowpass: 1400, attack: 0.02, cut: 0.9 }, swim: { level: 0.44, lowpass: 1200, attack: 0.03, cut: 1.0 } };
  function water(kind, x, z, level) {
    if (!ctx || muted) return false;
    var c = WET[kind] || WET.splash;
    if (roles[kind] && roles[kind].length) return play(kind, { x: x, z: z, jitter: 0.1, levelJitter: 0.2, level: c.level * (level === undefined ? 1 : level), lowpass: c.lowpass, attack: c.attack, cut: c.cut });
    var vol = attenuation({ x: x, z: z }); if (vol <= 0.02) return false;
    var now = ctx.currentTime, lvl = (WATER[kind] || 0.2) * (level === undefined ? 1 : level) * vol * rnd(0.25);
    var ns = ctx.createBufferSource(); ns.buffer = noise(); ns.loop = true;
    var f = ctx.createBiquadFilter(), g = ctx.createGain();
    if (kind === 'swim') {
      f.type = 'lowpass'; f.Q.value = 0.8; f.frequency.setValueAtTime(1100 * rnd(0.2), now); f.frequency.exponentialRampToValueAtTime(450, now + 0.5);
      g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(lvl, now + 0.12); g.gain.setTargetAtTime(0, now + 0.2, 0.16);
      ns.start(now); ns.stop(now + 0.7);
    } else {
      f.type = 'bandpass'; f.Q.value = 1.1; f.frequency.setValueAtTime(1500 * rnd(0.2), now); f.frequency.exponentialRampToValueAtTime(380, now + 0.18);
      g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(lvl, now + 0.008); g.gain.setTargetAtTime(0, now + 0.03, 0.09);
      ns.start(now); ns.stop(now + 0.4);
      var o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(190, now); o.frequency.exponentialRampToValueAtTime(80, now + 0.14);
      og.gain.setValueAtTime(lvl * 0.5, now); og.gain.setTargetAtTime(0, now + 0.02, 0.05);
      o.connect(og); og.connect(master); o.start(now); o.stop(now + 0.3);
    }
    ns.connect(f); f.connect(g); g.connect(master);
    stats.played++; stats.byRole[kind] = (stats.byRole[kind] || 0) + 1;
    return true;
  }
  function tune(o) { // from the console: numbers replace, the per-ground tables merge, water: {splash, swim} (the synthesized stand-ins), wet: {splash: {level, lowpass, attack, cut}, swim: {...}} (the clips)
    Object.keys(o || {}).forEach(function (k) {
      if (k === 'water') Object.assign(WATER, o[k]);
      else if (k === 'wet') Object.keys(o[k]).forEach(function (r) { Object.assign(WET[r] = WET[r] || {}, o[k][r]); });
      else if (typeof o[k] === 'object' && STEP[k] && typeof STEP[k] === 'object') Object.assign(STEP[k], o[k]);
      else STEP[k] = o[k];
    });
    return { step: STEP, water: WATER, wet: WET };
  }
  function setMuted(on) {
    muted = !!on;
    if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER, ctx.currentTime, 0.02);
  }
  return {
    load: load, unlock: audio, play: play, step: step, water: water, tune: tune,
    listen: function (x, z) { listener.x = x; listener.z = z; },
    setMuted: setMuted, isMuted: function () { return muted; },
    stats: function () { return { files: stats.files, loaded: stats.loaded, played: stats.played, byRole: stats.byRole, state: ctx ? ctx.state : 'none', muted: muted }; }
  };
})();
