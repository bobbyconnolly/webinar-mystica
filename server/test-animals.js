// Headless: run the world for ten simulated minutes and report animals that stopped getting anywhere,
// plus whether a player can jump onto and over a big rock.
'use strict';
const SIM = require('../prototype/sim.js');
const w = SIM.createWorld(7);
const animals = w.ents.filter(e => !e.driven);
const track = animals.map(e => ({ e, last: [e.x, e.z], stuckWindows: 0, windows: 0 }));
for (let s = 0; s < 600; s++) {
  for (let i = 0; i < 20; i++) SIM.simStep(w, 1 / 20);
  if (s % 10 === 9) for (const t of track) { // every 10 s: did it move at all in a window where it walked?
    const d = Math.hypot(t.e.x - t.last[0], t.e.z - t.last[1]); t.windows++; if (d < 0.3) t.stuckWindows++; t.last = [t.e.x, t.e.z];
  }
}
const stuck = track.filter(t => t.stuckWindows > t.windows * 0.6).map(t => ({ kind: t.e.kind, at: [t.e.x.toFixed(1), t.e.z.toFixed(1)], stuckFrac: (t.stuckWindows / t.windows).toFixed(2) }));
const inside = animals.filter(e => SIM.barrierAt(w, e.x, e.z) > SIM.surfaceAt(w, e.x, e.z) + 0.05).length;
// big rock test: find a rock prop with scale > 1 and try to walk through, then jump onto it
const rock = w.props.find(p => p.kind === 'rock' && p.scale > 1.0);
const P = SIM.addPlayer(w, rock.x - 2.5, rock.z);
const walk = (n, jump) => { for (let i = 0; i < n; i++) SIM.stepDriven(w, P, { mx: 1, mz: 0, run: false, jump: jump && i === 0 }, 1 / 60); };
const rr = 0.42 * rock.scale;
let enteredOnFoot = false;
for (let i = 0; i < 150; i++) { SIM.stepDriven(w, P, { mx: 1, mz: 0, run: false, jump: false }, 1 / 60); if (Math.hypot(P.x - rock.x, P.z - rock.z) < rr - 0.05) enteredOnFoot = true; }
P.x = rock.x - 1.1; P.z = rock.z; P.y = P.gy = SIM.surfaceAt(w, P.x, P.z); P.grounded = true;
let stoodOnTop = false, maxLift = 0;
for (let i = 0; i < 60; i++) {
  SIM.stepDriven(w, P, { mx: 1, mz: 0, run: false, jump: i === 0 }, 1 / 60);
  const lift = P.gy - SIM.heightAt(w, P.x, P.z); maxLift = Math.max(maxLift, lift);
  if (P.grounded && lift > 0.3 && Math.hypot(P.x - rock.x, P.z - rock.z) < rr) stoodOnTop = true;
}
walk(90, false); const past = P.x > rock.x + rr + 0.3;
console.log(JSON.stringify({ animals: animals.length, stuck, insideBarrier: inside, rock: { scale: rock.scale.toFixed(2), top: (rock.y + 0.33 * rock.scale + 0.3).toFixed(2), enteredOnFoot, stoodOnTop, maxLift: maxLift.toFixed(2), gotPast: past } }));
