# HidenHost — WebSocket relay

```
Internet
   │
   ▼
https://veltrix.hidenfree.com     ← Caddy / Nginx (TLS termination + reverse proxy)
   │   wss:// upgrade
   ▼
vicky.hidencloud.com:24609         ← Node.js (ws + express)
   │
   ├── Rust agents (role=agent, deviceId=<id>)
   └── Lovable frontend tabs (role=viewer, deviceId=<id>)
```

The relay routes JSON messages between **one agent** and **N viewers** per
`deviceId`. Drop-in replacement for the Supabase Realtime signaling channel
used by `agent/rust/src/signaling.rs` — same message shapes.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Node WS + HTTP server. Listens on `$PORT` (24609). |
| `.env.example` | Copy to `.env`, fill in `HIDEN_AUTH_KEY`. |
| `package.json` | Deps: `ws`, `express`, `cors`, `dotenv`, `@supabase/supabase-js`. |
| `Caddyfile` | Caddy reverse proxy (auto-TLS). |
| `nginx.conf` | Nginx reverse proxy + Let's Encrypt. |
| `hidenhost.service` | systemd unit. |
| `client-example.js` | How a viewer/agent connects. |

## Quick start (on `vicky.hidencloud.com`)

```bash
git clone <this folder> /opt/hidenhost
cd /opt/hidenhost
cp .env.example .env && nano .env        # set HIDEN_AUTH_KEY
npm install --omit=dev
node server.js                            # foreground test
# or as a service:
sudo cp hidenhost.service /etc/systemd/system/
sudo systemctl enable --now hidenhost
sudo journalctl -fu hidenhost
```

## Reverse proxy (on the box that owns `veltrix.hidenfree.com`)

### Caddy (easiest, auto-HTTPS)

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Nginx

```bash
sudo cp nginx.conf /etc/nginx/sites-available/veltrix
sudo ln -s /etc/nginx/sites-available/veltrix /etc/nginx/sites-enabled/
sudo certbot --nginx -d veltrix.hidenfree.com
sudo systemctl reload nginx
```

## Protocol

All messages are JSON.

1. **Connect:** `wss://veltrix.hidenfree.com/?key=$HIDEN_AUTH_KEY`
   (or send the key in the `x-hiden-key` header).
2. **Identify:**
   ```json
   { "type": "hello", "role": "agent" | "viewer", "deviceId": "abc-123" }
   ```
   Server replies: `{"type":"welcome","id":"<socketId>",...}`
3. **Route:** any subsequent message from a `viewer` is forwarded to the
   matching `agent` socket and vice-versa. The server adds `from:"agent"`
   / `from:"viewer"` and (for agent→viewer) supports an optional `to:<viewerId>`
   field to target one viewer.

### Reserved server-pushed events
| `type` | Meaning |
|--------|---------|
| `welcome` | Handshake ack. |
| `agent-online` / `agent-offline` | Pushed to viewers. |
| `viewer-joined` / `viewer-left` | Pushed to the agent. |
| `error` | `{ type:"error", error:"..."}` |

### HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/`          | Status + counts. |
| `GET`  | `/health`    | `{ok:true}` — for uptime monitors. |
| `GET`  | `/stats`     | Connected agents / viewers per device. |
| `POST` | `/register`  | Optional agent self-registration (`x-hiden-key` header). |

## Wiring the Rust agent

In `agent/rust/src/binding.rs` add:

```rust
pub const HIDEN_WS_URL:  &str = "wss://veltrix.hidenfree.com";
pub const HIDEN_AUTH_KEY: &str = "…";
```

…then point `signaling.rs` at `HIDEN_WS_URL` instead of Supabase Realtime
(the message envelopes already match: `hello` → `offer`/`answer`/`ice`).

## Wiring the Lovable frontend

```ts
const ws = new WebSocket(`wss://veltrix.hidenfree.com/?key=${KEY}`);
ws.onopen = () =>
  ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId }));
ws.onmessage = e => handle(JSON.parse(e.data));
```
