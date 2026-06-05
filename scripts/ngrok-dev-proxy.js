/**
 * Single-port dev proxy for free ngrok (one public URL).
 * /api/* and /uploads/* → Express :4000; everything else → Expo :8086.
 */
const http = require('http');

const PROXY_PORT = Number(process.env.NGROK_PROXY_PORT || 3099);
const API_TARGET = process.env.NGROK_PROXY_API || 'http://127.0.0.1:4000';
const EXPO_TARGET = process.env.NGROK_PROXY_EXPO || 'http://127.0.0.1:8086';

function parseTarget(base) {
  const u = new URL(base);
  return { hostname: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
}

const api = parseTarget(API_TARGET);
const expo = parseTarget(EXPO_TARGET);

function pickTarget(url) {
  const path = String(url || '/');
  if (path.startsWith('/api') || path.startsWith('/uploads')) {
    return api;
  }
  return expo;
}

function proxyHttp(req, res) {
  const target = pickTarget(req.url);
  const opts = {
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
  };

  const upstream = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end(`Proxy error (${target.port}): ${err.message}`);
  });

  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const target = expo;
  const upstream = http.request({
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
  });

  upstream.on('upgrade', (pres, upstreamSocket, upstreamHead) => {
    upstreamSocket.write(upstreamHead);
    socket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstream.on('error', () => socket.destroy());
  upstream.end();
}

const server = http.createServer(proxyHttp);
server.on('upgrade', proxyUpgrade);

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[ngrok-dev-proxy] http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[ngrok-dev-proxy] API  → ${API_TARGET}`);
  console.log(`[ngrok-dev-proxy] Expo → ${EXPO_TARGET}`);
});
