// Event mode and the admin's backstop, against a running server (PORT=8091, ADMIN_TOKEN=x). Run it twice:
//   EVENT=1 ADMIN_TOKEN=x MOBS=0 PORT=8091 DB_FILE=/tmp/x node server/server.js   then   PORT=8091 node server/test-event.js
//   ADMIN_TOKEN=x MOBS=0 PORT=8091 DB_FILE=/tmp/y node server/server.js           then   PORT=8091 node server/test-event.js
// With the event on: names come from the lists whatever the page sends and survive a reconnect, a 'name'
// message is ignored, speech reaches nobody, and the admin's rename / remove / clearboard still work.
// With it off: the sent name is kept, 'name' renames, speech reaches a neighbour until the admin mutes
// the speaker. Either way an op without the token does nothing. Prints JSON; exits 1 if anything failed.
'use strict';
const WebSocket = require('ws');
const PORT = process.env.PORT || 8091, URL = `ws://localhost:${PORT}/ws`, TOKEN = process.env.ADMIN_TOKEN || 'x';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', M = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', D = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
const GIVEN = /^[A-Z][a-z]+ [A-Z][a-z]+( \d\d)?$/;

function join(token, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL), c = { ws, id: 0, name: null, snaps: [], says: [], closed: null, hello: null };
    ws.on('message', (d, bin) => {
      if (bin) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.t === 'hello') { c.hello = m; ws.send(JSON.stringify({ t: 'auth', token, name })); }
      else if (m.t === 'welcome') { c.id = m.id; c.name = m.name; resolve(c); }
      else if (m.t === 'snap') { c.snaps.push(m); for (const ev of m.events || []) if (ev.type === 'say') c.says.push(ev); }
    });
    ws.on('close', code => { c.closed = code; resolve(c); });
    ws.on('error', reject);
  });
}
const nameOf = c => { const s = c.snaps[c.snaps.length - 1]; const e = s && s.ents.find(e => e.id === c.id); return e ? e.name : null; };
const admin = (m, op, extra) => m.ws.send(JSON.stringify(Object.assign({ t: 'admin', op, admin: TOKEN }, extra)));

(async () => {
  const out = {};
  const a = await join(A, 'Nasty Name');
  const event = !!(a.hello && a.hello.event);
  out.mode = event ? 'event' : 'free';
  const b = await join(B, 'Also Nasty');
  if (event) {
    out.givenNotSent = a.name !== 'Nasty Name' && GIVEN.test(a.name);
    out.distinct = b.name !== a.name && GIVEN.test(b.name);
  } else {
    out.sentNameKept = a.name === 'Nasty Name' && b.name === 'Also Nasty';
  }
  await sleep(400);
  a.ws.send(JSON.stringify({ t: 'name', name: 'Worse' })); await sleep(400);
  if (event) out.nameMessageIgnored = nameOf(a) === a.name; else out.nameMessageApplies = nameOf(a) === 'Worse';
  // speech: both bodies stand at the spawn, within earshot
  a.ws.send(JSON.stringify({ t: 'say', text: 'hello there' })); await sleep(500);
  if (event) out.chatClosed = !b.says.some(ev => ev.text === 'hello there'); else out.heardBeforeMute = b.says.some(ev => ev.text === 'hello there');
  // an op without the token does nothing
  const bName = nameOf(b);
  a.ws.send(JSON.stringify({ t: 'admin', op: 'rename', id: b.id, name: 'Hacked' })); await sleep(400);
  out.noTokenNoEffect = nameOf(b) === bName;
  // the admin
  const m = await join(M, 'mod');
  admin(m, 'rename', { id: a.id, name: 'Gentle Hare' }); await sleep(500);
  out.renamed = nameOf(a) === 'Gentle Hare';
  a.ws.send(JSON.stringify({ t: 'name', name: 'Back' })); await sleep(400);
  out.renamedCannotRenameBack = nameOf(a) === 'Gentle Hare';
  if (!event) {
    admin(m, 'mute', { id: a.id, seconds: 60 }); await sleep(300);
    const heard = b.says.length;
    a.ws.send(JSON.stringify({ t: 'say', text: 'still here?' })); await sleep(600);
    out.mutedSaysNothing = b.says.length === heard;
  }
  admin(m, 'clearboard', {}); await sleep(300);
  out.clearboardAccepted = true;
  admin(m, 'remove', { id: b.id }); await sleep(600);
  out.removedClosed4009 = b.closed === 4009;
  const b2 = await join(B, 'Back');
  out.removedStaysOut = b2.closed === 4009;
  if (event) {
    const d1 = await join(D, 'x'); d1.ws.close(); await sleep(300);
    const d2 = await join(D, 'y');
    out.reconnectKeepsName = d1.name === d2.name && GIVEN.test(d1.name);
    try { d2.ws.close(); } catch (e) {}
  }
  for (const c of [a, m]) try { c.ws.close(); } catch (e) {}
  console.log(JSON.stringify(out));
  const failed = Object.entries(out).filter(([k, v]) => k !== 'mode' && v !== true).map(([k]) => k);
  if (failed.length) { console.error('failed: ' + failed.join(', ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
