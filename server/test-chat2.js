// Earshot and away bodies against a local server (PORT, default 8091).
'use strict';
const WebSocket = require('ws');
const port = process.env.PORT || 8091;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(token, name) {
  const c = { token, me: null, snap: null, seq: 0, says: [] };
  c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); c.ws.binaryType = 'arraybuffer';
  c.ready = new Promise(res => c.ws.on('message', (d, bin) => {
    if (bin) return; const m = JSON.parse(d.toString());
    if (m.t === 'hello') c.ws.send(JSON.stringify({ t: 'auth', token, name }));
    if (m.t === 'welcome') { c.me = m; res(); }
    if (m.t === 'snap') { c.snap = m; for (const ev of m.events) if (ev.type === 'say') c.says.push(ev); }
  }));
  c.send = o => c.ws.send(JSON.stringify(o));
  c.walk = async (mx, mz, s) => { for (let i = 0; i < s * 20; i++) { c.send({ t: 'in', seq: ++c.seq, dt: 0.05, mx, mz, run: false, jump: false }); await sleep(50); } await sleep(200); };
  c.ent = id => c.snap && c.snap.ents.find(e => e.id === id);
  return c;
}
(async () => {
  const out = {};
  const a = client('a'.repeat(32), 'Ann'), b = client('b'.repeat(32), 'Ben'); await a.ready; await b.ready; await sleep(300);
  a.send({ t: 'say', text: 'close by' }); await sleep(400);
  out.near = { aHeard: a.says.at(-1).heard, bGotIt: b.says.some(s => s.text === 'close by') };
  await a.walk(-1, 0, 4.5); // ~16 tiles west, out of earshot
  a.send({ t: 'say', text: 'far away' }); await sleep(400);
  out.far = { aHeard: a.says.at(-1).heard, bGotIt: b.says.some(s => s.text === 'far away'), dist: Math.hypot(a.ent(a.me.id).x - b.ent(b.me.id).x, a.ent(a.me.id).z - b.ent(b.me.id).z).toFixed(1) };
  const aId = a.me.id; a.ws.close(); await sleep(600);
  const seenByB = b.ent(aId); out.afterLeave = { stillThere: !!seenByB, away: seenByB && seenByB.away };
  const a2 = client('a'.repeat(32), 'Ann'); await a2.ready; await sleep(400);
  out.back = { sameId: a2.me.id === aId, away: b.ent(aId).away, bodies: b.snap.ents.filter(e => e.kind === 'player').length };
  console.log(JSON.stringify(out));
  a2.ws.close(); b.ws.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
