// Headless check of identity and chess against a local server (PORT, default 8091).
//   node test-session.js
'use strict';
const WebSocket = require('ws');
const port = process.env.PORT || 8091;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(token, name) {
  const c = { token, me: null, items: {}, opened: null, snap: null, seq: 0, closed: null };
  c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); c.ws.binaryType = 'arraybuffer';
  c.ready = new Promise(res => {
    c.ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.t === 'hello') c.ws.send(JSON.stringify({ t: 'auth', token, name }));
      if (m.t === 'welcome') { c.me = m; res(); }
      if (m.t === 'item') c.items[m.id] = m;
      if (m.t === 'open') c.opened = m.id;
      if (m.t === 'snap') c.snap = m;
    });
    c.ws.on('close', (code) => { c.closed = code; });
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.walk = async (mx, mz, seconds) => { for (let i = 0; i < seconds * 20; i++) { c.send({ t: 'in', seq: ++c.seq, dt: 0.05, mx, mz, run: false, jump: false }); await sleep(50); } await sleep(200); };
  c.pos = () => { const e = c.snap && c.snap.ents.find(e => e.id === c.me.id); return e ? [e.x, e.z] : null; };
  return c;
}
const tok = s => s.padEnd(32, '0');

(async () => {
  const out = {};
  // 1. identity: walk, leave, come back
  let a = client(tok('aaaa'), 'Bobby'); await a.ready;
  out.firstJoin = { id: a.me.id, at: [a.me.x, a.me.z], name: a.me.name };
  await a.walk(1, 0, 2); const posBefore = a.pos(); a.ws.close(); await sleep(300);
  a = client(tok('aaaa'), 'Bobby'); await a.ready;
  out.returned = { id: a.me.id, at: [a.me.x, a.me.z], sameId: a.me.id === out.firstJoin.id, samePlace: Math.hypot(a.me.x - posBefore[0], a.me.z - posBefore[1]) < 0.05 };
  // 2. duplicate token: a second socket with the same token takes over, the first is closed
  const a2 = client(tok('aaaa'), 'Bobby'); await a2.ready; await sleep(300);
  out.takeover = { sameId: a2.me.id === a.me.id, oldClosedWith: a.closed, bodies: a2.snap ? a2.snap.ents.filter(e => e.kind === 'player').length : null };
  // 3. chess: b joins, both go to the table (7, -4.5) via a walk from the spawn through the door
  const b = client(tok('bbbb'), 'Dave'); await b.ready;
  const goToTable = async (c) => { // east to x=7, north through the door, stop at the table
    const p = c.pos() || [c.me.x, c.me.z]; const dx = 7 - p[0];
    if (Math.abs(dx) > 0.1) await c.walk(Math.sign(dx), 0, Math.abs(dx) / 3.6);
    await c.walk(0, -1, (p[1] + 4.0) / 3.6 + 0.3);
  };
  await goToTable(a2); await goToTable(b);
  out.atTable = { a: a2.pos(), b: b.pos() };
  a2.send({ t: 'use', item: 1 }); await sleep(300); b.send({ t: 'use', item: 1 }); await sleep(300);
  let st = b.items[1].state;
  out.seats = { opened: [a2.opened, b.opened], w: st.seats.w, b: st.seats.b, aIsWhite: st.seats.w === a2.me.id, bIsBlack: st.seats.b === b.me.id };
  a2.send({ t: 'board', item: 1, op: 'move', from: 12, to: 28 }); await sleep(300); // e2 -> e4
  st = b.items[1].state; out.move = { e2: st.cells[12], e4: st.cells[28], moves: st.moves, seenByB: true };
  a2.send({ t: 'board', item: 1, op: 'move', from: 28, to: 52 }); await sleep(300); // e4 takes e7 (no rules)
  st = b.items[1].state; out.capture = { e7: st.cells[52], whiteTray: st.trays.w, thisTurn: st.turnMoves.length, turn: st.turn };
  a2.send({ t: 'board', item: 1, op: 'turn' }); await sleep(300); st = b.items[1].state; // white passes the turn
  out.passed = { turn: st.turn, history: st.history.length, lastTurnMoves: st.history[0].moves.length, thisTurn: st.turnMoves.length };
  b.send({ t: 'board', item: 1, op: 'back' }); await sleep(300); st = b.items[1].state; // black takes white's turn back: start position, white to move
  out.backATurn = { turn: st.turn, e2: st.cells[12], e4: st.cells[28], e7: st.cells[52], whiteTray: st.trays.w, history: st.history.length };
  a2.send({ t: 'board', item: 1, op: 'move', from: 12, to: 28 }); await sleep(300);
  a2.send({ t: 'board', item: 1, op: 'back' }); await sleep(300); st = b.items[1].state; // undo the current turn's moves
  out.undoTurn = { turn: st.turn, e2: st.cells[12], e4: st.cells[28], thisTurn: st.turnMoves.length };
  a2.send({ t: 'board', item: 1, op: 'move', from: 12, to: 28 }); await sleep(300); // and move again so the reset below has something to clear
  a2.send({ t: 'board', item: 1, op: 'reset' }); await sleep(300); st = b.items[1].state; out.resetVote = { stillMoves: st.moves, voteW: st.resetVote.w };
  b.send({ t: 'board', item: 1, op: 'reset' }); await sleep(300); st = b.items[1].state; out.resetDone = { moves: st.moves, e2: st.cells[12], seatsKept: st.seats.w === a2.me.id && st.seats.b === b.me.id };
  await b.walk(0, 1, 1.5); await sleep(400); // back out through the door
  st = a2.items[1].state; out.walkAway = { bSeat: st.seats.b, bPos: b.pos() };
  console.log(JSON.stringify(out, null, 1));
  a2.ws.close(); b.ws.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
