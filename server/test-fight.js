// Headless: the arrow, the bull, regeneration, revival and a full round in the arena, pure sim.
'use strict';
const SIM = require('../prototype/sim.js');
const C = SIM.C, w = SIM.createWorld(7);
const out = {};
const put = (e, x, z, heading) => { e.x = x; e.z = z; e.y = e.gy = SIM.surfaceAt(w, x, z); e.grounded = true; e.heading = e.targetHeading = heading; };
const run = (s) => { for (let i = 0; i < s * 60; i++) SIM.simStep(w, 1 / 60); };
const evs = (type) => w.events.filter(e => e.type === type);
const a = SIM.addPlayer(w, 0, 3), b = SIM.addPlayer(w, 0, 3);
const AX = C.ARENA_X, AZ = C.ARENA_Z;
out.arena = { r: C.ARENA_R, ward: SIM.wardAt(w, AX, AZ).toFixed(3), treesInside: w.props.filter(p => (p.kind === 'tree' || p.kind === 'pine') && SIM.inArena(p.x, p.z)).length, bull: w.ents.filter(e => e.kind === 'bull').length };
// Two living players inside the rim start a round's countdown by themselves, and the countdown shields
// them (2026-10-18), so the arrow is tried on its own with b standing on the grounds just outside the
// rim, where bolts still land: a fires outward through the south-east gate along a clear line.
const GATE = 1 / 12 * Math.PI * 2 + 0.2, U = { x: Math.cos(GATE), z: Math.sin(GATE) }, PERP = { x: -Math.sin(GATE), z: Math.cos(GATE) };
const ray = (r, side) => ({ x: AX + U.x * r + PERP.x * (side || 0), z: AZ + U.z * r + PERP.z * (side || 0) });
const OUTWARD = Math.atan2(U.x, U.z), INWARD = OUTWARD + Math.PI;
const place = (e, r, side, heading) => { const p = ray(r, side); put(e, p.x, p.z, heading); };
// 1. arrow: real damage outside a round, casting roots the caster briefly
place(a, 11, 0, OUTWARD); place(b, 20.5, 0, INWARD);
out.arrow0 = { aInArena: SIM.inArena(a.x, a.z), bOnGrounds: !SIM.inArena(b.x, b.z) && SIM.inZone(b.x, b.z), phase: w.round.phase };
SIM.castSpell(w, a, 1, false);
const rooted = a.rootUntil > w.time;
run(1.0);
out.arrow = { hits: evs('hit').length, bHp: b.hp, rooted, speed: C.SHOT_SPEED, splashes: evs('splash').length, phase: w.round.phase };
w.events.length = 0;
// 2. pop at the end of range when nothing is hit
put(a, AX - 6, AZ - 1, Math.PI / 2); put(b, 0, 3, 0); a.cd.arrow = 0; SIM.castSpell(w, a, 1, false); run(1.2);
out.pop = { pops: evs('pop').length, splashes: evs('splash').length };
w.events.length = 0;
// 2b. a long tick cannot carry a bolt through a body: stepped at 100 ms (1.8 tiles a step at 18 tiles/s), the arrow still lands on a body 0.45 off its line
place(a, 12.5, 0, OUTWARD); place(b, 21.5, 0.45, INWARD); a.cd.arrow = 0; b.invulnUntil = 0; SIM.castSpell(w, a, 1, false);
for (let i = 0; i < 10; i++) SIM.simStep(w, 0.1);
out.substep = { hits: evs('hit').length, bHp: b.hp, speed: C.SHOT_SPEED, radius: C.SHOT_RADIUS, piece: C.SHOT_SUBSTEP };
b.hp = 3; w.events.length = 0;
// 3. aim assist: b stands 10 degrees off the line a faces
place(a, 11, 0, OUTWARD); place(b, 20.5, 9.5 * Math.tan(10 * Math.PI / 180), INWARD);
a.cd.arrow = 0; SIM.castSpell(w, a, 1, false); run(1.0); const miss = evs('hit').length;
a.cd.arrow = 0; b.invulnUntil = 0; SIM.castSpell(w, a, 1, true); run(1.0); out.assist = { withoutAssistHits: miss, withAssistHits: evs('hit').length - miss };
w.events.length = 0;
// 3b. the lock aims only within the arc the caster faces: a mark straight behind is not aimed at, one 22 degrees ahead is
place(a, 18, 0, INWARD); place(b, 21.5, 0, INWARD); // a faces the stone, b stands behind it on the grounds
a.cd.arrow = 0; b.invulnUntil = 0; SIM.castSpell(w, a, 1, false, b.id); run(1.0); const behindHits = evs('hit').length;
place(a, 12, 0, OUTWARD); place(b, 20.5, 8.5 * Math.tan(22 * Math.PI / 180), INWARD); a.cd.arrow = 0; b.invulnUntil = 0; SIM.castSpell(w, a, 1, false, b.id); run(1.0); // 9.2 tiles apart: within the arrow's reach
out.lockArc = { deg: C.AIM_DEG, behindHits, aheadOffsetHits: evs('hit').length - behindHits };
w.events.length = 0;
// 4. regeneration: b is down a heart, gets it back after REGEN_EVERY seconds
b.hp = 2; b.regenT = 0; run(C.REGEN_EVERY + 0.2); out.regen = { bHp: b.hp };
// 5. knocked down outside a round: a ghost until the healer, who wanders near the spawn, is reached
place(a, 11, 0, OUTWARD); place(b, 20.5, 0, INWARD); b.hp = 1; b.invulnUntil = 0; a.cd.arrow = 0;
SIM.castSpell(w, a, 1, false); run(1.0);
out.down = { ghost: b.ghost, downEvents: evs('down').length };
run(C.REVIVE_SECONDS + 1); out.stillGhost = b.ghost; // no timer brings you back
const healer = w.ents.find(e => e.kind === 'healer');
out.healer = { exists: !!healer, fromArena: Math.hypot(healer.x - AX, healer.z - AZ).toFixed(1), safe: Math.hypot(healer.x - AX, healer.z - AZ) > C.ARENA_R + C.BUFFER + C.HEALER_LEASH, zoneR: C.ARENA_R + C.BUFFER, boltReach: (C.SHOT_RANGE + 0.6 + C.KNOCKBACK).toFixed(1) };
put(b, healer.x + 1, healer.z, 0); run(0.3); out.revived = { ghost: b.ghost, hp: b.hp, reviveEvents: evs('revive').length };
out.noCastInBuffer = (() => { put(a, AX + C.ARENA_R + 3, AZ, 0); a.cd.arrow = 0; return !SIM.castSpell(w, a, 1, false) && SIM.inZone(a.x, a.z) && !SIM.inArena(a.x, a.z); })();
w.events.length = 0;
// 6. the bull: shoot it, it charges and gores; six hits kill it; it respawns after BULL_RESPAWN
let bull = w.ents.find(e => e.kind === 'bull');
put(bull, AX + 8, AZ + 7, 0); bull.state = 'idle'; bull.timer = 5; bull.hp = C.BULL_HP; put(a, AX + 1, AZ + 7, Math.PI / 2); put(b, 0, 3, 0); a.hp = 3; // a clear lane east of the stone; the bull stands still for the shot
a.cd.arrow = 0; a.invulnUntil = 0; SIM.castSpell(w, a, 1, true); run(0.8);
out.bullHit = { bullHp: bull.hp, target: bull.target === a.id, speed: bull.speed };
// escape: a runs due west at run speed; the charge is slower and bursts, so the gap opens and the grudge drops
{ const esc = { }; let dist0 = Math.hypot(bull.x - a.x, bull.z - a.z); a.invulnUntil = 0;
  for (let f = 0; f < 6 * 60; f++) { SIM.stepDriven(w, a, { mx: 0, mz: -1, run: true, jump: false }, 1 / 60); SIM.simStep(w, 1 / 60); } // north: a clear lane out of the arena
  esc.distAfter6s = Math.hypot(bull.x - a.x, bull.z - a.z).toFixed(1); esc.gaveUp = bull.target === null; esc.snorts = evs('snort').length; esc.aHp = a.hp; out.escape = esc;
  put(bull, AX + 8, AZ + 7, 0); put(a, AX + 1, AZ + 7, Math.PI / 2); a.hp = 3; a.cd.arrow = 0; bull.invulnUntil = 0; SIM.castSpell(w, a, 1, true); run(0.8); }
run(3); out.bullCharge = { dist: Math.hypot(bull.x - a.x, bull.z - a.z).toFixed(2), aHp: a.hp, gores: evs('gore').length };
let shots = 0; for (let i = 0; i < 12 && w.ents.includes(bull); i++) { a.cd.arrow = 0; bull.invulnUntil = 0; put(bull, AX + 3, AZ + 7, -Math.PI / 2); put(a, AX - 1, AZ + 7, Math.PI / 2); a.invulnUntil = w.time + 2; SIM.castSpell(w, a, 1, true); shots++; run(0.5); }
out.bullDead = { shotsFired: shots, bullHp: bull.hp, hitsOnBull: evs('hit').filter(e => e.who === bull.id).length, splashes: evs('splash').length, casts: evs('cast').length, died: evs('died').length, bulls: w.ents.filter(e => e.kind === 'bull').length, respawnQueued: w.respawns.length };
// 6a. (the nova's test lived here; the spell was taken out on 2026-10-17) a stays in the arena, but out of the coming wisp's sight
{ put(a, AX + 14, AZ + 6, 0); put(b, 0, 3, 0); a.hp = 3; w.events.length = 0; }
// 6b. waves: a is still in the arena, so the wisp comes next; it sees a, strafes and shoots; a's hits make a its target wherever a is
run(C.BULL_RESPAWN + 1); out.wave1 = { bulls: w.ents.filter(e => e.kind === 'bull').length, wisps: w.ents.filter(e => e.kind === 'wisp').length, tier: w.arena.tier, spawnEvents: evs('spawn').length };
w.events.length = 0;
let wisp = w.ents.find(e => e.kind === 'wisp');
const other = w.ents.find(e => e.kind === 'wisp' && e !== wisp); put(other, AX + 11, AZ + 7, 0); other.target = null; other.cd.arrow = w.time + 30; // the other of the pair: 12 tiles from a, past its own sight, within its leash
put(wisp, AX + 6, AZ + 7, 0); wisp.target = null; put(a, AX - 1, AZ + 7, Math.PI / 2); a.hp = 3; a.invulnUntil = w.time + 2.5; wisp.cd.arrow = 0;
{ const x0 = wisp.x, z0 = wisp.z, mobV = {}; for (let i = 0; i < 150; i++) { SIM.simStep(w, 1 / 60); for (const s of w.shots) if (s.mob) mobV[s.v] = true; }
  out.wisp = { mobBoltSpeeds: Object.keys(mobV), noticed: evs('notice').length, kinCalled: other.target === a.id, kinNoticeCalled: evs('notice').some(e => e.who === other.id && e.called), kinClosingIn: Math.hypot(other.x - a.x, other.z - a.z) < 12, target: wisp.target === a.id, mobCasts: evs('cast').filter(e => e.who === wisp.id).length, moved: Math.hypot(wisp.x - x0, wisp.z - z0).toFixed(1), inArena: SIM.inArena(wisp.x, wisp.z), dist: Math.hypot(wisp.x - a.x, wisp.z - a.z).toFixed(1) };
  run(2); out.wisp.aHp = a.hp; out.wisp.aHitByWisp = evs('hit').some(e => e.who === a.id && e.by === wisp.id); }
w.events.length = 0;
// the bull aggroes from any distance: hit from across the arena, it still comes
{ put(a, 0, 3, 0); put(b, 0, 3, 0); run(C.QUIET_SECONDS + 1); // nobody about: the wisp fades, the bull is back
  out.quiet = { fades: evs('fade').length, wisps: w.ents.filter(e => e.kind === 'wisp').length, bulls: w.ents.filter(e => e.kind === 'bull').length, tier: w.arena.tier };
  w.events.length = 0;
  const bl = w.ents.find(e => e.kind === 'bull'); put(bl, AX + 9, AZ + 7, 0); bl.target = null; bl.state = 'idle'; bl.timer = 5; put(a, AX - 1, AZ + 7, Math.PI / 2); a.cd.arrow = 0; bl.invulnUntil = 0; a.invulnUntil = 0;
  SIM.castSpell(w, a, 1, true); run(0.9); const d0 = Math.hypot(bl.x - a.x, bl.z - a.z); run(1.5);
  out.farAggro = { hitFrom: 10, target: bl.target === a.id, distAfterHit: d0.toFixed(1), closingIn: Math.hypot(bl.x - a.x, bl.z - a.z) < d0 - 3 }; }
// kill the bull with a present -> wisp; kill the wisp -> wraith, which fires volleys; then leave, and the bull returns
{ let bl = w.ents.find(e => e.kind === 'bull'); for (let i = 0; i < 12 && w.ents.includes(bl); i++) { a.cd.arrow = 0; bl.invulnUntil = 0; put(bl, AX + 3, AZ + 7, -Math.PI / 2); put(a, AX - 1, AZ + 7, Math.PI / 2); a.invulnUntil = w.time + 2; SIM.castSpell(w, a, 1, true); run(0.5); }
  run(C.BULL_RESPAWN + 1); const wisps = w.ents.filter(e => e.kind === 'wisp'); const tier1 = wisps.length ? 'wisp x' + wisps.length : 'none';
  const first = wisps[0]; for (let i = 0; i < 12 && first && w.ents.includes(first); i++) { first.invulnUntil = 0; SIM.damage(w, first, a.id, 1, 0); run(0.1); } // it strafes too well to pin down in a test lane: struck directly
  const afterOne = { queued: w.respawns.length, wispsLeft: w.ents.filter(e => e.kind === 'wisp').length }; // the wave waits for the pair
  for (const ws of w.ents.filter(e => e.kind === 'wisp')) for (let i = 0; i < 12 && w.ents.includes(ws); i++) { ws.invulnUntil = 0; SIM.damage(w, ws, a.id, 1, 0); run(0.1); }
  const afterBoth = { queued: w.respawns.length, wispsLeft: w.ents.filter(e => e.kind === 'wisp').length };
  w.events.length = 0; run(C.BULL_RESPAWN + 1); const wr = w.ents.find(e => e.kind === 'wraith');
  let volley = 0; if (wr) { put(wr, AX + 6, AZ + 7, 0); put(a, AX - 1, AZ + 7, Math.PI / 2); a.invulnUntil = w.time + 3; wr.cd.arrow = 0; run(0.3); volley = w.shots.filter(s => s.owner === wr.id).length; }
  let fire = null; if (wr) { // the wraith's second spell: a line of fire through a, across the line between them
    put(wr, AX + 6, AZ + 7, 0); put(a, AX - 1, AZ + 7, Math.PI / 2); a.hp = 3; a.invulnUntil = 0; wr.target = a.id; wr.cd.wall = 0; wr.cd.arrow = w.time + 30; wr.rootUntil = 0; w.shots.length = 0; w.events.length = 0; // the volley check above left bolts in the air
    run(0.2); const fw = w.walls.filter(x => x.kind === 'fire')[0];
    fire = { cast: evs('cast').some(e => e.spell === 'fire'), walls: w.walls.length, kind: fw && fw.kind, throughA: fw ? Math.hypot(fw.x - a.x, fw.z - a.z).toFixed(2) : null, acrossZ: fw ? Math.abs(fw.uz).toFixed(2) : null, hpDuringRise: a.hp, wraithHeld: wr.rootUntil > w.time };
    run(C.FIRE_RISE + 0.3); fire.hpAfterRise = a.hp; fire.pushed = Math.hypot(a.x - (AX - 1), a.z - (AZ + 7)).toFixed(2);
    put(a, AX - 1 - 2.5, AZ + 7, Math.PI / 2); a.invulnUntil = 0; const hp0 = a.hp; run(1.0); fire.offTheLine = a.hp === hp0;
    put(a, AX - 1, AZ + 7, Math.PI / 2); a.invulnUntil = 0; run(1.2); fire.crossingCosts = hp0 - a.hp; // back on it: one heart, then shoved off
    put(a, 0, 3, 0); run(C.FIRE_SECONDS); fire.goneAfter = w.walls.length;
  }
  out.wave2 = { afterBull: tier1, afterOne, afterBoth, wraith: !!wr, wraithHp: wr && wr.hp, volley, fire, tier: w.arena.tier };
  put(a, 0, 3, 0); run(C.QUIET_SECONDS + 1); out.wave2.quietAgain = { bulls: w.ents.filter(e => e.kind === 'bull').length, floaters: w.ents.filter(e => SIM.isFloater(e)).length, tier: w.arena.tier }; }
out.bullBack = { bulls: w.ents.filter(e => e.kind === 'bull').length };
// the admin's pin: the arena held to one wave for trying it out, then freed
{ SIM.pinArena(w, 'wraith'); const pinned = { wraiths: w.ents.filter(e => e.kind === 'wraith').length, others: w.ents.filter(e => SIM.isMob(e) && e.kind !== 'wraith').length, pin: w.arena.pin };
  put(a, AX - 1, AZ + 7, Math.PI / 2); const wr2 = w.ents.find(e => e.kind === 'wraith'); for (let i = 0; i < 12 && wr2 && w.ents.includes(wr2); i++) { wr2.invulnUntil = 0; SIM.damage(w, wr2, a.id, 1, 0); run(0.1); }
  run(C.BULL_RESPAWN + 1); pinned.backAgain = w.ents.filter(e => e.kind === 'wraith').length;
  SIM.pinArena(w, null); pinned.freed = w.arena.pin; put(a, 0, 3, 0); run(C.QUIET_SECONDS + 1); pinned.afterFreeAndQuiet = w.ents.filter(e => SIM.isMob(e)).map(e => e.kind); out.pinned = pinned; w.walls.length = 0; }
w.events.length = 0; a.hp = b.hp = 3; a.ghost = b.ghost = false;
// 7. rounds: nothing starts by itself; the stone starts a 4 s countdown for the two in the arena, 7 s with a third on the grounds;
//    a fallen contender keeps fighting and can kill, but the last unfallen contender wins
bull = w.ents.find(e => e.kind === 'bull'); put(bull, AX + 14, AZ + 6, 0); bull.target = null; bull.home = { x: AX + 14, z: AZ + 6 };
const c = SIM.addPlayer(w, 0, 3); c.name = 'Cid';
put(a, AX - 3, AZ, Math.PI / 2); put(b, AX + 3, AZ, -Math.PI / 2); put(c, 0, 3, 0); a.hp = b.hp = 3; a.ghost = b.ghost = false; w.events.length = 0;
run(0.1); out.round = { noAutoStart: w.round.phase };
out.round.stoneAlone = (() => { put(b, 0, 3, 0); const r = SIM.startRound(w); put(b, AX + 3, AZ, -Math.PI / 2); return r; })(); // a alone in the ring: the stone says so
out.round.stone = SIM.startRound(w); out.round.seconds = w.round.t.toFixed(1); out.round.stoneAgain = SIM.startRound(w); // the stone starts it; used again, it is busy
put(c, AX + C.ARENA_R + 5, AZ, 0); run(0.1); // c on the grounds: too late to change this countdown, it was already set
// the countdown's shield: a's arrow at b breaks on the body (a splash) and nothing lands
a.cd.arrow = 0; b.invulnUntil = 0; SIM.castSpell(w, a, 1, false, b.id); run(0.6);
out.round.shield = { phase: w.round.phase, splashes: evs('splash').length, hitsOnB: evs('hit').filter(e => e.who === b.id).length, bHp: b.hp };
run(C.COUNTDOWN + 0.3 - 0.6); out.round.fightWithTwo = { phase: w.round.phase, contenders: w.round.players.length, stayedPut: Math.abs(a.x - (AX - 3)) < 1e-6 && Math.abs(b.x - (AX + 3)) < 1e-6 && Math.abs(a.z - AZ) < 1e-6 };
// a step over the rim is forgiven: b out for a second is still standing, and back inside the clock resets
put(b, AX + C.ARENA_R + 2, AZ, -Math.PI / 2); run(1.0); out.round.graceOut1s = { fallen: !!w.round.fallen[b.id], phase: w.round.phase, out: w.round.out[b.id].toFixed(1) };
put(b, AX + 3, AZ, -Math.PI / 2); run(0.3); out.round.graceBack = { fallen: !!w.round.fallen[b.id], out: w.round.out[b.id] };
// b falls to a, walks to the healer, comes back, and kills a: a has fallen too, nobody is left, no winner
for (let i = 0; i < 3; i++) { a.cd.arrow = 0; a.invulnUntil = 0; b.invulnUntil = 0; put(b, AX + 3, AZ + 7, -Math.PI / 2); put(a, AX - 1, AZ + 7, Math.PI / 2); SIM.castSpell(w, a, 1, true); run(0.8); }
out.round.bFell = { ghost: b.ghost, fallen: !!w.round.fallen[b.id], phase: w.round.phase, standing: w.round.players.filter(id => !w.round.fallen[id]).length };
put(b, healer.x + 1, healer.z, 0); run(0.3); out.round.bRevived = !b.ghost;
for (let i = 0; i < 3; i++) { b.cd.arrow = 0; a.invulnUntil = 0; b.invulnUntil = 0; put(a, AX + 3, AZ + 7, -Math.PI / 2); put(b, AX - 1, AZ + 7, Math.PI / 2); SIM.castSpell(w, b, 1, true); run(0.8); }
out.round.aFellToFallenB = { aGhost: a.ghost, phase: w.round.phase, winner: w.round.winner, scoresB: w.round.scores[b.id] };
run(C.OVER_SECONDS + 0.3); out.round.backToLobby = { phase: w.round.phase, aGhost: a.ghost, bGhost: b.ghost };
// a crowd: three on the grounds, two in the arena -> 13 s; then the third walks in and the winner is the last unfallen
put(a, AX - 3, AZ, Math.PI / 2); put(b, AX + 3, AZ, -Math.PI / 2); put(c, AX + C.ARENA_R + 5, AZ, 0); a.hp = b.hp = c.hp = 3; run(0.1);
out.round.stillLobby = w.round.phase; SIM.startRound(w); // the stone again, with c on the grounds
out.round.crowd = { phase: w.round.phase, seconds: w.round.t.toFixed(1) };
put(c, AX, AZ + 5, 0); run(0.1); out.round.waitsForC = w.round.t.toFixed(1); // c walks in: the gong puts the crowd countdown back on the clock
run(C.COUNTDOWN_CROWD + 0.3); out.round.fightWithThree = { contenders: w.round.players.length };
// c leaves the ring for good: fallen after OUT_GRACE seconds with nobody to blame, and with a and b still standing the round goes on
put(c, AX + C.ARENA_R + 2, AZ, 0); run(C.OUT_GRACE + 0.5); out.round.graceFallen = { fallen: !!w.round.fallen[c.id], phase: w.round.phase, by: (evs('elim').find(e => e.who === c.id) || {}).by };
for (let i = 0; i < 3; i++) { a.cd.arrow = 0; a.invulnUntil = 0; c.invulnUntil = 0; put(c, AX + 3, AZ + 7, -Math.PI / 2); put(a, AX - 1, AZ + 7, Math.PI / 2); SIM.castSpell(w, a, 1, true); run(0.8); }
for (let i = 0; i < 3; i++) { c.cd.arrow = 0; a.invulnUntil = 0; b.invulnUntil = 0; put(b, AX + 3, AZ - 7, -Math.PI / 2); put(a, AX - 1, AZ - 7, Math.PI / 2); put(c, AX - 5, AZ - 7, Math.PI / 2); c.ghost = false; SIM.castSpell(w, c, 1, true); run(0.8); }
out.round.lastStanding = { phase: w.round.phase, winner: w.round.winner === a.id ? 'a' : w.round.winner === b.id ? 'b' : w.round.winner, fallenC: !!w.round.fallen[c.id], fallenB: !!w.round.fallen[b.id] };
out.noWallNoBlink = !SIM.castSpell(w, a, 2, false) && !SIM.castSpell(w, a, 3, false);
// chess: four boards (the house table and the garden's three); a started game keeps its players' seats when they walk off, a fresh board frees them
{ const boards = w.items.filter(it => it.kind === 'chessboard'), st = boards[0].state;
  SIM.chessSit(st, a.id); SIM.chessSit(st, b.id); const freshLeave = SIM.chessLeave(st, a.id); // no move yet: the seat frees
  SIM.chessSit(st, a.id); const mv = SIM.applyChessMove(st, a.id, 12, 28); const heldLeave = SIM.chessLeave(st, a.id); // e2-e4, then walking off keeps the seat
  const third = SIM.chessSit(st, c.id); // a third player finds both chairs taken
  out.chess = { boards: boards.map(it => ({ id: it.id, at: [Math.round(it.x), Math.round(it.z)], y: it.y.toFixed(2) })), freshLeave, move: mv, heldLeave, seatsAfter: Object.assign({}, st.seats), thirdSits: third, thirdMove: SIM.applyChessMove(st, c.id, 52, 36), held: SIM.chessHeld(st) };
  SIM.chessReset(st, a.id); SIM.chessReset(st, b.id); out.chess.afterReset = { held: SIM.chessHeld(st), freeAgain: SIM.chessLeave(st, a.id) }; }
// the stick's third speed: a creep at CREEP_MUL of a walk, a walk, a run, each over one second on the arena's floor
{ a.ghost = false; a.hp = 3; a.rootUntil = 0; a.away = false;
  const spd = (inp) => { put(a, AX - 8, AZ + 2, Math.PI / 2); const x0 = a.x, z0 = a.z; for (let i = 0; i < 60; i++) SIM.stepDriven(w, a, Object.assign({ mx: 1, mz: 0, run: false, jump: false }, inp), 1 / 60); return Math.hypot(a.x - x0, a.z - z0).toFixed(2); };
  out.speeds = { creep: spd({ creep: true }), walk: spd({}), run: spd({ run: true }), creepMul: C.CREEP_MUL, creepLosesToRun: spd({ creep: true, run: true }) }; }
console.log(JSON.stringify(out));
