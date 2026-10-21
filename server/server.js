/* server.js — Mystica authoritative server.
 *
 * Runs the shared simulation (prototype/sim.js) as the one true world, serves the client files from
 * prototype/, and talks to clients over WebSockets on the same port.
 *
 *   node server.js            -> http://localhost:8080   (PORT and SEED env vars override)
 *
 * Clients send intents, never results: per-frame inputs, sculpt intents, shared slider changes. The
 * server applies them with the same sim calls the client uses for prediction, steps the world at 20 Hz,
 * and sends entity snapshots at 10 Hz plus terrain patches (changed vertices only) at 10 Hz.
 *
 * Memory is the game; the database (step 3) will only be there so the world survives a restart.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const SIM = require('../prototype/sim.js');
const { Store } = require('./store.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const SEED = parseInt(process.env.SEED || '7', 10);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, `world-${SEED}.sqlite`);
const FLUSH_EVERY = parseFloat(process.env.FLUSH_EVERY || '5'); // seconds between write-behind flushes
const ROOT = path.join(__dirname, '..', 'prototype');
const TICK = 1 / 20, SNAP_EVERY = 0.1, PATCH_EVERY = 0.1, STROKE_GAP = 0.7;
// The session's leaderboard for the presenter's view (?watch=1, 2026-10-18): wins (rounds won), outs
// (players knocked out of a round) and hits on players, by player id, read from the same events the
// action log sees. Memory only: a restart empties it. Monsters' blows do not count, nor blows on monsters.
const tally = new Map();
function tallyRow(id) { let t = tally.get(id); if (!t) { t = { id, name: '', wins: 0, outs: 0, hits: 0 }; tally.set(id, t); } return t; }
function isPlayer(id) { const e = id === null || id === undefined ? null : SIM.findEntity(w, id); return !!e && e.kind === 'player'; }
function tallyEvent(ev) {
  if (ev.type === 'hit' && ev.by !== null && isPlayer(ev.by) && isPlayer(ev.who)) tallyRow(ev.by).hits++;
  else if (ev.type === 'elim' && ev.by !== null && isPlayer(ev.by)) tallyRow(ev.by).outs++;
  else if (ev.type === 'round' && ev.phase === 'over' && ev.winner !== null) tallyRow(ev.winner).wins++;
}
function tallyTop(n) {
  const rows = [...tally.values()];
  for (const t of rows) { const e = SIM.findEntity(w, t.id); if (e && e.name) t.name = e.name; }
  rows.sort((a, b) => b.wins - a.wins || b.outs - a.outs || b.hits - a.hits);
  return rows.slice(0, n).map(t => ({ id: t.id, name: t.name, wins: t.wins, outs: t.outs, hits: t.hits }));
}
// The client's version: a hash of the files it is made of, named in hello and at /version, so a page
// can tell it is stale after a redeploy and reload itself the next time its tab comes to the front
// (main.js, checkVersion). A redeploy drops every socket, so the reconnect's hello tells at once.
const CLIENT_FILES = ['index.html', 'main.js', 'sim.js', 'net.js', 'sounds.js', 'shaders.js', 'chess.js', 'board.js', 'sw.js', 'sounds/sounds-manifest.json'];
const CLIENT_VERSION = (() => {
  const h = require('crypto').createHash('sha1');
  for (const f of CLIENT_FILES) { try { h.update(fs.readFileSync(path.join(__dirname, '..', 'prototype', f))); } catch (e) { /* a dev tree may lack one */ } }
  return h.digest('hex').slice(0, 12);
})();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
               '.webmanifest': 'application/manifest+json', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

// ------------------------------------------------------------------ static files
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } // a malformed escape ("/%") throws, and an uncaught throw here took the whole server down
  catch (e) { res.writeHead(400); res.end('bad request'); return; }
  if (p === '/healthz') { // for the platform's probes and the status script
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: clients.size, creatures: w.ents.length, uptime: Math.round(process.uptime()), version: CLIENT_VERSION }));
    return;
  }
  if (p === '/version') { // the client polls this while its tab is visible
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: CLIENT_VERSION }));
    return;
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || p.includes('..')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ------------------------------------------------------------------ world + persistence
// The seed rebuilds the base world; the store holds only what players did. Memory is the game; the
// store is for restarts. Dirty chunks flush every FLUSH_EVERY seconds, so a crash loses at most that.
const store = new Store(DB_FILE, { journal: process.env.SQLITE_JOURNAL, mirror: process.env.MIRROR_DIR || null });
if (store.restored) log(`restored the database from its mirror in ${process.env.MIRROR_DIR}`);
const w = SIM.createWorld(SEED);
(function restore() {
  let loaded = 0;
  for (const row of store.loadChunks()) if (SIM.decodeChunk(w, row.blob)) loaded++;
  const town = store.get('town', null);
  if (town) { w.town.strength = town.strength; w.town.facing = town.facing; w.repose = town.repose; }
  const animals = store.get('animals', null);
  if (animals) { // replace the freshly generated herd with the one that was living here, reusing its ids
    for (let i = w.ents.length - 1; i >= 0; i--) if (!w.ents[i].driven) w.ents.splice(i, 1);
    w.nextId = 1;
    for (const a of animals) { const e = SIM.createEntity(w, a.kind, a.x, a.z); e.heading = e.targetHeading = a.heading; e.home = a.home; }
  }
  if (process.env.MOBS === '0') { for (let i = w.ents.length - 1; i >= 0; i--) if (SIM.isMob(w.ents[i])) w.ents.splice(i, 1); } // MOBS=0: an empty arena, for tests
  else if (process.env.MOBS && SIM.TIERS.includes(process.env.MOBS)) SIM.pinArena(w, process.env.MOBS); // MOBS=wraith (wisp, bull): the arena pinned to that wave, to try it out on the desk
  else if (!w.ents.some(e => SIM.isMob(e))) SIM.spawnBull(w); // the arena's monster and the healer are not saved; a restart starts over at the bull
  if (!w.ents.some(e => e.kind === 'healer')) SIM.spawnHealer(w);
  w.nextId = Math.max(w.nextId, store.maxPlayerId() + 1); // player ids are stable across restarts
  const items = store.get('items', null);
  let restoredItems = 0;
  if (items) for (const s of items) { const it = SIM.findItem(w, s.id); if (it && it.kind === s.kind) { it.state = s.state; restoredItems++; } }
  w.chunkDirty.fill(0);
  log(`restored ${loaded} chunks${town ? ', town' : ''}${animals ? `, ${animals.length} animals` : ''}, ${restoredItems} items from ${path.basename(DB_FILE)}`);
})();
for (const it of w.items) if (it.kind === 'chessboard') {
  if (SIM.chessUpgrade(it.state)) log(`chessboard ${it.id}: a game from before turns existed, ${it.state.turn === 'w' ? 'white' : 'black'} to move`); // uses the saved seats, so before they are cleared
  it.state.seats = { w: null, b: null }; it.state.resetVote = { w: false, b: false }; // nobody is seated after a restart
}
function flush(reason) {
  const n = w.CHUNKS, dirty = [];
  for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) if (w.chunkDirty[cz * n + cx]) dirty.push({ cx, cz, buf: SIM.encodeChunk(w, cx, cz) });
  if (dirty.length) { store.saveChunks(dirty); w.chunkDirty.fill(0); }
  store.set('town', { strength: w.town.strength, facing: w.town.facing, repose: w.repose });
  store.set('animals', w.ents.filter(e => !e.driven && !SIM.isMob(e) && e.kind !== 'healer').map(e => ({ kind: e.kind, x: r3(e.x), z: r3(e.z), heading: r3(e.heading), home: e.home })));
  store.set('items', w.items.map(it => ({ id: it.id, kind: it.kind, state: it.state })));
  for (const c of clients.values()) if (c.ent) savePlayer(c);
  for (const [token, p] of parked) store.savePlayer({ token, id: p.ent.id, name: p.ent.name, color: p.ent.color, x: r3(p.ent.x), z: r3(p.ent.z) });
  if (dirty.length || reason !== 'timer') log(`flushed ${dirty.length} chunk(s) (${reason})`);
  try { store.mirror(); } catch (e) { log(`mirror failed (${e.message}); the local database is intact, will retry next flush`); }
}
const clients = new Map(); // ws -> client
let nextClientNo = 1;

// A player is a device token. The body is created when the token arrives (auth), restored from the
// store if the token is known, so a refresh, a sleeping phone or a redeploy puts you back where you were.
const SPAWN = { x: 0, z: 3 };
function savePlayer(c) { store.savePlayer({ token: c.token, id: c.ent.id, name: c.ent.name, color: c.ent.color, x: r3(c.ent.x), z: r3(c.ent.z) }); }
function standable(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > w.HALF - 1 || Math.abs(z) > w.HALF - 1) return false;
  if (SIM.depthAt(w, x, z) >= SIM.C.DEEP) return false;
  return SIM.barrierAt(w, x, z) <= SIM.surfaceAt(w, x, z) + 0.05;
}
function onAuth(c, m) {
  if (c.ent) return;
  const token = String(m.token || '');
  if (!/^[0-9a-f]{32}$/.test(token)) { c.ws.close(4001, 'bad token'); return; }
  if (banned.has(token)) { c.ws.close(4009, 'removed'); return; } // removed by the admin for the rest of the run
  // the same device connecting again (a refresh): hand the existing body over instead of spawning a twin
  for (const [ows, oc] of clients) if (oc !== c && oc.token === token && oc.ent) {
    c.ent = oc.ent; oc.ent = null; oc.handedOver = true; oc.ws.close(4002, 'replaced');
    log(`client ${c.no} took over entity ${c.ent.id} from client ${oc.no}`);
    break;
  }
  c.token = token;
  c.watch = !!m.watch; // the presenter's view (?watch=1): a body like any other that is never moved, and the session's tally in its snapshots
  const name = EVENT ? givenName(token) : clean(m.name, 16);
  const p = parked.get(token);
  if (!c.ent && p) { c.ent = p.ent; c.ent.away = false; parked.delete(token); log(`client ${c.no} is back as player ${c.ent.id}`); }
  if (!c.ent) {
    const saved = store.getPlayer(token);
    let x = SPAWN.x, z = SPAWN.z;
    if (saved && standable(saved.x, saved.z)) { x = saved.x; z = saved.z; }
    c.ent = SIM.addPlayer(w, x, z);
    if (saved) {
      if (!w.ents.some(e => e !== c.ent && e.id === saved.id)) c.ent.id = saved.id;
      c.ent.color = saved.color | 0;
      c.ent.name = name || saved.name || '';
    } else c.ent.name = name;
    savePlayer(c);
    log(`client ${c.no} is ${saved ? 'returning' : 'new'} player ${c.ent.id} "${c.ent.name}" at (${r3(c.ent.x)}, ${r3(c.ent.z)})`);
  } else if (name) c.ent.name = name;
  store.logAction(c.ent.id, 'join', r3(c.ent.x), r3(c.ent.z), { client: c.no });
  c.ws.send(JSON.stringify({ t: 'welcome', id: c.ent.id, x: r3(c.ent.x), z: r3(c.ent.z), name: c.ent.name, color: c.ent.color }));
  for (const it of w.items) c.ws.send(itemMessage(it));
}

// Caps. The biggest legitimate message is a 200-character note (under 400 bytes); the library's default
// payload limit is 100 MB, and parsing one such frame would stall the tick for everyone. A client sends
// `in` once per frame plus sculpt strokes, so up to ~120 messages/s is honest traffic; MSG_DROP_PER_S
// above that are dropped, MSG_CLOSE_PER_S closes the socket (4008). Each connection costs a 56 KB
// terrain shadow and a 56 KB full-terrain send, so MAX_CLIENTS bounds memory and egress (4003 'full').
const MAX_PAYLOAD = 4096, MSG_DROP_PER_S = 200, MSG_CLOSE_PER_S = 600;
const MAX_CLIENTS = parseInt(process.env.MAX_CLIENTS || '200', 10);
// Admin: `reset` (wipes everyone's terrain) and the shared tune sliders (ward, facing, repose) change
// the world for all, so they need ADMIN_TOKEN (an env var; deploy.sh sets it, the client sends it from
// ?admin=<token>). With no token configured they are refused outright.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function isAdmin(m) {
  if (!ADMIN_TOKEN || typeof m.admin !== 'string' || m.admin.length !== ADMIN_TOKEN.length) return false;
  return require('crypto').timingSafeEqual(Buffer.from(m.admin), Buffer.from(ADMIN_TOKEN));
}

// For the event (EVENT=1): every body gets a name from two short lists, stable per device, whatever the
// page sent, the chat is closed and the notice boards are read-only (2026-10-18: a class joins on
// Monday and free text over fifty heads is a risk nobody needs). The admin's backstop, from the page's console
// (MYSTICA.mod.*): rename a player, mute one for a while, remove one for the rest of the run, clear a
// board. Gated like reset and tune.
const EVENT = process.env.EVENT === '1';
const GIVEN_A = ['Quiet', 'Amber', 'Swift', 'Gentle', 'Bold', 'Grey', 'Golden', 'Silent', 'Wandering', 'Humble', 'Bright', 'Merry', 'Steady', 'Keen', 'Patient', 'Wild', 'Lucky', 'Noble', 'Rusty', 'Misty', 'Dusty', 'Hollow', 'Stone', 'Oaken'];
const GIVEN_B = ['Heron', 'Fox', 'Otter', 'Hare', 'Wren', 'Badger', 'Stag', 'Lark', 'Owl', 'Finch', 'Pike', 'Hound', 'Ram', 'Crane', 'Vole', 'Robin', 'Trout', 'Moth', 'Beetle', 'Hawk', 'Mole', 'Dove', 'Boar', 'Lynx'];
function givenName(token) { // from the token, so a reconnect keeps it; the next pair when another live body already wears it
  const h = require('crypto').createHash('sha1').update(token).digest();
  for (let k = 0; k < 24; k++) {
    const name = `${GIVEN_A[(h[0] + k) % GIVEN_A.length]} ${GIVEN_B[(h[1] + k * 7) % GIVEN_B.length]}`;
    const taken = [...clients.values()].some(o => o.ent && o.token !== token && o.ent.name === name) || [...parked.values()].some(p => p.token !== token && p.ent.name === name);
    if (!taken) return name;
  }
  return `${GIVEN_A[h[0] % GIVEN_A.length]} ${GIVEN_B[h[1] % GIVEN_B.length]} ${h[2] % 90 + 10}`;
}
const banned = new Set(); // tokens the admin removed, for the rest of this run
function onAdmin(c, m) {
  if (!isAdmin(m)) { log(`client ${c.no} sent an admin op (${m.op}) without the admin token; refused`); return; }
  const id = m.id | 0, target = [...clients.values()].find(o => o.ent && o.ent.id === id);
  switch (m.op) {
    case 'rename': { const n = clean(m.name, 16); if (!target || !n) return; const was = target.ent.name; target.ent.name = n; target.renamed = true; savePlayer(target); log(`admin: player ${id} "${was}" renamed "${n}"`); store.logAction(id, 'renamed', null, null, { was, now: n }); break; }
    case 'mute': { if (!target) return; const secs = num(m.seconds, 0, 86400, 600); target.mutedUntil = w.time + secs; log(`admin: player ${id} "${target.ent.name}" muted ${secs} s`); store.logAction(id, 'muted', null, null, { seconds: secs }); break; }
    case 'remove': { if (!target) return; banned.add(target.token); log(`admin: player ${id} "${target.ent.name}" removed for the rest of the run`); store.logAction(id, 'removed', null, null); target.ws.close(4009, 'removed'); break; }
    case 'spawn': { const kind = String(m.kind || ''); const ok = SIM.pinArena(w, kind); log(`admin: arena ${ok ? 'pinned to the ' + kind : 'freed'}`); store.logAction(c.ent.id, 'arena-pin', null, null, { kind: ok ? kind : null }); break; } // MYSTICA.mod.spawn('wraith'): that wave now and after every death until spawn() with nothing
    case 'round': { const r = SIM.startRound(w); log(`admin: round ${r}`); if (r === 'ok') store.logAction(c.ent.id, 'round-called', null, null, { admin: true }); break; } // MYSTICA.mod.round(): the stone's doing from the console, for the show
    case 'chessfree': { const it = SIM.findItem(w, m.item | 0); if (!it || it.kind !== 'chessboard') return; it.state.seats = { w: null, b: null }; it.state.resetVote = { w: false, b: false }; touchItem(it); log(`admin: chessboard ${it.id} seats freed`); store.logAction(c.ent.id, 'chess-freed', it.x, it.z, { item: it.id }); break; } // MYSTICA.mod.chessFree(item): both chairs open again, the position untouched
    case 'clearboard': { let n = 0; for (const it of w.items) if (it.kind === 'board' && (!m.item || it.id === (m.item | 0)) && it.state.notes && it.state.notes.length) { n += it.state.notes.length; it.state.notes = []; touchItem(it); } log(`admin: cleared ${n} note(s)`); store.logAction(c.ent.id, 'board-cleared', null, null, { notes: n }); break; }
    default: return;
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });
wss.on('connection', (ws, req) => {
  // A socket error (an oversized frame, invalid UTF-8, a reset connection) is an 'error' event on the
  // socket, and an EventEmitter with no 'error' listener throws it: one bad frame from one phone took the
  // whole server down. Log it; the 'close' that follows does the cleanup.
  ws.on('error', e => log(`socket error (${req.socket.remoteAddress}): ${e.message}`));
  if (clients.size >= MAX_CLIENTS) { log(`refused a connection (${req.socket.remoteAddress}): ${clients.size} clients, the cap is ${MAX_CLIENTS}`); ws.close(4003, 'full'); return; }
  const c = { no: nextClientNo++, ws, ent: null, token: null, queue: [], lastSeq: 0, budget: 0.2, shadow: SIM.makeTerrainShadow(w), stroke: null, handedOver: false, msgs: 0, msgWindow: Date.now() };
  clients.set(ws, c);
  log(`client ${c.no} connected (${req.socket.remoteAddress})`);
  ws.send(JSON.stringify({ t: 'hello', seed: SEED, time: w.time, version: CLIENT_VERSION, event: EVENT }));
  ws.send(SIM.encodeTerrainFull(w), { binary: true });
  SIM.encodeTerrainPatch(w, c.shadow); // bring the shadow level with what was just sent
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    if (now - c.msgWindow >= 1000) { c.msgWindow = now; c.msgs = 0; }
    if (++c.msgs > MSG_DROP_PER_S) {
      if (c.msgs > MSG_CLOSE_PER_S) { log(`client ${c.no} flooded (${c.msgs} messages in a second), closing`); ws.close(4008, 'too fast'); }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'auth') { onAuth(c, m); return; }
    const ent = c.ent; if (!ent) return;
    switch (m.t) {
      case 'in': if (c.queue.length < 64) c.queue.push(m); break;
      case 'sculpt': onSculpt(c, m); break;
      case 'tune': onTune(c, m); break;
      case 'name': if (!EVENT && !c.renamed) ent.name = clean(m.name, 16); break; // for the event names are given; a player the admin renamed keeps that name
      case 'say': {
        const text = clean(m.text, 120);
        if (!text || EVENT || (c.mutedUntil || 0) > w.time || (c.lastSay !== undefined && w.time - c.lastSay < 0.5)) break; // for the event the chat is closed; muted by the admin: nothing is said
        c.lastSay = w.time;
        // speech is local: only players within earshot receive it, and the speaker learns how many did
        let heard = 0;
        for (const o of clients.values()) if (o.ent && o.ent !== ent && Math.hypot(o.ent.x - ent.x, o.ent.z - ent.z) <= EARSHOT) heard++;
        w.events.push({ type: 'say', who: ent.id, x: r3(ent.x), z: r3(ent.z), text, heard });
        store.logAction(ent.id, 'say', r3(ent.x), r3(ent.z), { text, heard });
        break;
      }
      case 'trace': onTrace(c, m); break;
      case 'use': onUse(c, m); break;
      case 'board': onBoard(c, m); break;
      case 'admin': onAdmin(c, m); break;
      case 'reset':
        if (!isAdmin(m)) { log(`client ${c.no} asked to reset the terrain without the admin token; refused`); break; }
        SIM.resetTerrain(w); store.logAction(ent.id, 'reset', null, null); log(`client ${c.no} reset the terrain`); break;
    }
  });
  ws.on('close', () => {
    endStroke(c);
    if (c.ent && !c.handedOver) {
      for (const it of w.items) if (it.kind === 'chessboard' && SIM.chessStand(it.state, c.ent.id)) touchItem(it);
      store.logAction(c.ent.id, 'leave', r3(c.ent.x), r3(c.ent.z));
      savePlayer(c);
      // the body stays a while, sitting and marked away, so a dropped phone or a refresh is not a vanishing act
      c.ent.away = true; c.ent.moving = c.ent.running = false;
      parked.set(c.token, { ent: c.ent, token: c.token, until: w.time + AWAY_SECONDS });
    }
    clients.delete(ws);
    log(`client ${c.no} left`);
  });
});
const EARSHOT = 12, AWAY_SECONDS = 60;
const parked = new Map(); // token -> {ent, until}: bodies of players who just left
function tickParked() {
  for (const [token, p] of parked) if (w.time >= p.until) {
    store.savePlayer({ token, id: p.ent.id, name: p.ent.name, color: p.ent.color, x: r3(p.ent.x), z: r3(p.ent.z) });
    SIM.removeEntity(w, p.ent.id);
    parked.delete(token);
  }
}

// ------------------------------------------------------------------ items: the chessboard
const REACH = 2.5, LEAVE = 3.5;
function itemMessage(it) { return JSON.stringify({ t: 'item', id: it.id, kind: it.kind, x: it.x, z: it.z, state: it.state }); }
function touchItem(it) { // state changed: persist on the next flush, tell everyone now
  w.itemsDirty = true;
  const msg = itemMessage(it);
  for (const c of clients.values()) if (c.ent && c.ws.readyState === 1) c.ws.send(msg);
}
function itemInReach(c, id) {
  const it = SIM.findItem(w, id | 0);
  if (!it || Math.hypot(it.x - c.ent.x, it.z - c.ent.z) > REACH) return null;
  return it;
}
function onUse(c, m) {
  const it = itemInReach(c, m.item); if (!it) return;
  if (it.kind === 'roundstone') { // the arena's stone starts a round for everyone in the ring (2026-10-19; before, rounds started by themselves and the stone only explained)
    const r = SIM.startRound(w);
    if (r === 'ok') store.logAction(c.ent.id, 'round-called', it.x, it.z); else w.events.push({ type: 'round', phase: w.round.phase, reason: 'stone-' + r, to: c.ent.id });
    return;
  }
  if (it.kind === 'chessboard' && SIM.chessSit(it.state, c.ent.id)) touchItem(it);
  c.ws.send(JSON.stringify({ t: 'open', id: it.id }));
  c.ws.send(itemMessage(it));
}
function onBoard(c, m) {
  const it = itemInReach(c, m.item); if (!it) return;
  if (it.kind === 'board') { // a notice board: pin a note, one every 5 s per player
    if (m.op !== 'note' || EVENT || (c.mutedUntil || 0) > w.time || (c.lastNote !== undefined && w.time - c.lastNote < 5)) return; // for the event the boards are read-only; a muted player pins nothing
    if (SIM.pinNote(it.state, c.ent.id, c.ent.name, clean(m.text, 200), Date.now())) {
      c.lastNote = w.time; touchItem(it);
      store.logAction(c.ent.id, 'note', it.x, it.z, { text: it.state.notes[0].text });
    }
    return;
  }
  if (it.kind !== 'chessboard') return;
  const st = it.state, pid = c.ent.id;
  let r = null;
  switch (m.op) {
    case 'sit': r = SIM.chessSit(st, pid) ? 'ok' : 'full'; break;
    case 'stand': r = SIM.chessStand(st, pid) ? 'ok' : 'notSeated'; break;
    case 'move': r = SIM.applyChessMove(st, pid, m.from, m.to); if (r === 'ok') store.logAction(pid, 'chess', it.x, it.z, { from: m.from | 0, to: m.to | 0, moves: st.moves }); break;
    case 'reset': r = SIM.chessReset(st, pid, w.time); if (r === 'reset') store.logAction(pid, 'chess-reset', it.x, it.z); break;
    case 'turn': r = SIM.chessPassTurn(st, pid); if (r === 'ok') store.logAction(pid, 'chess-turn', it.x, it.z, { to: st.turn }); break;
    case 'back': r = SIM.chessTakeBack(st, pid); if (r === 'ok') store.logAction(pid, 'chess-back', it.x, it.z, { turn: st.turn, history: st.history.length }); break;
    case 'redo': r = SIM.chessRedo(st, pid); if (r === 'ok') store.logAction(pid, 'chess-redo', it.x, it.z, { turn: st.turn }); break;
    default: return;
  }
  if (r === 'ok' || r === 'reset' || r === 'voted') touchItem(it);
}
function tickItems() { // seats are released when the holder walks away; reset votes expire
  for (const it of w.items) {
    if (it.kind !== 'chessboard') continue;
    const st = it.state; let changed = false;
    for (const s of ['w', 'b']) {
      const pid = st.seats[s]; if (pid === null) continue;
      const e = w.ents.find(x => x.id === pid);
      if ((!e || Math.hypot(it.x - e.x, it.z - e.z) > LEAVE) && SIM.chessLeave(st, pid)) changed = true; // a started game keeps its players' seats
    }
    if (SIM.chessExpireVotes(st, w.time)) changed = true;
    if (changed) touchItem(it);
  }
}

const clean = (s, max) => String(s == null ? "" : s).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
const num = (v, lo, hi, dflt) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; };
function onSculpt(c, m) {
  const x = num(m.x, -w.HALF, w.HALF, NaN), z = num(m.z, -w.HALF, w.HALF, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  if (Math.hypot(x - c.ent.x, z - c.ent.z) > 16) return; // out of reach
  if (SIM.inZone(x, z) || SIM.inZone(c.ent.x, c.ent.z)) return; // no digging on the arena grounds
  const tool = ['raise', 'lower', 'stone', 'clear'].includes(m.tool) ? m.tool : null;
  if (!tool) return;
  const dt = num(m.dt, 0, 0.05, 0);
  if (SIM.sculptAttempt(w, c.ent, x, z, tool, dt, num(m.r, 1, 7, 3)) !== 'ok') return;
  // the action log records strokes, not every frame of a held brush
  const now = w.time;
  if (!c.stroke || c.stroke.tool !== tool || now - c.stroke.last > STROKE_GAP) { endStroke(c); c.stroke = { tool, x, z, seconds: 0, last: now }; }
  c.stroke.seconds += dt; c.stroke.last = now;
}
function endStroke(c) {
  const s = c.stroke; if (!s) return;
  store.logAction(c.ent.id, 'sculpt', r3(s.x), r3(s.z), { tool: s.tool, seconds: r3(s.seconds) });
  c.stroke = null;
}
function onTrace(c, m) { // a client's own account of itself (?trace=1 on the page): logged and kept, one every 4 s per client
  const now = Date.now();
  if (c.lastTrace && now - c.lastTrace < 4000) return;
  c.lastTrace = now;
  const obj = Object.assign({}, m); delete obj.t;
  const body = JSON.stringify(obj);
  if (body.length > 3000) return;
  log(`trace p${c.ent.id} ${body}`);
  store.logAction(c.ent.id, 'trace', r3(c.ent.x), r3(c.ent.z), obj);
}
function onTune(c, m) {
 // the shared sliders are the admin's; the per-player ones (jump height, swimming) stay anyone's
  if (isAdmin(m)) {
    if (m.ward !== undefined) w.town.strength = num(m.ward, 0, 1, w.town.strength);
    if (m.facing !== undefined) w.town.facing = num(m.facing, 0, 359, 0) * Math.PI / 180;
    if (m.repose !== undefined) w.repose = num(m.repose, 20, 60, w.repose);
  }
  if (m.jumpH !== undefined) c.ent.jumpV = Math.sqrt(2 * SIM.C.GRAVITY * num(m.jumpH, 0.4, 2.2, SIM.C.JUMP_H));
  if (m.swim !== undefined) c.ent.canSwim = !!m.swim;
}

// ------------------------------------------------------------------ tick
let last = Date.now(), snapAcc = 0, patchAcc = 0, flushAcc = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.25); last = now;
  for (const c of clients.values()) if (c.stroke && w.time - c.stroke.last > STROKE_GAP) endStroke(c);
  // apply queued inputs, each with its own dt, within a budget that stops speed hacks
  for (const c of clients.values()) {
    if (!c.ent) { c.queue.length = 0; continue; }
    c.budget = Math.min(c.budget + dt * 1.25, 1.0); // a second's burst (a phone's radio buffers) is applied in full; the long-run rate is still capped at 1.25x
    while (c.queue.length) {
      const m = c.queue.shift();
      let d = num(m.dt, 0, 0.05, 0);
      if (d > c.budget) d = c.budget;
      c.budget -= d;
      SIM.stepDriven(w, c.ent, { mx: num(m.mx, -1e3, 1e3, 0), mz: num(m.mz, -1e3, 1e3, 0), run: !!m.run, creep: !!m.creep, jump: !!m.jump, cast: num(m.cast, 0, 3, 0) | 0, assist: !!m.assist, target: num(m.target, 0, 1e9, 0) | 0 }, d);
      c.lastSeq = m.seq | 0;
    }
  }
  SIM.simStep(w, dt);
  tickItems();
  tickParked();
  snapAcc += dt; if (snapAcc >= SNAP_EVERY) { snapAcc = 0; broadcastSnapshot(); }
  patchAcc += dt; if (patchAcc >= PATCH_EVERY) { patchAcc = 0; broadcastTerrain(); }
  flushAcc += dt; if (flushAcc >= FLUSH_EVERY) { flushAcc = 0; flush('timer'); }
}, TICK * 1000);

function broadcastSnapshot() {
  const t = w.town;
  const ents = w.ents.map(e => ({
    id: e.id, kind: e.kind, name: e.name, color: e.color, away: !!e.away, hp: e.hp, maxHp: e.maxHp, ghost: !!e.ghost, x: r3(e.x), z: r3(e.z), y: r3(e.y), vy: r3(e.vy), grounded: e.grounded, jumpsLeft: e.jumpsLeft,
    heading: r3(e.heading), moving: e.moving, running: e.running, cr: e.creeping ? 1 : undefined, walkPhase: r3(e.walkPhase), air: r3(e.air), // cr: creeping, for the other clients' footstep cadence
    aim: (e.kind === 'wisp' || e.kind === 'wraith') && e.rootUntil > w.time ? 1 : 0, // a floater hanging still after its shot: lit up on the client
    sl: e.kind === 'player' ? (e.slide | 0) : undefined, as: e.kind === 'player' ? (e.avoidSide | 0) : undefined, st: e.kind === 'player' && e.stalled ? 1 : undefined // the slide state, so a predicting client agrees with the authority about which way it is sliding
  }));
  const town = { strength: t.strength, facing: t.facing, guardTimer: r3(t.guardTimer), guardX: r3(t.guardX), guardZ: r3(t.guardZ), guardHeading: r3(t.guardHeading), repose: w.repose };
  const events = w.events.splice(0);
  for (const ev of events) {
    if (ev.type === 'guard') store.logAction(ev.who, 'guard', r3(ev.x), r3(ev.z), { strength: r3(ev.strength) });
    if (ev.type === 'elim') store.logAction(ev.by, 'elim', null, null, { who: ev.who });
    if (ev.type === 'died' && ev.kind) store.logAction(ev.by, ev.kind + '-slain', r3(ev.x), r3(ev.z));
    if (ev.type === 'round' && ev.phase === 'over') store.logAction(ev.winner, 'round-won', null, null, { scores: ev.scores });
    tallyEvent(ev);
  }
  const shots = w.shots.map(s => ({ id: s.id, o: s.owner, m: s.mob ? 1 : 0, v: s.v, x: r3(s.x), z: r3(s.z), dx: r3(s.dx), dz: r3(s.dz) })); // o, m: the client flies a bolt on between snapshots and holds it at a body, except its owner and, for a monster's bolt, other monsters
  const walls = w.walls.map(wl => ({ id: wl.id, k: wl.kind, x: r3(wl.x), z: r3(wl.z), angle: r3(wl.angle), left: r3(wl.until - w.time), age: r3(w.time - wl.from) })); // k: 'fire' (the wraith's); age: embers until FIRE_RISE
  const rd = w.round, round = { phase: rd.phase, t: r3(rd.t), players: rd.players, fallen: rd.fallen, winner: rd.winner, scores: rd.scores };
  let top; for (const c of clients.values()) if (c.watch && c.ent) { top = tallyTop(10); break; } // the leaderboard goes to watchers only: ten rows, built once per snapshot
  for (const c of clients.values()) {
    if (!c.ent || c.ws.readyState !== 1) continue; // nothing before auth: the client cannot tell its own body apart yet
    // speech reaches only those within earshot (and the speaker); targeted events only their target; the rest everyone
    const mine = events.filter(ev => ev.to !== undefined ? (c.ent && ev.to === c.ent.id) : (ev.type !== 'say' || (c.ent && (ev.who === c.ent.id || Math.hypot(ev.x - c.ent.x, ev.z - c.ent.z) <= EARSHOT))));
    const cd = c.ent ? { arrow: r3(Math.max(0, c.ent.cd.arrow - w.time)), wall: r3(Math.max(0, c.ent.cd.wall - w.time)), blink: r3(Math.max(0, c.ent.cd.blink - w.time)) } : null;
    c.ws.send(JSON.stringify({ t: 'snap', time: r3(w.time), ack: c.lastSeq, town, ents, events: mine, shots, walls, round, cd, tally: c.watch ? top : undefined }));
  }
}
function broadcastTerrain() {
  for (const c of clients.values()) {
    if (c.ws.readyState !== 1) continue;
    const buf = SIM.encodeTerrainPatch(w, c.shadow);
    if (buf) c.ws.send(buf, { binary: true });
  }
}
function r3(v) { return Math.round(v * 1000) / 1000; }
function log(msg) { console.log(new Date().toISOString().slice(11, 19), msg); }

function shutdown(sig) {
  log(`${sig}: flushing and closing`);
  for (const c of clients.values()) endStroke(c);
  try { flush('shutdown'); store.close(); } catch (e) { console.error(e); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
  const st = store.stats();
  log(`Mystica server: world seed ${SEED}, ${w.props.length} props, ${w.ents.length} creatures; store has ${st.chunks} chunks, ${st.actions} logged actions. http://localhost:${PORT}`);
});
