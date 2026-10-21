/* net.js — client side of the wire. Connects to the game server that served this page; if there is
 * none (file://, the published artifact, a plain static server) the client stays in local mode and
 * the simulation in sim.js is the world.
 *
 * Messages to the server are JSON: {t:'in', seq, dt, mx, mz, run, jump} once per frame,
 * {t:'sculpt', x, z, tool, dt, r} while a brush is held, {t:'tune', ...} for shared sliders, {t:'reset'}.
 * From the server: JSON {t:'hello', id, seed} and {t:'snap', ...} snapshots, plus binary terrain
 * messages in the format defined in sim.js.
 */
var NET = (function () {
  'use strict';
  var ws = null, hooks = {}, connected = false, seq = 0;
  function connect(h) {
    hooks = h || {};
    if (location.protocol === 'file:' || !location.host) return;
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    try { ws = new WebSocket(url); } catch (e) { return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { connected = true; }; // the handshake rides on the 'hello' message, below; onOpen is the item-open handler, not a socket-open one
    ws.onclose = function () {
      var was = connected; connected = false; ws = null;
      if (was && hooks.onClose) hooks.onClose();
      setTimeout(function () { connect(hooks); }, 3000); // the server restarts, the phone sleeps: just keep trying
    };
    ws.onerror = function () { /* no server behind this page: stay local */ };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'hello' && hooks.onHello) hooks.onHello(m);
        else if (m.t === 'snap' && hooks.onSnapshot) hooks.onSnapshot(m);
        else if (m.t === 'welcome' && hooks.onWelcome) hooks.onWelcome(m);
        else if (m.t === 'item' && hooks.onItem) hooks.onItem(m);
        else if (m.t === 'open' && hooks.onOpen) hooks.onOpen(m);
      } else if (hooks.onTerrain) hooks.onTerrain(ev.data);
    };
  }
  function send(o) { if (connected && ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  return {
    connect: connect, send: send,
    nextSeq: function () { return ++seq; },
    get connected() { return connected; }
  };
})();
