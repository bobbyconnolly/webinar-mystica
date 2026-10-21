// Exact circles: a body of radius 0.3 squeezes between a post and a rock when the gap allows it, and when
// it does not the body is blocked and stands still (no vibration, no teleport: since 2026-10-18 a slide never
// reverses the previous frame's slide, and nobody is moved to a free spot).
'use strict';
const SIM = require('../prototype/sim.js');
const C = SIM.C;
function world() { const w = SIM.createWorld(7); return w; }
function tryGap(gap) {
  const w = world(), y = 0.6, x0 = 3, z0 = 12; // on the town plateau, open grass
  // a post (r 0.1) and a rock (r 0.5) with `gap` between their edges, straddling the path z = z0
  const post = { x: x0, z: z0 - (gap / 2 + 0.1) }, rock = { x: x0, z: z0 + (gap / 2 + 0.5) };
  // use the sim's own hash insert via the exported helper on a fresh world
  SIM._barrierCircle(w, post.x, post.z, 0.1, 99); SIM._barrierCircle(w, rock.x, rock.z, 0.5, 99);
  const P = SIM.addPlayer(w, x0 - 3, z0); P.y = P.gy = SIM.surfaceAt(w, P.x, P.z);
  const xs = [];
  for (let i = 0; i < 180; i++) { SIM.stepDriven(w, P, { mx: 1, mz: 0, run: false, jump: false }, 1 / 60); xs.push(P.x); }
  // jitter: mean absolute frame-to-frame reversal in the last second
  let rev = 0; for (let i = xs.length - 60; i < xs.length - 1; i++) if (Math.sign(xs[i + 1] - xs[i]) !== Math.sign(xs[i] - xs[i - 1]) && Math.abs(xs[i + 1] - xs[i]) > 0.01) rev++;
  const movedLastSecond = Math.hypot(xs[xs.length - 1] - xs[xs.length - 60], 0);
  return { past: P.x > x0 + 1, still: movedLastSecond < 0.01 && rev === 0, endX: P.x.toFixed(2), endZ: P.z.toFixed(2), reversalsLastSecond: rev, y };
}
const out = { gap0_7: tryGap(0.7), gap0_5: tryGap(0.5), gap0_3: tryGap(0.3) };
// a 5-pixel post alone: walk straight at it, the body goes round and gets past
const w = world(); SIM._barrierCircle(w, 3, 12, 0.1, 99);
const P = SIM.addPlayer(w, 0, 12); P.y = P.gy = SIM.surfaceAt(w, 0, 12);
for (let i = 0; i < 120; i++) SIM.stepDriven(w, P, { mx: 1, mz: 0, run: false, jump: false }, 1 / 60);
out.postAlone = { past: P.x > 4, x: P.x.toFixed(2) };
out.hashBuckets = { total: w.hash.filter(Boolean).length, circles: w.circles.length, maxPerBucket: Math.max(...w.hash.filter(Boolean).map(b => b.length)) };
console.log(JSON.stringify(out));
