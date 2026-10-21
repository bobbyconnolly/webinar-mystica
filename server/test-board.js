// Notice boards online: pin a note, another client sees it, the note survives a server restart.
// Run twice against the same DB: first pass pins, second pass (RESTARTED=1) only reads.
'use strict';
const WebSocket = require('ws');
const port = process.env.PORT || 8091, restarted = process.env.RESTARTED === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(token, name) {
  const c = { token, me: null, items: {}, opened: null };
  c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); c.ws.binaryType = 'arraybuffer';
  c.ready = new Promise(res => c.ws.on('message', (d, bin) => {
    if (bin) return; const m = JSON.parse(d.toString());
    if (m.t === 'hello') c.ws.send(JSON.stringify({ t: 'auth', token, name }));
    if (m.t === 'welcome') { c.me = m; res(); }
    if (m.t === 'item') c.items[m.id] = m;
    if (m.t === 'open') c.opened = m.id;
  }));
  c.send = o => c.ws.send(JSON.stringify(o));
  return c;
}
(async () => {
  const out = {};
  const a = client('a'.repeat(32), 'Ann'); await a.ready; await sleep(300);
  const boards = Object.values(a.items).filter(i => i.kind === 'board');
  out.boards = boards.map(b => ({ id: b.id, at: [b.x, b.z], notes: b.state.notes.length }));
  const spawnBoard = boards.find(b => Math.hypot(b.x - a.me.x, b.z - a.me.z) < 6); // the one by the spawn is in reach
  if (!restarted) {
    const b = client('b'.repeat(32), 'Ben'); await b.ready; await sleep(300);
    for (let i = 0; i < 16; i++) { a.send({ t: 'in', seq: i + 1, dt: 0.05, mx: -1, mz: 0, run: false, jump: false }); await sleep(50); } // walk west to the board
    await sleep(300);
    a.send({ t: 'use', item: spawnBoard.id }); await sleep(300); out.opened = a.opened === spawnBoard.id;
    a.send({ t: 'board', item: spawnBoard.id, op: 'note', text: '  Dave, I was here. <b>Chess</b> tonight?  ' }); await sleep(400);
    a.send({ t: 'board', item: spawnBoard.id, op: 'note', text: 'too soon' }); await sleep(400); // rate limited: one per 5 s
    const seenByB = b.items[spawnBoard.id].state.notes;
    out.pinned = { count: seenByB.length, text: seenByB[0] && seenByB[0].text, name: seenByB[0] && seenByB[0].name, by: seenByB[0] && seenByB[0].by === a.me.id };
    b.ws.close();
    await sleep(6000); // past the flush interval (FLUSH_EVERY=2 in the test server) so the note is on disk
  } else {
    out.afterRestart = { notes: spawnBoard.state.notes.length, text: spawnBoard.state.notes[0] && spawnBoard.state.notes[0].text };
  }
  console.log(JSON.stringify(out));
  a.ws.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
