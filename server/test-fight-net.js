// Online path: two clients walk to the arena, one uses the stone to start the round (item 4; nothing starts
// by itself), both cast, the snapshot carries shots, walls, round state and cooldowns. Against a
// local server (PORT, 8091). Since 2026-10-18 nobody is moved at "Fight!", so the two stand where they
// walked: b on the same side of the round stone as a, or a's arrow breaks on the stone before a snapshot sees it.
'use strict';
const WebSocket = require('ws');
const SIM = require('../prototype/sim.js');
const C = SIM.C, port = process.env.PORT || 8091;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(token, name, watch) {
  const c = { token, me: null, snap: null, seq: 0, events: [] };
  c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); c.ws.binaryType = 'arraybuffer';
  c.ready = new Promise(res => c.ws.on('message', (d, bin) => {
    if (bin) return; const m = JSON.parse(d.toString());
    if (m.t === 'hello') c.ws.send(JSON.stringify({ t: 'auth', token, name, watch: watch ? 1 : 0 }));
    if (m.t === 'welcome') { c.me = m; res(); }
    if (m.t === 'snap') { c.snap = m; for (const ev of m.events) c.events.push(ev); }
  }));
  c.send = o => c.ws.send(JSON.stringify(o));
  c.input = (mx, mz, extra) => c.send(Object.assign({ t: 'in', seq: ++c.seq, dt: 0.05, mx, mz, run: true, jump: false }, extra || {}));
  c.ent = () => c.snap && c.snap.ents.find(e => e.id === c.me.id);
  c.walkTo = async (tx, tz, maxS, stop) => { // crude: head straight, stop when close (within stop, 1.2 by default)
    for (let i = 0; i < maxS * 20; i++) {
      const e = c.ent(); if (e && Math.hypot(tx - e.x, tz - e.z) < (stop || 1.2)) break;
      const dx = e ? tx - e.x : 0, dz = e ? tz - e.z : 0, n = Math.hypot(dx, dz) || 1;
      c.input(dx / n, dz / n); await sleep(50);
    }
    await sleep(200);
  };
  return c;
}
(async () => {
  const out = {};
  const a = client('a'.repeat(32), 'Ann'), b = client('b'.repeat(32), 'Ben'), s = client('c'.repeat(32), 'Watcher', true); await a.ready; await b.ready; await s.ready; await sleep(300);
  // walk to the arena the long way round the house: via (-2, 6) then straight
  await a.walkTo(-4, 8, 4); await a.walkTo(C.ARENA_X + 4, C.ARENA_Z + 4, 14); await a.walkTo(C.ARENA_X + 1.1, C.ARENA_Z + 1.1, 4, 0.4); // close enough to the stone to use it (reach 2.5)
  await b.walkTo(-4, 8, 4); await b.walkTo(C.ARENA_X + 5, C.ARENA_Z + 5, 14);
  out.inArena = { a: SIM.inArena(a.ent().x, a.ent().z), b: SIM.inArena(b.ent().x, b.ent().z), aPos: [a.ent().x, a.ent().z] };
  out.beforeStone = a.snap.round.phase; a.send({ t: 'use', item: 4 }); await sleep(400); // the stone, within a's reach
  out.round = { phase: a.snap.round.phase, t: a.snap.round.t };
  await sleep((C.COUNTDOWN + 0.5) * 1000);
  out.fight = { phase: a.snap.round.phase, players: a.snap.round.players.length, hp: a.ent().hp, aStayedPut: Math.hypot(a.ent().x - out.inArena.aPos[0], a.ent().z - out.inArena.aPos[1]) < 0.5 };
  // a faces b and casts: arrow with assist, then a wall
  const ea = a.ent(), eb = b.ent(); const dx = eb.x - ea.x, dz = eb.z - ea.z, n = Math.hypot(dx, dz);
  for (let i = 0; i < 4; i++) { a.input(dx / n * 0.01, dz / n * 0.01); await sleep(50); } // turn to face b
  a.input(0, 0, { cast: 1, assist: true }); await sleep(150);
  out.shotSeen = a.snap.shots.length; out.shotSpeed = a.snap.shots.length ? a.snap.shots[0].v : null;
  a.input(0, 0, { cast: 2 }); await sleep(200);
  out.wallSeen = { walls: a.snap.walls.length, cdWall: a.snap.cd.wall };
  await sleep(1500);
  out.hits = a.events.filter(e => e.type === 'hit').length;
  out.watch = { tallyRows: Array.isArray(s.snap.tally) ? s.snap.tally.length : null, fighterGetsNone: a.snap.tally === undefined, line: s.snap.round.phase }; // the presenter's view gets the tally, fighters do not
  // b locks a (within the arc b faces after its walk south) and lands an arrow: the watcher's tally shows the hit
  b.input(0, 0, { cast: 1, target: a.me.id }); await sleep(1200);
  out.watch.afterHit = { aHp: a.ent().hp, tally: s.snap.tally };
  console.log(JSON.stringify(out));
  a.ws.close(); b.ws.close(); s.ws.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
