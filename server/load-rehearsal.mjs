// Load rehearsal: N scripted players against a Mystica server for T seconds.
//   node load-rehearsal.mjs <ws url> <clients> <seconds> [--force]
// Each player authenticates with its own token, sends inputs at 20 Hz (a wander that stays within 6
// tiles of the spawn, so nobody reaches the arena), and records every snapshot: its arrival time,
// size, the server's sim time and the ack. Reported: connection outcomes, snapshot cadence (p50/p95/
// max of the gap), snapshot size and egress, input-ack latency (p50/p95/max), and sim-time drift against
// the wall clock (negative = the server's tick fell behind). Refuses to run against a server that has
// players unless --force.
import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';

const [url, nStr, tStr, ...flags] = process.argv.slice(2);
const N = parseInt(nStr, 10), T = parseFloat(tStr), force = flags.includes('--force');
const httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

async function health() { try { return await (await fetch(httpBase + '/healthz')).json(); } catch (e) { return { error: String(e) }; } }

const before = await health();
console.log('healthz before:', JSON.stringify(before));
if (!force && before.players > 0) { console.log(`refusing: ${before.players} player(s) online; pass --force to run anyway`); process.exit(2); }

const SPAWN = { x: 0, z: 3 };
const stats = { opened: 0, welcomed: 0, closed: {}, errors: 0, terrainBytes: 0, snapBytes: [], snapGaps: [], ackLat: [], drift: [], inputsSent: 0, snaps: 0 };
const clients = [];

function makeClient(i) {
  const c = { i, ws: null, id: null, seq: 0, pending: new Map(), lastSnapAt: 0, firstWall: 0, firstSim: 0, lastWall: 0, lastSim: 0, x: SPAWN.x, z: SPAWN.z, heading: Math.random() * Math.PI * 2, turnAt: 0, timer: null, done: false };
  const token = crypto.randomBytes(16).toString('hex');
  const ws = new WebSocket(url, { perMessageDeflate: false });
  c.ws = ws;
  ws.on('open', () => { stats.opened++; });
  ws.on('error', () => { stats.errors++; });
  ws.on('close', (code) => { stats.closed[code] = (stats.closed[code] || 0) + 1; if (c.timer) clearInterval(c.timer); });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { stats.terrainBytes += data.length; return; }
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (m.t === 'hello') { ws.send(JSON.stringify({ t: 'auth', token, name: 'rehearsal-' + i })); return; }
    if (m.t === 'welcome') {
      stats.welcomed++; c.id = m.id; c.x = m.x; c.z = m.z;
      c.timer = setInterval(() => tick(c), 50);
      return;
    }
    if (m.t !== 'snap') return;
    const now = performance.now();
    stats.snaps++;
    stats.snapBytes.push(data.length);
    if (c.lastSnapAt) stats.snapGaps.push(now - c.lastSnapAt);
    c.lastSnapAt = now;
    if (!c.firstWall) { c.firstWall = now; c.firstSim = m.time; }
    c.lastWall = now; c.lastSim = m.time;
    for (const [seq, at] of c.pending) { if (seq <= m.ack) { stats.ackLat.push(now - at); c.pending.delete(seq); } }
    if (c.pending.size > 200) { const oldest = Math.min(...c.pending.keys()); c.pending.delete(oldest); } // never acked: drop
    const me = m.ents && m.ents.find(e => e.id === c.id);
    if (me) { c.x = me.x; c.z = me.z; }
  });
  return c;
}

function tick(c) {
  if (c.done || c.ws.readyState !== 1) return;
  const now = performance.now();
  const dx = c.x - SPAWN.x, dz = c.z - SPAWN.z, far = Math.hypot(dx, dz);
  if (far > 6) { c.heading = Math.atan2(-dx, -dz) + (Math.random() - 0.5) * 0.6; c.turnAt = now + 1500; }
  else if (now > c.turnAt) { c.heading = Math.random() * Math.PI * 2; c.turnAt = now + 1000 + Math.random() * 2000; }
  const seq = ++c.seq;
  c.pending.set(seq, now);
  const msg = { t: 'in', seq, dt: 0.05, mx: Math.sin(c.heading), mz: Math.cos(c.heading), run: (seq % 97) < 20, jump: seq % 173 === 0 };
  c.ws.send(JSON.stringify(msg));
  stats.inputsSent++;
}

const t0 = performance.now();
for (let i = 0; i < N; i++) { clients.push(makeClient(i)); await sleep(N > 1 ? 100 : 0); }
console.log(`${N} connection(s) started over ${r1((performance.now() - t0) / 1000)} s; running ${T} s`);
const midAt = Math.max(1, Math.floor(T / 2));
await sleep(midAt * 1000);
const mid = await health();
console.log('healthz mid-run:', JSON.stringify(mid));
await sleep(Math.max(0, (T - midAt) * 1000));

for (const c of clients) { c.done = true; if (c.timer) clearInterval(c.timer); }
for (const c of clients) {
  if (c.firstWall && c.lastWall > c.firstWall) stats.drift.push((c.lastSim - c.firstSim) - (c.lastWall - c.firstWall) / 1000);
}
for (const c of clients) try { c.ws.close(); } catch (e) {}
await sleep(1500);
const after = await health();

const secs = T;
const egressPerClient = stats.snapBytes.length ? (stats.snapBytes.reduce((a, b) => a + b, 0) / stats.welcomed / secs) : 0;
const report = {
  url, clients: N, seconds: T,
  connections: { opened: stats.opened, welcomed: stats.welcomed, closeCodes: stats.closed, socketErrors: stats.errors },
  healthz: { before, mid, after },
  inputsSent: stats.inputsSent,
  snapshots: { count: stats.snaps, perClientPerSec: r1(stats.snaps / Math.max(1, stats.welcomed) / secs),
    gapMs: { p50: r1(pct(stats.snapGaps, 0.5)), p95: r1(pct(stats.snapGaps, 0.95)), p99: r1(pct(stats.snapGaps, 0.99)), max: r1(pct(stats.snapGaps, 1)) },
    bytes: { mean: Math.round(stats.snapBytes.reduce((a, b) => a + b, 0) / Math.max(1, stats.snapBytes.length)), max: Math.max(0, ...stats.snapBytes) },
    egressKBps: { perClient: r1(egressPerClient / 1024), total: r1(egressPerClient * stats.welcomed / 1024) } },
  ackLatencyMs: { p50: r1(pct(stats.ackLat, 0.5)), p95: r1(pct(stats.ackLat, 0.95)), p99: r1(pct(stats.ackLat, 0.99)), max: r1(pct(stats.ackLat, 1)), samples: stats.ackLat.length },
  simDriftSeconds: { median: r1(pct(stats.drift, 0.5)), worst: r1(pct(stats.drift, 0)) },
  terrainKB: Math.round(stats.terrainBytes / 1024),
};
console.log(JSON.stringify(report, null, 1));
const out = `load-${N}x${T}-${Date.now()}.json`;
fs.writeFileSync(new URL('./' + out, import.meta.url), JSON.stringify(report, null, 1));
console.log('saved', out);
process.exit(0);
