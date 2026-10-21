/* main.js — Mystica client: input, rendering and UI around the shared simulation in sim.js.
 *
 * Nothing in this file decides what the world does. It turns keys and pointer into a player intent,
 * hands that to SIM, steps the world, and draws whatever SIM says is there. The same calls will later
 * run against a server's authoritative state with this client predicting its own body.
 *
 * Rendering: a true-3D scene through a locked UO-style camera into a low-res target, upscaled by an
 * integer factor with nearest-neighbour sampling (see shaders.js).
 */
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
var C = SIM.C;

// ------------------------------------------------------------------ settings (rendering + tunables)
var S = {
  scale: 3, tilePx: 44, snapCam: true, snapObj: true,
  oblique: true, elev: 30, kVert: 1.0,
  ramps: true, dither: 1.0, surfNoise: 0.6, outline: true, creases: true,
  night: 0, animFps: 10, cutout: true,
  mode: 'walk', tool: 'raise', brushR: 3, repose: C.REPOSE,
  ward: 1, facing: 0,
  jumpH: C.JUMP_H, swim: false,
  sound: true
};
// Any setting can be preset from the URL, e.g. ?scale=2&oblique=0&night=0.6
(function () {
  var q = new URLSearchParams(location.search);
  q.forEach(function (v, k) {
    if (!(k in S)) return;
    if (typeof S[k] === 'boolean') S[k] = v === '1' || v === 'true';
    else if (typeof S[k] === 'number') S[k] = parseFloat(v);
    else S[k] = v;
  });
})();

// ?watch=1: the presenter's view (2026-10-18, for the webinar's finale). A body of its own, under a token
// made for this tab (so it never takes over the phone's body), standing at the spawn and never moved; the
// camera sits over the arena with the pixels chosen so the ring fits (watchFit) until it is dragged, keyed or zoomed
// (watchPan; Home brings the ring back), the HUD is gone, and the
// session's leaderboard, the server's tally for watchers, stands at the top right, sized for a screen
// shared at 720p. The toasts and the round-end board still show.
var WATCH = new URLSearchParams(location.search).get('watch') === '1';

// ------------------------------------------------------------------ world
var SEED = (function () { var q = new URLSearchParams(location.search).get('seed'); return q ? parseInt(q, 10) : 7; })();
var w = SIM.createWorld(SEED);
var P = SIM.addPlayer(w, 0, 3);
P.local = true;
// a name, asked once and remembered on this device
var myName = '';
try { myName = localStorage.getItem('mystica-name') || ''; } catch (e) { /* storage blocked */ }
if (!myName) myName = (new URLSearchParams(location.search).get('name') || '').trim().slice(0, 16); // ?name= skips the card
if (WATCH) myName = 'Watcher'; // the presenter's view: no card, no name of its own
var needsWelcome = !myName; // a first visit: the welcome card asks the name and explains the controls
var eventMode = false; // the server's hello says: names are given and the boards are read-only (EVENT=1)
P.name = myName;
// the device token is the identity: a random secret made once, never shown, never typed
var myToken = '';
try { myToken = (WATCH ? sessionStorage.getItem('mystica-watch-token') : localStorage.getItem('mystica-token')) || ''; } catch (e) { /* storage blocked */ }
if (!/^[0-9a-f]{32}$/.test(myToken)) {
  var rnd = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(rnd) : rnd.forEach(function (_, i) { rnd[i] = Math.random() * 256; });
  myToken = Array.prototype.map.call(rnd, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  try { if (WATCH) sessionStorage.setItem('mystica-watch-token', myToken); else localStorage.setItem('mystica-token', myToken); } catch (e) { /* storage blocked: a new character each visit */ } // the watcher's token lives with its tab, so the same desktop can still play on its own token
}
P.target = null; // click-to-walk target (client-side intent, never sent as a result)
// ?trace=1: every 5 s the client sends the server a short account of itself (version, fps, the frame
// cap hits, prediction corrections, ack latency, the biggest corrections with positions). The server
// logs it as `trace` and keeps it in the action log, so a phone's view of the game can be read remotely.
var TRACE = new URLSearchParams(location.search).get('trace') === '1';
var traceStats = { frames: 0, dtMax: 0, slow: 0, corr: 0, big: 0, maxErr: 0, sumErr: 0, lagSum: 0, lagMax: 0, lagN: 0, ev: [] };
// ?admin=<token>: the server's ADMIN_TOKEN, sent with the world-wide actions (reset, the shared sliders);
// without it the server refuses them and only the per-player sliders take effect online
var ADMIN = new URLSearchParams(location.search).get('admin') || '';
// Offline is what net.js decides it is: no server behind this page. (NET.connected is false at load either way,
// so the dev sandboxes below used to run online too and flash for a frame before the live world came back.)
var OFFLINE = location.protocol === 'file:' || !location.host;
// ?arena=wraith (wisp, bull): offline, the sandbox pins the local world to that wave; on the admin page online, the
// server is asked to pin the arena once the welcome has arrived (onWelcome). On a plain page online it does nothing.
var ARENA_PIN = (function () { var k = new URLSearchParams(location.search).get('arena'); return k && k !== '1' && SIM.TIERS.indexOf(k) >= 0 ? k : null; })(), arenaPinSent = false;
function applyTunables() {
  w.repose = S.repose;
  w.town.strength = S.ward; w.town.facing = S.facing * Math.PI / 180;
  P.jumpV = Math.sqrt(2 * C.GRAVITY * S.jumpH); P.canSwim = !!S.swim;
  if (NET.connected) NET.send({ t: 'tune', ward: S.ward, facing: S.facing, repose: S.repose, jumpH: S.jumpH, swim: S.swim, admin: ADMIN });
}
applyTunables();

// ------------------------------------------------------------------ sound
// The picks live in sounds/sounds-manifest.json (see sounds.js). Muted is remembered on this device.
try { if (localStorage.getItem('mystica-sound') === '0') S.sound = false; } catch (e) { /* storage blocked */ }
SFX.setMuted(!S.sound);
SFX.load('sounds/sounds-manifest.json');
document.addEventListener('pointerdown', SFX.unlock, true); // phones play nothing until a gesture
window.addEventListener('keydown', SFX.unlock, true);
// the ground under a point, the way the terrain shader decides what to draw: the arena's sand and its
// paved ring, anything you stand on above the ground (a crate, the house floor) as wood, stone facing,
// beaches and steep slopes, disturbed earth, else grass
function groundAt(x, z) {
  var ad = Math.hypot(x - C.ARENA_X, z - C.ARENA_Z);
  if (ad < C.ARENA_R - 1.4) return 'sand';
  if (ad < C.ARENA_R + 0.3) return 'stone';
  var h = SIM.heightAt(w, x, z);
  if (SIM.platformAt(w, x, z) > h + 0.05) return 'wood';
  var i = Math.round(x + w.HALF), j = Math.round(z + w.HALF), k = clamp(j, 0, w.V - 1) * w.V + clamp(i, 0, w.V - 1);
  if (w.faced[k]) return 'stone';
  if (h < 0.25) return 'sand';
  var slope = Math.abs(SIM.heightAt(w, x + 0.5, z) - SIM.heightAt(w, x - 0.5, z)) + Math.abs(SIM.heightAt(w, x, z + 0.5) - SIM.heightAt(w, x, z - 0.5));
  if (slope > 0.9) return 'stone';
  if (slope > 0.45 || w.loose[k] > 0.3) return 'dirt';
  return 'grass';
}
// my footsteps: every STEP_S at a walk, scaled by how fast the body actually goes (a run is quicker,
// water slower), the variants alternating left and right inside SFX.step (Bobby 2026-10-17: the
// animation's stride was "a tap dancer"). Ankle-deep water splashes instead; past the knees it is a
// swimming stroke every STROKE_S and no steps; stepping into water splashes once.
var STEP_S = 0.5, STROKE_S = 0.85, WADE_MIN = 0.08;
var lastStepAt = -1, lastStroke = -1, wasInWater = false, landedNow = false;
function stepSounds() {
  if (!P.grounded) return; // in the air there is no splash yet, whatever the shadow crosses: it comes with the landing (Bobby 2026-10-18: a jump into water "splashes a bit too soon")
  var d = SIM.depthAt(w, P.x, P.z), swimming = d > C.WADE, wading = !swimming && d > WADE_MIN;
  if ((swimming || wading) && !wasInWater) SFX.water('splash', P.x, P.z, landedNow ? 1.4 : 1.1); // a plunge from a jump is a bigger splash than a wade
  wasInWater = swimming || wading;
  if (!P.moving || P.away) return;
  if (swimming) { if (time - lastStroke >= STROKE_S) { lastStroke = time; SFX.water('swim', P.x, P.z, 1); } return; }
  if (!P.grounded) return;
  var speed = (P.running ? C.WALK * C.RUN_MULT : P.creeping ? C.WALK * C.CREEP_MUL : C.WALK) * SIM.waterFactor(w, P, P.x, P.z);
  if (time - lastStepAt < STEP_S * C.WALK / Math.max(0.5, speed)) return;
  lastStepAt = time;
  SFX.step(wading ? 'water' : groundAt(P.x, P.z), P.running, P.x, P.z); // ankle deep: wet footsteps
}
// other bodies: their steps, splashes and strokes on the same cadences while they move (their phase
// arrives ten times a second, too coarse to follow), a bull's hoofbeats when it charges, a sheep now
// and then
function ambientFor(v, e) {
  if (e === P || e.ghost || e.away) return;
  if (e.kind === 'player' && e.moving) {
    var d = SIM.depthAt(w, e.x, e.z);
    if (time < (v.stepAt || 0)) return;
    if (d > C.WADE) { v.stepAt = time + STROKE_S; SFX.water('swim', e.x, e.z, 0.8); }
    else { v.stepAt = time + (e.running ? STEP_S / C.RUN_MULT : e.creeping ? STEP_S / C.CREEP_MUL : STEP_S); SFX.step(d > WADE_MIN ? 'water' : groundAt(e.x, e.z), e.running, e.x, e.z); }
  } else if (e.kind === 'bull' && e.moving && e.net) {
    var sp = Math.hypot(e.net.tx - e.net.fx, e.net.tz - e.net.fz) / SNAP_DT;
    if (sp > 3 && time >= (v.stepAt || 0)) { v.stepAt = time + 0.26; SFX.play('bull charge', { x: e.x, z: e.z, jitter: 0.1, levelJitter: 0.2, level: 0.8, cut: 0.3 }); }
  } else if (e.kind === 'sheep') {
    if (!v.baaAt) v.baaAt = time + 4 + Math.random() * 16;
    if (time >= v.baaAt) { v.baaAt = time + 10 + Math.random() * 24; SFX.play('sheep', { x: e.x, z: e.z, jitter: 0.1, level: 0.5 /* 0.6 until 2026-10-18: Bobby, "a bit too loud, maybe like 17%" */ }); }
  }
}

// ------------------------------------------------------------------ palette
// One hand-picked ramp per material, shadow -> highlight. Shadows lean cool, highlights warm.
var STEPS = 6, NMATS = 20;
var M = { GRASS: 0, DIRT: 1, ROCK: 2, SAND: 3, WATER: 4, WOOD: 5, LEAVES: 6, PLASTER: 7, ROOF: 8,
          SKIN: 9, RED: 10, BLUE: 11, WOOL: 12, DARK: 13, SNOW: 14, FUR: 15, COBBLE: 16 };
var RAMPS = [
  ['#24331f', '#34502a', '#4a6e34', '#5f8a3c', '#78a448', '#94bd58'], // grass
  ['#2e2118', '#4a3424', '#664a30', '#7f5f3c', '#99774a', '#b08d5c'], // dirt
  ['#26262e', '#3b3b45', '#52525e', '#6c6c78', '#878792', '#a3a3ad'], // rock
  ['#6b5a3c', '#8a7650', '#a89262', '#c2ab74', '#d8c388', '#ead89e'], // sand
  ['#0e2240', '#163a60', '#1e5280', '#2a6b9c', '#3a86b5', '#58a6cc'], // water
  ['#2a1a10', '#40281a', '#583824', '#704a2e', '#86603a', '#9c7648'], // wood
  ['#142a1a', '#1f4026', '#2a5a30', '#377238', '#4a8a40', '#62a44a'], // leaves
  ['#4a4038', '#6e6258', '#918478', '#b0a496', '#cbc0b0', '#e2d9c8'], // plaster
  ['#3a1a14', '#5a2a1c', '#7a3a24', '#96482a', '#b05a34', '#c87040'], // roof tile
  ['#4a2e22', '#6e4634', '#8f5c44', '#b07656', '#cc9268', '#e0ab7c'], // skin
  ['#3a0e10', '#5c1618', '#7e2020', '#a02a28', '#bc3a34', '#d45048'], // red cloth
  ['#10163a', '#1a2458', '#243476', '#2e4692', '#3c5aaa', '#5074c0'], // blue cloth
  ['#5a5a60', '#80808a', '#a4a4ac', '#c4c4ca', '#dededf', '#f4f4f0'], // wool
  ['#0e0e12', '#1a1a20', '#28282e', '#38383e', '#4a4a50', '#5c5c62'], // dark / iron
  ['#7a8aa0', '#98a8bc', '#b6c4d4', '#d0dae6', '#e6ecf2', '#f8fafc'], // snow
  ['#2e1e14', '#46301e', '#5e4228', '#765432', '#8e683e', '#a67e4c'], // fur
  ['#2c2a2e', '#44424a', '#5c5a62', '#74727a', '#8c8a92', '#a4a2aa'], // cobble
  ['#1a4a6a', '#2a7aa0', '#3aa8d0', '#5ad0f0', '#9ae8ff', '#e0fbff'], // magic (bolts)
  ['#3a1208', '#7a2410', '#b84a14', '#e07a1c', '#f6b23a', '#fff0a0']  // fire (the wraith's line of fire)
];
M.MAGIC = 17; M.FIRE = 18;
function buildPalette() {
  var data = new Uint8Array(STEPS * NMATS * 4);
  for (var m = 0; m < NMATS; m++) for (var s = 0; s < STEPS; s++) {
    var hex = (RAMPS[m] || RAMPS[M.ROCK])[s], o = (m * STEPS + s) * 4;
    data[o] = parseInt(hex.slice(1, 3), 16); data[o + 1] = parseInt(hex.slice(3, 5), 16);
    data[o + 2] = parseInt(hex.slice(5, 7), 16); data[o + 3] = 255;
  }
  var tex = new THREE.DataTexture(data, STEPS, NMATS, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ renderer, targets
var canvas = $('c');
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.autoClear = false;

var lowW = 640, lowH = 360, cw = 1920, ch = 1080;
var rtColor = null, rtNormal = null;
var CAM_NEAR = 1, CAM_FAR = 300;

var paletteTex = buildPalette();
var shared = {
  uPalette: { value: paletteTex }, uPass: { value: 0 }, uRes: { value: new THREE.Vector2(lowW, lowH) },
  uSnap: { value: 1 }, uSunDir: { value: new THREE.Vector3(-0.5, 1.6, 1.0).normalize() },
  uAmbient: { value: 0.2 }, uRamps: { value: 1 }, uDither: { value: 1 }, uSurfNoise: { value: 0.6 },
  uNightMul: { value: 1 }, uSteps: { value: STEPS }, uNumMats: { value: NMATS }, uTime: { value: 0 },
  uCutEnabled: { value: 1 }, uPlayerPix: { value: new THREE.Vector2() }, uPlayerViewZ: { value: -100 },
  uCutRadius: { value: 50 }, uCutMargin: { value: 0.5 }, uBrush: { value: new THREE.Vector3(0, 0, 0) },
  uTown: { value: new THREE.Vector4(0, 0, 1, 0) }, uTownShape: { value: new THREE.Vector3(C.WARD_W, C.WARD_AHEAD, C.WARD_BACK) },
  uThr: { value: C.WARD_THR },
  uArena: { value: new THREE.Vector3(C.ARENA_X, C.ARENA_Z, C.ARENA_R) } // the paved ring and the sand floor
};
var postMat = new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: null }, tNormal: { value: null }, tDepth: { value: null },
    uRes: { value: new THREE.Vector2(lowW, lowH) }, uOutline: { value: 1 }, uCreases: { value: 1 },
    uDepthThr: { value: 0.3 / (CAM_FAR - CAM_NEAR) }, uNormThr: { value: 0.4 }, uNight: { value: 0 }
  },
  vertexShader: SHADERS.postVert, fragmentShader: SHADERS.postFrag, depthTest: false, depthWrite: false
});
var postScene = new THREE.Scene();
var postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
postQuad.frustumCulled = false;
postScene.add(postQuad);
var postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function makeTarget(width, height, withDepth) {
  var rt = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat,
    depthBuffer: true, stencilBuffer: false
  });
  if (withDepth) {
    rt.depthTexture = new THREE.DepthTexture(width, height);
    rt.depthTexture.type = THREE.UnsignedIntType;
    rt.depthTexture.format = THREE.DepthFormat;
  }
  return rt;
}
// The presenter's view fits the ring: the largest pixels (the scale first, then 44 px tiles before 32) at
// which the arena's diameter and a tile each side fit both ways; a small window gets 24 px tiles. ?scale=
// or ?tilePx= on the URL pins that choice instead. The zoom is still a change of render target (rule 3).
var watchPinned = (function () { var q = new URLSearchParams(location.search); return q.has('scale') || q.has('tilePx'); })();
var WATCH_BOARD_PX = 420; // the board's width plus its margin, in CSS pixels: the ring is centred in what is left of the screen
// The presenter's view can be moved (2026-10-20, Bobby: leave it on the screen and pan, with no hero attached): a drag takes
// the ground along, WASD or the arrows slide it, the wheel or a pinch zooms (and the choice then sticks, watchPinned), and
// Home or 0 brings the fitted ring back. watchPan is the offset from the ring's centre, in tiles.
var watchPan = { x: 0, z: 0 }, watchDrag = null, WATCH_PAN_SPEED = 14; // tiles per second on the keys; a runner does 6.5
var watchPinnedUrl = watchPinned;
function watchFit(pw, ph) {
  if (watchPinned) return;
  var need = C.ARENA_R * 2 + 2, scales = [3, 2, 1], tiles = [44, 32], vert = S.oblique ? 1 : Math.sin(THREE.MathUtils.degToRad(S.elev));
  var avail = pw - WATCH_BOARD_PX * (window.devicePixelRatio || 1);
  for (var i = 0; i < scales.length; i++) for (var j = 0; j < tiles.length; j++) {
    var upp = Math.SQRT2 / tiles[j];
    if (avail / scales[i] * upp >= need && ph / scales[i] * upp / vert >= need) { S.scale = scales[i]; S.tilePx = tiles[j]; return; }
  }
  S.scale = 1; S.tilePx = 24;
}
function resize() {
  var dpr = window.devicePixelRatio || 1;
  var pw = Math.floor(window.innerWidth * dpr), ph = Math.floor(window.innerHeight * dpr);
  if (WATCH) { watchFit(pw, ph); document.body.dataset.watchFit = S.scale + '/' + S.tilePx; } // the choice, readable by the headless rig
  lowW = Math.max(32, Math.floor(pw / S.scale));
  lowH = Math.max(32, Math.floor(ph / S.scale));
  cw = lowW * S.scale; ch = lowH * S.scale;
  renderer.setSize(cw, ch, false);
  canvas.style.width = (cw / dpr) + 'px';
  canvas.style.height = (ch / dpr) + 'px';
  if (rtColor) { rtColor.dispose(); rtNormal.dispose(); }
  rtColor = makeTarget(lowW, lowH, true);
  rtNormal = makeTarget(lowW, lowH, false);
  postMat.uniforms.tColor.value = rtColor.texture;
  postMat.uniforms.tNormal.value = rtNormal.texture;
  postMat.uniforms.tDepth.value = rtColor.depthTexture;
  postMat.uniforms.uRes.value.set(lowW, lowH);
  shared.uRes.value.set(lowW, lowH);
  $('st-res').textContent = lowW + '×' + lowH;
  $('st-scale').textContent = S.scale;
}

// ------------------------------------------------------------------ materials & geometry helpers
function makeMat(opts) {
  opts = opts || {};
  var u = Object.assign({}, shared, {
    uCutout: { value: opts.cutout ? 1 : 0 },
    uGhost: { value: 0 },
    uFlash: { value: 0 },
    uSnapOrigin: { value: new THREE.Vector3() }
  });
  return new THREE.ShaderMaterial({
    uniforms: u, vertexShader: SHADERS.objVert, fragmentShader: SHADERS.objFrag,
    defines: opts.terrain ? { TERRAIN: 1 } : opts.shadow ? { SHADOW: 1 } : {},
    extensions: { derivatives: true }
  });
}
function flat(g) { var ng = g.index ? g.toNonIndexed() : g; ng.computeVertexNormals(); return ng; }
function boxPart(bw, bh, bd, x, y, z, mat) { var g = new THREE.BoxGeometry(bw, bh, bd); g.translate(x, y, z); return { g: g, mat: mat }; }
function part(g, mat) { return { g: g, mat: mat }; }
function mergeParts(parts) {
  var list = [], count = 0;
  parts.forEach(function (p) { var g = p.g.index ? p.g.toNonIndexed() : p.g; count += g.attributes.position.count; list.push({ g: g, mat: p.mat }); });
  var pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), mat = new Float32Array(count), o = 0;
  list.forEach(function (e) {
    var n = e.g.attributes.position.count;
    pos.set(e.g.attributes.position.array, o * 3);
    nor.set(e.g.attributes.normal.array, o * 3);
    mat.fill(e.mat, o, o + n);
    o += n;
  });
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 1));
  return geo;
}

// ------------------------------------------------------------------ scene
var scene = new THREE.Scene();
function addMesh(geo, opts) {
  var m = new THREE.Mesh(geo, makeMat(opts)); m.frustumCulled = false; return m;
}
function addProp(geo, x, y, z, opts) {
  opts = opts || {};
  var m = addMesh(geo, opts);
  m.position.set(x, y, z);
  if (opts.rot) m.rotation.y = opts.rot;
  if (opts.scale) m.scale.copy(opts.scale);
  m.material.uniforms.uSnapOrigin.value.copy(m.position);
  scene.add(m);
  return m;
}
function shadowMesh(rx, rz) { // stippled blob shadow that sits on the ground under a creature
  var g = new THREE.CircleGeometry(1, 12); g.rotateX(-Math.PI / 2); g.scale(rx, 1, rz); g.translate(0, 0.05, 0);
  return addMesh(mergeParts([part(g, M.DARK)]), { shadow: true });
}
function setSnapOrigin(group) {
  group.traverse(function (o) { if (o.material) o.material.uniforms.uSnapOrigin.value.copy(group.position); });
}

// terrain mesh mirrors w.base/delta/loose/faced
var V = w.V, N = w.N;
var tGeo = new THREE.BufferGeometry();
var tPos = new Float32Array(V * V * 3), tLoose = new Float32Array(V * V), tFaced = new Float32Array(V * V);
(function () {
  var idx = new Uint16Array(N * N * 6), p = 0;
  for (var j = 0; j < V; j++) for (var i = 0; i < V; i++) { var k = (j * V + i) * 3; tPos[k] = i - w.HALF; tPos[k + 2] = j - w.HALF; }
  for (var jj = 0; jj < N; jj++) for (var ii = 0; ii < N; ii++) {
    var a = jj * V + ii, b = a + 1, c = a + V, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b;
    idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  tGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  tGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(V * V * 3), 3));
  tGeo.setAttribute('aLoose', new THREE.BufferAttribute(tLoose, 1));
  tGeo.setAttribute('aFaced', new THREE.BufferAttribute(tFaced, 1));
})();
function syncTerrain() {
  if (!w.terrainDirty) return;
  for (var k = 0; k < V * V; k++) { tPos[k * 3 + 1] = w.base[k] + w.delta[k]; tLoose[k] = w.loose[k]; tFaced[k] = w.faced[k]; }
  tGeo.attributes.position.needsUpdate = true;
  tGeo.attributes.aLoose.needsUpdate = true;
  tGeo.attributes.aFaced.needsUpdate = true;
  tGeo.computeVertexNormals();
  SIM.measureSculpt(w);
  w.terrainDirty = false;
}
syncTerrain();
scene.add(addMesh(tGeo, { terrain: true }));
var waterGeo = new THREE.PlaneGeometry(N, N); waterGeo.rotateX(-Math.PI / 2);
addProp(mergeParts([part(waterGeo, M.WATER)]), 0, 0, 0);

// props: meshes built from the sim's plain descriptions
var treeGeo = mergeParts([
  part(flat(new THREE.CylinderGeometry(0.14, 0.2, 1.3, 6)).translate(0, 0.65, 0), M.WOOD),
  part(flat(new THREE.IcosahedronGeometry(1.0, 0)).scale(1, 1.25, 1).translate(0, 2.1, 0), M.LEAVES),
  part(flat(new THREE.IcosahedronGeometry(0.62, 0)).translate(0.35, 2.95, 0.2), M.LEAVES)
]);
var pineGeo = mergeParts([
  part(flat(new THREE.CylinderGeometry(0.12, 0.18, 1.0, 6)).translate(0, 0.5, 0), M.WOOD),
  part(flat(new THREE.ConeGeometry(1.1, 1.6, 6)).translate(0, 1.6, 0), M.LEAVES),
  part(flat(new THREE.ConeGeometry(0.8, 1.4, 6)).translate(0, 2.6, 0), M.LEAVES),
  part(flat(new THREE.ConeGeometry(0.5, 1.1, 6)).translate(0, 3.5, 0), M.LEAVES)
]);
var rockGeo = flat(new THREE.DodecahedronGeometry(0.5, 0));
var stoneGeo = mergeParts([boxPart(0.45, 1.4, 0.45, 0, 0.7, 0, M.ROCK), boxPart(0.3, 0.25, 0.3, 0, 1.5, 0, M.WOOL)]);
var PROP_BUILDERS = {
  tree: function (p) { addProp(treeGeo, p.x, p.y, p.z, { cutout: true, rot: p.rot, scale: new THREE.Vector3(p.scale, p.scale, p.scale) }); },
  pine: function (p) { addProp(pineGeo, p.x, p.y, p.z, { cutout: true, rot: p.rot, scale: new THREE.Vector3(p.scale, p.scale, p.scale) }); },
  rock: function (p) { addProp(mergeParts([part(rockGeo, M.ROCK)]), p.x, p.y, p.z, { rot: p.rot, scale: new THREE.Vector3(p.scale, p.scale * 0.65, p.scale * p.scaleZ) }); },
  house: function (p) {
    var WH = C.WALL_H, WT = C.WALL_T;
    function wallX(x0, x1, z) { return boxPart(x1 - x0, WH, WT, (x0 + x1) / 2 - p.x, WH / 2, z - p.z, M.PLASTER); }
    function wallZ(z0, z1, x) { return boxPart(WT, WH, z1 - z0, x - p.x, WH / 2, (z0 + z1) / 2 - p.z, M.PLASTER); }
    addProp(mergeParts([
      wallX(p.x0, p.x1, p.z0), wallX(p.x0, p.door[0], p.z1), wallX(p.door[1], p.x1, p.z1),
      wallZ(p.z0, p.z1, p.x0 + WT / 2), wallZ(p.z0, p.z1, p.x1 - WT / 2),
      boxPart(0.3, 0.6, WT, (p.door[0] + p.door[1]) / 2 - p.x, WH - 0.3, p.z1 - p.z, M.PLASTER) // lintel over the door
    ]), p.x, p.y, p.z, { cutout: true });
    addProp(mergeParts([boxPart(p.x1 - p.x0, 0.1, p.z1 - p.z0, 0, 0.05, 0, M.COBBLE)]), p.x, p.y, p.z);
  },
  path: function (p) { addProp(mergeParts([boxPart(p.w, 0.08, p.d, 0, 0.04, 0, M.COBBLE)]), p.x, p.y, p.z); },
  crate: function (p) {
    var parts = [boxPart(0.6, 0.6, 0.6, 0, 0.3, 0, M.WOOD)];
    if (p.stacked) parts.push(boxPart(0.5, 0.5, 0.5, 0.1, 0.85, 0.05, M.WOOD));
    addProp(mergeParts(parts), p.x, p.y, p.z, { rot: p.rot });
  },
  table: function (p) {
    addProp(mergeParts([
      boxPart(1.4, 0.08, 0.8, 0, 0.8, 0, M.WOOD), boxPart(0.08, 0.8, 0.08, -0.6, 0.4, -0.3, M.WOOD), boxPart(0.08, 0.8, 0.08, 0.6, 0.4, -0.3, M.WOOD),
      boxPart(0.08, 0.8, 0.08, -0.6, 0.4, 0.3, M.WOOD), boxPart(0.08, 0.8, 0.08, 0.6, 0.4, 0.3, M.WOOD)
    ]), p.x, p.y, p.z);
  },
  well: function (p) {
    addProp(mergeParts([
      part(flat(new THREE.CylinderGeometry(0.6, 0.65, 0.9, 8)).translate(0, 0.45, 0), M.ROCK),
      boxPart(0.1, 1.7, 0.1, -0.6, 0.85, 0, M.WOOD), boxPart(0.1, 1.7, 0.1, 0.6, 0.85, 0, M.WOOD),
      boxPart(1.7, 0.12, 1.3, 0, 1.75, 0, M.ROOF)
    ]), p.x, p.y, p.z, { cutout: true });
  },
  fence: function (p) {
    var parts = [], pw = p.w, pd = p.d;
    function post(x, z) { parts.push(boxPart(0.14, 1.0, 0.14, x, 0.5, z, M.WOOD)); }
    function railX(x0, x1, z) { parts.push(boxPart(x1 - x0, 0.08, 0.06, (x0 + x1) / 2, 0.75, z, M.WOOD)); parts.push(boxPart(x1 - x0, 0.08, 0.06, (x0 + x1) / 2, 0.4, z, M.WOOD)); }
    function railZ(z0, z1, x) { parts.push(boxPart(0.06, 0.08, z1 - z0, x, 0.75, (z0 + z1) / 2, M.WOOD)); parts.push(boxPart(0.06, 0.08, z1 - z0, x, 0.4, (z0 + z1) / 2, M.WOOD)); }
    for (var x = -pw / 2; x <= pw / 2; x += 1) { post(x, -pd / 2); if (Math.abs(x) > p.gap) post(x, pd / 2); }
    for (var z = -pd / 2; z <= pd / 2; z += 1) { post(-pw / 2, z); post(pw / 2, z); }
    railX(-pw / 2, pw / 2, -pd / 2); railX(-pw / 2, -p.gap, pd / 2); railX(p.gap, pw / 2, pd / 2);
    railZ(-pd / 2, pd / 2, -pw / 2); railZ(-pd / 2, pd / 2, pw / 2);
    addProp(mergeParts(parts), p.x, p.y, p.z);
  },
  sign: function (p) { addProp(mergeParts([boxPart(0.12, 1.6, 0.12, 0, 0.8, 0, M.WOOD), boxPart(0.9, 0.35, 0.06, 0.3, 1.35, 0, M.WOOD)]), p.x, p.y, p.z, { rot: p.rot }); },
  obelisk: function (p) { addProp(mergeParts([boxPart(0.6, 2.4, 0.6, 0, 1.2, 0, M.ROCK), boxPart(0.4, 0.3, 0.4, 0, 2.5, 0, M.ROCK)]), p.x, p.y, p.z, p.tall ? { scale: new THREE.Vector3(1.25, 1.5, 1.25) } : {}); }, // the gateposts stand taller
  lowwall: function (p) { addProp(mergeParts([boxPart(p.len, 1.6, 0.5, 0, 0.8, 0, M.ROCK), boxPart(p.len + 0.2, 0.2, 0.7, 0, 1.6, 0, M.ROCK)]), p.x, p.y, p.z, { rot: p.rot }); },
  arrowsign: function (p) { addProp(mergeParts([boxPart(0.12, 1.5, 0.12, 0, 0.75, 0, M.WOOD), boxPart(0.9, 0.3, 0.06, 0.35, 1.3, 0, M.ROOF), boxPart(0.25, 0.5, 0.06, 0.85, 1.3, 0, M.ROOF)]), p.x, p.y, p.z, { rot: p.rot }); },
  roundstone: function (p) { addProp(mergeParts([boxPart(1.0, 1.1, 1.0, 0, 0.55, 0, M.ROCK), boxPart(0.6, 0.2, 0.6, 0, 1.2, 0, M.SAND)]), p.x, p.y, p.z); },
  board: function (p) { // a notice board: two posts, a dark plank, a parchment face with a few pinned slips
    var parts = [boxPart(0.12, 1.7, 0.12, -0.6, 0.85, 0, M.WOOD), boxPart(0.12, 1.7, 0.12, 0.6, 0.85, 0, M.WOOD), boxPart(1.4, 0.9, 0.08, 0, 1.25, 0, M.WOOD), boxPart(1.2, 0.7, 0.04, 0, 1.25, 0.05, M.SAND)];
    [[-0.35, 1.35], [0.1, 1.4], [0.35, 1.1], [-0.15, 1.05]].forEach(function (s) { parts.push(boxPart(0.3, 0.22, 0.02, s[0], s[1], 0.08, M.WOOL)); });
    addProp(mergeParts(parts), p.x, p.y, p.z, { rot: p.rot });
  },
  chessboard: function (p) { // a flat checkered square; the game itself opens as an overlay
    var parts = [boxPart(0.96, 0.03, 0.96, 0, 0.015, 0, M.WOOD)], s = 0.9 / 8;
    for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) parts.push(boxPart(s, 0.02, s, (f - 3.5) * s, 0.04, (r - 3.5) * s, (r + f) % 2 ? M.WOOL : M.DARK));
    addProp(mergeParts(parts), p.x, p.y, p.z, { rot: p.rot });
  }
};
w.props.forEach(function (p) { var b = PROP_BUILDERS[p.kind]; if (b) b(p); });
w.items.forEach(function (it) { var b = PROP_BUILDERS[it.kind]; if (b) b(it); });

// wardstones: one mesh per dynamic obstacle, placed from the sim each frame
var wardstones = w.dynObs.slice(0, w.wardstones).map(function () { return addProp(stoneGeo, 0, 0, 0); });
function syncWardstones() {
  for (var i = 0; i < wardstones.length; i++) {
    var o = w.dynObs[i], m = wardstones[i];
    m.visible = o.r > 0;
    if (!m.visible) continue;
    m.position.set(o.x, SIM.heightAt(w, o.x, o.z), o.z);
    m.material.uniforms.uSnapOrigin.value.copy(m.position);
  }
}

// ------------------------------------------------------------------ creature visuals
function makeBiped(opts) {
  opts = opts || {};
  var torsoMat = opts.torso !== undefined ? opts.torso : M.RED;
  var legMat = opts.legs !== undefined ? opts.legs : M.BLUE;
  var g = new THREE.Group();
  var parts = [
    boxPart(0.5, 0.6, 0.3, 0, 0.9, 0, torsoMat),
    boxPart(0.34, 0.34, 0.34, 0, 1.4, 0, M.SKIN),
    boxPart(0.1, 0.1, 0.1, 0, 1.38, 0.21, M.SKIN),
    boxPart(0.14, 0.55, 0.14, -0.33, 0.9, 0, M.SKIN), boxPart(0.14, 0.55, 0.14, 0.33, 0.9, 0, M.SKIN)
  ];
  if (opts.helmet) parts.push(boxPart(0.4, 0.3, 0.4, 0, 1.62, 0, M.DARK), boxPart(0.06, 2.1, 0.06, 0.42, 1.05, 0.1, M.WOOD)); // helmet, spear
  else parts.push(boxPart(0.36, 0.12, 0.36, 0, 1.6, -0.02, M.DARK)); // hair
  var body = new THREE.Group(); g.add(body); g.add(shadowMesh(0.38, 0.3));
  var torso = addMesh(mergeParts(parts), {});
  body.add(torso);
  var legGeo = mergeParts([boxPart(0.2, 0.6, 0.22, 0, -0.3, 0, legMat)]);
  var legs = [];
  [[-0.14, 1], [0.14, -1]].forEach(function (c) {
    var l = addMesh(legGeo, {}); l.position.set(c[0], 0.6, 0); l.userData.ph = c[1]; body.add(l); legs.push(l);
  });
  return { group: g, body: body, legs: legs, torso: torso, legSwing: 0.7, poseT: -1 };
}
function makeHealer() { // a robed figure with a staff
  var g = new THREE.Group();
  var parts = [
    boxPart(0.56, 0.9, 0.36, 0, 0.75, 0, M.WOOL),               // robe
    boxPart(0.34, 0.34, 0.34, 0, 1.4, 0, M.SKIN),
    boxPart(0.1, 0.1, 0.1, 0, 1.38, 0.21, M.SKIN),
    boxPart(0.4, 0.14, 0.4, 0, 1.62, 0, M.WOOL),                 // hood
    boxPart(0.14, 0.55, 0.14, -0.33, 0.9, 0, M.WOOL), boxPart(0.14, 0.55, 0.14, 0.33, 0.9, 0, M.WOOL),
    boxPart(0.07, 2.0, 0.07, 0.45, 1.0, 0.15, M.WOOD), boxPart(0.18, 0.18, 0.18, 0.45, 2.05, 0.15, M.SAND) // staff with a bright knob
  ];
  var body = new THREE.Group(); g.add(body); g.add(shadowMesh(0.38, 0.3));
  var torso = addMesh(mergeParts(parts), {}); body.add(torso);
  var legGeo = mergeParts([boxPart(0.2, 0.4, 0.22, 0, -0.2, 0, M.WOOL)]);
  var legs = [];
  [[-0.14, 1], [0.14, -1]].forEach(function (c) { var l = addMesh(legGeo, {}); l.position.set(c[0], 0.4, 0); l.userData.ph = c[1]; body.add(l); legs.push(l); });
  return { group: g, body: body, legs: legs, torso: torso, legSwing: 0.4, poseT: -1 };
}
function makeQuad(kind) {
  var deer = kind === 'deer', bull = kind === 'bull';
  var bodyMat = deer ? M.FUR : bull ? M.DIRT : M.WOOL, headMat = deer ? M.FUR : bull ? M.DIRT : M.DARK, legMat = deer ? M.FUR : bull ? M.DIRT : M.DARK;
  var g = new THREE.Group();
  var bodyY = deer ? 0.85 : bull ? 0.95 : 0.6;
  var parts = bull ? [
    boxPart(1.5, 0.8, 0.8, 0, bodyY, 0, M.DIRT),                     // a heavy body
    boxPart(0.5, 0.5, 0.55, 0, bodyY + 0.1, 0.95, M.DIRT),           // head, low and forward
    boxPart(0.3, 0.1, 0.1, 0, bodyY - 0.05, 1.25, M.WOOL),           // muzzle
    boxPart(0.5, 0.08, 0.08, -0.4, bodyY + 0.35, 1.0, M.WOOL), boxPart(0.5, 0.08, 0.08, 0.4, bodyY + 0.35, 1.0, M.WOOL), // horns
    boxPart(0.08, 0.25, 0.08, -0.62, bodyY + 0.5, 1.0, M.WOOL), boxPart(0.08, 0.25, 0.08, 0.62, bodyY + 0.5, 1.0, M.WOOL),
    boxPart(0.9, 0.2, 0.7, 0, bodyY + 0.45, -0.1, M.DARK)            // the hump
  ] : [
    boxPart(deer ? 0.95 : 0.85, 0.48, deer ? 0.42 : 0.5, 0, bodyY, 0, bodyMat),
    boxPart(0.28, 0.28, 0.32, 0, bodyY + (deer ? 0.45 : 0.1), deer ? 0.55 : 0.5, headMat)
  ];
  if (deer) {
    parts.push(boxPart(0.2, 0.45, 0.2, 0, bodyY + 0.2, 0.42, M.FUR));
    parts.push(boxPart(0.05, 0.35, 0.05, -0.1, bodyY + 0.75, 0.55, M.DARK));
    parts.push(boxPart(0.05, 0.35, 0.05, 0.1, bodyY + 0.75, 0.55, M.DARK));
    parts.push(boxPart(0.2, 0.05, 0.05, -0.1, bodyY + 0.85, 0.55, M.DARK));
    parts.push(boxPart(0.2, 0.05, 0.05, 0.1, bodyY + 0.85, 0.55, M.DARK));
  }
  var body = new THREE.Group(); g.add(body); g.add(shadowMesh(bull ? 0.7 : deer ? 0.42 : 0.4, bull ? 0.9 : deer ? 0.6 : 0.55));
  var trunk = addMesh(mergeParts(parts), {}); body.add(trunk);
  var legH = deer ? 0.62 : bull ? 0.55 : 0.38;
  var legGeo = mergeParts([boxPart(bull ? 0.2 : 0.12, legH, bull ? 0.2 : 0.12, 0, -legH / 2, 0, legMat)]);
  var legs = [], lx = deer ? 0.3 : bull ? 0.5 : 0.28, lz = deer ? 0.3 : bull ? 0.5 : 0.25;
  [[-lx, lz, 1], [lx, lz, -1], [-lx, -lz, -1], [lx, -lz, 1]].forEach(function (c) {
    var l = addMesh(legGeo, {}); l.position.set(c[0], legH, c[1]); l.userData.ph = c[2]; body.add(l); legs.push(l);
  });
  return { group: g, body: body, legs: legs, torso: null, legSwing: 0.6, poseT: -1 };
}
// the floaters: a wisp is a bright core with shards about it; a wraith a tattered dark shape with a lit face. No legs: they hover
function makeFloater(kind) {
  var g = new THREE.Group(), wisp = kind === 'wisp', parts;
  if (wisp) parts = [
    boxPart(0.42, 0.42, 0.42, 0, 0, 0, M.MAGIC),                                     // the core
    boxPart(0.14, 0.14, 0.14, 0.38, 0.12, 0, M.SNOW), boxPart(0.14, 0.14, 0.14, -0.38, -0.08, 0.1, M.SNOW),
    boxPart(0.14, 0.14, 0.14, 0.05, 0.36, -0.3, M.SNOW), boxPart(0.12, 0.12, 0.12, -0.1, -0.34, -0.25, M.MAGIC),
    boxPart(0.2, 0.5, 0.2, 0, -0.5, -0.1, M.DARK)                                      // a dark tail beneath
  ]; else parts = [
    boxPart(0.7, 1.1, 0.5, 0, 0, 0, M.DARK),                                            // the shroud
    boxPart(0.5, 0.5, 0.3, 0, -0.75, 0.05, M.DARK), boxPart(0.25, 0.4, 0.2, -0.2, -1.1, 0.05, M.DARK), boxPart(0.25, 0.3, 0.2, 0.22, -1.05, 0.05, M.DARK), // tatters
    boxPart(0.46, 0.46, 0.46, 0, 0.75, 0.05, M.DARK), boxPart(0.3, 0.16, 0.1, 0, 0.78, 0.3, M.MAGIC),  // the hood and what glows within
    boxPart(0.18, 0.18, 0.7, -0.5, 0.15, 0.2, M.DARK), boxPart(0.18, 0.18, 0.7, 0.5, 0.15, 0.2, M.DARK), // arms reaching forward
    boxPart(0.14, 0.14, 0.14, -0.5, 0.15, 0.6, M.MAGIC), boxPart(0.14, 0.14, 0.14, 0.5, 0.15, 0.6, M.MAGIC)
  ];
  var body = new THREE.Group(); g.add(body); g.add(shadowMesh(wisp ? 0.3 : 0.45, wisp ? 0.3 : 0.4));
  var trunk = addMesh(mergeParts(parts), {}); body.add(trunk);
  return { group: g, body: body, legs: [], torso: null, legSwing: 0, poseT: -1, floater: true, hover: wisp ? 1.1 : 1.5 };
}
var vis = {}; // entity id -> visual
var SHIRTS = [M.RED, M.BLUE, M.LEAVES, M.ROOF, M.SAND, M.WOOL];
var labelsEl = $('labels');
function visualFor(e) {
  var v = vis[e.id];
  if (!v) {
    v = e.kind === 'player' ? makeBiped({ torso: SHIRTS[(e.color || 0) % SHIRTS.length] }) : e.kind === 'healer' ? makeHealer() : SIM.isFloater(e) ? makeFloater(e.kind) : makeQuad(e.kind);
    v.kind = e.kind;
    if (e.kind === 'player' || SIM.isMob(e) || e.kind === 'healer') {
      v.label = document.createElement('div'); v.label.className = 'lbl';
      v.label.innerHTML = '<span class="say" hidden></span><span class="unheard" hidden>nobody hears you</span><span class="nm"></span>';
      labelsEl.appendChild(v.label);
    }
    v.group.traverse(function (o) { o.frustumCulled = false; });
    scene.add(v.group);
    vis[e.id] = v;
  }
  return v;
}
function applyPose(v, e) {
  v.group.rotation.y = e.heading;
  var ph = e.moving ? e.walkPhase : 0, i;
  if (v.fallUntil && time < v.fallUntil) { // keeling over: the body tips forward onto the ground
    var k = Math.min(1, (0.45 - (v.fallUntil - time)) / 0.45);
    for (i = 0; i < v.legs.length; i++) v.legs[i].rotation.x = 0;
    v.body.rotation.x = -Math.PI / 2 * k; v.body.position.y = -0.1 * k;
    if (v.torso) v.torso.position.y = 0;
    return;
  }
  if (e.away) { // sitting on the ground, legs out: the player stepped away
    for (i = 0; i < v.legs.length; i++) v.legs[i].rotation.x = -Math.PI / 2;
    v.body.rotation.x = 0; if (v.torso) v.torso.position.y = 0;
    return;
  }
  if (v.floater) { v.body.rotation.x = e.moving ? 0.22 : 0; v.body.rotation.z = Math.sin(time * 1.7 + e.id) * 0.08; return; } // leans into its drift, sways
  if (e.air > 0.05) { // airborne: legs tucked
    for (i = 0; i < v.legs.length; i++) v.legs[i].rotation.x = -0.6 * (v.legs[i].userData.ph > 0 ? 1 : 0.5);
  } else {
    for (i = 0; i < v.legs.length; i++) v.legs[i].rotation.x = Math.sin(ph) * v.legSwing * (e.running ? 1.3 : 1) * v.legs[i].userData.ph;
  }
  v.body.rotation.x = e.running && e.moving ? 0.14 : 0; // lean into a run
  if (v.torso) v.torso.position.y = e.moving && e.air <= 0.05 ? Math.abs(Math.sin(ph)) * (e.running ? 0.09 : 0.06) : 0;
}
function setGhost(v, on) {
  if (v.ghost === on) return; v.ghost = on;
  v.group.traverse(function (o) { if (o.material && o.material.uniforms.uGhost) o.material.uniforms.uGhost.value = on ? 1 : 0; });
}
function setFlash(v, on) { // damage: the body goes white for a few frames
  if (v.flash === on) return; v.flash = on;
  v.group.traverse(function (o) { if (o.material && o.material.uniforms.uFlash) o.material.uniforms.uFlash.value = on ? 1 : 0; });
}
// bolts and walls of stone: short-lived meshes keyed by the sim's ids
var shotGeo = mergeParts([boxPart(0.22, 0.22, 0.5, 0, 0.9, 0, M.MAGIC), boxPart(0.1, 0.1, 0.4, 0, 0.9, -0.4, M.MAGIC)]);
var wallGeo = mergeParts([boxPart(2.2, 1.6, 0.6, 0, 0.8, 0, M.ROCK), boxPart(2.4, 0.2, 0.8, 0, 1.6, 0, M.ROCK)]);
// the wraith's line of fire: a row of flames of uneven heights along x, three rows swapped on the animation clock
// (rule 10: stepped, never eased); a low row of embers while it rises
function flameRow(seed, h) {
  var parts = [], n = Math.round(C.FIRE_LEN * 2);
  for (var i = 0; i < n; i++) {
    var x = (i + 0.5) / n * C.FIRE_LEN - C.FIRE_LEN / 2, k = Math.sin(i * 2.3 + seed * 1.7) * 0.5 + 0.5, fh = 0.2 + h * k;
    parts.push(boxPart(0.3, fh, 0.3, x, fh / 2, Math.sin(i * 1.1 + seed) * 0.15, M.FIRE));
  }
  return mergeParts(parts);
}
var fireGeos = [flameRow(0, 0.9), flameRow(1, 1.2), flameRow(2, 0.7)], emberGeo = flameRow(3, 0.05);
var shotVis = {}, wallVis = {};
// particles: bursts when a bolt hits, pops or dies; a pool of small bright cubes stepped by the client
var PART_GEO = { magic: mergeParts([boxPart(0.14, 0.14, 0.14, 0, 0, 0, M.MAGIC)]), blood: mergeParts([boxPart(0.16, 0.16, 0.16, 0, 0, 0, M.RED)]), fire: mergeParts([boxPart(0.14, 0.14, 0.14, 0, 0, 0, M.FIRE)]) };
var parts = [], partPool = { magic: [], blood: [], fire: [] };
function burst(x, z, n, speed, up, dirx, dirz, kind) {
  kind = kind || 'magic';
  var y = SIM.surfaceAt(w, x, z) + 0.9;
  for (var i = 0; i < n; i++) {
    var a = Math.random() * Math.PI * 2, s = speed * (0.5 + Math.random());
    var vx = Math.cos(a) * s + (dirx || 0) * speed * 0.6, vz = Math.sin(a) * s + (dirz || 0) * speed * 0.6;
    var m = partPool[kind].pop(); if (!m) { m = addMesh(PART_GEO[kind], {}); m.frustumCulled = false; m.userData.kind = kind; }
    m.visible = true; scene.add(m);
    parts.push({ m: m, x: x, y: y, z: z, vx: vx, vy: up * (0.6 + Math.random()), vz: vz, life: 0.35 + Math.random() * 0.25 });
  }
}
function stepParticles(dt) {
  for (var i = parts.length - 1; i >= 0; i--) {
    var p = parts[i]; p.life -= dt;
    if (p.life <= 0) { scene.remove(p.m); partPool[p.m.userData.kind].push(p.m); parts.splice(i, 1); continue; }
    p.vy -= 12 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.m.position.set(p.x, p.y, p.z); p.m.material.uniforms.uSnapOrigin.value.copy(p.m.position);
  }
}
function syncFx() {
  var seen = {}, i, id;
  for (i = 0; i < w.shots.length; i++) {
    var s = w.shots[i]; seen[s.id] = true;
    var m = shotVis[s.id];
    if (!m) { m = addMesh(shotGeo, {}); scene.add(m); shotVis[s.id] = m; }
    var sx = s.x + (s.ox || 0), sz = s.z + (s.oz || 0); // the eased remainder of the last snapshot's correction
    m.position.set(sx, SIM.surfaceAt(w, sx, sz), sz); m.rotation.y = Math.atan2(s.dx, s.dz);
    m.material.uniforms.uSnapOrigin.value.copy(m.position);
  }
  for (id in shotVis) if (!seen[id]) { scene.remove(shotVis[id]); delete shotVis[id]; }
  seen = {};
  for (i = 0; i < w.walls.length; i++) {
    var wl = w.walls[i]; seen[wl.id] = true;
    var fire = wl.k === 'fire' || wl.kind === 'fire';
    var age = wl.age !== undefined ? wl.age + (time - wl.at) : w.time - wl.from; // online: the snapshot's age plus the time since it came; offline: the sim's clock
    var geo = !fire ? wallGeo : age < C.FIRE_RISE ? emberGeo : fireGeos[Math.floor(time * S.animFps / 2) % fireGeos.length];
    var wm = wallVis[wl.id];
    if (!wm) { wm = addMesh(geo, { cutout: true }); scene.add(wm); wallVis[wl.id] = wm; }
    if (wm.geometry !== geo) wm.geometry = geo;
    wm.position.set(wl.x, SIM.surfaceAt(w, wl.x, wl.z), wl.z); wm.rotation.y = wl.angle;
    wm.material.uniforms.uSnapOrigin.value.copy(wm.position);
    if (fire && age >= C.FIRE_RISE && Math.random() < 0.2) { var fs = (Math.random() - 0.5) * C.FIRE_LEN; burst(wl.x + Math.cos(wl.angle) * fs, wl.z - Math.sin(wl.angle) * fs, 1, 0.3, 1.4, 0, 0, 'fire'); } // a lick of flame now and then, somewhere along the line
  }
  for (id in wallVis) if (!seen[id]) { scene.remove(wallVis[id]); delete wallVis[id]; }
}
// Ghosts are glimpsed, not watched: a living player sees another's ghost only while the ghost moves
// and the watcher stands still. Ghosts see each other, and everyone sees themselves.
function ghostVisible(e) { return e === P || P.ghost || (e.moving && !P.moving); }
function syncEntities() {
  var alive = {}, i;
  for (i = 0; i < w.ents.length; i++) {
    var e = w.ents[i], v = visualFor(e); alive[e.id] = true;
    setGhost(v, !!e.ghost);
    // a floater that has just shot hangs still for a moment and blinks white: hit it now
    var aiming = e.aim || (!NET.connected && SIM.isFloater(e) && e.rootUntil > w.time);
    setFlash(v, time < (v.flashUntil || 0) || (aiming && Math.floor(time * 6) % 2 === 0));
    v.group.visible = !e.ghost || ghostVisible(e);
    if (v.label) v.label.hidden = !v.group.visible;
    v.group.position.set(e.x, e.gy, e.z); // the group sits on the ground (shadow); the body rides above it
    var falling = v.fallUntil && time < v.fallUntil;
    if (!falling) v.body.position.y = e.away ? -0.55 : e.air + (v.floater ? v.hover + Math.sin(time * 2.2 + e.id) * 0.12 : 0); // an away body sits down; a floater bobs
    // animation is sampled on a coarse clock; position stays continuous (a fall is sampled every frame)
    if (falling || time - v.poseT >= 1 / S.animFps) { v.poseT = time; applyPose(v, e); }
    setSnapOrigin(v.group);
    ambientFor(v, e);
  }
  // visuals whose entity is gone: a death plays out as a corpse that keels over and sinks; anything else goes at once
  for (var id in vis) if (!alive[id]) {
    var c = vis[id];
    if (!c.dyingAt) { removeVisual(id); continue; }
    var t = time - c.dyingAt;
    if (t > 1.6) { removeVisual(id); continue; }
    var tip = Math.min(1, t / 0.4), sink = Math.max(0, (t - 0.7) / 0.9);
    c.body.rotation.z = Math.PI / 2 * tip; c.body.position.y = -0.2 * tip - 1.2 * sink;
    setGhost(c, sink > 0.3); if (c.label) c.label.hidden = true;
    setSnapOrigin(c.group);
  }
}
// the town guard: drawn from w.town while a guard is present
var guardVis = makeBiped({ torso: M.BLUE, legs: M.DARK, helmet: true });
guardVis.group.visible = false; guardVis.group.traverse(function (o) { o.frustumCulled = false; });
scene.add(guardVis.group);
function syncGuard() {
  var t = w.town;
  guardVis.group.visible = t.guardTimer > 0;
  if (!guardVis.group.visible) return;
  guardVis.group.position.set(t.guardX, SIM.surfaceAt(w, t.guardX, t.guardZ), t.guardZ);
  guardVis.group.rotation.y = t.guardHeading;
  setSnapOrigin(guardVis.group);
}
var toastEl = $('toast'), toastTimer = null;
function toast(msg, ms) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 2600);
}
function hitFlash() { document.body.classList.add('hit'); setTimeout(function () { document.body.classList.remove('hit'); }, 180); }
// the fight HUD: phase line and hearts at the top, a scoreboard when a round ends, spell buttons
// with cooldown rings while in the arena. It says what is, never what to do: the world is for
// exploring (Bobby 2026-10-17: no coddling), so the way to the arena is the signed trail, not a hint.
var myCd = null; // from the server; offline from P.cd
var lastTick = -1; // the last countdown second that sounded
function nameOf(id) { var e = id === P.id ? P : findEntity(id); return e && e.name ? e.name : 'someone'; }
function syncFight() {
  var r = w.round, here = SIM.inArena(P.x, P.z), zone = SIM.inZone(P.x, P.z);
  if (WATCH) syncWatch(r);
  // the only thing at the top is the scoreboard when a round ends, for those on the grounds: the zone
  // needs no label, the hearts float over a hurt player, the toasts say what the round does
  var show = r.phase === 'over' && (zone || WATCH);
  $('fight').hidden = !show;
  $('tb-mode').hidden = zone; // no digging on the arena grounds
  if (zone && S.mode === 'sculpt') setMode('walk');
  if (show) {
    var board = $('fight-board'); board.hidden = false;
    var rows = Object.keys(r.scores).map(function (id) { return { id: +id, s: r.scores[id] }; }).sort(function (a, b) { return b.s.elims - a.s.elims || b.s.hits - a.s.hits; });
    var top = rows.slice(0, 5), mine = rows.filter(function (x) { return x.id === P.id; })[0]; // fifty in the ring: the top five and your own line (2026-10-18)
    if (mine && top.indexOf(mine) < 0) top.push(mine);
    board.innerHTML = top.length ? top.map(function (x) { return '<div><b>' + x.s.elims + '</b> out · ' + x.s.hits + ' hits · ' + nameOf(x.id).replace(/</g, '&lt;') + '</div>'; }).join('') : '<div>no hits landed</div>';
  }
  var sp = $('spells'); sp.hidden = !(here && !P.ghost && !overlayOpen());
  document.body.classList.toggle('arena', !sp.hidden);
  if (r.phase === 'countdown' && (zone || WATCH)) { var sec = Math.ceil(r.t); if (sec !== lastTick) { lastTick = sec; SFX.play('countdown', { level: 0.7 }); } } else lastTick = -1; // one soft gong per second
  if (!sp.hidden) {
    var cdA = myCd ? myCd.arrow : Math.max(0, P.cd.arrow - w.time), el = $('sp-arrow');
    el.style.setProperty('--cd', (cdA / C.CD_ARROW).toFixed(2)); el.classList.toggle('ready', cdA <= 0);
  }
  // the arrow at the top: toward the healer for a ghost (being dead is a mechanic, the arrow is part of
  // it); else toward the nearest other player when they are out of sight (two players in a big world
  // need to find each other). Never toward the arena: the signed trail from the house is the way.
  var ar = $('arena-arrow'), goal = null, label = '';
  if (P.ghost) { var healer = w.ents.filter(function (e) { return e.kind === 'healer'; })[0]; if (healer) { goal = healer; label = 'healer'; } }
  else {
    var nearest = null, nd = 1e9;
    for (var pi = 0; pi < w.ents.length; pi++) { var o = w.ents[pi]; if (o === P || o.kind !== 'player' || o.away) continue; var d = Math.hypot(o.x - P.x, o.z - P.z); if (d < nd) { nd = d; nearest = o; } }
    if (nearest && nd > 10) { goal = nearest; label = nearest.name || 'player'; }
  }
  ar.hidden = overlayOpen() || !goal;
  if (!ar.hidden) {
    ar.lastChild.textContent = label;
    tmpV.set(goal.x, goal.gy, goal.z).project(camera);
    var ax = tmpV.x, ay = tmpV.y;
    tmpV.set(P.x, P.gy, P.z).project(camera);
    var ang = Math.atan2(-(ay - tmpV.y) * lowH, (ax - tmpV.x) * lowW) * 180 / Math.PI;
    $('arena-arrow-glyph').style.setProperty('--rot', ang.toFixed(0) + 'deg');
  }
}
function drainEvents() {
  for (var i = 0; i < w.events.length; i++) {
    var ev = w.events[i];
    if (ev.type === 'say') { var sp = ev.who === P.id ? P : findEntity(ev.who); if (sp) { sayLocal(sp, ev.text, sp === P && ev.heard === 0); SFX.play('say', { x: sp.x, z: sp.z, level: 0.5 }); } }
    if (ev.type === 'cast' && ev.spell === 'fire') { burst(ev.x, ev.z, 10, 1.5, 2, 0, 0, 'fire'); SFX.play('bolt splash', { x: ev.x, z: ev.z, rate: 0.6, level: 0.8 }); } // the wraith's fire: a low whoosh (the splash clip slowed) until a clip of its own is picked
    else if (ev.type === 'cast') { var ce = ev.who === P.id ? P : findEntity(ev.who); if (ce) { if (SIM.isFloater(ce)) SFX.play('floater shot', { x: ce.x, z: ce.z, rate: 0.7, jitter: 0.05 }); else SFX.play('bolt cast', { x: ce.x, z: ce.z, jitter: 0.06 }); } }
    if (ev.type === 'hit') { // damage: red sparks, the body flashes white, the victim's screen edge flashes
      burst(ev.x, ev.z, 12, 3.5, 3.5, 0, 0, 'blood');
      var hv = vis[ev.who]; if (hv) hv.flashUntil = time + 0.16;
      if (ev.who === P.id) { hitFlash(); SFX.play('player hurt', { jitter: 0.05 }); }
      else { var he = findEntity(ev.who); SFX.play(he && SIM.isFloater(he) ? 'floater hit' : 'bolt hit', { x: ev.x, z: ev.z, jitter: 0.06 }); }
    }
    if (ev.type === 'snort') { burst(ev.x, ev.z, 5, 1.2, 1.5, 0, 0, 'magic'); SFX.play('bull snort', { x: ev.x, z: ev.z, jitter: 0.1 }); }
    if (ev.type === 'splash') { burst(ev.x, ev.z, 10, 4, 4, -ev.dx, -ev.dz); SFX.play('bolt splash', { x: ev.x, z: ev.z, jitter: 0.08, level: 0.7 }); } // disintegrates against what it hit
    if (ev.type === 'pop') { burst(ev.x, ev.z, 6, 1.5, 3); SFX.play('bolt pop', { x: ev.x, z: ev.z, jitter: 0.1, level: 0.5 }); } // spent: a small pop
    if (ev.type === 'died') { burst(ev.x, ev.z, 28, 4, 5, 0, 0, ev.kind === 'bull' ? 'blood' : 'magic'); var dv = vis[ev.who]; if (dv) dv.dyingAt = time; SFX.play(ev.kind === 'bull' ? 'bull death' : 'floater death', { x: ev.x, z: ev.z, rate: ev.kind === 'bull' ? 1 : 0.8 }); }
    if (ev.type === 'fade') { burst(ev.x, ev.z, 16, 2, 3, 0, 0, 'magic'); SFX.play('floater death', { x: ev.x, z: ev.z, rate: 0.8, level: 0.5 }); } // nobody about: it thins into nothing
    if (ev.type === 'notice' && ev.target === P.id) { toast(ev.called ? 'The other ' + ev.kind + ' comes too.' : 'The ' + ev.kind + ' turns toward you.', 2500); SFX.play('notice', { level: 0.6 }); }
    if ((ev.type === 'down' || ev.type === 'elim') && vis[ev.who]) vis[ev.who].fallUntil = time + 0.45;
    if (ev.type === 'gore') SFX.play('bull gore', { x: ev.x, z: ev.z, jitter: 0.05 }); // the hit event carries the flash
    if (ev.type === 'down') { var de = ev.who === P.id ? P : findEntity(ev.who); SFX.play('player fall', { x: de ? de.x : undefined, z: de ? de.z : undefined, level: ev.who === P.id ? 1 : 0.8 }); }
    if (ev.type === 'down' && ev.who === P.id) toast('You are dead.', 4000);
    if (ev.type === 'revive') { burst(ev.x, ev.z, 16, 2, 4, 0, 0, 'magic'); SFX.play('heal', { x: ev.x, z: ev.z }); if (ev.who === P.id) toast('Life returns to you.', 2500); }
    if (ev.type === 'spawn' && SIM.inZone(P.x, P.z)) toast(ev.kind === 'bull' ? 'A bull paws the dirt.' : ev.kind === 'wisp' ? (ev.count > 1 ? 'Two wisps drift over the arena.' : 'A wisp drifts over the arena.') : 'A wraith rises.', 3000);
    if (ev.type === 'elim' && ev.who === P.id) toast(ev.by === null ? 'You left the ring.' : 'You have fallen.', 3500);
    if (ev.type === 'round') {
      if (ev.reason === 'stone-alone') toast('Nobody else is in the ring.', 2500); // the stone, used alone
      else if (ev.reason === 'stone-busy') toast('A round is already on.', 2500);
      else if (ev.reason === 'alone') { /* the countdown was called off: the strip says so */ }
      else if (ev.phase === 'countdown') toast(ev.seconds > 5 ? 'A fight is brewing in the arena.' : 'Ready yourselves.', ev.seconds > 5 ? 4000 : 2000);
      else if (ev.phase === 'fight') { toast('Fight!', 2000); SFX.play('round start'); }
      else if (ev.phase === 'over') { toast(ev.winner === null ? 'Nobody is left standing.' : ev.winner === P.id ? 'You stand alone. Victory.' : nameOf(ev.winner) + ' stands alone.', 5000); SFX.play('round win'); if (ev.winner === P.id) SFX.play('round win fanfare', { level: 0.8 }); }
    }
    if (ev.type === 'guard' && (ev.who === undefined || ev.who === P.id)) toast(ev.strength >= 0.75 ? 'Guards! The town stops you at once.' : 'A guard arrives from the town and stops you.');
  }
  w.events.length = 0;
}

// ------------------------------------------------------------------ camera
var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAM_NEAR, CAM_FAR);
var UPV = new THREE.Vector3(-1, 0, -1).normalize();     // screen-up on the ground plane
var RIGHTV = new THREE.Vector3(1, 0, -1).normalize();   // screen-right on the ground plane
var shearM = new THREE.Matrix4();
function placeCamera() {
  if (S.oblique) {
    camera.position.set(0, 120, 0);
    camera.up.copy(UPV);
  } else {
    var e = THREE.MathUtils.degToRad(S.elev), d = 120;
    camera.position.set(Math.cos(e) * d / Math.SQRT2, Math.sin(e) * d, Math.cos(e) * d / Math.SQRT2);
    camera.up.set(0, 1, 0);
  }
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
}
var tmpV = new THREE.Vector3();
function updateCamera() {
  var k = S.oblique ? S.kVert : 0;
  var upp = Math.SQRT2 / S.tilePx; // world units per game pixel (tile diagonal spans tilePx pixels)
  if (WATCH) tmpV.set(C.ARENA_X + watchPan.x, C.ARENA_Y + 0.8, C.ARENA_Z + watchPan.z); else tmpV.set(P.x, P.gy + 0.8, P.z); // the presenter's view sits over the ring, or where it was dragged
  tmpV.applyMatrix4(camera.matrixWorldInverse);
  var sx = tmpV.x + (WATCH ? WATCH_BOARD_PX * (window.devicePixelRatio || 1) / S.scale * 0.5 : leadX) * upp, sy = tmpV.y + k * tmpV.z + (WATCH ? 0 : leadY) * upp; // the presenter's view: the ring centred left of the board
  if (S.snapCam) { sx = Math.round(sx / upp) * upp; sy = Math.round(sy / upp) * upp; }
  var hw = lowW * 0.5 * upp, hh = lowH * 0.5 * upp;
  camera.left = sx - hw; camera.right = sx + hw; camera.top = sy + hh; camera.bottom = sy - hh;
  camera.updateProjectionMatrix();
  if (k !== 0) {
    shearM.set(1, 0, 0, 0, 0, 1, k, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    camera.projectionMatrix.multiply(shearM);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
}
// Ray through a canvas point; in oblique mode the ray is tilted so that y + k*z stays constant.
function pickGround(clientX, clientY) {
  var rect = canvas.getBoundingClientRect();
  var nx = ((clientX - rect.left) / rect.width) * 2 - 1, ny = -((clientY - rect.top) / rect.height) * 2 + 1;
  var origin = new THREE.Vector3(nx, ny, -1).unproject(camera);
  var k = S.oblique ? S.kVert : 0;
  var dir = new THREE.Vector3(0, k, -1).normalize().transformDirection(camera.matrixWorld);
  if (dir.y >= 0) return null;
  var t = Math.max(0, (origin.y - 9) / -dir.y), prev = t, p = new THREE.Vector3();
  for (var i = 0; i < 600; i++) {
    p.copy(origin).addScaledVector(dir, t);
    if (p.y < -8) return null;
    var inside = Math.abs(p.x) <= w.HALF && Math.abs(p.z) <= w.HALF;
    if (inside && p.y <= SIM.heightAt(w, p.x, p.z)) {
      var a = prev, b = t;
      for (var j = 0; j < 10; j++) { var m = (a + b) / 2; p.copy(origin).addScaledVector(dir, m); if (p.y <= SIM.heightAt(w, p.x, p.z)) b = m; else a = m; }
      return p.copy(origin).addScaledVector(dir, b).clone();
    }
    prev = t; t += 0.12;
  }
  return null;
}

// ------------------------------------------------------------------ input
var keys = {}, jumpQueued = false, castQueued = 0;
var mouse = { x: 0, y: 0, over: false, button: -1 };
// The lock (2026-10-17: aiming by facing with a thumb was "not fun"): a monster or player you tapped
// (hard), else the nearest monster in range with a clear line (soft). The arrow flies at it while it is
// within AIM_DEG of the way you face, and a reticle over it says so (grey outside the arc, out of reach or
// behind cover: the arrow then flies straight ahead). A hard lock drops when its mark dies, goes far, or is
// tapped again. The id rides on every input, so the server aims the same way.
var lock = { id: 0, hard: false };
function lockTarget() { return lock.id ? findEntity(lock.id) : null; }
function syncLock() {
  var t = lockTarget();
  if (lock.hard) { if (!t || t.ghost || t.away || Math.hypot(t.x - P.x, t.z - P.z) > C.SHOT_RANGE * 1.6) { lock.id = 0; lock.hard = false; } else return; }
  var best = null, bd = C.SHOT_RANGE;
  for (var i = 0; i < w.ents.length; i++) {
    var e = w.ents[i]; if (!SIM.isMob(e) || e.ghost) continue; // the soft lock only picks monsters: a fellow player standing near is not a target
    var d = Math.hypot(e.x - P.x, e.z - P.z);
    if (d < bd && SIM.clearLine(w, P.x, P.z, e.x, e.z)) { bd = d; best = e; }
  }
  lock.id = best ? best.id : 0;
}
// a monster or player under the pointer, by screen distance to its middle (a thumb gets a wider net)
function markAt(clientX, clientY) {
  var rect = canvas.getBoundingClientRect(), best = null, bd = TOUCH ? 44 : 26;
  var armed = SIM.inZone(P.x, P.z); // a player is a mark only on the arena grounds, where arrows fly; elsewhere a tap near a fellow player is a tap on the ground or the thing under it (2026-10-19: at the chess table every tap on the board locked the player across it, and the board never opened)
  for (var i = 0; i < w.ents.length; i++) {
    var e = w.ents[i]; if (e === P || (e.kind !== 'player' && !SIM.isMob(e)) || (e.kind === 'player' && !armed) || e.ghost || e.away) continue;
    tmpV.set(e.x, e.gy + e.air + (SIM.isFloater(e) ? 1.3 : 0.9), e.z).project(camera);
    var sx = rect.left + (tmpV.x + 1) * 0.5 * rect.width, sy = rect.top + (1 - tmpV.y) * 0.5 * rect.height, d = Math.hypot(sx - clientX, sy - clientY);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function syncReticle() {
  var el = $('reticle'), t = lockTarget(), show = !!t && !$('spells').hidden; // only while the spell is up: in the arena, alive
  el.hidden = !show; if (!show) return;
  var rect = canvas.getBoundingClientRect();
  tmpV.set(t.x, t.gy + t.air + (SIM.isFloater(t) ? 1.3 : 0.9), t.z).project(camera);
  el.style.transform = 'translate(' + Math.round(rect.left + (tmpV.x + 1) * 0.5 * rect.width) + 'px,' + Math.round(rect.top + (1 - tmpV.y) * 0.5 * rect.height) + 'px)';
  el.classList.toggle('hard', lock.hard);
  el.classList.toggle('out', !SIM.shootable(w, P, t) || !SIM.inArc(P, t, C.AIM_DEG)); // out of range, behind cover, or outside the arc you face: the arrow would fly straight ahead
}
window.addEventListener('keydown', function (ev) {
  if (ev.target && ev.target.tagName === 'INPUT') return;
  var k = ev.key.toLowerCase();
  if (overlayOpen()) { if (k === 'escape') { CHESS.hide(); BOARD.hide(); } return; } // an overlay has the keyboard
  if (k === 'enter') { ev.preventDefault(); openChat(); return; }
  if (k === 'tab') { ev.preventDefault(); if (S.mode === 'walk' && SIM.inZone(P.x, P.z)) { toast('The earth here will not be moved.'); return; } setMode(S.mode === 'walk' ? 'sculpt' : 'walk'); return; }
  if (k === 'h') { setOverlay('panel', $('panel').hidden); return; }
  if (k === 'k') { setOverlay('keys', $('keys').hidden); return; }
  if (k === '=' || k === '+') { setScale(S.scale + 1); return; }
  if (k === '-' || k === '_') { setScale(S.scale - 1); return; }
  if ((k === 'home' || k === '0') && WATCH) { watchPan.x = watchPan.z = 0; watchPinned = watchPinnedUrl; resize(); return; } // the presenter's view: back over the ring, fitted (or the URL's choice)
  if (k === 'r') { resetTerrain(); return; }
  if (k === ' ') { ev.preventDefault(); jumpQueued = true; return; }
  if (k === '1' || k === '2' || k === '3' || k === '4') { // walk mode: spells; sculpt mode: tools
    if (S.mode === 'sculpt') setTool(['raise', 'lower', 'stone', 'clear'][+k - 1]); else if (k === '1' && !ev.repeat) castQueued = 1;
    return;
  }
  keys[k] = true;
});
window.addEventListener('keyup', function (ev) { keys[ev.key.toLowerCase()] = false; });
window.addEventListener('blur', function () { keys = {}; mouse.button = -1; });
// no context menu anywhere but in a text field: on a phone the long press that opens one also buzzes, and a thumb
// resting on the stick is a long press (Bobby 2026-10-19: "a single vibrating pulse after about a second"; the
// canvas already refused the menu, the stick zone over it did not)
document.addEventListener('contextmenu', function (ev) { if (!(ev.target && ev.target.closest && ev.target.closest('input, textarea'))) ev.preventDefault(); });
// Pointer events with capture: while a button is held, moves and the release reach us even when the
// cursor leaves the window, so steering keeps working from the last known cursor position.
var pointers = {}, pinch = null; // active canvas pointers by id; two fingers = pinch zoom, never a tap
function pointerCount() { return Object.keys(pointers).length; }
function pinchDist() { var ids = Object.keys(pointers), a = pointers[ids[0]], b = pointers[ids[1]]; return Math.hypot(a.x - b.x, a.y - b.y); }
// The presenter's drag: the ground follows the cursor, so the camera's target goes the other way, from where the pan
// stood when the press began (never accumulated: several moves in one frame would count twice). World units per CSS
// pixel is itemAtScreen's ratio, and the screen's vertical is foreshortened by the elevation when not oblique (watchFit).
function watchPanTo(dx, dy) {
  var rect = canvas.getBoundingClientRect(), wpc = Math.SQRT2 / (S.scale * S.tilePx) * cw / rect.width;
  var vert = S.oblique ? 1 : Math.sin(THREE.MathUtils.degToRad(S.elev));
  var r = -dx * wpc, u = dy * wpc / vert;
  watchPan.x = watchDrag.px + r * RIGHTV.x + u * UPV.x; watchPan.z = watchDrag.pz + r * RIGHTV.z + u * UPV.z;
}
function watchDragEnd() { watchDrag = null; document.body.classList.remove('dragging'); }
canvas.addEventListener('pointerdown', function (ev) {
  pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events have no pointer to capture */ }
  if (pointerCount() >= 2) { pinch = { d0: pinchDist() }; mouse.button = -1; P.target = null; watchDragEnd(); return; }
  if (WATCH) { watchDrag = { x: ev.clientX, y: ev.clientY, px: watchPan.x, pz: watchPan.z }; document.body.classList.add('dragging'); return; } // the presenter's view: a press starts a drag of the ground, never a tap (its body stands at the spawn, out of reach of everything)
  mouse.x = ev.clientX; mouse.y = ev.clientY; mouse.over = true; mouse.button = ev.button;
  if (S.mode === 'walk' && ev.button === 0) {
    var mark = markAt(ev.clientX, ev.clientY); // a tap on a monster or player locks it (again: unlocks); never a walk
    if (mark) { if (lock.hard && lock.id === mark.id) { lock.hard = false; lock.id = 0; } else { lock.id = mark.id; lock.hard = true; } noteTap(ev, 'lock', mark.kind); return; }
    var hit = itemAtScreen(ev.clientX, ev.clientY); // the thing itself, judged on the screen: the ground ray fell through a raised thing to the ground behind it
    if (hit) { noteTap(ev, 'item', hit.kind); useItem(hit); return; }
    var p = pickGround(ev.clientX, ev.clientY);
    if (p) { var it = itemAt(p.x, p.z); if (it) { noteTap(ev, 'ground-item', it.kind); useItem(it); } else { noteTap(ev, 'walk', null, p); P.target = { x: p.x, z: p.z }; } } else noteTap(ev, 'none');
  }
});
// items: click one within reach to use it
function itemAt(x, z) {
  for (var i = 0; i < w.items.length; i++) { var it = w.items[i]; if (Math.hypot(it.x - x, it.z - z) < 0.8) return it; }
  return null;
}
// A tap on the thing itself, judged on the screen like a tap on a body (markAt). The ground ray fell through a
// raised thing (a board on a table, the arena's stone) to the ground behind it, in the oblique view about its
// height away, often more than itemAt's 0.8 tiles from the thing's foot, and the tap did nothing (2026-10-19,
// Bobby: "I have to tap multiple times"). The thing's body on the screen is the line from its foot to its top,
// as wide as it is (ITEM_SIZE: width, height in tiles), plus a thumb's slack; the stone stands a hundred pixels
// tall at 3x, so a point at its middle was not enough.
var ITEM_SIZE = { chessboard: [0.96, 0.1], roundstone: [1.0, 1.3], board: [1.3, 1.6] };
function itemAtScreen(clientX, clientY) {
  var rect = canvas.getBoundingClientRect(), best = null, bestD = 1e9, slack = TOUCH ? 16 : 8;
  var pxPerUnit = S.scale * S.tilePx / Math.SQRT2 * rect.width / cw; // CSS pixels per tile on the ground (rect.width / cw undoes the device pixel ratio)
  for (var i = 0; i < w.items.length; i++) {
    var it = w.items[i], size = ITEM_SIZE[it.kind] || [0.8, 0.8];
    tmpV.set(it.x, it.y, it.z).project(camera); var fx = rect.left + (tmpV.x + 1) * 0.5 * rect.width, fy = rect.top + (1 - tmpV.y) * 0.5 * rect.height;
    tmpV.set(it.x, it.y + size[1], it.z).project(camera); var tx = rect.left + (tmpV.x + 1) * 0.5 * rect.width, ty = rect.top + (1 - tmpV.y) * 0.5 * rect.height;
    var vx = tx - fx, vy = ty - fy, l2 = vx * vx + vy * vy || 1, u = clamp(((clientX - fx) * vx + (clientY - fy) * vy) / l2, 0, 1);
    var d = Math.hypot(clientX - (fx + vx * u), clientY - (fy + vy * u)) - size[0] * 0.5 * pxPerUnit;
    if (d < slack && d < bestD) { bestD = d; best = it; }
  }
  return best;
}
// the last taps, for the trace (?trace=1): what each one hit, and for a walk the nearest thing and how far off the ground point fell
var taps = [];
function noteTap(ev, hit, what, p) {
  var rec = { t: Math.round(time * 10) / 10, px: [Math.round(ev.clientX), Math.round(ev.clientY)], hit: hit, what: what || undefined };
  if (p) { var near = null, nd = 1e9; for (var i = 0; i < w.items.length; i++) { var d = Math.hypot(w.items[i].x - p.x, w.items[i].z - p.z); if (d < nd) { nd = d; near = w.items[i]; } } if (near && nd < 4) { rec.near = near.kind; rec.off = Math.round(nd * 100) / 100; } }
  taps.push(rec); if (taps.length > 8) taps.shift();
}
function useItem(it) {
  if (Math.hypot(it.x - P.x, it.z - P.z) > 2.5) { P.target = { x: it.x + 0.9, z: it.z + 0.9 }; toast('It is out of reach.'); return; }
  P.target = null;
  if (NET.connected) { NET.send({ t: 'use', item: it.id }); return; }
  if (it.kind === 'chessboard') { SIM.chessSit(it.state, P.id); CHESS.show(it.id, it.state, P.id); }
  if (it.kind === 'board') BOARD.show(it.id, it.state);
  if (it.kind === 'chessboard' || it.kind === 'board') SFX.play('board open');
  if (it.kind === 'roundstone') { var rr = SIM.startRound(w); if (rr !== 'ok') w.events.push({ type: 'round', phase: w.round.phase, reason: 'stone-' + rr, to: P.id }); } // offline the stone starts the round here
}
BOARD.init({
  onClose: function () { SFX.play('board close'); },
  send: function (op) {
    var id = BOARD.itemId();
    if (op.op === 'note') SFX.play('note pin');
    if (NET.connected) { NET.send(Object.assign({ t: 'board', item: id }, op)); return; }
    var it = SIM.findItem(w, id); if (!it) return;
    if (op.op === 'note' && SIM.pinNote(it.state, P.id, P.name, op.text, Date.now())) BOARD.update(id, it.state);
  }
});
function overlayOpen() { return CHESS.isOpen() || BOARD.isOpen() || welcomeOpen(); }
CHESS.init({
  nameOf: function (id) { var e = id === P.id ? P : findEntity(id); return e ? e.name : ''; },
  onClose: function (id) { SFX.play('board close'); if (NET.connected) NET.send({ t: 'board', item: id, op: 'stand' }); else { var it = SIM.findItem(w, id); if (it) SIM.chessStand(it.state, P.id); } },
  send: function (op) {
    var id = CHESS.itemId();
    if (op.op === 'move') SFX.play('chess piece', { jitter: 0.06 });
    if (NET.connected) { NET.send(Object.assign({ t: 'board', item: id }, op)); return; }
    var it = SIM.findItem(w, id); if (!it) return; // offline: the local sim is the server
    if (op.op === 'sit') SIM.chessSit(it.state, P.id);
    else if (op.op === 'stand') SIM.chessStand(it.state, P.id);
    else if (op.op === 'move') SIM.applyChessMove(it.state, P.id, op.from, op.to);
    else if (op.op === 'reset') SIM.chessReset(it.state, P.id, time);
    else if (op.op === 'turn') SIM.chessPassTurn(it.state, P.id);
    else if (op.op === 'back') SIM.chessTakeBack(it.state, P.id);
    else if (op.op === 'redo') SIM.chessRedo(it.state, P.id);
    CHESS.update(id, it.state);
  }
});
canvas.addEventListener('pointermove', function (ev) {
  if (pointers[ev.pointerId]) { pointers[ev.pointerId].x = ev.clientX; pointers[ev.pointerId].y = ev.clientY; }
  if (pinch && pointerCount() >= 2) { // pinch steps the zoom; a 30% change in finger distance is one step
    var d = pinchDist();
    if (d > pinch.d0 * 1.3) { setScale(S.scale + 1); pinch.d0 = d; }
    else if (d < pinch.d0 * 0.77) { setScale(S.scale - 1); pinch.d0 = d; }
    return;
  }
  if (WATCH && watchDrag) { if (ev.buttons) watchPanTo(ev.clientX - watchDrag.x, ev.clientY - watchDrag.y); else watchDragEnd(); return; }
  mouse.x = ev.clientX; mouse.y = ev.clientY; mouse.over = true;
  if (mouse.button >= 0 && ev.buttons === 0) mouse.button = -1; // released while we weren't told
});
function pointerGone(ev) { delete pointers[ev.pointerId]; if (pointerCount() < 2) pinch = null; if (pointerCount() === 0) { mouse.button = -1; watchDragEnd(); } }
canvas.addEventListener('pointerup', pointerGone);
canvas.addEventListener('pointercancel', pointerGone);
window.addEventListener('pointerup', function () { if (pointerCount() === 0) mouse.button = -1; });
canvas.addEventListener('pointerleave', function () { if (mouse.button < 0) mouse.over = false; });
canvas.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  if (S.mode === 'sculpt') setKey('brushR', clamp(S.brushR + (ev.deltaY < 0 ? 0.5 : -0.5), 1, 7));
  else setScale(S.scale + (ev.deltaY < 0 ? 1 : -1));
}, { passive: false });
window.addEventListener('resize', resize);

// Turn the current controls into one tick's intent for the sim. Pure input mapping; no world rules here.
function playerIntent() {
  var inp = { mx: 0, mz: 0, run: !!keys.shift, jump: jumpQueued, cast: castQueued, assist: TOUCH };
  jumpQueued = false; castQueued = 0;
  if (overlayOpen() || WATCH) { P.target = null; return inp; } // at the board: no walking; the presenter's view never moves
  var ix = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
  var iy = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
  if (ix || iy) {
    P.target = null;
    inp.mx = ix * RIGHTV.x + iy * UPV.x; inp.mz = ix * RIGHTV.z + iy * UPV.z;
  } else if (touch.active && (stickBandNow = stickBand()) !== 'stop') {
    // virtual stick: screen-relative like WASD; a creep within a hair of the centre when it is meant (stickBand), a run past 80%
    P.target = null;
    var tx = touch.dx, ty = -touch.dy;
    inp.mx = tx * RIGHTV.x + ty * UPV.x; inp.mz = tx * RIGHTV.z + ty * UPV.z;
    inp.run = inp.run || stickBandNow === 'run'; inp.creep = stickBandNow === 'creep';
    $('stick').classList.toggle('creep', inp.creep); // the knob dims while creeping
  } else if (S.mode === 'walk' && mouse.button === 2) {
    // UO steering: hold the right button and the character moves toward the cursor; far cursor = run.
    var rect = canvas.getBoundingClientRect();
    var sx = (mouse.x - (rect.left + rect.width / 2)) / rect.width * lowW;
    var sy = -(mouse.y - (rect.top + rect.height / 2)) / rect.height * lowH;
    var sd = Math.hypot(sx, sy);
    if (sd > 10) {
      P.target = null;
      inp.mx = sx * RIGHTV.x + sy * UPV.x; inp.mz = sx * RIGHTV.z + sy * UPV.z;
      inp.run = inp.run || sd > 2.6 * S.tilePx;
    }
  } else if (P.target) {
    inp.mx = P.target.x - P.x; inp.mz = P.target.z - P.z;
    if (Math.hypot(inp.mx, inp.mz) < 0.12) { P.target = null; inp.mx = inp.mz = 0; }
  }
  return inp;
}

// ------------------------------------------------------------------ touch layer (phones, tablets)
// MOBA layout: a floating stick appears wherever the left thumb lands, action buttons sit under the
// right thumb. Shown on coarse-pointer devices, on the first touch anywhere, or with ?touch=1.
var TOUCH = window.matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).get('touch') === '1';
var touch = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, mag: 0, band: 'dead', bandAt: 0, creepArmed: false };
var STICK_R = 56;
// The stick's bands, by deflection: a dead centre, a creep band within a hair of it, a walk, a run past 80%.
// The creep is a deliberate speed (Bobby 2026-10-19): on the way out of the centre it is granted only after
// the thumb has lingered in the band STICK_CREEP_MS, so a flick passes straight through to a walk or a run
// and nothing moves meanwhile; on the way back in from a walk or a run it is granted at once.
var STICK_DEAD = 0.15, STICK_CREEP = 0.45, STICK_RUN = 0.8, STICK_CREEP_MS = 150, stickBandNow = 'stop'; // STICK_CREEP 0.3 -> 0.45 the same day: the band was too narrow a hair to land in (Bobby)
function stickBand() {
  var m = touch.mag, b = m <= STICK_DEAD ? 'dead' : m <= STICK_CREEP ? 'creep' : m <= STICK_RUN ? 'walk' : 'run';
  if (b !== touch.band) { touch.creepArmed = b === 'creep' && touch.band !== 'dead'; touch.bandAt = time; touch.band = b; }
  if (b === 'creep' && !touch.creepArmed && time - touch.bandAt >= STICK_CREEP_MS / 1000) touch.creepArmed = true;
  return b === 'dead' ? 'stop' : b === 'creep' ? (touch.creepArmed ? 'creep' : 'stop') : b;
}
function enableTouchHud() {
  if (!$('touch').hidden) return;
  $('touch').hidden = false;
  document.body.classList.add('touchmode'); // only the controls on a phone; settings and legends stay desktop-only
  TOUCH = true;
  syncTouchHud();
  if (inputs) updateViewMode(); // before the UI is bound, init calls this itself
}
(function () {
  var zone = $('stick-zone'), stick = $('stick'), knob = $('stick-knob');
  zone.addEventListener('pointerdown', function (ev) {
    if (touch.active) return;
    ev.preventDefault();
    touch.active = true; touch.id = ev.pointerId; touch.cx = ev.clientX; touch.cy = ev.clientY; touch.dx = touch.dy = touch.mag = 0; touch.band = 'dead'; touch.bandAt = time; touch.creepArmed = false;
    try { zone.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
    stick.hidden = false; stick.style.left = ev.clientX + 'px'; stick.style.top = ev.clientY + 'px';
    knob.style.transform = 'translate(0px, 0px)';
  });
  zone.addEventListener('pointermove', function (ev) {
    if (!touch.active || ev.pointerId !== touch.id) return;
    var dx = ev.clientX - touch.cx, dy = ev.clientY - touch.cy, d = Math.hypot(dx, dy);
    if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; d = STICK_R; }
    touch.dx = dx / STICK_R; touch.dy = dy / STICK_R; touch.mag = d / STICK_R;
    knob.style.transform = 'translate(' + dx.toFixed(0) + 'px, ' + dy.toFixed(0) + 'px)';
  });
  function release(ev) { if (!touch.active || ev.pointerId !== touch.id) return; touch.active = false; touch.mag = 0; touch.band = 'dead'; stick.hidden = true; stick.classList.remove('creep'); stickBandNow = 'stop'; }
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);
  function tap(id, fn) {
    var b = $(id);
    b.addEventListener('pointerdown', function (ev) { ev.preventDefault(); fn(); });
    b.addEventListener('click', function (ev) { ev.preventDefault(); });
  }
  tap('tb-jump', function () { jumpQueued = true; });
  Array.prototype.forEach.call(document.querySelectorAll('#spells .spell'), function (b) {
    b.addEventListener('pointerdown', function (ev) { ev.preventDefault(); castQueued = +b.dataset.spell; });
    b.addEventListener('click', function (ev) { ev.preventDefault(); });
  });
  tap('tb-mode', function () { if (S.mode === 'walk' && SIM.inZone(P.x, P.z)) { toast('The earth here will not be moved.'); return; } setMode(S.mode === 'walk' ? 'sculpt' : 'walk'); });
  tap('tb-tool', function () { var tools = ['raise', 'lower', 'stone', 'clear']; setTool(tools[(tools.indexOf(S.tool) + 1) % tools.length]); });
  tap('tb-zoom', function () { setScale(S.scale >= 4 ? 2 : S.scale + 1); });
  tap('tb-sound', function () { setKey('sound', !S.sound); });
  $('tb-say').addEventListener('click', function (ev) { ev.preventDefault(); openChat(); });
})();
// Landscape-phone view presets. The 1:1 diamond spends 22 px of height per tile of depth, so a short,
// wide frame shows little of what's ahead. These are the candidate fixes, cycled on the device; they
// apply only while a touch device is held in landscape, and never on desktop or in portrait.
var VIEW_PRESETS = [
  { name: 'Current view', apply: function () {} },
  { name: 'Zoom out: 2x pixels', apply: function (d) { setScale(Math.max(1, d.scale - 1)); } },
  { name: 'Smaller tiles: 32 px', apply: function () { setKey('tilePx', 32); } },
  { name: 'Camera lead', apply: function () { S.lead = true; } },
  { name: 'Flatter: vertical 0.75', apply: function () { setKey('kVert', 0.75); } },
  { name: 'True ortho 30 deg', apply: function () { setProjection(false); setKey('elev', 30); } }
];
var viewDefaults = null;
S.view = 0; S.lead = false;
function applyView(i) {
  if (!viewDefaults) viewDefaults = { scale: S.scale, tilePx: S.tilePx, kVert: S.kVert, oblique: S.oblique, elev: S.elev };
  var d = viewDefaults;
  setKey('tilePx', d.tilePx); setKey('kVert', d.kVert); setKey('elev', d.elev); setProjection(d.oblique); setScale(d.scale); S.lead = false;
  VIEW_PRESETS[i].apply(d);
}
function updateViewMode() {
  var landscape = window.matchMedia('(orientation: landscape)').matches;
  var on = document.body.classList.contains('touchmode') && landscape;
  $('tb-view').hidden = !on;
  if (on) applyView(S.view);
  else if (viewDefaults) applyView(0); // portrait or desktop: exactly the settings the player had
}
$('tb-view').addEventListener('pointerdown', function (ev) {
  ev.preventDefault();
  S.view = (S.view + 1) % VIEW_PRESETS.length;
  applyView(S.view);
  toast((S.view + 1) + '/' + VIEW_PRESETS.length + ' ' + VIEW_PRESETS[S.view].name);
});
$('tb-view').addEventListener('click', function (ev) { ev.preventDefault(); });
// Full screen: Android browsers hide their bars on request; iPhones only drop them for a page launched
// from the home screen, so there the button explains that instead.
var standalone = window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || window.navigator.standalone === true;
function goFullscreen() {
  var el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (document.fullscreenElement) { (document.exitFullscreen || function () {}).call(document); return; }
  if (!req) { toast('Share, then Add to Home Screen: launched from there, there is no address bar.'); return; }
  var p = req.call(el, { navigationUI: 'hide' });
  if (p && p.catch) p.catch(function () { toast('Full screen is not allowed here. Add to Home Screen instead.'); });
}
$('tb-full').addEventListener('pointerdown', function (ev) { ev.preventDefault(); goFullscreen(); });
$('tb-full').addEventListener('click', function (ev) { ev.preventDefault(); });
if (standalone) $('tb-full').hidden = true; // already launched without browser chrome
document.addEventListener('fullscreenchange', function () { $('tb-full').textContent = document.fullscreenElement ? 'Exit' : 'Full'; });
if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(function () { /* not installable here; the page still works */ });
}
window.matchMedia('(orientation: landscape)').addEventListener('change', updateViewMode);
// camera lead: when a preset asks for it, the frame slides toward the direction of travel
var leadTX = 0, leadTY = 0, leadX = 0, leadY = 0; // game pixels
function updateLead(inp, dt) {
  if (S.lead && (inp.mx || inp.mz)) {
    var n = Math.hypot(inp.mx, inp.mz);
    leadTX = (inp.mx * RIGHTV.x + inp.mz * RIGHTV.z) / n * lowH * 0.18;
    leadTY = (inp.mx * UPV.x + inp.mz * UPV.z) / n * lowH * 0.22;
  } else { leadTX = leadTY = 0; }
  var k = 1 - Math.exp(-3 * dt);
  leadX += (leadTX - leadX) * k; leadY += (leadTY - leadY) * k;
}
// The presenter's keys: WASD or the arrows slide the view on the screen's axes, as they would walk a body.
function watchSteer(dt) {
  var ix = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0), iy = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
  if (!ix && !iy) return;
  var v = WATCH_PAN_SPEED * dt / Math.hypot(ix, iy);
  watchPan.x += (ix * RIGHTV.x + iy * UPV.x) * v; watchPan.z += (ix * RIGHTV.z + iy * UPV.z) * v;
}
function syncTouchHud() {
  if ($('touch').hidden) return;
  $('tb-mode').textContent = S.mode === 'sculpt' ? 'Digging' : 'Dig';
  $('tb-mode').classList.toggle('on', S.mode === 'sculpt');
  $('tb-tool').hidden = S.mode !== 'sculpt';
  $('tb-tool').textContent = S.tool;
  $('tb-zoom').textContent = 'Zoom ' + S.scale + '×';
  $('tb-sound').textContent = S.sound ? 'Sound' : 'Muted';
  $('tb-sound').classList.toggle('on', !S.sound);
}
if (TOUCH) enableTouchHud();
window.addEventListener('touchstart', enableTouchHud, { once: true, passive: true });

// ------------------------------------------------------------------ UI binding
var inputs = {};
Array.prototype.forEach.call(document.querySelectorAll('[data-key]'), function (el) {
  var key = el.dataset.key; inputs[key] = el;
  if (el.type === 'checkbox') el.checked = !!S[key]; else el.value = S[key];
  el.addEventListener('input', function () {
    var v = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
    S[key] = v; onSetting(key); showValue(key);
  });
  showValue(key);
});
function showValue(key) {
  var el = inputs[key]; if (!el || el.type === 'checkbox') return;
  var out = el.parentElement.querySelector('output'); if (!out) return;
  var v = S[key], txt;
  switch (key) {
    case 'scale': txt = v + '×'; break;
    case 'elev': case 'repose': case 'facing': txt = v + '°'; break;
    case 'animFps': txt = v + ' fps'; break;
    case 'brushR': txt = v.toFixed(1); break;
    case 'tilePx': txt = String(v); break;
    default: txt = v.toFixed(2);
  }
  out.textContent = txt;
}
function setKey(key, v) { S[key] = v; var el = inputs[key]; if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } onSetting(key); showValue(key); }
function onSetting(key) {
  if (key === 'scale') { resize(); syncTouchHud(); }
  if (key === 'oblique' || key === 'elev') placeCamera();
  if (key === 'oblique') { $('row-k').classList.toggle('disabled', !S.oblique); $('row-elev').classList.toggle('disabled', S.oblique); }
  if (key === 'sound') { SFX.setMuted(!S.sound); try { localStorage.setItem('mystica-sound', S.sound ? '1' : '0'); } catch (e) { /* storage blocked */ } syncTouchHud(); }
  applyTunables();
}
function setScale(v) { if (WATCH) watchPinned = true; setKey('scale', clamp(v, 1, 6)); } // the presenter's zoom sticks: watchFit would set it straight back
function setMode(m) {
  S.mode = m;
  canvas.classList.toggle('walk', m === 'walk');
  $('st-mode').textContent = m;
  $('k-click').textContent = m === 'walk' ? 'walk there' : S.tool + ' (right: lower)';
  $('k-wheel').textContent = m === 'walk' ? 'zoom' : 'brush size';
  Array.prototype.forEach.call(document.querySelectorAll('#modeseg button'), function (b) { b.classList.toggle('on', b.dataset.mode === m); });
  if (m === 'sculpt') P.target = null;
  syncTouchHud();
}
function setProjection(oblique) {
  S.oblique = oblique; onSetting('oblique');
  Array.prototype.forEach.call(document.querySelectorAll('#proj button'), function (b) { b.classList.toggle('on', (b.dataset.proj === '1') === oblique); });
}
function setTool(t) {
  S.tool = t;
  Array.prototype.forEach.call(document.querySelectorAll('#toolseg button'), function (b) { b.classList.toggle('on', b.dataset.tool === t); });
  if (S.mode === 'sculpt') $('k-click').textContent = t + ' (right: lower)';
  syncTouchHud();
}
function resetTerrain() { if (NET.connected) NET.send({ t: 'reset', admin: ADMIN }); else SIM.resetTerrain(w); }
Array.prototype.forEach.call(document.querySelectorAll('#modeseg button'), function (b) { b.addEventListener('click', function () { setMode(b.dataset.mode); }); });
Array.prototype.forEach.call(document.querySelectorAll('#toolseg button'), function (b) { b.addEventListener('click', function () { setTool(b.dataset.tool); }); });
Array.prototype.forEach.call(document.querySelectorAll('#proj button'), function (b) { b.addEventListener('click', function () { setProjection(b.dataset.proj === '1'); }); });
$('reset').addEventListener('click', resetTerrain);
// overlays: collapsible, and collapsed to start with on touch devices or narrow screens
function setOverlay(id, open) {
  $(id).hidden = !open;
  var t = $(id + '-toggle');
  if (id === 'panel') t.textContent = open ? 'close' : 'settings';
  t.setAttribute('aria-expanded', open ? 'true' : 'false');
}
$('panel-toggle').addEventListener('click', function () { setOverlay('panel', $('panel').hidden); });
$('keys-toggle').addEventListener('click', function () { setOverlay('keys', true); });
(function () {
  var small = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 900;
  setOverlay('panel', !small); setOverlay('keys', !small);
})();
// the welcome card: first visit only. Choosing a name steps you in; the server learns it at once.
function showWelcome() {
  $('welcome').hidden = false;
  var input = $('welcome-name'); input.value = ''; setTimeout(function () { input.focus(); }, 50);
  $('welcome-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var n = eventMode ? (P.name || myName || 'Wanderer') : input.value.trim().slice(0, 16); if (!n) return;
    myName = n; P.name = n;
    SFX.unlock(); // the button press is the gesture a phone wants before any sound
    try { localStorage.setItem('mystica-name', n); } catch (e) { /* storage blocked */ }
    if (NET.connected && !eventMode) NET.send({ t: 'name', name: n });
    $('welcome').hidden = true;
  });
}
function welcomeOpen() { return !$('welcome').hidden; }
function welcomeGiven(name) { // the event: the card tells you who you are instead of asking
  var input = $('welcome-name'); input.required = false; input.hidden = true;
  input.parentNode.textContent = 'Today you are ' + name + '.';
}
if (needsWelcome) showWelcome();
// the presenter's view: nothing on the screen but the world, the toasts, the round-end board and its own board
var tally = [], tallyDirty = true; // the session's leaderboard, from the server (watchers only)
if (WATCH) { document.body.classList.add('watch'); $('watch').hidden = false; }
function syncWatch(r) {
  var line;
  if (r.phase === 'countdown') line = 'Fight in ' + Math.ceil(r.t);
  else if (r.phase === 'fight') { var standing = 0; for (var i = 0; i < r.players.length; i++) if (!r.fallen[r.players[i]]) standing++; line = standing + ' standing of ' + r.players.length; }
  else if (r.phase === 'over') line = r.winner === null ? 'Nobody is left standing' : nameOf(r.winner) + ' stands alone';
  else { var n = 0; for (var k = 0; k < w.ents.length; k++) { var e = w.ents[k]; if (e.kind === 'player' && e !== P && !e.away && !e.ghost && SIM.inArena(e.x, e.z)) n++; } line = n ? n + ' in the ring' : 'The ring is empty'; }
  var el = $('watch-line'); if (el.textContent !== line) el.textContent = line;
  if (!tallyDirty) return;
  tallyDirty = false;
  $('watch-rows').innerHTML = tally.length ? tally.map(function (x, i) {
    return '<div><span class="n">' + (i + 1) + '</span><span class="who">' + String(x.name || 'someone').replace(/</g, '&lt;') + '</span><b>' + x.wins + '</b><span>' + x.outs + '</span><span>' + x.hits + '</span></div>';
  }).join('') : '<div class="empty">no blows yet</div>';
}
// keep keyboard focus off the controls so WASD and Space reach the game after clicking the panel
document.addEventListener('click', function (ev) { if (ev.target && ev.target.tagName === 'BUTTON') ev.target.blur(); });
Array.prototype.forEach.call(document.querySelectorAll('#panel input'), function (el) { el.addEventListener('change', function () { el.blur(); }); });
setMode(S.mode === 'sculpt' ? 'sculpt' : 'walk');
setTool(['raise', 'lower', 'stone', 'clear'].indexOf(S.tool) >= 0 ? S.tool : 'raise');
setProjection(!!S.oblique);
updateViewMode();

// ------------------------------------------------------------------ networking
// Offline (file://, the published artifact, a plain static server): the local sim is the world.
// Online: the server's sim is the world. This client predicts its own body from its inputs and
// reconciles against the server's acknowledged state; everything else is interpolated from snapshots.
var SNAP_DT = 0.1;
var pending = []; // inputs sent and not yet acknowledged; replayed on top of each server correction
var welcomed = false; // the welcome has named my body; a snapshot before it describes a world in which I am someone else
// A redeploy must not strand a phone on the old client (Bobby 2026-10-17). The server names the
// client's version, a hash of its files, in hello and at /version. The page learns its own from the
// first hello, polls every two minutes while visible, hears the new one on the reconnect a redeploy
// forces, and reloads only when its tab comes back to the front: never under the player's thumbs.
var clientVersion = '', staleClient = false;
function noteVersion(v) { if (!v) return; if (!clientVersion) clientVersion = v; else if (v !== clientVersion) staleClient = true; }
function checkVersion(reloadIfStale) {
  if (!location.host || location.protocol === 'file:') return;
  fetch('version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (j) noteVersion(j.version);
    if (reloadIfStale && staleClient) location.reload();
  }).catch(function () { /* offline: nothing to do */ });
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  if (staleClient) location.reload(); else checkVersion(true);
});
setInterval(function () { if (document.visibilityState === 'visible') checkVersion(false); }, 120000);
function onHello(m) {
  noteVersion(m.version);
  eventMode = !!m.event; BOARD.readOnly(eventMode);
  if (eventMode) { // no chat: the Say button goes, and every hint about talking
    $('tb-say').hidden = true; closeChat();
    Array.prototype.forEach.call(document.querySelectorAll('kbd + span'), function (sp) { if (/\b(say|talk)/i.test(sp.textContent)) { sp.hidden = true; sp.previousElementSibling.hidden = true; } });
    var p = document.querySelector('#welcome-form p'); if (p) p.textContent = 'A small world you can walk, dig and fight in. The rest is yours to find.';
  }
  if (m.seed !== w.seed) { var q = new URLSearchParams(location.search); q.set('seed', m.seed); location.search = q.toString(); return; }
  // drop the locally generated animals, the server's arrive by snapshot; then say who we are
  for (var i = w.ents.length - 1; i >= 0; i--) if (w.ents[i] !== P) { removeVisual(w.ents[i].id); w.ents.splice(i, 1); }
  pending.length = 0;
  welcomed = false;
  NET.send({ t: 'auth', token: myToken, name: myName, watch: WATCH ? 1 : 0 });
}
function onWelcome(m) { // the server's body is mine now: its id, its colour, and where it was last seen
  removeVisual(P.id);
  P.id = m.id; P.name = m.name; P.color = m.color;
  if (eventMode) { myName = m.name; try { localStorage.setItem('mystica-name', m.name); } catch (e) { /* storage blocked */ } if (welcomeOpen()) welcomeGiven(m.name); }
  // A snapshot that slipped in before this message (a reconnect from far away: the body was parked
  // and 250 ms is two snapshots) made a remote copy of my own body: sitting, away, sharing my visual
  // by id. Drop it and its visual, or the figure on screen is the copy and never moves.
  for (var j = w.ents.length - 1; j >= 0; j--) if (w.ents[j] !== P && w.ents[j].id === m.id) w.ents.splice(j, 1);
  removeVisual(m.id);
  welcomed = true;
  P.x = m.x; P.z = m.z; P.y = P.gy = SIM.surfaceAt(w, m.x, m.z); P.grounded = true; P.vy = 0; P.target = null;
  pending.length = 0;
  $('st-net').textContent = 'online';
  applyTunables();
  if (ARENA_PIN && ADMIN && !arenaPinSent) { arenaPinSent = true; NET.send({ t: 'admin', op: 'spawn', kind: ARENA_PIN, admin: ADMIN }); } // ?arena=wraith on the admin page: the server pins the arena, once per page load
}
function onItem(m) {
  var it = SIM.findItem(w, m.id); if (!it) return;
  it.state = m.state;
  if (it.kind === 'chessboard') SIM.chessUpgrade(it.state); // an older server sends boards without turns
  CHESS.update(it.id, it.state); BOARD.update(it.id, it.state);
  if (CHESS.isOpen() && CHESS.itemId() === it.id && Math.hypot(it.x - P.x, it.z - P.z) > 3.5) CHESS.hide();
}
function onOpen(m) {
  var it = SIM.findItem(w, m.id); if (!it) return;
  if (it.kind === 'chessboard') CHESS.show(it.id, it.state, P.id);
  if (it.kind === 'board') BOARD.show(it.id, it.state);
  SFX.play('board open');
}
function onTerrain(buf) { SIM.applyTerrainMessage(w, buf); }
function onSnapshot(m) {
  if (!welcomed) return; // before the welcome I cannot tell my own body apart (see onWelcome)
  var t = m.town, tw = w.town;
  tw.strength = t.strength; tw.facing = t.facing; tw.guardTimer = t.guardTimer; tw.guardX = t.guardX; tw.guardZ = t.guardZ; tw.guardHeading = t.guardHeading;
  w.repose = t.repose;
  reflectTunables(t);
  if (m.shots) { // the bolts fly on between snapshots (flyShots); a snapshot's correction is eased out of the drawn position
    var prev = {}; for (var si = 0; si < w.shots.length; si++) prev[w.shots[si].id] = w.shots[si];
    w.shots = m.shots;
    for (si = 0; si < w.shots.length; si++) { var sh = w.shots[si], ps = prev[sh.id]; if (ps) { sh.ox = ps.x + (ps.ox || 0) - sh.x; sh.oz = ps.z + (ps.oz || 0) - sh.z; } }
  }
  if (m.walls) { w.walls = m.walls; for (var wi = 0; wi < w.walls.length; wi++) w.walls[wi].at = time; } // at: when this snapshot's age was true, so the flames know when the embers catch
  if (m.round) w.round = m.round;
  if (m.cd) myCd = m.cd;
  if (m.tally) { tally = m.tally; tallyDirty = true; } // the session's leaderboard: watchers only
  var seen = {};
  for (var i = 0; i < m.ents.length; i++) {
    var s = m.ents[i]; seen[s.id] = true;
    if (s.id === P.id) { reconcile(s, m.ack); continue; }
    var e = findEntity(s.id);
    if (!e) {
      e = { id: s.id, kind: s.kind, name: s.name || '', color: s.color || 0, x: s.x, z: s.z, y: s.y, gy: s.y - s.air, air: s.air, heading: s.heading,
            moving: false, running: false, walkPhase: 0, driven: s.kind === 'player', local: false };
      w.ents.push(e);
    }
    e.name = s.name || '';
    e.net = { fx: e.x, fz: e.z, fy: e.y, fh: e.heading, fa: e.air, tx: s.x, tz: s.z, ty: s.y, th: s.heading, ta: s.air, t: 0 };
    e.moving = s.moving; e.running = s.running; e.creeping = !!s.cr; e.walkPhase = s.walkPhase; e.away = !!s.away; e.hp = s.hp; e.ghost = !!s.ghost; e.aim = !!s.aim;
  }
  for (var j = w.ents.length - 1; j >= 0; j--) { // gone from the world, or a stray copy of my own body
    var o = w.ents[j]; if (o === P || (seen[o.id] && o.id !== P.id)) continue;
    if (o.id !== P.id) removeVisual(o.id);
    w.ents.splice(j, 1);
  }
  for (var k = 0; k < m.events.length; k++) w.events.push(m.events[k]);
}
function reconcile(s, ack) {
  if (s.name !== undefined && s.name !== P.name) { P.name = s.name; myName = s.name; } // the authority's name for me (the event gives names; the admin may rename)
  var px = P.x, pz = P.z;
  P.x = s.x; P.z = s.z; P.y = s.y; P.vy = s.vy; P.grounded = s.grounded; P.jumpsLeft = s.jumpsLeft;
  P.hp = s.hp; P.ghost = !!s.ghost; P.away = false; // my own body is here, being driven: never render or treat it as away
  P.slide = s.sl | 0; if (s.as) P.avoidSide = s.as; P.stalled = !!s.st; // the authority's slide state, replayed from
  var pendingBefore = pending;
  pending = pending.filter(function (i) { return i.seq > ack; });
  // replay each input at the sim time it was made, so the casting root and the cooldown fall where they fell
  var now = w.time, keep = { progT: P.progT, px: P.px, pz: P.pz }; // the wedge detector's clock counted these inputs once already
  for (var i = 0; i < pending.length; i++) { w.time = pending[i].t || now; SIM.stepDriven(w, P, pending[i], pending[i].dt); }
  w.time = now; P.progT = keep.progT; P.px = keep.px; P.pz = keep.pz;
  // small disagreements are eased out over a few snapshots instead of snapping
  var err = Math.hypot(P.x - px, P.z - pz);
  if (TRACE) {
    var ackIn = null; for (var ai = 0; ai < pendingBefore.length; ai++) if (pendingBefore[ai].seq === ack) { ackIn = pendingBefore[ai]; break; }
    if (ackIn && ackIn.t) { var lag = w.time - ackIn.t; traceStats.lagSum += lag; traceStats.lagN++; if (lag > traceStats.lagMax) traceStats.lagMax = lag; }
    if (err > 0.05) traceStats.corr++; if (err >= 0.5) traceStats.big++; if (err > traceStats.maxErr) traceStats.maxErr = err; traceStats.sumErr += err;
    if (err > 0.3 && traceStats.ev.length < 12) traceStats.ev.push({ t: Math.round(w.time * 100) / 100, e: Math.round(err * 100) / 100, s: [Math.round(s.x * 100) / 100, Math.round(s.z * 100) / 100], p: [Math.round(px * 100) / 100, Math.round(pz * 100) / 100], n: [Math.round(P.x * 100) / 100, Math.round(P.z * 100) / 100], ack: ack, pend: pending.length });
  }
  if (window.__dbg) window.__dbg.push({ t: w.time, ack: ack, pend: pending.length, firstT: pending.length ? pending[0].t : null, lastT: pending.length ? pending[pending.length - 1].t : null, sx: s.x, sz: s.z, px: px, pz: pz, nx: P.x, nz: P.z, err: err, rf: P.rootFrom, ru: P.rootUntil, casts: pending.filter(function (i) { return i.cast; }).length }); // a probe for the headless rig (jitter-check)
  if (err < 0.5) { P.x = px + (P.x - px) * 0.35; P.z = pz + (P.z - pz) * 0.35; }
}
function interpolateRemotes(dt) {
  for (var i = 0; i < w.ents.length; i++) {
    var e = w.ents[i]; if (e === P || !e.net) continue;
    var n = e.net; n.t += dt; var a = Math.min(1, n.t / SNAP_DT);
    e.x = n.fx + (n.tx - n.fx) * a; e.z = n.fz + (n.tz - n.fz) * a; e.y = n.fy + (n.ty - n.fy) * a; e.air = n.fa + (n.ta - n.fa) * a;
    e.gy = e.y - e.air;
    var dh = ((n.th - n.fh + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    e.heading = n.fh + dh * a;
  }
}
// Online the server steps the bolts and a snapshot carries where they are. Between snapshots they fly
// on here at their known speed and hold at a wall or a body (the snapshot will remove them); a
// snapshot's correction (ox, oz) is eased out of the drawn position over about 60 ms (syncFx).
function flyShots(dt) {
  var k = Math.exp(-dt / 0.06);
  for (var i = 0; i < w.shots.length; i++) {
    var s = w.shots[i], step = (s.v || C.SHOT_SPEED) * dt, nx = s.x + s.dx * step, nz = s.z + s.dz * step, blocked = false; // each bolt at its own speed: a player's arrow outruns a monster's bolt
    if (SIM.barrierAt(w, nx, nz, 0.1) > SIM.surfaceAt(w, nx, nz) + 0.3) blocked = true;
    else for (var j = 0; j < w.ents.length && !blocked; j++) {
      var t = w.ents[j];
      if (t.id === s.o || (t.kind !== 'player' && !SIM.isMob(t)) || t.ghost || t.away || (s.m && SIM.isMob(t))) continue;
      if (Math.hypot(t.x - nx, t.z - nz) <= C.SHOT_RADIUS + ((t.radius || C.BODY_R) - C.BODY_R)) blocked = true;
    }
    if (!blocked) { s.x = nx; s.z = nz; }
    if (s.ox) { s.ox *= k; s.oz *= k; }
  }
}
function findEntity(id) { for (var i = 0; i < w.ents.length; i++) if (w.ents[i].id === id) return w.ents[i]; return null; }
function removeVisual(id) { var v = vis[id]; if (!v) return; scene.remove(v.group); if (v.label) v.label.remove(); delete vis[id]; }
// names and speech float over heads: project each player's head to canvas pixels after the camera moves
function syncLabels() {
  var rect = canvas.getBoundingClientRect();
  for (var i = 0; i < w.ents.length; i++) {
    var e = w.ents[i], v = vis[e.id]; if (!v || !v.label) continue;
    tmpV.set(e.x, e.gy + e.air + (e.kind === 'bull' ? 1.9 : e.kind === 'wisp' ? 2.1 : e.kind === 'wraith' ? 2.9 : 2.0), e.z).project(camera);
    var sx = rect.left + (tmpV.x + 1) * 0.5 * rect.width, sy = rect.top + (1 - tmpV.y) * 0.5 * rect.height;
    v.label.style.transform = 'translate(' + Math.round(sx) + 'px,' + Math.round(sy) + 'px) translate(-50%,-100%)';
    var nm = v.label.lastChild, say = v.label.firstChild;
    var nameText = (e.name || '') + (e.away ? ' (away)' : '') + (e.ghost ? ' (ghost)' : '');
    if (e.kind === 'player' && (w.round.phase === 'fight' || w.round.phase === 'over') && (w.round.fallen[e.id] || w.round.players.indexOf(e.id) < 0)) nameText = '☠ ' + nameText; // fallen or late: cannot win
    if (SIM.isMob(e) || (e.kind === 'player' && !e.ghost && e.hp < (e.maxHp || C.HP))) { // hearts over a monster always, over a hurt player
      var bh = '', mh = e.maxHp || C.HP;
      for (var q = 0; q < mh; q++) bh += q < e.hp ? '♥' : '♡';
      nameText = SIM.isMob(e) ? bh : nameText + ' ' + bh;
    }
    if (nm.textContent !== nameText) { nm.textContent = nameText; nm.classList.toggle('away', !!e.away); }
    var talking = e.say && time < e.sayUntil;
    say.hidden = !talking;
    if (talking && say.textContent !== e.say) say.textContent = e.say;
    var unheard = v.label.querySelector('.unheard');
    unheard.hidden = !(talking && e.sayUnheard);
  }
}
function sayLocal(e, text, unheard) { e.say = text; e.sayUntil = time + 3 + text.length * 0.06; e.sayUnheard = !!unheard; }
// chat: Enter opens the box, Enter sends, Esc cancels. Offline the words just appear over your head.
var chatEl = $('chat');
function openChat() { if (eventMode) return; $('chat-wrap').hidden = false; chatEl.value = ''; chatEl.focus(); } // the event: no chat
function closeChat() { $('chat-wrap').hidden = true; chatEl.blur(); }
chatEl.addEventListener('keydown', function (ev) {
  ev.stopPropagation();
  if (ev.key === 'Escape') { closeChat(); return; }
  if (ev.key !== 'Enter') return;
  var text = chatEl.value.trim().slice(0, 120);
  closeChat();
  if (!text) return;
  if (NET.connected) NET.send({ t: 'say', text: text }); else sayLocal(P, text, true);
});
// phones: a Send button, and the box rides above the on-screen keyboard
$('chat-send').addEventListener('click', function () { chatEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
if (window.visualViewport) {
  var placeChat = function () {
    var vv = window.visualViewport, bottom = window.innerHeight - (vv.offsetTop + vv.height);
    $('chat-wrap').style.bottom = Math.max(0, bottom) + (TOUCH ? 12 : 120) + 'px';
  };
  window.visualViewport.addEventListener('resize', placeChat);
  window.visualViewport.addEventListener('scroll', placeChat);
  placeChat();
}
function reflectTunables(t) { // another client may have moved a shared slider; show it without re-sending
  var deg = Math.round(t.facing * 180 / Math.PI);
  if (S.ward !== t.strength) { S.ward = t.strength; if (inputs.ward) inputs.ward.value = t.strength; showValue('ward'); }
  if (S.facing !== deg) { S.facing = deg; if (inputs.facing) inputs.facing.value = deg; showValue('facing'); }
  if (S.repose !== t.repose) { S.repose = t.repose; if (inputs.repose) inputs.repose.value = t.repose; showValue('repose'); }
}
NET.connect({ onHello: onHello, onWelcome: onWelcome, onTerrain: onTerrain, onSnapshot: onSnapshot, onItem: onItem, onOpen: onOpen,
  onClose: function () { $('st-net').textContent = 'local'; w.clientMode = false; welcomed = false; CHESS.hide(); } });

// ------------------------------------------------------------------ frame
var time = 0, last = performance.now(), fpsAvg = 60, statT = 0;
function update(dt) {
  // 1. player intent: predicted locally, and sent to the server when connected
  syncLock();
  var inp = playerIntent();
  if (window.__drive) { inp.mx = window.__drive.mx; inp.mz = window.__drive.mz; inp.run = !!window.__drive.run; P.target = null; } // the headless rig drives the body at any angle
  inp.seq = NET.nextSeq(); inp.dt = dt; inp.target = lock.id;
  if (inp.cast && lock.id) { var lt = lockTarget(); if (lt && SIM.inArc(P, lt, C.AIM_DEG)) P.heading = P.targetHeading = Math.atan2(lt.x - P.x, lt.z - P.z); } // turn to the mark at once when it is within the arc; the server does the same
  updateLead(inp, dt);
  if (WATCH) watchSteer(dt);
  var online = NET.connected && $('st-net').textContent === 'online'; // welcomed: the server has a body for us
  // the bolt is never predicted: online the server casts it and it arrives in the snapshot. The casting
  // root and the cooldown are (castSpell in client mode), so the body stops where the server will stop it.
  var local = inp;
  SFX.listen(WATCH ? C.ARENA_X + watchPan.x : P.x, WATCH ? C.ARENA_Z + watchPan.z : P.z); // the presenter's view listens from where it looks
  if (inp.jump && P.grounded && !overlayOpen()) SFX.play('jump', { level: 0.3, lowpass: 900, attack: 0.03, rate: 0.9, cool: 0.2 }); // soft and muffled: a body, not a hit
  var wasGrounded = P.grounded;
  if (!SIM.stepDriven(w, P, local, dt)) P.target = null; // walked into something: drop a click target
  landedNow = !wasGrounded && P.grounded;
  if (landedNow && SIM.depthAt(w, P.x, P.z) <= WADE_MIN) SFX.play('land', { level: 0.22, lowpass: 500, attack: 0.03, rate: 0.85, cool: 0.2 }); // a landing in water is the splash (stepSounds), not a thud
  stepSounds();
  if (online && !WATCH) { // the presenter's view sends nothing: its body stands where it was born
    local.t = w.time; pending.push(local); if (pending.length > 300) pending.shift(); // t: replayed at the time it was made (reconcile)
    NET.send({ t: 'in', seq: inp.seq, dt: dt, mx: inp.mx, mz: inp.mz, run: inp.run, creep: inp.creep || undefined, jump: inp.jump, cast: inp.cast, assist: inp.assist, target: inp.target });
  }
  // 2. sculpt intent: the server (or, offline, the local sim) gives the guards their say
  var brush = shared.uBrush.value; brush.z = 0;
  if (S.mode === 'sculpt' && mouse.over) {
    var hit = pickGround(mouse.x, mouse.y);
    if (hit) {
      brush.set(hit.x, hit.z, S.brushR);
      var tool = mouse.button === 2 ? 'lower' : mouse.button === 0 ? S.tool : null;
      if (tool) {
        SFX.play(tool === 'stone' ? 'stone place' : 'dig', { cool: 0.22, jitter: 0.1, levelJitter: 0.2, level: 0.7 }); // a pick striking while the brush is held
        if (NET.connected) NET.send({ t: 'sculpt', x: hit.x, z: hit.z, tool: tool, dt: dt, r: S.brushR });
        else SIM.sculptAttempt(w, P, hit.x, hit.z, tool, dt, S.brushR);
      }
    }
  }
  // 3. the world's own business: offline everything, online only derived state (the server owns the rest)
  w.clientMode = NET.connected;
  SIM.simStep(w, dt);
  if (NET.connected) { interpolateRemotes(dt); flyShots(dt); }
  drainEvents();
  stepParticles(dt);
}
function syncVisuals() {
  syncTerrain();
  syncEntities();
  syncGuard();
  syncWardstones();
  syncFx();
  syncFight();
}

function render() {
  updateCamera();
  syncLabels();
  syncReticle();
  shared.uTime.value = Math.floor(time * S.animFps) / S.animFps;
  shared.uSnap.value = S.snapObj ? 1 : 0;
  shared.uRamps.value = S.ramps ? 1 : 0;
  shared.uDither.value = S.dither;
  shared.uSurfNoise.value = S.surfNoise;
  shared.uNightMul.value = 1 - 0.6 * S.night;
  shared.uCutEnabled.value = S.cutout ? 1 : 0;
  shared.uCutRadius.value = S.tilePx * 1.3;
  shared.uTown.value.set(w.town.x, w.town.z, w.town.strength, w.town.facing);
  tmpV.set(P.x, P.gy + 0.8, P.z).applyMatrix4(camera.matrixWorldInverse);
  shared.uPlayerViewZ.value = tmpV.z;
  tmpV.set(P.x, P.gy + 0.8, P.z).project(camera);
  shared.uPlayerPix.value.set((tmpV.x + 1) * 0.5 * lowW, (tmpV.y + 1) * 0.5 * lowH);
  postMat.uniforms.uOutline.value = S.outline ? 1 : 0;
  postMat.uniforms.uCreases.value = S.creases ? 1 : 0;
  postMat.uniforms.uNight.value = S.night;

  shared.uPass.value = 0;
  renderer.setRenderTarget(rtColor);
  renderer.setClearColor(0x000000, 1); renderer.clear(true, true, false);
  renderer.render(scene, camera);

  shared.uPass.value = 1;
  renderer.setRenderTarget(rtNormal);
  renderer.setClearColor(0x8080ff, 1); renderer.clear(true, true, false);
  renderer.render(scene, camera);

  renderer.setRenderTarget(null);
  renderer.render(postScene, postCam);
}

function step(now, draw) {
  var raw = (now - last) / 1000, dt = Math.min(raw, 0.05); last = now; time += dt; // 0.05 is the cap the server puts on an input's dt: a slow frame is predicted the way it will be applied
  if (TRACE) { traceStats.frames++; if (raw > traceStats.dtMax) traceStats.dtMax = raw; if (raw > 0.05) traceStats.slow++; }
  update(dt);
  syncVisuals();
  if (draw) render();
  fpsAvg += (1 / Math.max(dt, 1e-3) - fpsAvg) * 0.05;
  if ((statT += dt) > 0.25) {
    statT = 0;
    $('st-fps').textContent = Math.round(fpsAvg);
    $('st-vol').textContent = w.sculptVolume.toFixed(1);
    var wf = SIM.wardAt(w, P.x, P.z);
    $('st-ward').textContent = wf.toFixed(2) + (wf >= C.WARD_THR ? ' warded' : ' wilds');
  }
}
var lastFrameT = 0;
function frame(now) {
  // phones: 30 fps is plenty for a 10 fps-animated world and halves the heat
  if (TOUCH && now - lastFrameT < 28) { requestAnimationFrame(frame); return; }
  lastFrameT = now;
  step(now, true);
  requestAnimationFrame(frame);
}
// Browsers pause requestAnimationFrame in background tabs. Keep simulating at 20 Hz without drawing
// (50 ms steps: the most the server applies per input), as a networked client would have to anyway.
setInterval(function () { if (document.hidden) step(performance.now(), false); }, 50);
if (TRACE) setInterval(function () {
  if (!NET.connected || $('st-net').textContent !== 'online') return;
  var ts = traceStats, r2 = function (v) { return Math.round(v * 100) / 100; };
  NET.send({ t: 'trace', v: clientVersion, ua: navigator.userAgent.slice(0, 60), touch: TOUCH, view: [innerWidth, innerHeight], fps: Math.round(fpsAvg),
    frames: ts.frames, dtMax: r2(ts.dtMax), slow: ts.slow, corr: ts.corr, big: ts.big, maxErr: r2(ts.maxErr), sumErr: r2(ts.sumErr),
    lag: ts.lagN ? [r2(ts.lagSum / ts.lagN), r2(ts.lagMax)] : null, at: [r2(P.x), r2(P.z)], ev: ts.ev, taps: taps.splice(0) }); // taps: what the last taps hit
  traceStats = { frames: 0, dtMax: 0, slow: 0, corr: 0, big: 0, maxErr: 0, sumErr: 0, lagSum: 0, lagMax: 0, lagN: 0, ev: [] };
}, 5000);

// console handle for poking at the prototype: MYSTICA.P.x, MYSTICA.sim(seconds), MYSTICA.SIM.heightAt(MYSTICA.w, x, z) ...
window.MYSTICA = {
  S: S, w: w, P: P, SIM: SIM, camera: camera, pick: pickGround, SFX: SFX, groundAt: groundAt, watchPan: watchPan,
  version: function () { return { loaded: clientVersion, stale: staleClient }; },
  // the admin's backstop (needs the admin token the page has): who is here, rename, mute for seconds, remove for the run, clear a board (all, or one item id)
  mod: { // (in event mode speech is refused for everyone, so mute matters only with names free)
    who: function () { return w.ents.filter(function (e) { return e.kind === 'player'; }).map(function (e) { return { id: e.id, name: e.name, away: !!e.away, at: [Math.round(e.x), Math.round(e.z)] }; }); },
    rename: function (id, name) { NET.send({ t: 'admin', op: 'rename', id: id, name: name, admin: ADMIN }); },
    mute: function (id, seconds) { NET.send({ t: 'admin', op: 'mute', id: id, seconds: seconds || 600, admin: ADMIN }); },
    remove: function (id) { NET.send({ t: 'admin', op: 'remove', id: id, admin: ADMIN }); },
    spawn: function (kind) { NET.send({ t: 'admin', op: 'spawn', kind: kind || '', admin: ADMIN }); }, // pin the arena to one wave ('bull', 'wisp', 'wraith') to try it out: that monster now and after every death; no argument frees it
    clearBoard: function (item) { NET.send({ t: 'admin', op: 'clearboard', item: item || 0, admin: ADMIN }); },
    boards: function () { return w.items.filter(function (it) { return it.kind === 'chessboard'; }).map(function (it) { var s = it.state.seats; return { id: it.id, at: [Math.round(it.x), Math.round(it.z)], white: s.w === null ? null : nameOf(s.w) + ' (' + s.w + ')', black: s.b === null ? null : nameOf(s.b) + ' (' + s.b + ')', moves: it.state.moves }; }); }, // the chessboards, who holds their chairs, and how far each game is
    chessFree: function (item) { NET.send({ t: 'admin', op: 'chessfree', item: item | 0, admin: ADMIN }); }, // both chairs of that board open again; the position stays
    round: function () { NET.send({ t: 'admin', op: 'round', admin: ADMIN }); } // start a round for everyone in the ring, as the stone would, from the shared screen
  },
  state: function () { return { x: P.x, z: P.z, moving: !!P.moving, running: !!P.running, creeping: !!P.creeping, band: stickBandNow, mag: touch.mag }; }, // for the headless rig: my body's gait and the stick's band
  screenOf: function (x, y, z) { var rect = canvas.getBoundingClientRect(); tmpV.set(x, y, z).project(camera); return [rect.left + (tmpV.x + 1) * 0.5 * rect.width, rect.top + (1 - tmpV.y) * 0.5 * rect.height]; }, // a world point on the page, for the rig
  items: function () { return w.items.map(function (it) { return { id: it.id, kind: it.kind, x: it.x, y: it.y, z: it.z }; }); },
  taps: function () { return taps.slice(); },
  sim: function (seconds) { var n = Math.round(seconds * 60); for (var i = 0; i < n; i++) { time += 1 / 60; updateCamera(); update(1 / 60); } syncVisuals(); }
};

resize();
placeCamera();
syncVisuals();
requestAnimationFrame(frame);
// dev: ?arena=1 puts you in the arena with a bolt in flight and a wall up (offline only)
if (new URLSearchParams(location.search).get('arena') === '1' && OFFLINE) {
  P.x = C.ARENA_X - 2; P.z = C.ARENA_Z + 2; P.y = P.gy = SIM.surfaceAt(w, P.x, P.z); P.heading = P.targetHeading = Math.PI / 2; P.target = null;
  P.heading = -Math.PI / 4; SIM.castSpell(w, P, 1, false); P.hp = 2;
  var dummy = SIM.addPlayer(w, C.ARENA_X + 4, C.ARENA_Z - 1); dummy.name = 'Dave'; dummy.ghost = true;
}
// dev: ?arena=wraith (or wisp, bull) pins the offline arena to that wave and stands you in front of it, the monster already
// on you; a wraith's fire comes at once. Online the same parameter asks the server instead, from the admin page (onWelcome).
(function () {
  var k = ARENA_PIN; if (!k || !OFFLINE) return;
  P.x = C.ARENA_X - 2; P.z = C.ARENA_Z + 2; P.y = P.gy = SIM.surfaceAt(w, P.x, P.z); P.heading = P.targetHeading = Math.PI / 2; P.target = null;
  SIM.pinArena(w, k);
  var m = w.ents.filter(function (e) { return e.kind === k; })[0];
  if (m) { m.x = P.x + 7; m.z = P.z; m.y = m.gy = SIM.surfaceAt(w, m.x, m.z); m.target = P.id; m.cd.wall = 0; m.cd.arrow = w.time + 3; }
})();
// dev: ?board=1 opens the spawn notice board with a couple of notes on it (offline only)
if (new URLSearchParams(location.search).get('board') === '1' && !NET.connected) {
  var bd = w.items.filter(function (i) { return i.kind === 'board'; })[0];
  if (bd) { SIM.pinNote(bd.state, 2, 'Dave', 'Bobby, your sheep got out again. I put them back.', Date.now() - 3600e3 * 5); SIM.pinNote(bd.state, 1, 'Bobby', 'Chess tonight at nine? Board is in the house.', Date.now() - 60e3 * 7); P.x = bd.x + 1; P.z = bd.z + 1; BOARD.show(bd.id, bd.state); }
}
// dev: ?chess=1 puts you at the table with the board open (offline only; online the server places you)
if (new URLSearchParams(location.search).get('chess') === '1' && !NET.connected) {
  P.x = 7.6; P.z = -4.0; P.y = P.gy = SIM.surfaceAt(w, P.x, P.z); P.target = null;
  var itDev = w.items[0]; if (itDev) { SIM.chessSit(itDev.state, P.id); SIM.applyChessMove(itDev.state, P.id, 12, 28); CHESS.show(itDev.id, itDev.state, P.id); }
}
})();
