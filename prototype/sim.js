/* sim.js — Mystica world simulation.
 *
 * No rendering, no DOM, no Three.js. This module is shared by the browser client (for prediction) and
 * the Node server (as the authority). Every function takes the world object explicitly, so one process
 * can host several worlds and tests can build fresh ones. All randomness goes through the world's seeded
 * generator and all noise uses integer hashing, so server and client generate identical worlds.
 *
 * Units: 1 tile = 1 world unit. Heights in tiles. Time in seconds.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SIM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var C = {
  N: 96,                      // world size in tiles (square); 3x3 chunks until streaming lands
  CHUNK: 32,                  // tiles per chunk side; the unit of persistence and, later, of streaming
  CRES: 0.5, BODY_R: 0.3,     // collision grid cell size (rectangles only); a creature's body radius
  STEP: 0.4, MAX_GRADE: 1.0,  // max step up on foot; max uphill grade (height per tile) on foot
  GRAVITY: 22, WADE: 0.4, DEEP: 1.2, SWIM_MUL: 0.5, // water past WADE (a quarter of a body) is swimming at SWIM_MUL of a walk, no running; past DEEP it needs the skill
  WALK: 3.6, RUN_MULT: 1.8, CREEP_MUL: 0.3, JUMP_H: 1.1, TURN: 14, SLIDE_MIN: 0.5, // CREEP_MUL: the stick's slowest band, a deliberate creep at this share of a walk (2026-10-19); SLIDE_MIN: speed along an obstacle when pushing straight at it, as a share of the push
  SCULPT_RATE: 2.5, SLUMP_RATE: 2.5, REPOSE: 38,
  WARD_THR: 0.3, WARD_W: 14, WARD_AHEAD: 40, WARD_BACK: 10, GUARD_STAY: 6,
  HOUSE_Y: 0.6, WALL_H: 2.6, WALL_T: 0.3, FENCE_H: 0.8,
  // the arena (outside the ward, north of the house) and the three spells
  // 2026-10-17: radius 16 -> 20 ("needs to be bigger"), the centre moved three tiles toward the town so
  // the floor stays clear of the map's south edge (z -43 of -48); the rim is a paved ring, the floor sand
  ARENA_X: -13, ARENA_Z: -23, ARENA_R: 20, ARENA_Y: 0.9,
  BUFFER: 6,                 // arena grounds beyond the rim: no casting, no digging, bolts still land. Was 12 (wider than a bolt flies); at 20 + 12 the grounds reached the house and the spawn, and a player at the chessboard counted as "about" at the arena
  HEALER_X: 1, HEALER_Z: 6, HEALER_LEASH: 4, HEAL_REACH: 2.0, // the healer wanders near the signpost, 32 tiles from the arena centre: past the grounds (26) even at full leash
  HP: 3, SHOT_SPEED: 18, MOB_SHOT_SPEED: 13, SHOT_RANGE: 10, SHOT_RADIUS: 0.55, SHOT_SUBSTEP: 0.3, ASSIST_DEG: 15, // 2026-10-18 ("way too hard to hit someone"): a player's arrow 13 -> 18, three times a runner; monsters' bolts stay at 13; the bolt 0.45 -> 0.55 wide; a bolt is stepped in pieces of at most SHOT_SUBSTEP so no tick, however long, carries it through a body
  AIM_DEG: 45,                // a locked mark is aimed at only within this many degrees of the way the body faces; beyond, the arrow flies straight ahead (2026-10-18: facing should matter)
  CD_ARROW: 0.7, CAST_ROOT: 0.25, WALL_H2: 1.6,
  HIT_INVULN: 0.5, KNOCKBACK: 1.0, COUNTDOWN: 4, COUNTDOWN_CROWD: 7, OVER_SECONDS: 8, // knockback 1.0 since 2026-10-17 (was 0.5): a landed hit should feel landed
  OUT_GRACE: 3,               // a contender may be out of the ring (or disconnected) this long before they have fallen; a step over the rim used to end the round at once (2026-10-18)
  COUNTDOWN_MAX: 30,          // each new arrival in the ring during the countdown puts COUNTDOWN_CROWD back on the clock, but the gong never waits longer than this from the first call (2026-10-18: fifty students arriving over a minute)
  // COUNTDOWN_CROWD 13 -> 7 (2026-10-18): the countdown is a shielded wait now, and the grounds are six tiles deep, two seconds at a run
  REGEN_EVERY: 10, MOB_REGEN_AFTER: 20, REVIVE_SECONDS: 5, // a monster mends only 20 s after it was last hurt, never while it has someone in its sights (it out-healed the arrows)
  BULL_HP: 6, BULL_RESPAWN: 13, BULL_WALK: 1.4, BULL_CHARGE: 6.0, BULL_GORE_CD: 1.5,
  BULL_BURST: 3, BULL_REST: 2, BULL_GRUDGE: 12, // charges in bursts, rests between, forgets after a while
  // the waves: the bull first, then floating things that shoot back, as long as someone is still around
  QUIET_SECONDS: 30,  // a floater alone on the grounds this long fades away and the bull returns
  WISP_HP: 4, WISP_SIGHT: 11, WISP_CD: 1.6, WISP_SPEED: 2.0, WISP_KEEP: 5,
  WISP_COUNT: 2,              // the wisp comes as a pair, one shooting while the other holds (2026-10-19, Bobby: "a little too easy, easier than the bull"; the arrows had just got faster and wider)
  WRAITH_HP: 7, WRAITH_SIGHT: 13, WRAITH_CD: 1.8, WRAITH_SPEED: 2.8, WRAITH_KEEP: 6, WRAITH_VOLLEY: 3,
  FLOATER_HOLD: 1.2, // a floater hangs still this long when it shoots, blinking: the moment to hit it (was 0.7 and unannounced)
  // The wraith's second spell (2026-10-19, Bobby: the last monster is too easy, "a wall of fire or something"): a line
  // of fire FIRE_LEN long through where its mark stands, across the line between them, so you must step off it and it
  // then lies between you and the wraith: round an end, or across it for a heart. Embers for FIRE_RISE, then it burns
  // FIRE_SECONDS; a player on it loses a heart (HIT_INVULN keeps it to one per crossing) and is shoved out the side
  // they came from. Monsters never burn, nothing is blocked, bolts fly over. The first fire comes WRAITH_FIRE_FIRST
  // seconds after the wraith notices someone, then one every WRAITH_FIRE_CD while the mark is within WRAITH_FIRE_RANGE.
  WRAITH_FIRE_CD: 9, WRAITH_FIRE_RANGE: 9, WRAITH_FIRE_FIRST: 4, FIRE_LEN: 7, FIRE_HALF_W: 0.45, FIRE_RISE: 0.6, FIRE_SECONDS: 6
};
var TIERS = ['bull', 'wisp', 'wraith']; // the arena's waves, in order; after the last, the bull again
function isMob(e) { return e.kind === 'bull' || e.kind === 'wisp' || e.kind === 'wraith'; }
function isFloater(e) { return e.kind === 'wisp' || e.kind === 'wraith'; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ------------------------------------------------------------------ deterministic randomness
function makeRng(seed) {
  var s = seed >>> 0;
  return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function hash2(x, y, seed) { // integer lattice hash -> [0,1); bit-identical on every JS engine
  var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  var sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  var a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * sx) + ((c - a) + (a - b - c + d) * sx) * sy;
}
function fbm(x, y, seed) { var v = 0, a = 0.5, f = 1; for (var o = 0; o < 4; o++) { v += a * vnoise(x * f, y * f, seed + o * 101); a *= 0.5; f *= 2; } return v; }
function gauss(d, r) { return Math.exp(-(d * d) / (r * r)); }
function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

// ------------------------------------------------------------------ world
function createWorld(seed) {
  var N = C.N, V = N + 1, CG = N * 2, CHUNKS = N / C.CHUNK;
  var w = {
    seed: seed | 0, N: N, V: V, HALF: N / 2, CG: CG, CHUNKS: CHUNKS,
    rng: makeRng(seed * 7919 + 17),
    time: 0, nextId: 1,
    // terrain: heights = base + delta. Nothing ever reverts on its own.
    base: new Float32Array(V * V), delta: new Float32Array(V * V),
    loose: new Float32Array(V * V),  // 1 = freshly disturbed earth, 0 = undisturbed ground
    faced: new Uint8Array(V * V),    // 1 = stone facing: pins the vertex and blocks slumping across it
    anyLoose: false, terrainDirty: true, sculptVolume: 0,
    chunkDirty: new Uint8Array(CHUNKS * CHUNKS), // chunks with player-made changes not yet persisted
    repose: C.REPOSE,
    // collision (see canEnter): rectangles on a half-tile grid, round things as exact circles in a
    // per-tile spatial hash, and a short list of dynamic circles (wardstones, walls of stone)
    barrierH: new Float32Array(CG * CG), platformH: new Float32Array(CG * CG), dynObs: [],
    circles: [], hash: new Array(N * N),
    // the one town: ward field, guards
    town: { x: 0, z: 0, strength: 1, facing: 0, alarm: 0, sculptedThisTick: false, guardTimer: 0, guardX: 0, guardZ: 0, guardHeading: 0 },
    props: [], ents: [], events: [],
    items: [], nextItemId: 1, itemsDirty: false, // interactable objects with server-owned state (the chessboard)
    shots: [], nextShotId: 1, walls: [], nextWallId: 1, // bolts in flight, and the wraith's lines of fire (the player's walls of stone went 2026-10-17; the list and its wire format stayed)
    respawns: [],                                // {kind, at}: monsters that will return ('wave': whatever comes next)
    arena: { tier: 0, quietT: 0, pin: null },    // which wave is up (index into TIERS), how long it has been alone, and a wave the admin has pinned it to (a kind, or null)
    round: { phase: 'lobby', t: 0, players: [], fallen: {}, out: {}, here: 0, began: 0, winner: null, scores: {} }
  };
  w.barrierH.fill(-1e9); w.platformH.fill(-1e9);
  w.wardstones = 16;
  for (var i = 0; i < w.wardstones; i++) w.dynObs.push({ x: 0, z: 0, r: 0, top: 99 });
  buildBase(w);
  generateProps(w);
  spawnAnimals(w);
  updateWardObstacles(w);
  return w;
}

// ------------------------------------------------------------------ terrain
function buildBase(w) {
  var N = w.N, V = w.V, H = w.HALF, s = w.seed;
  for (var j = 0; j < V; j++) for (var i = 0; i < V; i++) {
    var x = i - H, z = j - H;
    var h = (fbm(x * 0.05 + 3.1, z * 0.05 + 7.7, s) - 0.5) * 7.0 + 0.9;
    h += 3.4 * gauss(Math.hypot(x - 24, z + 20), 10);   // hill (snow cap)
    h -= 3.2 * gauss(Math.hypot(x + 22, z - 18), 12);   // lake basin
    var flat = 1 - smoothstep(13, 19, Math.hypot(x, z)); // town plateau
    h = h * (1 - flat) + C.HOUSE_Y * flat;
    var arena = 1 - smoothstep(C.ARENA_R + 1, C.ARENA_R + 6, Math.hypot(x - C.ARENA_X, z - C.ARENA_Z)); // the arena: flat, this is a 2D fight
    h = h * (1 - arena) + C.ARENA_Y * arena;
    w.base[j * V + i] = h;
    if (Math.hypot(x - C.ARENA_X, z - C.ARENA_Z) < C.ARENA_R - 0.5) w.loose[j * V + i] = 1; // trampled dirt floor
  }
}
function inArena(x, z) { return Math.hypot(x - C.ARENA_X, z - C.ARENA_Z) <= C.ARENA_R; }
function inZone(x, z) { return Math.hypot(x - C.ARENA_X, z - C.ARENA_Z) <= C.ARENA_R + C.BUFFER; } // arena plus its grounds
function heightAt(w, x, z) {
  var N = w.N, V = w.V, H = w.HALF;
  var fx = clamp(x + H, 0, N - 1e-4), fz = clamp(z + H, 0, N - 1e-4);
  var i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * V + i;
  var h00 = w.base[k] + w.delta[k], h10 = w.base[k + 1] + w.delta[k + 1];
  var h01 = w.base[k + V] + w.delta[k + V], h11 = w.base[k + V + 1] + w.delta[k + V + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
// Brush tools. Raising and lowering disturb the earth (and dig through any stone facing).
// Stone facing pins vertices so a slope can be held steeper than its angle of repose.
function sculpt(w, cx, cz, tool, amount, R) {
  var N = w.N, V = w.V, H = w.HALF;
  var i0 = clamp(Math.floor(cx - R + H), 0, N), i1 = clamp(Math.ceil(cx + R + H), 0, N);
  var j0 = clamp(Math.floor(cz - R + H), 0, N), j1 = clamp(Math.ceil(cz + R + H), 0, N);
  for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
    var d = Math.hypot(i - H - cx, j - H - cz);
    if (d >= R) continue;
    var k = j * V + i;
    markDirtyVertex(w, k);
    if (tool === 'stone') { w.faced[k] = 1; w.loose[k] = 0; continue; }
    if (tool === 'clear') { if (w.faced[k]) { w.faced[k] = 0; w.loose[k] = Math.max(w.loose[k], 0.6); } continue; }
    var f = 1 - (d * d) / (R * R);
    w.delta[k] = clamp(w.delta[k] + amount * f * f, -8, 8);
    w.loose[k] = 1; w.faced[k] = 0;
  }
  w.anyLoose = true; w.terrainDirty = true;
}
// Mark every chunk that holds vertex k (edge vertices belong to two chunks, corners to four).
function markDirtyVertex(w, k) {
  var V = w.V, i = k % V, j = (k - i) / V, CH = C.CHUNK, n = w.CHUNKS;
  var ca = (i / CH) | 0, cb = (j / CH) | 0;
  for (var dx = 0; dx < 2; dx++) {
    var cx = ca - dx; if (cx < 0 || cx >= n) continue; if (dx === 1 && i % CH !== 0) continue;
    for (var dz = 0; dz < 2; dz++) {
      var cz = cb - dz; if (cz < 0 || cz >= n) continue; if (dz === 1 && j % CH !== 0) continue;
      w.chunkDirty[cz * n + cx] = 1;
    }
  }
}
// Angle of repose: disturbed earth steeper than the stable slope sheds height to its lower neighbour.
// Nothing moves toward the original heightmap; slopes relax and that is all. Undisturbed ground only
// joins in when something disturbed sits next to it (an undercut bank slumps into the pit).
function relax(w, dt) {
  if (!w.anyLoose) return;
  var N = w.N, V = w.V, tanLoose = Math.tan(w.repose * Math.PI / 180), k = Math.min(0.5, C.SLUMP_RATE * dt);
  var moved = 0, looseSeen = false;
  for (var j = 0; j < V; j++) for (var i = 0; i < V; i++) {
    var a = j * V + i;
    if (w.loose[a] > 0.02) looseSeen = true;
    if (i < N) moved += slumpPair(w, a, a + 1, tanLoose, k);
    if (j < N) moved += slumpPair(w, a, a + V, tanLoose, k);
  }
  w.anyLoose = looseSeen;
  if (moved > 1e-4) w.terrainDirty = true;
}
function slumpPair(w, a, b, tanLoose, k) {
  if (w.faced[a] || w.faced[b]) return 0;
  var la = w.loose[a], lb = w.loose[b], lmax = la > lb ? la : lb;
  if (lmax < 0.02) return 0;
  var ha = w.base[a] + w.delta[a], hb = w.base[b] + w.delta[b];
  var hi = a, lo = b, diff = ha - hb;
  if (diff < 0) { diff = -diff; hi = b; lo = a; }
  var limit = tanLoose * (1.5 - 0.5 * lmax); // undisturbed banks hold a little steeper than loose fill
  if (diff - limit < 0.003) return 0;
  var flow = (diff - limit) * 0.5 * k;
  w.delta[hi] -= flow; w.delta[lo] += flow;
  if (w.loose[hi] < 0.6) w.loose[hi] = 0.6;
  if (w.loose[lo] < 0.7) w.loose[lo] = 0.7;
  markDirtyVertex(w, hi); markDirtyVertex(w, lo);
  return flow;
}
function measureSculpt(w) { var s = 0; for (var k = 0; k < w.V * w.V; k++) s += Math.abs(w.delta[k]); w.sculptVolume = s; return s; }
function resetTerrain(w) { w.delta.fill(0); w.loose.fill(0); w.faced.fill(0); w.anyLoose = false; w.terrainDirty = true; w.sculptVolume = 0; w.chunkDirty.fill(1); }

// ------------------------------------------------------------------ chunk blobs (persistence, later streaming)
// A chunk blob holds the player-made state of a 32x32-tile chunk: its 33x33 vertices (edge vertices are
// shared with the neighbour and stored in both). Base terrain comes from the seed and is never stored.
//   [u8 version=1][i16 cx][i16 cz][u8 chunkSize][(size+1)^2 x (f32 delta, u8 loose, u8 faced)]
function encodeChunk(w, cx, cz) {
  var CH = C.CHUNK, VC = CH + 1, buf = new ArrayBuffer(6 + VC * VC * 6), dv = new DataView(buf);
  dv.setUint8(0, 1); dv.setInt16(1, cx, true); dv.setInt16(3, cz, true); dv.setUint8(5, CH);
  for (var j = 0, o = 6; j <= CH; j++) for (var i = 0; i <= CH; i++, o += 6) {
    var k = (cz * CH + j) * w.V + (cx * CH + i);
    dv.setFloat32(o, w.delta[k], true); dv.setUint8(o + 4, Math.round(clamp(w.loose[k], 0, 1) * 255)); dv.setUint8(o + 5, w.faced[k]);
  }
  return buf;
}
function decodeChunk(w, data) { // data: ArrayBuffer or a typed array view; returns {cx, cz} or null
  var dv = data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.byteLength < 6 || dv.getUint8(0) !== 1 || dv.getUint8(5) !== C.CHUNK) return null;
  var cx = dv.getInt16(1, true), cz = dv.getInt16(3, true), CH = C.CHUNK;
  if (cx < 0 || cz < 0 || cx >= w.CHUNKS || cz >= w.CHUNKS || dv.byteLength < 6 + (CH + 1) * (CH + 1) * 6) return null;
  for (var j = 0, o = 6; j <= CH; j++) for (var i = 0; i <= CH; i++, o += 6) {
    var k = (cz * CH + j) * w.V + (cx * CH + i);
    w.delta[k] = dv.getFloat32(o, true); w.loose[k] = dv.getUint8(o + 4) / 255; w.faced[k] = dv.getUint8(o + 5);
    if (w.loose[k] > 0.02) w.anyLoose = true;
  }
  w.terrainDirty = true;
  return { cx: cx, cz: cz };
}

// ------------------------------------------------------------------ collision
// One rule for everything that blocks. A spot has a surface height (terrain, or a floor or rock you can
// stand on) and a barrier height (fences, walls, trunks: never stood on). A body may move to a spot when
// its feet are above the barrier there and the surface is at most a small step above it. In the air the
// feet are wherever the jump put them, so a fence passes under you and a wall does not. Slopes steeper
// than MAX_GRADE block like walls; loose earth slumps to a walkable angle, so only stone-faced banks stop
// anyone. Rectangles (walls, fences, floors) live on a half-tile grid, where they are exact. Round things
// (trees, rocks, posts) are exact circles in a per-tile spatial hash: a query reads one bucket and tests
// a handful of circles against the body's radius, so a 5-pixel post blocks a 5-pixel post.
function cIndex(w, x, z) {
  var i = clamp(Math.floor((x + w.HALF) / C.CRES), 0, w.CG - 1), j = clamp(Math.floor((z + w.HALF) / C.CRES), 0, w.CG - 1);
  return j * w.CG + i;
}
function stampRect(w, arr, x0, z0, x1, z1, h) { // cells whose centre lies inside the rect (keeps doorways open)
  var H = w.HALF, CG = w.CG, R = C.CRES;
  var i0 = clamp(Math.ceil((x0 + H) / R - 0.5), 0, CG - 1), i1 = clamp(Math.floor((x1 + H) / R - 0.5), 0, CG - 1);
  var j0 = clamp(Math.ceil((z0 + H) / R - 0.5), 0, CG - 1), j1 = clamp(Math.floor((z1 + H) / R - 0.5), 0, CG - 1);
  for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) { var k = j * CG + i; if (h > arr[k]) arr[k] = h; }
}
// Rectangles grow by the body radius at stamp time (the grid is point-sampled). Round things do not:
// they are kept exact and the body's radius is added at query time.
function barrier(w, x0, z0, x1, z1, top) { stampRect(w, w.barrierH, x0 - C.BODY_R, z0 - C.BODY_R, x1 + C.BODY_R, z1 + C.BODY_R, top); }
var HASH_REACH = 1.0; // a circle is listed in every tile bucket within its radius plus this, so one bucket answers any body up to this radius
function barrierCircle(w, cx, cz, r, top) {
  var c = { x: cx, z: cz, r: r, top: top }; w.circles.push(c);
  var H = w.HALF, N = w.N, R = r + HASH_REACH;
  var i0 = clamp(Math.floor(cx - R + H), 0, N - 1), i1 = clamp(Math.floor(cx + R + H), 0, N - 1);
  var j0 = clamp(Math.floor(cz - R + H), 0, N - 1), j1 = clamp(Math.floor(cz + R + H), 0, N - 1);
  for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) { var k = j * N + i; (w.hash[k] || (w.hash[k] = [])).push(c); }
}
function barrierSegment(w, x0, z0, x1, z1, r, top) { // a straight run with round ends, exact like the circles, in the same buckets
  var c = { x0: x0, z0: z0, x1: x1, z1: z1, r: r, top: top, seg: true }; w.circles.push(c);
  var H = w.HALF, N = w.N, R = r + HASH_REACH;
  var i0 = clamp(Math.floor(Math.min(x0, x1) - R + H), 0, N - 1), i1 = clamp(Math.floor(Math.max(x0, x1) + R + H), 0, N - 1);
  var j0 = clamp(Math.floor(Math.min(z0, z1) - R + H), 0, N - 1), j1 = clamp(Math.floor(Math.max(z0, z1) + R + H), 0, N - 1);
  for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) { var k = j * N + i; (w.hash[k] || (w.hash[k] = [])).push(c); }
}
function obstacleDist(o, x, z) { // distance from a point to a round thing's centre, or to a segment's nearest point
  if (!o.seg) return Math.hypot(x - o.x, z - o.z);
  var dx = o.x1 - o.x0, dz = o.z1 - o.z0, l2 = dx * dx + dz * dz || 1, t = clamp(((x - o.x0) * dx + (z - o.z0) * dz) / l2, 0, 1);
  return Math.hypot(x - (o.x0 + dx * t), z - (o.z0 + dz * t));
}
function platform(w, x0, z0, x1, z1, top) { stampRect(w, w.platformH, x0, z0, x1, z1, top); }
// Highest barrier a body of radius br would touch at (x, z): rectangles from the grid, round things from
// the one bucket this tile owns, dynamic circles from their short list.
function barrierAt(w, x, z, br) {
  if (br === undefined) br = C.BODY_R;
  var h = w.barrierH[cIndex(w, x, z)], i, o;
  var i0 = clamp(Math.floor(x + w.HALF), 0, w.N - 1), j0 = clamp(Math.floor(z + w.HALF), 0, w.N - 1);
  var bucket = w.hash[j0 * w.N + i0];
  if (bucket) for (i = 0; i < bucket.length; i++) { o = bucket[i]; if (o.top > h && obstacleDist(o, x, z) <= o.r + br) h = o.top; }
  for (i = 0; i < w.dynObs.length; i++) { o = w.dynObs[i]; if (o.r > 0 && o.top > h && Math.hypot(x - o.x, z - o.z) <= o.r + br) h = o.top; }
  return h;
}
function platformAt(w, x, z) { return w.platformH[cIndex(w, x, z)]; }
function surfaceAt(w, x, z) { return Math.max(heightAt(w, x, z), platformAt(w, x, z), -0.7); } // -0.7: swimming level
function depthAt(w, x, z) { return Math.max(0, -heightAt(w, x, z)); }
function waterFactor(w, e, x, z) { // speed multiplier; 0 means too deep to enter
  var d = depthAt(w, x, z);
  if (d <= C.WADE) return 1; // ankle deep: unhindered
  if (d >= C.DEEP && !e.canSwim) return 0;
  return C.SWIM_MUL; // past the knees you swim: half a walk (Bobby 2026-10-17), and the skill only decides how deep you may go
}
function canEnter(w, e, x, z, nx, nz) {
  if (Math.abs(nx) > w.HALF - 1 || Math.abs(nz) > w.HALF - 1) return false;
  var foot = e.y, br = e.radius || C.BODY_R;
  var inThere = barrierAt(w, nx, nz, br) > foot + 0.05, inHere = barrierAt(w, x, z, br) > foot + 0.05;
  if (inThere && !inHere) return false; // a wall stops you
  // A body inside a barrier may only step out, never further in: the wire rounds positions to a millimetre,
  // which can put a predicting client's copy a hair inside a wall it hugs, and the old rule (inside may go
  // anywhere) let its replay walk straight through. If it cannot get out in one step, the authority alone
  // walks it out once the wedge detector has called it stuck (2026-10-18).
  if (inThere && inHere && (w.clientMode || !e.stalled)) return false;
  if (waterFactor(w, e, nx, nz) <= 0) return false;
  if (e.grounded) {
    var surf = surfaceAt(w, nx, nz);
    if (surf - foot > C.STEP) return false;
    if (platformAt(w, nx, nz) < surf) { // on terrain: refuse grades steeper than MAX_GRADE uphill
      var dh = heightAt(w, nx, nz) - heightAt(w, x, z), dist = Math.hypot(nx - x, nz - z);
      if (dist > 1e-6 && dh / dist > C.MAX_GRADE) return false;
    }
  }
  return true;
}
// Positions live on a millimetre grid, the precision the snapshot carries, so a predicting client and the
// authority work from the same numbers and decide a slide the same way (a 3 degree lean once sent them
// round a wall on opposite sides, 2026-10-18). Rounding may not push a body into a barrier: then truncate
// toward where it came from instead.
function settle(w, e, ox, oz) {
  var qx = Math.round(e.x * 1000) / 1000, qz = Math.round(e.z * 1000) / 1000;
  if (barrierAt(w, qx, qz, e.radius || C.BODY_R) > e.y + 0.05) { qx = ox + Math.trunc((e.x - ox) * 1000) / 1000; qz = oz + Math.trunc((e.z - oz) * 1000) / 1000; }
  e.x = qx; e.z = qz;
}
function moveEntity(w, e, dx, dz) { // true if the body moved at all
  var want = Math.hypot(dx, dz);
  if (want < 1e-9) return false;
  var step = function (rx, rz) { return canEnter(w, e, e.x, e.z, e.x + rx, e.z + rz); };
  var ox = e.x, oz = e.z;
  if (step(dx, dz)) { e.x += dx; e.z += dz; e.slide = 0; settle(w, e, ox, oz); return true; }
  if (e.stalled) return false; // wedged (half a second without progress): stand still rather than vibrate
  // Blocked. On each side of the way it wants to go, find the smallest turn that is open: probe at 15 degree
  // steps up to 90, then bisect the last 15 down to about a degree, so the step ends hugging whatever
  // blocks, a flat wall, a post, a boulder, a row of stones, a steep bank, at any angle. Take the smaller
  // turn (the way the motion leans), the remembered side when the two are within 6 degrees, the
  // previous frame's side while it is still open (switching sides is the wiggle in a V between two things),
  // and never more than 90: a step that backs off the obstacle frees the
  // next direct step, which goes back in, and the body shakes. Speed along the turn is the push scaled by
  // its cosine, never below SLIDE_MIN: a wall slows you, it does not stop you. (2026-10-18: this replaced axis
  // slides and per-circle tangents, which on the arena's rows of stones at 23 degrees left the body stuck
  // from one side and shaking from the other, client and server disagreeing about which.)
  var ux = dx / want, uz = dz / want, D = Math.PI / 180;
  var at = function (deg) { var a = deg * D, c = Math.cos(a), s = Math.sin(a); return [ux * c - uz * s, ux * s + uz * c]; }; // the push turned left by deg (right when negative)
  var open = function (sg) { // the smallest turn on this side with a free full step, in degrees (up to 120), or null
    var lo = 0, hi = null, v;
    for (var a = 15; a <= 120; a += 15) { v = at(sg * a); if (step(v[0] * want, v[1] * want)) { hi = a; break; } lo = a; }
    if (hi === null) return null;
    for (var k = 0; k < 4; k++) { var mid = (lo + hi) / 2; v = at(sg * mid); if (step(v[0] * want, v[1] * want)) hi = mid; else lo = mid; }
    return hi;
  };
  // A turn past 90 degrees backs off the push; it is allowed only up to 100 and only on the side the body slid
  // last frame, so a thumb wobbling across a wall's normal keeps the body going the same way, while a slide never
  // starts backing off (in a closing corner the body stops instead of bouncing between the walls).
  var L = open(1), R = open(-1), sg;
  if (L !== null && L > (e.slide === 1 ? 100 : 90)) L = null;
  if (R !== null && R > (e.slide === -1 ? 100 : 90)) R = null;
  if (L === null && R === null) return false;
  if (L === null) sg = -1; else if (R === null) sg = 1; else if (e.slide) sg = e.slide; else if (Math.abs(L - R) <= 6) sg = e.avoidSide || 1; else sg = L < R ? 1 : -1;
  var ang = sg === 1 ? L : R;
  if (ang + 1 <= 120) { var v1 = at(sg * (ang + 1)); if (step(v1[0] * want, v1[1] * want)) ang += 1; } // a degree of margin off the surface, so the wire's rounding never puts the body a hair inside it
  var v = at(sg * ang), k = Math.max(C.SLIDE_MIN, Math.cos(ang * D));
  if (k < 1 && !step(v[0] * want * k, v[1] * want * k)) k = 1; // the shorter step is checked too; if only the full one is free, take that
  e.x += v[0] * want * k; e.z += v[1] * want * k; e.slide = sg; e.avoidSide = sg; settle(w, e, ox, oz);
  return true;
}
function updateVertical(w, e, dt) { // stick to the surface while grounded, fall off ledges, gravity in the air
  e.gy = surfaceAt(w, e.x, e.z);
  if (e.grounded) {
    if (e.gy < e.y - 0.35) { e.grounded = false; e.vy = 0; } else e.y = e.gy;
  }
  if (!e.grounded) {
    e.vy -= C.GRAVITY * dt; e.y += e.vy * dt;
    if (e.y <= e.gy) { e.y = e.gy; e.vy = 0; e.grounded = true; e.jumpsLeft = e.maxJumps; }
  }
  e.air = e.y - e.gy;
}
function tryJump(w, e) {
  if (e.jumpV <= 0 || e.jumpsLeft <= 0 || depthAt(w, e.x, e.z) > C.WADE) return false;
  e.vy = e.jumpV; e.grounded = false; e.jumpsLeft--;
  return true;
}

// ------------------------------------------------------------------ props (world content)
// Props are plain descriptions: the client builds meshes from them, the sim registers their footprints.
function addProp(w, p) { w.props.push(p); return p; }
function generateProps(w) {
  var rng = w.rng, HY = C.HOUSE_Y;
  // trees
  var placed = 0, tries = 0;
  while (placed < 46 && tries++ < 2000) {
    var tx = (rng() * 2 - 1) * 44, tz = (rng() * 2 - 1) * 44, th = heightAt(w, tx, tz);
    var slope = Math.abs(heightAt(w, tx + 0.7, tz) - heightAt(w, tx - 0.7, tz)) + Math.abs(heightAt(w, tx, tz + 0.7) - heightAt(w, tx, tz - 0.7));
    if (Math.hypot(tx, tz) < 11 || th < 0.35 || th > 3.4 || slope > 0.9) continue;
    if (tx > 2 && tx < 13 && tz > -9 && tz < 6) continue; // keep the yard clear
    if (Math.hypot(tx - C.ARENA_X, tz - C.ARENA_Z) < C.ARENA_R + 2) continue; // and the arena
    var sc = 0.8 + rng() * 0.5, pine = th > 2.0 || rng() < 0.3;
    addProp(w, { kind: pine ? 'pine' : 'tree', x: tx, z: tz, y: th, rot: rng() * 6.28, scale: sc, cutout: true });
    barrierCircle(w, tx, tz, 0.22 * sc, 99);
    placed++;
  }
  // rocks
  for (var r = 0; r < 22; r++) {
    var rx = (rng() * 2 - 1) * 45, rz = (rng() * 2 - 1) * 45, rh = heightAt(w, rx, rz);
    var rs = 0.5 + rng() * 1.3, rot = rng() * 6.28, rzs = 0.7 + rng() * 0.6;
    if (rh < 0.2 || Math.hypot(rx - C.ARENA_X, rz - C.ARENA_Z) < C.ARENA_R + 2) continue;
    addProp(w, { kind: 'rock', x: rx, z: rz, y: rh - 0.15 * rs, rot: rot, scale: rs, scaleZ: rzs });
    // every rock has a real top: small ones you step onto, big ones block on foot but a jump lands on them
    var top = rh + 0.18 * rs + (rs > 1.0 ? 0.3 : 0), rr = 0.42 * rs;
    platform(w, rx - rr, rz - rr, rx + rr, rz + rr, top);
    if (top - rh > C.STEP) barrierCircle(w, rx, rz, rr, top);
  }
  // house (roofless; walls take part in the cut-away)
  var HX = 7, HZ = -4, WH = C.WALL_H;
  addProp(w, { kind: 'house', x: HX, z: HZ, y: HY, x0: 3.85, x1: 10.15, z0: -6.5, z1: -1.5, door: [6.4, 7.6], cutout: true });
  barrier(w, 3.85, -6.65, 10.15, -6.35, HY + WH); barrier(w, 3.85, -1.65, 6.4, -1.35, HY + WH); barrier(w, 7.6, -1.65, 10.15, -1.35, HY + WH);
  barrier(w, 3.85, -6.5, 4.15, -1.5, HY + WH); barrier(w, 9.85, -6.5, 10.15, -1.5, HY + WH);
  platform(w, 3.85, -6.5, 10.15, -1.5, HY + 0.1); // floor
  addProp(w, { kind: 'path', x: 7, z: 1.5, y: HY, w: 1.0, d: 6.0 });
  addProp(w, { kind: 'crate', x: 4.9, z: -5.8, y: HY + 0.1, rot: 0.3, stacked: true }); platform(w, 4.6, -6.1, 5.2, -5.5, HY + 0.7);
  addProp(w, { kind: 'crate', x: 9.2, z: -2.2, y: HY + 0.1, rot: -0.2 });                 platform(w, 8.9, -2.5, 9.5, -1.9, HY + 0.7);
  addProp(w, { kind: 'table', x: 7, z: -4.5, y: HY + 0.1 });                               platform(w, 6.3, -4.9, 7.7, -4.1, HY + 0.94);
  addItem(w, 'chessboard', 7, HY + 0.94, -4.5, 0.15); // on the table
  addProp(w, { kind: 'well', x: 12, z: 2, y: HY, cutout: true });                          barrierCircle(w, 12, 2, 0.65, 99);
  // sheep pen
  var pen = addProp(w, { kind: 'fence', x: -7, z: 5, y: HY, w: 7, d: 6, gap: 1 });
  var top = HY + C.FENCE_H, cx = pen.x, cz = pen.z, pw = pen.w, pd = pen.d;
  barrier(w, cx - pw / 2, cz - pd / 2 - 0.1, cx + pw / 2, cz - pd / 2 + 0.1, top);
  barrier(w, cx - pw / 2, cz + pd / 2 - 0.1, cx - pen.gap, cz + pd / 2 + 0.1, top); barrier(w, cx + pen.gap, cz + pd / 2 - 0.1, cx + pw / 2, cz + pd / 2 + 0.1, top);
  barrier(w, cx - pw / 2 - 0.1, cz - pd / 2, cx - pw / 2 + 0.1, cz + pd / 2, top); barrier(w, cx + pw / 2 - 0.1, cz - pd / 2, cx + pw / 2 + 0.1, cz + pd / 2, top);
  // signpost, and the notice boards: one by the spawn, one on the house wall beside the door
  addProp(w, { kind: 'sign', x: -2, z: 1, y: HY, rot: 0.6 }); barrierCircle(w, -2, 1, 0.15, 99);
  addItem(w, 'board', -4.5, HY, 2.5, 0.6); barrierCircle(w, -4.5, 2.5, 0.3, 99);
  addItem(w, 'board', 9.2, HY, -1.1, Math.PI); barrierCircle(w, 9.2, -1.1, 0.25, 99);

  // the arena: dirt floor, cover that works in two dimensions, obelisks on the rim with gaps,
  // the round stone in the middle. A sign trail leads from the house door north to it.
  var AX = C.ARENA_X, AZ = C.ARENA_Z, AY = C.ARENA_Y, AR = C.ARENA_R;
  for (var o = 0; o < 12; o++) { // rim obelisks on the paved ring, two gaps left open toward the house (south-east) and away; taller ones flank each gap
    var ang = o / 12 * Math.PI * 2 + 0.2;
    if (o === 1 || o === 7) continue;
    var ox = AX + Math.cos(ang) * AR, oz = AZ + Math.sin(ang) * AR;
    addProp(w, { kind: 'obelisk', x: ox, z: oz, y: heightAt(w, ox, oz), tall: o === 0 || o === 2 || o === 6 || o === 8 }); barrierCircle(w, ox, oz, 0.35, 99);
  }
  var K = AR / 11; // cover laid out for a radius of 11, spread to the real radius
  [[-4.5, -3, 0.4], [4.5, 3, 0.4], [3, -5, 1.9], [-3, 5, 1.9], [-8, 0, 1.2], [8, 0, 1.2]].forEach(function (s) { // low stone walls, a pinwheel plus two flanks
    var cx = AX + s[0] * K, cz = AZ + s[1] * K, len = 3.2, dx = Math.cos(s[2]) * len / 2, dz = Math.sin(s[2]) * len / 2;
    addProp(w, { kind: 'lowwall', x: cx, z: cz, y: AY, rot: -s[2], len: len });
    barrierSegment(w, cx - dx, cz - dz, cx + dx, cz + dz, 0.25, AY + C.WALL_H2); // one straight run: a row of circles was a comb, and a body in one of its scallops had no way to slide (2026-10-18)
  });
  [[-7, 2], [7, -2], [0, 7.5], [0, -7.5], [-5, -7], [5, 7], [-3, -2.5], [3, 2.5], [-8.5, 6], [8.5, -6]].forEach(function (b, i) { // boulders you can hop
    var bx = AX + b[0] * K, bz = AZ + b[1] * K, bs = 1.2 + (i % 3) * 0.1, top = AY + 0.18 * bs + 0.3, rr = 0.42 * bs;
    addProp(w, { kind: 'rock', x: bx, z: bz, y: AY - 0.15 * bs, rot: i * 1.1, scale: bs, scaleZ: 0.9 });
    platform(w, bx - rr, bz - rr, bx + rr, bz + rr, top); barrierCircle(w, bx, bz, rr, top);
  });
  addItem(w, 'roundstone', AX, AY, AZ, 0); barrierCircle(w, AX, AZ, 0.5, 99);
  // the chess garden (2026-10-19, for the webinar): three tables on the lawn east of the house path, each with a
  // board of its own, so students play here while the house table keeps its game. Added after the stone so the
  // saved items keep their ids.
  [[10.5, 7, 0.15], [12.5, 7, -0.2], [11.5, 9.2, 0.1]].forEach(function (t) {
    var ty = heightAt(w, t[0], t[1]);
    addProp(w, { kind: 'table', x: t[0], z: t[1], y: ty }); platform(w, t[0] - 0.7, t[1] - 0.4, t[0] + 0.7, t[1] + 0.4, ty + 0.84);
    addItem(w, 'chessboard', t[0], ty + 0.84, t[1], t[2]);
  });
  // the way there: cobbles from the house door to the arena's south-east gate, signs pointing
  // north-west (screen-up). The only directions the game gives; the HUD gives none.
  [[6.5, -0.5], [4.5, -4], [2.5, -7.5]].forEach(function (p, i) {
    addProp(w, { kind: 'path', x: p[0] - 1.2, z: p[1] - 1.2, y: heightAt(w, p[0] - 1.2, p[1] - 1.2), w: 1.0, d: 1.0 });
    if (i % 2 === 1) { addProp(w, { kind: 'arrowsign', x: p[0] + 0.8, z: p[1], y: heightAt(w, p[0] + 0.8, p[1]), rot: Math.PI * 0.75 }); barrierCircle(w, p[0] + 0.8, p[1], 0.12, 99); }
  });
}

// ------------------------------------------------------------------ items
// An item is a thing in the world with state that the server owns: {id, kind, x, y, z, rot, state}.
// Today there is one kind. Later a backpack moves items around; the shape already allows it.
function addItem(w, kind, x, y, z, rot) {
  var it = { id: w.nextItemId++, kind: kind, x: x, y: y, z: z, rot: rot || 0, state: kind === 'chessboard' ? initialChessState() : {} };
  if (kind === 'roundstone') it.state = { rounds: 0 };
  if (kind === 'board') it.state = { notes: [] }; // a notice board: {by, name, text, at}, newest first
  w.items.push(it);
  return it;
}
function findItem(w, id) { for (var i = 0; i < w.items.length; i++) if (w.items[i].id === id) return w.items[i]; return null; }

// Chess on the honor system: no rules, two seats, any seated player may move any piece anywhere.
// Cell index = rank * 8 + file, so 0 is a1 and 63 is h8; white starts on ranks 1 and 2.
function initialChessState() {
  var cells = [], back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  for (var i = 0; i < 64; i++) cells.push('');
  for (var f = 0; f < 8; f++) { cells[f] = 'w' + back[f]; cells[8 + f] = 'wP'; cells[48 + f] = 'bP'; cells[56 + f] = 'b' + back[f]; }
  var st = { cells: cells, trays: { w: [], b: [] }, seats: { w: null, b: null }, resetVote: { w: false, b: false }, resetVoteAt: 0, moves: 0, lastMove: null,
             turn: 'w', turnMoves: [], turnStart: null, history: [], redo: [] };
  st.turnStart = chessSnapshot(st);
  return st;
}
// Turns are a courtesy, not a rule: 'turn' says who is to move, 'turnMoves' lists what moved since the
// turn last changed hands (castling is two moves), 'turnStart' is the position when it did, and
// 'history' holds the starts of earlier turns (newest last, CHESS_HISTORY at most) so a turn can be
// taken back. Passing the turn is a button either seated player may press.
var CHESS_HISTORY = 40;
function chessSnapshot(st) { return { cells: st.cells.slice(), trays: { w: st.trays.w.slice(), b: st.trays.b.slice() } }; }
function chessUpgrade(st) { // a board saved before turns existed: keep its position, guess whose move it is
  if (!st.redo) st.redo = []; // (redo came a day after turns)
  if (st.turn) return false;
  var by = st.lastMove ? st.lastMove.by : null;
  st.turn = by !== null && by === st.seats.b ? 'w' : by !== null && by === st.seats.w ? 'b' : 'w';
  st.turnMoves = []; st.history = []; // the last move stays in lastMove; the overlay shows it as the other side's
  st.turnStart = chessSnapshot(st);
  return true;
}
function chessPassTurn(st, pid) {
  if (!chessSeatOf(st, pid)) return 'notSeated';
  st.history.push({ cells: st.turnStart.cells, trays: st.turnStart.trays, turn: st.turn, moves: st.turnMoves });
  if (st.history.length > CHESS_HISTORY) st.history.shift();
  st.turn = st.turn === 'w' ? 'b' : 'w';
  st.turnStart = chessSnapshot(st); st.turnMoves = []; st.redo = [];
  st.resetVote.w = st.resetVote.b = false;
  return 'ok';
}
// Redo: put back what Take back removed, newest first; any new move or a passed turn clears it.
function chessRedo(st, pid) {
  if (!chessSeatOf(st, pid)) return 'notSeated';
  var r = st.redo.pop(); if (!r) return 'nothing';
  if (r.history) st.history.push(r.history);
  st.cells = r.cells; st.trays = r.trays; st.turn = r.turn; st.turnMoves = r.turnMoves; st.turnStart = r.turnStart;
  st.lastMove = r.turnMoves.length ? r.turnMoves[r.turnMoves.length - 1] : null;
  st.resetVote.w = st.resetVote.b = false;
  return 'ok';
}
// Take back: first the moves of the current turn (back to how it stood when the turn began), then,
// when there are none, the previous turn, whose player is to move again.
function chessTakeBack(st, pid) {
  if (!chessSeatOf(st, pid)) return 'notSeated';
  var from, undone = { cells: st.cells, trays: st.trays, turn: st.turn, turnMoves: st.turnMoves, turnStart: st.turnStart, history: null };
  if (st.turnMoves.length) { from = st.turnStart; }
  else if (st.history.length) { var h = st.history.pop(); from = h; st.turn = h.turn; undone.history = h; }
  else return 'nothing';
  st.redo.push(undone); if (st.redo.length > CHESS_HISTORY) st.redo.shift();
  st.cells = from.cells.slice(); st.trays = { w: from.trays.w.slice(), b: from.trays.b.slice() };
  st.turnStart = chessSnapshot(st); st.turnMoves = []; st.lastMove = null;
  st.resetVote.w = st.resetVote.b = false;
  return 'ok';
}
function chessSeatOf(st, pid) { return st.seats.w === pid ? 'w' : st.seats.b === pid ? 'b' : null; }
function chessSit(st, pid) { // returns the seat taken, or null when both are taken by others
  var s = chessSeatOf(st, pid); if (s) return s;
  if (st.seats.w === null) { st.seats.w = pid; return 'w'; }
  if (st.seats.b === null) { st.seats.b = pid; return 'b'; }
  return null;
}
function chessStand(st, pid) { var s = chessSeatOf(st, pid); if (!s) return false; st.seats[s] = null; st.resetVote[s] = false; return true; }
// A game under way (a move made since the last reset) keeps its players: walking away leaves the seat theirs, so
// nobody else can sit, move or vote until the two of them reset it. A board nobody has moved on frees its seats
// as before. (2026-10-19, for the webinar: fifty students may not disturb the game on the house table.)
function chessHeld(st) { return st.moves > 0; }
function chessLeave(st, pid) { return chessHeld(st) ? false : chessStand(st, pid); } // the server calls this when a seated player walks off
function applyChessMove(st, pid, from, to) {
  var seat = chessSeatOf(st, pid); if (!seat) return 'notSeated';
  from |= 0; to |= 0;
  if (from < 0 || from > 63 || to < 0 || to > 63 || from === to) return 'bad';
  var piece = st.cells[from]; if (!piece) return 'empty';
  if (st.cells[to]) st.trays[seat].push(st.cells[to]); // whatever was there is captured into the mover's tray
  st.cells[to] = piece; st.cells[from] = '';
  st.moves++; st.lastMove = { from: from, to: to, by: pid }; st.turnMoves.push(st.lastMove); st.redo = [];
  st.resetVote.w = st.resetVote.b = false;
  return 'ok';
}
// Reset needs both seated players to ask within 20 s of each other; alone, it is immediate.
function chessReset(st, pid, now) {
  var seat = chessSeatOf(st, pid); if (!seat) return 'notSeated';
  var other = seat === 'w' ? 'b' : 'w';
  if (st.seats[other] !== null && !st.resetVote[other]) { st.resetVote[seat] = true; st.resetVoteAt = now; return 'voted'; }
  var seats = st.seats, fresh = initialChessState(); fresh.seats = seats;
  for (var k in fresh) st[k] = fresh[k];
  return 'reset';
}
// Notice boards: anyone may pin a short note; the board keeps the newest NOTES_MAX.
var NOTES_MAX = 40, NOTE_LEN = 200;
function pinNote(st, by, name, text, at) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_LEN);
  if (!text) return false;
  st.notes.unshift({ by: by, name: String(name || '').slice(0, 16), text: text, at: at });
  if (st.notes.length > NOTES_MAX) st.notes.length = NOTES_MAX;
  return true;
}
function chessExpireVotes(st, now) {
  if ((st.resetVote.w || st.resetVote.b) && now - st.resetVoteAt > 20) { st.resetVote.w = st.resetVote.b = false; return true; }
  return false;
}

// ------------------------------------------------------------------ entities
function createEntity(w, kind, x, z) {
  var e = {
    id: w.nextId++, kind: kind, x: x, z: z, y: 0, gy: 0, air: 0, vy: 0, grounded: true,
    heading: 0, targetHeading: 0,
    speed: kind === 'player' ? C.WALK : kind === 'sheep' ? 0.7 : kind === 'bull' ? C.BULL_WALK : kind === 'healer' ? 0.8 : 1.1,
    radius: kind === 'deer' ? 0.35 : kind === 'bull' ? 0.5 : kind === 'wisp' || kind === 'wraith' ? 0.55 : C.BODY_R, stalled: false, stallCount: 0, progT: 0,
    vx: 0, vz: 0, // last step's velocity, for leading a shot at a thing that moves
    walkPhase: 0, moving: false, running: false,
    // movement abilities; mobs will get more (fly, swim, climb)
    maxJumps: 1, jumpsLeft: 1, jumpV: kind === 'sheep' ? 0 : Math.sqrt(2 * C.GRAVITY * C.JUMP_H), canSwim: false,
    home: { x: x, z: z }, state: 'idle', timer: w.rng() * 2, avoidSide: 1,
    stuckT: 0, sx: x, sz: z, stuckCount: 0, lastTurn: -1, // stuck detection for animals
    name: '', color: 0, // players: display name and shirt colour index
    hp: kind === 'bull' ? C.BULL_HP : kind === 'wisp' ? C.WISP_HP : kind === 'wraith' ? C.WRAITH_HP : C.HP, // the fight
    maxHp: kind === 'bull' ? C.BULL_HP : kind === 'wisp' ? C.WISP_HP : kind === 'wraith' ? C.WRAITH_HP : C.HP,
    sight: 0, keep: 0, fireCd: 0, volley: 1, side: 1, strafeT: 0, // floaters: how far they see, the distance they hold, how they shoot
    ghost: false, invulnUntil: 0, rootFrom: 0, rootUntil: 0, reviveAt: 0, regenT: 0, cd: { arrow: 0, wall: 0, blink: 0 },
    target: null, lastHurt: -1e9, goreCd: 0, chargeT: 0, restUntil: 0,
    driven: false, // moved by inputs (players): whoever owns the input steps it with stepDriven
    local: false   // on a client: this is my own body (predicted); everything else is interpolated
  };
  e.y = e.gy = surfaceAt(w, x, z);
  w.ents.push(e);
  return e;
}
function addPlayer(w, x, z) { var e = createEntity(w, 'player', x, z); e.driven = true; e.color = e.id % 6; e.heading = e.targetHeading = Math.PI / 4; return e; }
function removeEntity(w, id) { for (var i = 0; i < w.ents.length; i++) if (w.ents[i].id === id) { w.ents.splice(i, 1); return true; } return false; }
function spawnAnimals(w) {
  var rng = w.rng, i;
  for (i = 0; i < 7; i++) { var s = createEntity(w, 'sheep', -7 + (rng() * 2 - 1) * 2.6, 5 + (rng() * 2 - 1) * 2.2); s.heading = s.targetHeading = rng() * 6.28; }
  for (i = 0; i < 5; i++) { var d = createEntity(w, 'deer', 18 + (rng() * 2 - 1) * 6, 12 + (rng() * 2 - 1) * 6); d.heading = d.targetHeading = rng() * 6.28; }
  spawnBull(w);
  spawnHealer(w);
}
function spawnHealer(w) { // out of every spell's reach by construction: she can never die
  var spot = freeSpotNear(w, C.HEALER_X, C.HEALER_Z) || { x: C.HEALER_X, z: C.HEALER_Z };
  var h = createEntity(w, 'healer', spot.x, spot.z);
  h.name = 'Healer'; h.home = { x: C.HEALER_X, z: C.HEALER_Z }; h.heading = h.targetHeading = w.rng() * 6.28; h.jumpV = 0;
  return h;
}
function spawnBull(w) {
  var spot = freeSpotNear(w, C.ARENA_X + 5, C.ARENA_Z + 4) || { x: C.ARENA_X + 5, z: C.ARENA_Z + 4 };
  var b = createEntity(w, 'bull', spot.x, spot.z);
  b.name = 'Bull'; b.home = { x: C.ARENA_X, z: C.ARENA_Z }; b.heading = b.targetHeading = w.rng() * 6.28; b.jumpV = 0;
  return b;
}
// The floaters: a wisp (one bolt at a time, and it comes as a pair) and a wraith (a volley of three,
// faster, farther sighted). They rise on the far side of the arena from where the bull stands; the
// second of a pair a little way round the ring from the first.
var MOB_SPOTS = [[-5, -4], [3, -9]];
function spawnMob(w, kind, i) {
  if (kind === 'bull') return spawnBull(w);
  var at = MOB_SPOTS[(i || 0) % MOB_SPOTS.length], spot = freeSpotNear(w, C.ARENA_X + at[0], C.ARENA_Z + at[1]) || { x: C.ARENA_X + at[0], z: C.ARENA_Z + at[1] };
  var m = createEntity(w, kind, spot.x, spot.z), wisp = kind === 'wisp';
  m.name = wisp ? 'Wisp' : 'Wraith'; m.home = { x: C.ARENA_X, z: C.ARENA_Z }; m.heading = m.targetHeading = w.rng() * 6.28; m.jumpV = 0;
  m.sight = wisp ? C.WISP_SIGHT : C.WRAITH_SIGHT; m.keep = wisp ? C.WISP_KEEP : C.WRAITH_KEEP;
  m.fireCd = wisp ? C.WISP_CD : C.WRAITH_CD; m.volley = wisp ? 1 : C.WRAITH_VOLLEY; m.speed = wisp ? C.WISP_SPEED : C.WRAITH_SPEED;
  m.side = w.rng() < 0.5 ? -1 : 1; m.strafeT = 1 + w.rng();
  m.cd.arrow = w.time + 1.5; // a breath before the first shot
  return m;
}
function spawnTier(w, tier) {
  w.arena.tier = tier; w.arena.quietT = 0;
  var kind = TIERS[tier], count = kind === 'wisp' ? C.WISP_COUNT : 1, m = null;
  for (var i = 0; i < count; i++) m = spawnMob(w, kind, i) || m;
  w.events.push({ type: 'spawn', who: m.id, kind: m.kind, tier: tier, count: count }); // one event for the wave, however many rise
  return m;
}
function nextTier(w, want) { var p = w.arena.pin ? TIERS.indexOf(w.arena.pin) : -1; return p >= 0 ? p : want; } // a pinned arena brings the same wave back whatever was due
function spawnWave(w) { // after the arena's last monster falls: the next wave if anyone is still about, else the bull again
  return spawnTier(w, nextTier(w, playersInZone(w).length ? (w.arena.tier + 1) % TIERS.length : 0));
}
// Pin the arena to one wave (a kind from TIERS), or free it (anything else): the monsters in it go, queued waves
// are dropped, the wanted wave rises now, and every later respawn, fade or quiet brings the same one until freed.
// For trying a monster out: MYSTICA.mod.spawn('wraith') from the admin page's console, or MOBS=wraith at start.
function pinArena(w, kind) {
  var tier = TIERS.indexOf(kind);
  w.arena.pin = tier >= 0 ? kind : null;
  if (tier < 0) return false;
  for (var i = w.ents.length - 1; i >= 0; i--) if (isMob(w.ents[i])) removeEntity(w, w.ents[i].id);
  w.respawns.length = 0;
  spawnTier(w, tier);
  return true;
}
function turnToward(a, target, maxStep) {
  var d = ((target - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return a + clamp(d, -maxStep, maxStep);
}
// Player intent for one tick: a world-space move direction (not necessarily unit), run flag, jump edge.
// Returns true if the body moved or did not try to; false when it pushed into something.
function applyPlayerInput(w, e, inp, dt) {
  var want = (inp.mx || inp.mz) ? Math.hypot(inp.mx, inp.mz) : 0;
  e.moving = false;
  e.running = !!(want && inp.run && e.grounded);
  e.creeping = !!(want && inp.creep && !e.running); // the stick's third speed, CREEP_MUL of a walk: only the stick asks for it, and only on purpose (stickBand in main.js)
  if (inp.jump) tryJump(w, e);
  if (inp.cast) castSpell(w, e, inp.cast, !!inp.assist, inp.target | 0);
  if (!want) { e.stalled = false; e.slide = 0; e.progT = 0; e.px = e.x; e.pz = e.z; return true; }
  var mx = inp.mx / want, mz = inp.mz / want;
  var wf = waterFactor(w, e, e.x, e.z); if (wf < 1) e.running = false; // nobody runs through water
  var speed = (e.running ? e.speed * C.RUN_MULT : e.creeping ? e.speed * C.CREEP_MUL : e.speed) * wf;
  if (!e.grounded) speed = Math.min(speed, e.speed); // no running jumps: air speed is walking speed
  var rooted = w.time >= e.rootFrom && w.time < e.rootUntil; if (rooted) speed = 0; // casting plants the feet for a moment; you still turn. A window, not a deadline: the client replays old inputs at their own time, and one from before the cast must still move
  e.targetHeading = Math.atan2(mx, mz);
  e.heading = turnToward(e.heading, e.targetHeading, C.TURN * dt);
  var moved = moveEntity(w, e, mx * speed * dt, mz * speed * dt);
  // wedge detection: pushing for half a second without getting anywhere means stop deflecting (the
  // screen stops shaking); a full second means step to the nearest free spot
  if (rooted) { e.stalled = false; e.progT = 0; e.px = e.x; e.pz = e.z; } // rooted feet are not a wedge (deep water that stops a body still counts)
  else if ((e.progT = (e.progT || 0) + dt) >= 0.5) {
    var got = Math.hypot(e.x - (e.px === undefined ? e.x : e.px), e.z - (e.pz === undefined ? e.z : e.pz));
    e.stalled = got < 0.15; // wedged: moveEntity stops trying rather than vibrate. Nobody is teleported: the old nearest-free-spot move went straight through thin walls (2026-10-18)
    e.progT = 0; e.px = e.x; e.pz = e.z;
  }
  if (moved) { e.walkPhase += speed * dt * 5.5; e.moving = true; return true; }
  return false;
}
function updateAnimal(w, e, dt) {
  var rng = w.rng;
  if (e.kind === 'bull' && updateBull(w, e, dt)) return;
  if (isFloater(e) && updateFloater(w, e, dt)) return;
  e.timer -= dt;
  if (e.timer <= 0) {
    if (e.state === 'walk') { e.state = 'idle'; e.timer = 1.5 + rng() * 3; }
    else {
      e.state = 'walk'; e.timer = 2 + rng() * 4; e.targetHeading = rng() * Math.PI * 2;
      var dx = e.home.x - e.x, dz = e.home.z - e.z;
      if (Math.hypot(dx, dz) > (e.kind === 'sheep' ? 3 : isMob(e) ? C.ARENA_R - 4 : e.kind === 'healer' ? C.HEALER_LEASH : 12)) e.targetHeading = Math.atan2(dx, dz);
    }
  }
  e.heading = turnToward(e.heading, e.targetHeading, 2.5 * dt);
  e.moving = false;
  if (e.state === 'walk') {
    var sp = e.speed * waterFactor(w, e, e.x, e.z);
    if (moveEntity(w, e, Math.sin(e.heading) * sp * dt, Math.cos(e.heading) * sp * dt)) { e.walkPhase += sp * dt * 7; e.moving = true; }
    else if (e.grounded) {
      var ahead = barrierAt(w, e.x + Math.sin(e.heading) * 0.6, e.z + Math.cos(e.heading) * 0.6) - e.y;
      if (e.jumpV > 0 && ahead > 0 && ahead < 0.95) tryJump(w, e); // a deer hops a fence; a sheep turns back
      else if (w.time - e.lastTurn > 0.5) { e.targetHeading = e.heading + Math.PI * (0.6 + rng() * 0.8); e.lastTurn = w.time; }
    }
    // stuck in a corner (sliding back and forth without getting anywhere): turn right round, and if
    // that fails twice, step to the nearest free spot
    e.stuckT += dt;
    if (e.stuckT > 2) {
      if (Math.hypot(e.x - e.sx, e.z - e.sz) < 0.5) {
        e.stuckCount++;
        e.heading = e.targetHeading = e.heading + Math.PI + (rng() - 0.5);
        e.timer = 2 + rng() * 2;
        if (e.stuckCount >= 2) { var spot = freeSpotNear(w, e.x, e.z); if (spot) { e.x = spot.x; e.z = spot.z; } e.stuckCount = 0; }
      } else e.stuckCount = 0;
      e.stuckT = 0; e.sx = e.x; e.sz = e.z;
    }
  } else { e.stuckT = 0; e.sx = e.x; e.sz = e.z; }
}
function freeSpotNear(w, x, z) { // nearest spot with ground to stand on, no barrier, no deep water
  for (var r = 1; r <= 6; r += 0.5) for (var k = 0; k < 16; k++) {
    var a = k / 16 * Math.PI * 2, nx = x + Math.cos(a) * r, nz = z + Math.sin(a) * r;
    if (Math.abs(nx) > w.HALF - 1 || Math.abs(nz) > w.HALF - 1) continue;
    if (depthAt(w, nx, nz) >= C.DEEP) continue;
    if (barrierAt(w, nx, nz) > surfaceAt(w, nx, nz) + 0.05) continue;
    return { x: nx, z: nz };
  }
  return null;
}

// ------------------------------------------------------------------ the fight: the arrow, the bull, rounds
// Mobile first: the one spell aims where the body faces and is one tap; casting plants the feet for a
// moment, so you stop to shoot. Spells only work inside the arena. Bolts move like a walker in two
// dimensions (barriers stop them, height does not) and do real damage whenever they land; a round only
// adds scoring and last-one-standing. Everyone regenerates a heart every REGEN_EVERY seconds.
function facing(e) { return { x: Math.sin(e.heading), z: Math.cos(e.heading) }; }
function canCast(w, e) { return !e.ghost && !e.away && inArena(e.x, e.z); }
// The countdown's shield: nobody standing in the ring can be hurt until "Fight!". (2026-10-18: the start
// used to scatter everyone to the rim with full hearts, and a step over the rim ended the round; Bobby
// read the pair as the fight resetting and teleporting them. Now the gong is the only change.)
function shielded(w, t) { return w.round.phase === 'countdown' && t.kind === 'player' && inArena(t.x, t.z); }
// Who an arrow can be aimed at: a living player or monster within range, not behind cover.
function shootable(w, e, t) {
  if (!t || t === e || (t.kind !== 'player' && !isMob(t)) || t.ghost || t.away) return false;
  var d = Math.hypot(t.x - e.x, t.z - e.z);
  return d >= 0.5 && d <= C.SHOT_RANGE && clearLine(w, e.x, e.z, t.x, t.z);
}
function inArc(e, t, deg) { // is t within deg of the way e faces?
  var f = facing(e), dx = t.x - e.x, dz = t.z - e.z, d = Math.hypot(dx, dz) || 1;
  return (dx * f.x + dz * f.z) / d >= Math.cos(deg * Math.PI / 180);
}
// The unit direction that meets a moving mark: aim where it will be when the bolt arrives.
function leadDir(e, t) {
  var dx = t.x - e.x, dz = t.z - e.z, dist = Math.hypot(dx, dz) || 1e-6;
  if (t.vx || t.vz) {
    var fly = dist / C.SHOT_SPEED; dx += t.vx * fly; dz += t.vz * fly;
    fly = Math.hypot(dx, dz) / C.SHOT_SPEED; dx = t.x - e.x + t.vx * fly; dz = t.z - e.z + t.vz * fly; dist = Math.hypot(dx, dz) || 1e-6;
  }
  return { x: dx / dist, z: dz / dist };
}
// `target` is the lock (2026-10-17: aiming by facing with a thumb was "not fun"): the entity the client
// tapped, or the nearest monster in its range. If it can be shot, the arrow flies at it whatever way
// the caster faces and the caster turns to it; else the old assist cone, else straight ahead.
function castSpell(w, e, which, assist, target) {
  if (which !== 1 || !canCast(w, e)) return false;
  var f = facing(e), now = w.time;
  if (now < e.cd.arrow) return false;
  e.cd.arrow = now + C.CD_ARROW; e.rootFrom = now; e.rootUntil = now + C.CAST_ROOT;
  if (w.clientMode) return true; // online the server casts the bolt; the client predicts the root and the cooldown, so the body stops where the server will stop it
  var d = f, mark = target ? findEntity(w, target) : null;
  if (mark && shootable(w, e, mark) && inArc(e, mark, C.AIM_DEG)) { // the lock aims only within the arc the body faces; outside it the arrow flies straight ahead (the touch cone below may still bend it a little)
    d = leadDir(e, mark);
    e.heading = e.targetHeading = Math.atan2(d.x, d.z);
  } else if (assist) { // bend toward the nearest target within a narrow cone: thumbs are not mice
    var best = null, bestA = C.ASSIST_DEG * Math.PI / 180;
    for (var i = 0; i < w.ents.length; i++) {
      var t = w.ents[i]; if (t === e || (t.kind !== 'player' && !isMob(t)) || t.ghost || t.away) continue;
      var dist = Math.hypot(t.x - e.x, t.z - e.z); if (dist < 0.5 || dist > C.SHOT_RANGE) continue;
      var ld = leadDir(e, t), a = Math.acos(clamp(ld.x * f.x + ld.z * f.z, -1, 1));
      if (a < bestA) { bestA = a; best = ld; }
    }
    if (best) d = best;
  }
  w.shots.push({ id: w.nextShotId++, owner: e.id, v: C.SHOT_SPEED, x: e.x + d.x * 0.6, z: e.z + d.z * 0.6, dx: d.x, dz: d.z, left: C.SHOT_RANGE });
  w.events.push({ type: 'cast', who: e.id, spell: 'arrow' });
  return true;
}
// (The nova, a charge-and-release shockwave, lived here 2026-10-17 and was taken out the same day:
// Bobby, "let's go back to just arrows". It is in the history if it is ever wanted again.)
// Each bolt flies at its own speed (a player's arrow, a monster's bolt) and is stepped in pieces no longer
// than SHOT_SUBSTEP, each checked against walls and bodies: the hit was once tested only where a whole
// tick's step ended (0.65 tiles at 20 Hz, 1.3 when the small container's tick stretched), so grazes landed
// by luck and a long tick could carry a bolt clean through a body (2026-10-18).
function stepShots(w, dt) {
  for (var i = w.shots.length - 1; i >= 0; i--) {
    var s = w.shots[i], step = Math.min((s.v || C.SHOT_SPEED) * dt, s.left), gone = false;
    var pieces = Math.max(1, Math.ceil(step / C.SHOT_SUBSTEP)), piece = step / pieces;
    s.left -= step;
    for (var p = 0; p < pieces && !gone; p++) {
      var nx = s.x + s.dx * piece, nz = s.z + s.dz * piece;
      if (Math.abs(nx) > w.HALF - 0.5 || Math.abs(nz) > w.HALF - 0.5) { gone = true; break; }
      if (barrierAt(w, nx, nz, 0.1) > surfaceAt(w, nx, nz) + 0.3) { gone = true; w.events.push({ type: 'splash', x: nx, z: nz, dx: s.dx, dz: s.dz }); break; }
      s.x = nx; s.z = nz;
      for (var j = 0; j < w.ents.length; j++) {
        var t = w.ents[j];
        if (t.id === s.owner || (t.kind !== 'player' && !isMob(t)) || t.ghost || t.away || w.time < t.invulnUntil) continue;
        if (s.mob && isMob(t)) continue; // a monster's bolt passes its own kind
        if (Math.hypot(t.x - s.x, t.z - s.z) > C.SHOT_RADIUS + (t.radius - C.BODY_R)) continue;
        if (shielded(w, t)) { w.events.push({ type: 'splash', x: s.x, z: s.z, dx: s.dx, dz: s.dz }); gone = true; break; } // the countdown's shield: the bolt breaks on the body, seen and heard, and nothing lands
        damage(w, t, s.owner, s.dx, s.dz); gone = true; break;
      }
    }
    if (!gone && s.left <= 0) { gone = true; w.events.push({ type: 'pop', x: s.x, z: s.z }); } // spent: it pops
    if (gone) w.shots.splice(i, 1);
  }
}
// One heart of damage from `by` (an entity id, or null for the world), pushed along (dx, dz).
function damage(w, t, by, dx, dz) {
  var r = w.round, fighting = r.phase === 'fight' && r.players.indexOf(t.id) >= 0;
  t.invulnUntil = w.time + C.HIT_INVULN; t.lastHurt = w.time;
  var kx = t.x + dx * C.KNOCKBACK, kz = t.z + dz * C.KNOCKBACK;
  if (barrierAt(w, kx, kz, t.radius) <= surfaceAt(w, kx, kz) + 0.05 && depthAt(w, kx, kz) < C.DEEP) { t.x = kx; t.z = kz; }
  t.hp--;
  w.events.push({ type: 'hit', who: t.id, by: by, x: t.x, z: t.z, hp: t.hp });
  if (isMob(t)) {
    var shooter = by !== null ? findEntity(w, by) : null;
    if (shooter && shooter.kind === 'player') { t.target = by; t.chargeT = 0; callKin(w, t, shooter); } // whoever hurts it is the one it wants, however far; its kin want them too
    if (t.hp <= 0) {
      w.events.push({ type: 'died', who: t.id, kind: t.kind, by: by, x: t.x, z: t.z });
      removeEntity(w, t.id);
      w.arena.tier = Math.max(0, TIERS.indexOf(t.kind));
      if (!w.ents.some(isMob)) w.respawns.push({ kind: 'wave', at: w.time + C.BULL_RESPAWN }); // the wave turns when the last of them falls; what comes next is decided when the time comes
    }
    return;
  }
  if (r.phase === 'fight' && by !== null && inArena(t.x, t.z)) score(r, by).hits++; // anyone's hits count, fallen or not
  if (t.hp <= 0) {
    t.ghost = true; t.target = null;
    if (fighting && !r.fallen[t.id]) { // a contender falls: still a fighter after the healer, but no longer able to win
      r.fallen[t.id] = true;
      if (by !== null) score(r, by).elims++;
      w.events.push({ type: 'elim', who: t.id, by: by });
    } else w.events.push({ type: 'down', who: t.id, by: by }); // a ghost until the healer brings you back
  }
}
function score(r, id) { return r.scores[id] || (r.scores[id] = { hits: 0, elims: 0 }); }
// Regeneration, the healer's touch, respawns.
function stepLife(w, dt) {
  var healers = w.ents.filter(function (h) { return h.kind === 'healer'; });
  for (var i = w.ents.length - 1; i >= 0; i--) {
    var e = w.ents[i];
    if (e.kind !== 'player' && !isMob(e)) continue;
    var mends = !e.ghost && e.hp < e.maxHp && !e.away && (!isMob(e) || (e.target === null && w.time - e.lastHurt > C.MOB_REGEN_AFTER));
    if (mends) { e.regenT += dt; if (e.regenT >= C.REGEN_EVERY) { e.regenT = 0; e.hp++; } } else e.regenT = 0;
    if (e.ghost && e.kind === 'player' && !e.away) { // a ghost who reaches the healer is made whole
      for (var k = 0; k < healers.length; k++) {
        if (Math.hypot(healers[k].x - e.x, healers[k].z - e.z) > C.HEAL_REACH) continue;
        e.ghost = false; e.hp = e.maxHp; e.invulnUntil = w.time + 1.5;
        w.events.push({ type: 'revive', who: e.id, by: healers[k].id, x: e.x, z: e.z });
        break;
      }
    }
  }
  for (var k = w.respawns.length - 1; k >= 0; k--) if (w.time >= w.respawns[k].at) {
    if (w.respawns[k].kind === 'wave') spawnWave(w); else spawnTier(w, nextTier(w, 0));
    w.respawns.splice(k, 1);
  }
  // a floater with nobody about fades, and the arena goes back to the bull: you always meet the bull first
  var floaters = w.ents.filter(isFloater);
  if (floaters.length) {
    if (playersInZone(w).length) w.arena.quietT = 0;
    else if ((w.arena.quietT += dt) >= C.QUIET_SECONDS) {
      for (var q = 0; q < floaters.length; q++) { var fl = floaters[q]; w.events.push({ type: 'fade', who: fl.id, kind: fl.kind, x: fl.x, z: fl.z }); removeEntity(w, fl.id); } // a pair fades together
      spawnTier(w, nextTier(w, 0));
    }
  }
}
function arenaGate(w) { // the south-east gap in the rim, where the trail arrives
  var ang = 1 / 12 * Math.PI * 2 + 0.2, x = C.ARENA_X + Math.cos(ang) * (C.ARENA_R - 1.5), z = C.ARENA_Z + Math.sin(ang) * (C.ARENA_R - 1.5);
  return freeSpotNear(w, x, z) || { x: x, z: z };
}
// The wraith's line of fire: through the mark, across the line between them (ux, uz is the line's direction;
// angle is the same for the client's mesh, which lies along x and turns about y). It is a wall entry: the
// snapshot carries it like the old walls of stone, with a kind and an age.
function castFire(w, e, t) {
  var dx = t.x - e.x, dz = t.z - e.z, d = Math.hypot(dx, dz) || 1e-6, px = -dz / d, pz = dx / d;
  e.cd.wall = w.time + C.WRAITH_FIRE_CD; e.rootUntil = w.time + C.FLOATER_HOLD; e.vx = e.vz = 0;
  w.walls.push({ id: w.nextWallId++, kind: 'fire', owner: e.id, x: t.x, z: t.z, ux: px, uz: pz, angle: Math.atan2(-pz, px), from: w.time, until: w.time + C.FIRE_RISE + C.FIRE_SECONDS });
  w.events.push({ type: 'cast', who: e.id, spell: 'fire', x: e.x, z: e.z });
}
// Lines of fire: gone when their time is up; while one burns, a living player on it loses a heart and is shoved out
// the side they came from (HIT_INVULN keeps it to one heart per crossing, the countdown's shield to none). Monsters
// never burn, and nothing is blocked.
function stepWalls(w, dt) {
  for (var i = w.walls.length - 1; i >= 0; i--) {
    var f = w.walls[i];
    if (w.time >= f.until) { w.walls.splice(i, 1); continue; }
    if (f.kind !== 'fire' || w.time < f.from + C.FIRE_RISE) continue;
    var h = C.FIRE_LEN / 2, x0 = f.x - f.ux * h, z0 = f.z - f.uz * h;
    for (var j = 0; j < w.ents.length; j++) {
      var t = w.ents[j];
      if (t.kind !== 'player' || t.ghost || t.away || w.time < t.invulnUntil || shielded(w, t)) continue;
      var s = clamp(((t.x - x0) * f.ux + (t.z - z0) * f.uz) / C.FIRE_LEN, 0, 1), nx = x0 + f.ux * C.FIRE_LEN * s, nz = z0 + f.uz * C.FIRE_LEN * s;
      var ox = t.x - nx, oz = t.z - nz, od = Math.hypot(ox, oz);
      if (od > C.FIRE_HALF_W + t.radius) continue;
      if (od < 1e-3) { ox = -f.uz; oz = f.ux; od = 1; } // standing dead on the line: shoved to one side
      damage(w, t, f.owner, ox / od, oz / od);
    }
  }
}
// The bull: wanders the arena; whoever hurts it, from however far, is charged in bursts (BULL_BURST
// seconds of charge, BULL_REST of standing and snorting) and gored on contact, until they are down,
// gone from the arena, or BULL_GRUDGE seconds have passed since it was last hurt. The charge is a
// shade slower than a running player, so running away works; standing and shooting does not.
// Returns true when it handled this tick itself.
function updateBull(w, e, dt) {
  var t = e.target !== null ? findEntity(w, e.target) : null;
  if (t && (t.ghost || t.away || !inArena(t.x, t.z) || w.time - e.lastHurt > C.BULL_GRUDGE)) {
    e.target = null; t = null; e.chargeT = 0;
  }
  e.goreCd = Math.max(0, e.goreCd - dt);
  if (!t) { e.speed = C.BULL_WALK; e.resting = false; return false; } // the ordinary wander, leashed to the arena by home
  var dx = t.x - e.x, dz = t.z - e.z, dist = Math.hypot(dx, dz);
  e.targetHeading = Math.atan2(dx, dz); e.heading = turnToward(e.heading, e.targetHeading, 6 * dt);
  e.state = 'walk'; e.timer = 1; e.moving = false;
  if (w.time < e.restUntil) { e.resting = true; return true; } // winded: stands, turns, glares
  e.resting = false;
  e.chargeT += dt;
  if (e.chargeT >= C.BULL_BURST) { e.chargeT = 0; e.restUntil = w.time + C.BULL_REST; w.events.push({ type: 'snort', who: e.id, x: e.x, z: e.z }); return true; }
  e.speed = C.BULL_CHARGE;
  if (dist > e.radius + t.radius + 0.2) {
    if (moveEntity(w, e, Math.sin(e.heading) * C.BULL_CHARGE * dt, Math.cos(e.heading) * C.BULL_CHARGE * dt)) { e.walkPhase += C.BULL_CHARGE * dt * 5; e.moving = true; }
  } else if (e.goreCd <= 0 && w.time >= t.invulnUntil && !shielded(w, t)) {
    e.goreCd = C.BULL_GORE_CD;
    damage(w, t, e.id, dx / (dist || 1), dz / (dist || 1));
    w.events.push({ type: 'gore', who: e.id, x: e.x, z: e.z });
  }
  return true;
}
// The floaters: hover about the arena until they see someone (within sight, nothing in the way), then
// hold a distance and strafe across the line of fire, switching sides every second or two or when they
// bump into cover, and shoot whenever the line is clear. A hit from anyone makes that person the target.
// They never leave the arena. Returns true when it handled this tick itself.
function clearLine(w, x0, z0, x1, z1) {
  var dx = x1 - x0, dz = z1 - z0, n = Math.ceil(Math.hypot(dx, dz) / 0.5);
  for (var i = 1; i < n; i++) { var x = x0 + dx * i / n, z = z0 + dz * i / n; if (barrierAt(w, x, z, 0.1) > surfaceAt(w, x, z) + 0.3) return false; }
  return true;
}
// Kin hunt together: when a floater takes a mark, by sight or by being hurt, every other floater of its kind
// whose leash (sight x 1.5, the distance past which it would drop a mark) reaches the mark takes it too and
// drifts in (2026-10-19, Bobby: he engaged one wisp and the other, close by, watched).
function callKin(w, e, t) {
  for (var i = 0; i < w.ents.length; i++) {
    var k = w.ents[i];
    if (k === e || k.kind !== e.kind || !isFloater(k) || k.target !== null) continue;
    if (Math.hypot(t.x - k.x, t.z - k.z) > k.sight * 1.5) continue;
    k.target = t.id; k.chargeT = 0;
    w.events.push({ type: 'notice', who: k.id, kind: k.kind, target: t.id, x: k.x, z: k.z, called: true });
  }
}
function floaterSees(w, e) {
  var best = null, bd = e.sight;
  for (var i = 0; i < w.ents.length; i++) {
    var p = w.ents[i]; if (p.kind !== 'player' || p.ghost || p.away || !inArena(p.x, p.z)) continue;
    var d = Math.hypot(p.x - e.x, p.z - e.z);
    if (d < bd && clearLine(w, e.x, e.z, p.x, p.z)) { bd = d; best = p; }
  }
  return best;
}
function updateFloater(w, e, dt) {
  var t = e.target !== null ? findEntity(w, e.target) : null;
  if (t && (t.ghost || t.away || !inArena(t.x, t.z) || Math.hypot(t.x - e.x, t.z - e.z) > e.sight * 1.5)) { e.target = null; t = null; }
  if (!t) { t = floaterSees(w, e); if (t) { e.target = t.id; w.events.push({ type: 'notice', who: e.id, kind: e.kind, target: t.id, x: e.x, z: e.z }); if (e.kind === 'wraith') e.cd.wall = Math.max(e.cd.wall, w.time + C.WRAITH_FIRE_FIRST); callKin(w, e, t); } } // a breath before the first fire; the kin come too
  if (!t) return false; // the ordinary hover-wander, leashed to the arena by home
  var dx = t.x - e.x, dz = t.z - e.z, dist = Math.hypot(dx, dz) || 1e-6, ux = dx / dist, uz = dz / dist;
  e.targetHeading = Math.atan2(dx, dz); e.heading = turnToward(e.heading, e.targetHeading, 8 * dt);
  e.state = 'walk'; e.timer = 1; e.moving = false; e.vx = e.vz = 0;
  if (w.time < e.rootUntil) return true; // hanging still to shoot: stand and be hit
  if (e.kind === 'wraith' && w.time >= e.cd.wall && dist <= C.WRAITH_FIRE_RANGE) { castFire(w, e, t); return true; } // the wraith's second spell, with the same tell as a shot
  e.strafeT -= dt; if (e.strafeT <= 0) { e.side = -e.side; e.strafeT = 1.2 + w.rng() * 1.5; }
  var sx = -uz * e.side, sz = ux * e.side, mx, mz; // across the line of fire
  if (dist > e.keep + 1.5) { mx = ux + sx * 0.5; mz = uz + sz * 0.5; }
  else if (dist < e.keep - 2) { mx = -ux + sx * 0.5; mz = -uz + sz * 0.5; }
  else { mx = sx; mz = sz; }
  var n = Math.hypot(mx, mz) || 1, sp = e.speed, stepX = mx / n * sp * dt, stepZ = mz / n * sp * dt;
  if (Math.hypot(e.x + stepX - C.ARENA_X, e.z + stepZ - C.ARENA_Z) > C.ARENA_R - 1.5) { e.side = -e.side; e.strafeT = 1.5; } // the rim: turn back
  else if (moveEntity(w, e, stepX, stepZ)) { e.walkPhase += sp * dt * 5; e.moving = true; e.vx = stepX / dt; e.vz = stepZ / dt; }
  else { e.side = -e.side; e.strafeT = 1.5; } // cover in the way: strafe the other way
  if (w.time >= e.cd.arrow && dist <= C.SHOT_RANGE && clearLine(w, e.x, e.z, t.x, t.z)) {
    e.cd.arrow = w.time + e.fireCd; e.rootUntil = w.time + C.FLOATER_HOLD; e.vx = e.vz = 0;
    var k, vol = e.volley, spread = 12 * Math.PI / 180, base = Math.atan2(ux, uz);
    for (k = 0; k < vol; k++) {
      var a = base + (vol > 1 ? (k - (vol - 1) / 2) * spread : (w.rng() - 0.5) * 6 * Math.PI / 180), bx = Math.sin(a), bz = Math.cos(a);
      w.shots.push({ id: w.nextShotId++, owner: e.id, mob: true, v: C.MOB_SHOT_SPEED, x: e.x + bx * 0.6, z: e.z + bz * 0.6, dx: bx, dz: bz, left: C.SHOT_RANGE });
    }
    w.events.push({ type: 'cast', who: e.id, spell: 'arrow' });
  }
  return true;
}
// A round starts when someone standing in the ring uses the stone (startRound: the server's onUse, the
// admin's MYSTICA.mod.round()); nothing starts by itself (2026-10-19: two players fighting the wraith found
// themselves in a round, and its board in the middle of the screen). The countdown is 4 s when the two
// are the only ones on the grounds, 7 s when others are nearby and might run in; each arrival during the
// countdown puts 7 s back on the clock, up to COUNTDOWN_MAX from the first call. Nobody in the ring can be
// hurt during the countdown (shielded), and at "Fight!" everyone in the arena is a contender with full
// hearts, standing where they stood. A contender who dies, or is out of the ring or disconnected for
// OUT_GRACE seconds, has fallen: they may come back (via the healer) and keep fighting, and their kills
// count, but they cannot win. The round ends when a single contender is left unfallen, whoever landed
// the blows.
function playersInArena(w) { return w.ents.filter(function (e) { return e.kind === 'player' && !e.away && !e.ghost && inArena(e.x, e.z); }); }
function playersInZone(w) { return w.ents.filter(function (e) { return e.kind === 'player' && !e.away && !e.ghost && inZone(e.x, e.z); }); }
function startRound(w) { // the stone's doing: 'ok', 'busy' (a round is on), 'alone' (fewer than two in the ring)
  var r = w.round;
  if (r.phase !== 'lobby') return 'busy';
  var here = playersInArena(w).length;
  if (here < 2) return 'alone';
  var crowd = playersInZone(w).length > here;
  r.phase = 'countdown'; r.t = crowd ? C.COUNTDOWN_CROWD : C.COUNTDOWN; r.winner = null; r.scores = {}; r.fallen = {}; r.here = here; r.began = w.time;
  w.events.push({ type: 'round', phase: 'countdown', seconds: r.t });
  return 'ok';
}
function fall(w, r, e, by) {
  if (r.fallen[e.id]) return;
  r.fallen[e.id] = true;
  w.events.push({ type: 'elim', who: e.id, by: by });
}
function stepRound(w, dt) {
  var r = w.round, i, e;
  if (r.phase === 'lobby') return; // nothing starts by itself: the stone does
  if (r.phase === 'countdown') {
    var here = playersInArena(w).length;
    if (here < 2) { r.phase = 'lobby'; w.events.push({ type: 'round', phase: 'lobby', reason: 'alone' }); return; }
    if (here > r.here) r.t = Math.max(r.t, Math.min(C.COUNTDOWN_CROWD, r.began + C.COUNTDOWN_MAX - w.time)); // someone else walked in: the gong waits for them, never past COUNTDOWN_MAX from the first call (before, the first two to arrive started a round the rest could only fall into)
    r.here = here;
    r.t -= dt;
    if (r.t > 0) return;
    var ps = playersInArena(w);
    r.phase = 'fight'; r.t = 0; r.players = ps.map(function (p) { return p.id; }); r.fallen = {}; r.out = {};
    for (i = 0; i < ps.length; i++) { e = ps[i]; e.hp = C.HP; e.cd = { arrow: 0, wall: 0, blink: 0 }; } // full hearts where they stand: nobody is moved, and the shield has held until this moment
    w.events.push({ type: 'round', phase: 'fight', players: r.players.slice() });
    return;
  }
  if (r.phase === 'fight') {
    r.t += dt;
    var standing = [];
    var out = r.out || (r.out = {});
    for (i = 0; i < r.players.length; i++) {
      var id = r.players[i]; e = findEntity(w, id);
      if (!e) { r.fallen[id] = true; continue; } // gone from the game
      if (!e.ghost && (e.away || !inArena(e.x, e.z))) { // out of the ring, or the connection dropped: a grace, then fallen
        if ((out[id] = (out[id] || 0) + dt) >= C.OUT_GRACE) fall(w, r, e, null);
      } else out[id] = 0;
      if (!r.fallen[e.id]) standing.push(e);
    }
    if (standing.length <= 1) {
      r.phase = 'over'; r.winner = standing.length ? standing[0].id : null; r.t = C.OVER_SECONDS;
      w.events.push({ type: 'round', phase: 'over', winner: r.winner, scores: r.scores });
    }
    return;
  }
  if (r.phase === 'over') {
    r.t -= dt;
    if (r.t > 0) return;
    r.phase = 'lobby'; r.players = []; r.fallen = {};
    for (i = 0; i < w.ents.length; i++) { e = w.ents[i]; if (e.kind === 'player') { e.ghost = false; e.reviveAt = 0; e.hp = C.HP; } }
    w.events.push({ type: 'round', phase: 'lobby' });
  }
}
function findEntity(w, id) { for (var i = 0; i < w.ents.length; i++) if (w.ents[i].id === id) return w.ents[i]; return null; }

// ------------------------------------------------------------------ town: ward field and guards
// Safety is a property of land. The town emits a ward field that falls off with distance, stretched
// along a facing direction (a lobe). Land is warded where the field exceeds WARD_THR. Guard response
// time grows as the field weakens, and below the threshold nobody comes. Strength stands in for
// presence and economy until the server computes them.
function wardAt(w, x, z) {
  var t = w.town, dx = x - t.x, dz = z - t.z, fx = Math.cos(t.facing), fz = Math.sin(t.facing);
  var along = dx * fx + dz * fz, perp = dx * fz - dz * fx;
  var L = along >= 0 ? C.WARD_AHEAD : C.WARD_BACK;
  return t.strength * Math.exp(-((perp * perp) / (C.WARD_W * C.WARD_W) + (along * along) / (L * L)));
}
function wardRadius(w, phi) { // distance from the town centre to the threshold line, in direction phi
  var t = w.town;
  if (t.strength <= C.WARD_THR) return 0;
  var ux = Math.cos(phi), uz = Math.sin(phi);
  var along = ux * Math.cos(t.facing) + uz * Math.sin(t.facing), perp = ux * Math.sin(t.facing) - uz * Math.cos(t.facing);
  var L = along >= 0 ? C.WARD_AHEAD : C.WARD_BACK;
  return Math.sqrt(Math.log(t.strength / C.WARD_THR) / ((perp * perp) / (C.WARD_W * C.WARD_W) + (along * along) / (L * L)));
}
function updateWardObstacles(w) { // wardstones sit on the threshold line and block like posts
  var t = w.town, n = w.wardstones; // the first entries of dynObs; walls of stone come after them
  for (var i = 0; i < n; i++) {
    var phi = i / n * Math.PI * 2, r = wardRadius(w, phi), o = w.dynObs[i];
    o.r = r > 0 ? 0.3 : 0;
    if (r > 0) { o.x = clamp(t.x + Math.cos(phi) * r, -w.HALF + 1, w.HALF - 1); o.z = clamp(t.z + Math.sin(phi) * r, -w.HALF + 1, w.HALF - 1); }
  }
}
function guardResponseTime(f) { // seconds before a guard arrives: instant in the core, slow at the fringe
  if (f >= 0.75) return 0;
  return 0.2 + (0.75 - f) / (0.75 - C.WARD_THR) * 5;
}
// A sculpt attempt by entity e at (x, z). Returns 'ok', 'blocked' (a guard is already there) or 'guard'
// (a guard just arrived). Guards appear beside the offender; the client draws them from w.town.
function sculptAttempt(w, e, x, z, tool, dt, R) {
  var t = w.town, f = wardAt(w, x, z);
  if (f >= C.WARD_THR) {
    t.sculptedThisTick = true;
    if (t.guardTimer > 0) return 'blocked';
    t.alarm += dt;
    if (t.alarm >= guardResponseTime(f)) {
      t.guardTimer = C.GUARD_STAY;
      t.guardX = e.x + 0.92; t.guardZ = e.z - 0.92; // a step to the offender's screen-right
      t.guardHeading = Math.atan2(e.x - t.guardX, e.z - t.guardZ);
      w.events.push({ type: 'guard', who: e.id, strength: f, x: t.guardX, z: t.guardZ });
      return 'guard';
    }
  }
  var amount = tool === 'lower' ? -C.SCULPT_RATE * dt : C.SCULPT_RATE * dt;
  sculpt(w, x, z, tool, amount, R);
  return 'ok';
}

// ------------------------------------------------------------------ step
// Driven bodies (players) are stepped by whoever owns their input: the server for everyone, a client
// for its own body (prediction). stepDriven does one input's worth of horizontal and vertical motion.
// simStep then runs everything that is the world's own business. On a client (w.clientMode) the world's
// business belongs to the server: animals come from snapshots and terrain from patches, so only the
// cheap derived state (wardstone positions) is refreshed.
function stepDriven(w, e, inp, dt) {
  var ok = applyPlayerInput(w, e, inp, dt);
  updateVertical(w, e, dt);
  return ok;
}
function simStep(w, dt) {
  w.time += dt;
  var t = w.town;
  if (!w.clientMode) {
    for (var i = 0; i < w.ents.length; i++) {
      var e = w.ents[i];
      if (e.driven) continue;
      updateAnimal(w, e, dt);
      updateVertical(w, e, dt);
    }
    if (!t.sculptedThisTick) t.alarm = Math.max(0, t.alarm - dt * 0.5);
    t.sculptedThisTick = false;
    if (t.guardTimer > 0) { t.guardTimer -= dt; if (t.guardTimer <= 0) { t.guardTimer = 0; t.alarm = 0; w.events.push({ type: 'guardLeave' }); } }
    relax(w, dt);
    stepShots(w, dt);
    stepWalls(w, dt);
    stepLife(w, dt);
    stepRound(w, dt);
  }
  updateWardObstacles(w);
}

// ------------------------------------------------------------------ terrain wire format
// Only player-made state travels: delta (f32), loose (u8, x255) and faced (u8) per vertex.
//   full:  [u8 1][u32 count][count x (f32 delta, u8 loose, u8 faced)]
//   patch: [u8 2][u16 count][count x (u16 index, f32 delta, u8 loose, u8 faced)]
function encodeTerrainFull(w) {
  var n = w.V * w.V, buf = new ArrayBuffer(5 + n * 6), dv = new DataView(buf);
  dv.setUint8(0, 1); dv.setUint32(1, n, true);
  for (var k = 0, o = 5; k < n; k++, o += 6) {
    dv.setFloat32(o, w.delta[k], true); dv.setUint8(o + 4, Math.round(clamp(w.loose[k], 0, 1) * 255)); dv.setUint8(o + 5, w.faced[k]);
  }
  return buf;
}
// Compare the world against a shadow copy (what a peer last received), update the shadow, and return a
// patch buffer with every vertex that differs, or null when nothing changed.
function encodeTerrainPatch(w, shadow) {
  var n = w.V * w.V, idx = [];
  for (var k = 0; k < n; k++) {
    var l8 = Math.round(clamp(w.loose[k], 0, 1) * 255);
    if (w.delta[k] !== shadow.delta[k] || l8 !== shadow.loose[k] || w.faced[k] !== shadow.faced[k]) {
      idx.push(k); shadow.delta[k] = w.delta[k]; shadow.loose[k] = l8; shadow.faced[k] = w.faced[k];
    }
  }
  if (!idx.length) return null;
  if (idx.length > 60000) return encodeTerrainFull(w);
  var buf = new ArrayBuffer(3 + idx.length * 8), dv = new DataView(buf);
  dv.setUint8(0, 2); dv.setUint16(1, idx.length, true);
  for (var i = 0, o = 3; i < idx.length; i++, o += 8) {
    var v = idx[i];
    dv.setUint16(o, v, true); dv.setFloat32(o + 2, w.delta[v], true); dv.setUint8(o + 6, shadow.loose[v]); dv.setUint8(o + 7, w.faced[v]);
  }
  return buf;
}
function makeTerrainShadow(w) { var n = w.V * w.V; return { delta: new Float32Array(n), loose: new Uint8Array(n), faced: new Uint8Array(n) }; }
function applyTerrainMessage(w, buf) {
  var dv = new DataView(buf), type = dv.getUint8(0), n = w.V * w.V, k, o;
  if (type === 1) {
    var count = Math.min(dv.getUint32(1, true), n);
    for (k = 0, o = 5; k < count; k++, o += 6) { w.delta[k] = dv.getFloat32(o, true); w.loose[k] = dv.getUint8(o + 4) / 255; w.faced[k] = dv.getUint8(o + 5); }
  } else if (type === 2) {
    var cnt = dv.getUint16(1, true);
    for (var i = 0, p = 3; i < cnt; i++, p += 8) {
      var v = dv.getUint16(p, true); if (v >= n) continue;
      w.delta[v] = dv.getFloat32(p + 2, true); w.loose[v] = dv.getUint8(p + 6) / 255; w.faced[v] = dv.getUint8(p + 7);
    }
  } else return false;
  w.terrainDirty = true;
  return true;
}

return {
  C: C, createWorld: createWorld, heightAt: heightAt, surfaceAt: surfaceAt, barrierAt: barrierAt, platformAt: platformAt,
  depthAt: depthAt, waterFactor: waterFactor, sculpt: sculpt, sculptAttempt: sculptAttempt, relax: relax,
  measureSculpt: measureSculpt, resetTerrain: resetTerrain, canEnter: canEnter, moveEntity: moveEntity,
  updateVertical: updateVertical, tryJump: tryJump, createEntity: createEntity, addPlayer: addPlayer, removeEntity: removeEntity,
  applyPlayerInput: applyPlayerInput, stepDriven: stepDriven, updateAnimal: updateAnimal, wardAt: wardAt, wardRadius: wardRadius,
  updateWardObstacles: updateWardObstacles, simStep: simStep, turnToward: turnToward, makeRng: makeRng,
  encodeTerrainFull: encodeTerrainFull, encodeTerrainPatch: encodeTerrainPatch, makeTerrainShadow: makeTerrainShadow, applyTerrainMessage: applyTerrainMessage,
  encodeChunk: encodeChunk, decodeChunk: decodeChunk, markDirtyVertex: markDirtyVertex,
  addItem: addItem, findItem: findItem, initialChessState: initialChessState, chessSeatOf: chessSeatOf, chessSit: chessSit,
  chessStand: chessStand, chessHeld: chessHeld, chessLeave: chessLeave, applyChessMove: applyChessMove, chessReset: chessReset, chessExpireVotes: chessExpireVotes, pinNote: pinNote,
  chessUpgrade: chessUpgrade, chessPassTurn: chessPassTurn, chessTakeBack: chessTakeBack, chessRedo: chessRedo,
  inArena: inArena, inZone: inZone, inArc: inArc, shielded: shielded, castSpell: castSpell, clearLine: clearLine, shootable: shootable, startRound: startRound, findEntity: findEntity, freeSpotNear: freeSpotNear, spawnBull: spawnBull, spawnHealer: spawnHealer, damage: damage,
  isMob: isMob, isFloater: isFloater, spawnMob: spawnMob, spawnTier: spawnTier, playersInZone: playersInZone, TIERS: TIERS, castFire: castFire, pinArena: pinArena,
  _barrierCircle: barrierCircle // for tests and tools that add obstacles to a world
};
});
