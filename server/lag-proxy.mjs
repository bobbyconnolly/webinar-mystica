// A latency proxy for testing the client against a local server as if it were far away.
//   node server/lag-proxy.mjs <listen port> <target port> [one-way ms]
// Serves the game pages by forwarding HTTP to the target and relays the WebSocket both ways, holding
// every frame for the given one-way delay (default 150 ms, so a 300 ms round trip, about an
// intercontinental link). Open http://localhost:<listen port>/ instead of the server's own port.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const [listenStr, targetStr, lagStr] = process.argv.slice(2);
const LISTEN = parseInt(listenStr, 10), TARGET = parseInt(targetStr, 10), LAG = parseInt(lagStr || '150', 10);

const server = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: TARGET, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('target down'); });
  req.pipe(up);
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, client => {
    const target = new WebSocket(`ws://127.0.0.1:${TARGET}${req.url}`, { perMessageDeflate: false });
    const queue = []; // frames from the client that arrived before the target socket opened
    const relay = (from, to) => from.on('message', (data, isBinary) => {
      const buf = Buffer.from(data);
      setTimeout(() => { if (to.readyState === 1) to.send(buf, { binary: isBinary }); }, LAG);
    });
    client.on('message', (data, isBinary) => { if (target.readyState !== 1) queue.push([Buffer.from(data), isBinary]); });
    target.on('open', () => {
      for (const [buf, isBinary] of queue) setTimeout(() => { if (target.readyState === 1) target.send(buf, { binary: isBinary }); }, LAG);
      queue.length = 0;
      relay(client, target); relay(target, client);
    });
    const closeBoth = () => { setTimeout(() => { try { client.close(); } catch (e) {} try { target.close(); } catch (e) {} }, LAG); };
    client.on('close', closeBoth); target.on('close', closeBoth);
    client.on('error', () => {}); target.on('error', () => {});
  });
});
server.listen(LISTEN, () => console.log(`lag proxy: http://localhost:${LISTEN} -> :${TARGET}, ${LAG} ms each way`));
