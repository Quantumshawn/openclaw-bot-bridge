'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
// Optional shared secret. Set via environment: AUTH_TOKEN=secret node server.js
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');

function isValidName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

// ---- HTTP server (serves dashboard) ----
const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  if (urlPath === '/' || urlPath === '/index.html') {
    fs.readFile(DASHBOARD_PATH, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Dashboard not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---- WebSocket relay ----
const wss = new WebSocketServer({ server });

/** @type {Map<string, {ws: WebSocket, name: string, connectedAt: string}>} */
const bots = new Map();
/** @type {Set<WebSocket>} */
const dashboards = new Set();
/** @type {Array<object>} */
const messageLog = [];
const MAX_LOG = 200;

function broadcastToDashboards(data) {
  const msg = JSON.stringify(data);
  for (const ws of dashboards) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToBots(data, excludeName = null) {
  const msg = JSON.stringify(data);
  for (const [name, bot] of bots) {
    if (name !== excludeName && bot.ws.readyState === WebSocket.OPEN) {
      bot.ws.send(msg);
    }
  }
}

function getStatusPayload() {
  return {
    type: 'status',
    bots: Array.from(bots.values()).map(b => ({ name: b.name, connectedAt: b.connectedAt }))
  };
}

wss.on('connection', (ws) => {
  let botName = null;
  let isDashboard = false;
  let registered = false;

  // Require registration within 10 seconds
  const regTimeout = setTimeout(() => {
    if (!registered) ws.close(4001, 'Registration timeout');
  }, 10000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.close(4002, 'Invalid JSON');
      return;
    }

    // ---- Registration ----
    if (!registered) {
      if (msg.type !== 'register') {
        ws.close(4003, 'Must register first');
        return;
      }
      if (AUTH_TOKEN && msg.token !== AUTH_TOKEN) {
        ws.close(4004, 'Unauthorized');
        console.warn('[!] Rejected connection: bad token');
        return;
      }
      clearTimeout(regTimeout);
      registered = true;

      if (msg.name === 'dashboard') {
        isDashboard = true;
        dashboards.add(ws);
        ws.send(JSON.stringify(getStatusPayload()));
        ws.send(JSON.stringify({ type: 'history', messages: messageLog.slice(-50) }));
        console.log('[+] Dashboard connected');
      } else {
        if (!isValidName(msg.name)) {
          ws.close(4005, 'Invalid name: use letters, numbers, - or _ (max 32)');
          return;
        }
        botName = msg.name;
        // Replace stale connection with same name
        if (bots.has(botName)) {
          const old = bots.get(botName);
          if (old.ws !== ws && old.ws.readyState === WebSocket.OPEN) {
            old.ws.close(4006, 'Replaced by new connection');
          }
        }
        bots.set(botName, { ws, name: botName, connectedAt: new Date().toISOString() });
        console.log(`[+] Bot "${botName}" connected (${bots.size} online)`);
        broadcastToDashboards(getStatusPayload());
        broadcastToBots({ type: 'peer_online', name: botName }, botName);
      }
      return;
    }

    // ---- Post-registration messages ----
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'message') {
      const from = isDashboard ? 'dashboard' : botName;
      if (!from) return;

      // Validate content exists
      if (msg.content === undefined) return;

      const toTarget = typeof msg.to === 'string' ? msg.to : 'all';
      const envelope = {
        type: 'message',
        from,
        to: toTarget,
        content: msg.content,
        filename: typeof msg.filename === 'string' ? msg.filename : null,
        timestamp: new Date().toISOString()
      };

      const preview = JSON.stringify(String(envelope.content)).slice(0, 80);
      console.log(`[MSG] ${envelope.from} -> ${envelope.to}: ${preview}`);

      messageLog.push(envelope);
      if (messageLog.length > MAX_LOG) messageLog.shift();

      if (envelope.to === 'all') {
        broadcastToBots(envelope, isDashboard ? null : botName);
      } else if (envelope.to !== 'dashboard') {
        const target = bots.get(envelope.to);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify(envelope));
        }
      }
      broadcastToDashboards(envelope);
    }
  });

  ws.on('close', () => {
    clearTimeout(regTimeout);
    if (isDashboard) {
      dashboards.delete(ws);
      console.log('[-] Dashboard disconnected');
    } else if (botName && bots.get(botName)?.ws === ws) {
      bots.delete(botName);
      console.log(`[-] Bot "${botName}" disconnected (${bots.size} remaining)`);
      broadcastToDashboards(getStatusPayload());
      broadcastToBots({ type: 'peer_offline', name: botName });
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS error] (${botName || 'unregistered'}): ${err.message}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw relay server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  if (AUTH_TOKEN) {
    console.log(`Auth enabled. Use: http://localhost:${PORT}/?token=${AUTH_TOKEN}`);
  } else {
    console.log('No auth token set. Set AUTH_TOKEN env var to require authentication.');
  }
});
