# Python WebSocket Relay

Drop-in replacement for `hidenhost/server.js` — same protocol, Python runtime.

## Setup

```bash
pip install -r requirements.txt
cp .env .env.local   # edit values
python server.py
```

## Ports

- **WS relay**: `PORT` (default 24609)
- **HTTP health/stats**: `PORT + 1` (default 24610)

## Endpoints

- `GET /` — status JSON
- `GET /health` — `{"ok": true}`
- `GET /stats` — connected agents/viewers

## Protocol

Same as Node relay:
- Connect via `ws://host:port?role=agent&device=DEVICE_ID&key=AUTH_KEY`
- Or send `{"type":"hello","role":"agent","deviceId":"..."}`
- Binary frames forwarded as-is (JPEG screen data)
- JSON frames routed agent↔viewers by deviceId
