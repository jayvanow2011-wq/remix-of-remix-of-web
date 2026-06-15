// ─────────────────────────────────────────────────────────────────────────────
// HidenHost WebSocket relay  —  PURE forwarder, no database.
//
//   Internet (TLS)
//        │
//        ▼
//   https://veltrix.hidenfree.com    (Caddy / Nginx reverse proxy)
//        │   wss:// upgrade
//        ▼
//   vicky.hidencloud.com:24609       (this Node process)
//        │
//        ▼
//   Rust agents  ←→  Lovable frontend
//
// The relay only routes JSON frames between an `agent` socket and N
// `viewer` sockets sharing the same `deviceId`. All database/auth state
// (devices.is_online, sessions, etc.) is owned by the Lovable frontend
// — viewers update Supabase directly with the user's session, agents
// hit the existing `/api/public/agent/*` endpoints. This box never
// holds a service-role key.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '24609', 10);
const AUTH_KEY = process.env.HIDEN_AUTH_KEY || '';
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || '25000', 10);
const DEAD_TIMEOUT_MS = parseInt(process.env.DEAD_TIMEOUT_MS || '60000', 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ── HTTP side (health + stats only) ─────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS,
    credentials: false,
  })
);

const startedAt = Date.now();

app.get('/', (_req, res) => {
  res.json({
    name: 'hidenhost-ws',
    ok: true,
    publicUrl: process.env.PUBLIC_WS_URL || `ws://${HOST}:${PORT}`,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    agents: agents.size,
    viewers: viewers.size,
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/stats', (_req, res) => {
  res.json({
    agents: [...agents.keys()],
    viewers: [...viewers.entries()].map(([dev, set]) => ({
      deviceId: dev,
      count: set.size,
    })),
  });
});

const server = http.createServer(app);

// ── WebSocket side ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

/** deviceId -> ws  (one agent per device) */
const agents = new Map();
/** deviceId -> Set<ws>  (many viewers per device) */
const viewers = new Map();

function checkKey(provided) {
  if (!AUTH_KEY) return true; // unset = open relay (dev only)
  return provided === AUTH_KEY;
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = req.headers['x-hiden-key'] || url.searchParams.get('key');
  if (!checkKey(key)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws._url = url;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  ws.id = randomUUID();
  ws.role = null;          // "agent" | "viewer"
  ws.deviceId = null;
  ws.isAlive = true;
  ws.connectedAt = Date.now();

  // Allow identifying via query string too:  ?role=agent&device=abc
  const qRole = ws._url?.searchParams.get('role');
  const qDevice = ws._url?.searchParams.get('device');
  if (qRole && qDevice) attach(ws, qRole, qDevice);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return safeSend(ws, { type: 'error', error: 'invalid json' }); }

    // Identify handshake
    if (msg.type === 'hello') {
      attach(ws, msg.role, msg.deviceId);
      safeSend(ws, { type: 'welcome', id: ws.id, role: ws.role, deviceId: ws.deviceId });
      return;
    }

    if (!ws.role || !ws.deviceId) {
      return safeSend(ws, { type: 'error', error: 'not identified — send {type:"hello",role,deviceId}' });
    }

    // Application-level routing.
    // Expected envelope: { type, payload, to? }
    //   "offer" / "answer" / "ice" / "cmd" / "result" / "frame" / etc.
    if (ws.role === 'viewer') {
      const target = agents.get(ws.deviceId);
      if (target && target.readyState === ws.OPEN) {
        safeSend(target, { ...msg, from: 'viewer', viewerId: ws.id });
      } else {
        safeSend(ws, { type: 'error', error: 'agent offline' });
      }
    } else if (ws.role === 'agent') {
      const set = viewers.get(ws.deviceId);
      if (set) {
        for (const v of set) {
          if (v.readyState === ws.OPEN) {
            if (msg.to && msg.to !== v.id) continue;
            safeSend(v, { ...msg, from: 'agent' });
          }
        }
      }
    }
  });

  ws.on('close', () => detach(ws));
  ws.on('error', () => detach(ws));
});

function attach(ws, role, deviceId) {
  if (!deviceId || !['agent', 'viewer'].includes(role)) return;
  ws.role = role;
  ws.deviceId = deviceId;
  if (role === 'agent') {
    const prev = agents.get(deviceId);
    if (prev && prev !== ws) try { prev.close(4000, 'replaced'); } catch (_) {}
    agents.set(deviceId, ws);
    broadcastToViewers(deviceId, { type: 'agent-online', deviceId });
  } else {
    if (!viewers.has(deviceId)) viewers.set(deviceId, new Set());
    viewers.get(deviceId).add(ws);
    const a = agents.get(deviceId);
    if (a && a.readyState === ws.OPEN) {
      safeSend(a, { type: 'viewer-joined', deviceId, viewerId: ws.id });
    }
  }
  console.log(`[+] ${role} ${deviceId} (${ws.id.slice(0, 8)})`);
}

function detach(ws) {
  if (!ws.deviceId) return;
  if (ws.role === 'agent' && agents.get(ws.deviceId) === ws) {
    agents.delete(ws.deviceId);
    broadcastToViewers(ws.deviceId, { type: 'agent-offline', deviceId: ws.deviceId });
  } else if (ws.role === 'viewer') {
    const set = viewers.get(ws.deviceId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) viewers.delete(ws.deviceId);
      const a = agents.get(ws.deviceId);
      if (a && a.readyState === ws.OPEN) {
        safeSend(a, { type: 'viewer-left', deviceId: ws.deviceId, viewerId: ws.id });
      }
    }
  }
  console.log(`[-] ${ws.role} ${ws.deviceId} (${ws.id.slice(0, 8)})`);
}

function broadcastToViewers(deviceId, msg) {
  const set = viewers.get(deviceId);
  if (!set) return;
  for (const v of set) if (v.readyState === v.OPEN) safeSend(v, msg);
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

// Liveness pings — drop dead sockets
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, PING_INTERVAL_MS);

// ── Boot ────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`╔═══════════════════════════════════════════════╗`);
  console.log(`║  HidenHost WS relay (pure forwarder)`);
  console.log(`║  Listening   ${HOST}:${PORT}`);
  console.log(`║  Public WS   ${process.env.PUBLIC_WS_URL || `ws://${HOST}:${PORT}`}`);
  console.log(`║  Public HTTP ${process.env.PUBLIC_HTTP_URL || `http://${HOST}:${PORT}`}`);
  console.log(`║  Auth        ${AUTH_KEY ? 'ENABLED' : 'DISABLED (dev)'}`);
  console.log(`║  DB          none — frontend owns Supabase`);
  console.log(`╚═══════════════════════════════════════════════╝`);
  void DEAD_TIMEOUT_MS; // reserved for future grace-window logic
});

process.on('SIGINT', () => { console.log('\nshutting down…'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { console.log('\nshutting down…'); server.close(() => process.exit(0)); });
