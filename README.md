# Mystica

An Ultima Online-style isometric sandbox MMO prototype: a true-3D world rendered through a locked UO camera into a low-resolution pixel pipeline, with sculptable terrain, a town ward field, and an authoritative server.

## Run it

Multiplayer (the server runs the world and serves the client):

```
cd server
npm install
node server.js
```

Then open http://localhost:8080 on the PC and, for a phone on the same network, `http://<your-pc-ip>:8080`. The stats strip shows `online` when the client is connected. `PORT=9000 SEED=42 node server.js` changes the port and the world seed; `MOBS=0` starts without the arena's monsters, for tests. `?trace=1` on the page makes the client send a five-second account of itself (version, fps, slow frames, prediction corrections with positions, ack latency), which the server logs as `trace` and keeps in the action log: `az containerapp logs show -n mystica -g mystica --type console --tail 300 | grep trace`.

The world is saved to `server/world-<seed>.sqlite` (player-made terrain per chunk, the town, the animals, items, players, an action log) and restored on the next start. Delete the file for a fresh world. A player is identified by a random token kept in the browser: name, shirt colour and last position come back on the next visit, with no sign-up.

To invite someone, send them the server URL. Inside the house there is a chessboard on the table: walk up and click it to sit down; two seats, honor rules, Reset needs both players. The board says whose move it is and what moved last; press Done to pass the turn, Take back to undo.

Offline sandbox (no server, the browser simulates the world itself): open `prototype/index.html` directly, or any static server. The stats strip shows `local`.

A redeploy does not strand open pages: the server names the client's version (a hash of the client files) at `/version` and in its hello, the page polls it while visible and hears the new one when the redeploy's reconnect comes, and it reloads itself the next time its tab comes back to the front, never while the player is in it.

## Cloud (Azure Container Apps)

Everything lives in resource group `mystica`, Canada Central: a Basic container registry, a Container Apps environment, the `mystica` app (0.25 vCPU, 0.5 GiB, one replica, HTTPS and WSS ingress), and a storage account whose file share is mounted at `/data` for the world database. Scripts are bash; on Windows run them from Git Bash with `az` logged in.

| Script | What it does |
|---|---|
| `bash deploy/deploy.sh` | Create or update everything; builds the image in Azure from the `Dockerfile` (no local Docker), rolls the app, waits for `/healthz`. |
| `bash deploy/up.sh` | Before a session: ingress on, one replica pinned. |
| `bash deploy/down.sh` | After: scale to zero, ingress off. Compute costs nothing; the world stays on the share. |
| `bash deploy/status.sh` | Resources, replica state, health. |
| `bash deploy/destroy.sh` | Delete the whole group, world included. Asks for the group name. |

The first deploy writes an admin token to `deploy/admin.token` (git-ignored, reused by later deploys, delete it to rotate) and prints the admin URL: the game URL with `?admin=<token>`. Only a page opened that way can reset the terrain or move the shared sliders (ward, facing, angle of repose); everyone else's `reset` and shared `tune` are refused. The server also caps a message at 4 KB, drops a socket's messages above 200 a second and closes it above 600 (4008), and refuses connections beyond `MAX_CLIENTS` (200) with 4003. Locally, `ADMIN_TOKEN=x node server.js` and `http://localhost:8080/?admin=x` give the same powers.

For an event with strangers, `EVENT=1 bash deploy/deploy.sh`: every body gets a name from two short lists ("Quiet Heron"), stable per device, whatever the page sent, the welcome card says who you are instead of asking, the chat is closed (no Say button, Enter does nothing, the server drops speech), and the notice boards are read-only; a plain `bash deploy/deploy.sh` turns it off again. The admin page's console has a backstop either way: `MYSTICA.mod.who()`, `MYSTICA.mod.rename(id, name)`, `MYSTICA.mod.mute(id, seconds)`, `MYSTICA.mod.remove(id)` (for the rest of the run), `MYSTICA.mod.clearBoard()`.

Roughly US$15 to 20 a month pinned on, about US$5 scaled to zero (the registry). SQLite cannot lock files on the share (a network file system), so the live database sits on the container's local disk and a consistent copy is mirrored to the share after every flush (`MIRROR_DIR`), and restored from there when the container starts.

## Sounds

Every clip is CC0 (Kenney packs and OpenGameArt: the wet footsteps and the splashes come from there), listed with its source in `prototype/sounds/index.json`. The game plays the picks in `prototype/sounds/sounds-manifest.json` through WebAudio (`prototype/sounds.js`): a cooldown per role, a little pitch and level variation, volume falling with distance from your character, and nothing until a touch or key unlocks the context. Two files under one role are variants the game alternates, so footsteps are a left and a right. Open `sounds/audition.html` on the running game to hear every candidate at a common loudness, rate them, and export a new manifest to paste over the file. On 2026-10-18 the water sounds (the splash on entering, the swim strokes, wet footsteps) were measured through the game's own chain with ffmpeg (`tools/measure-sounds.sh`: loudest 50 ms, peak, spectral centroid) and levelled with the footsteps: as shipped they came out 10 to 15 dB above a grass step, clipped, and sat near 4 kHz against a step's 300 Hz; now within a decibel of a dry step and about 1.5 kHz. `MYSTICA.SFX.tune({ wet: { splash: { level: 0.4, lowpass: 1400 } } })` moves them live. Sound off: the Sound button on a phone, the Sound checkbox in the panel on a desktop; remembered on the device.

## Layout

- `prototype/sim.js`: the simulation. Shared by server and client; no rendering in it.
- `prototype/main.js`, `shaders.js`, `net.js`, `index.html`: the client.
- `server/server.js`: the authoritative server (Node, `ws`).
- `prototype/NOTES.md`: what each system does and where it lives.
- `server/load-rehearsal.mjs`: N scripted players against a server for T seconds (`node server/load-rehearsal.mjs wss://<host>/ws 50 120`); reports connections, snapshot cadence and size, egress, input-ack latency and sim drift. Refuses a server with players online unless `--force`.
- `server/lag-proxy.mjs`: serves the game through a one-way delay (`node server/lag-proxy.mjs 8096 8080 150`), to feel a phone's latency on the desk and to measure prediction against it.

## Controls

WASD or hold the right mouse button to move (far cursor runs), Shift runs, Space jumps, Tab switches to sculpting (1 to 4 pick the tool, left drag applies, right drag lowers), mouse wheel zooms, H and K hide the panels.

On a phone, hold it sideways: the left thumb gets a floating stick (push far to run), the right thumb gets Jump, Dig and Zoom buttons, and a pinch steps the zoom.

In the arena the Arrow button (key 1) fires at the nearest monster in range, or at the one you tapped, as long as it is within 45 degrees of the way you face: a reticle marks the target, grey when the arrow would not be aimed at it (out of reach, behind cover, or outside that arc), in which case the arrow flies straight ahead.
