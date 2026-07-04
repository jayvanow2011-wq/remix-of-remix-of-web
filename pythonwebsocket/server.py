#!/usr/bin/env python3
"""
HidenHost WebSocket relay — Python edition.
============================================
Drop-in replacement for hidenhost/server.js.

Pure forwarder: agents ←→ viewers, no database.
Requires: pip install websockets aiohttp python-dotenv

Run:
    python server.py
"""

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

try:
    import websockets
    from websockets.server import serve as ws_serve
except ImportError:
    print("ERROR: pip install websockets"); raise SystemExit(1)

try:
    from aiohttp import web
except ImportError:
    print("ERROR: pip install aiohttp"); raise SystemExit(1)

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "24609"))
AUTH_KEY = os.environ.get("HIDEN_AUTH_KEY", "")
PING_INTERVAL = int(os.environ.get("PING_INTERVAL_SEC", "25"))
DEAD_TIMEOUT = int(os.environ.get("DEAD_TIMEOUT_SEC", "60"))
CORS_ORIGINS = [s.strip() for s in os.environ.get("CORS_ORIGINS", "*").split(",") if s.strip()]
PUBLIC_WS_URL = os.environ.get("PUBLIC_WS_URL", f"ws://{HOST}:{PORT}")
PUBLIC_HTTP_URL = os.environ.get("PUBLIC_HTTP_URL", f"http://{HOST}:{PORT}")

started_at = time.time()

# ── State ────────────────────────────────────────────────────────────────────

# device_id -> websocket (one agent per device)
agents: dict[str, websockets.WebSocketServerProtocol] = {}
# device_id -> set of viewer websockets
viewers: dict[str, set[websockets.WebSocketServerProtocol]] = {}
# f"{device_id}|{client_id}" -> websocket (dedup per browser tab)
viewer_by_client: dict[str, websockets.WebSocketServerProtocol] = {}


def ts():
    return time.strftime("%H:%M:%S")


def log(msg):
    print(f"[{ts()}] {msg}", flush=True)


def check_key(provided: str | None) -> bool:
    if not AUTH_KEY:
        return True
    return provided == AUTH_KEY


# ── HTTP health/stats server ────────────────────────────────────────────────

async def handle_root(request):
    return web.json_response({
        "name": "hidenhost-ws-python",
        "ok": True,
        "publicUrl": PUBLIC_WS_URL,
        "uptimeSec": int(time.time() - started_at),
        "agents": len(agents),
        "viewers": sum(len(s) for s in viewers.values()),
    })


async def handle_health(request):
    return web.json_response({"ok": True})


async def handle_stats(request):
    return web.json_response({
        "agents": list(agents.keys()),
        "viewers": [
            {"deviceId": dev, "count": len(s)}
            for dev, s in viewers.items()
        ],
    })


def add_cors_headers(response):
    origin = "*" if "*" in CORS_ORIGINS else ",".join(CORS_ORIGINS)
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Hiden-Key"
    return response


@web.middleware
async def cors_middleware(request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
        return add_cors_headers(resp)
    resp = await handler(request)
    return add_cors_headers(resp)


# ── WebSocket relay ──────────────────────────────────────────────────────────

def safe_send(ws, obj: dict):
    try:
        asyncio.ensure_future(ws.send(json.dumps(obj)))
    except Exception:
        pass


def broadcast_to_viewers(device_id: str, msg: dict):
    s = viewers.get(device_id)
    if not s:
        return
    for v in list(s):
        if v.open:
            safe_send(v, msg)


def attach(ws, role: str, device_id: str, client_id: str | None = None):
    if not device_id or role not in ("agent", "viewer"):
        return
    ws._role = role
    ws._device_id = device_id
    ws._client_id = client_id

    if role == "agent":
        prev = agents.get(device_id)
        if prev and prev is not ws:
            asyncio.ensure_future(prev.close(4000, "replaced"))
        agents[device_id] = ws
        broadcast_to_viewers(device_id, {"type": "agent-online", "deviceId": device_id})
    else:
        if client_id:
            key = f"{device_id}|{client_id}"
            prev = viewer_by_client.get(key)
            if prev and prev is not ws:
                asyncio.ensure_future(prev.close(4000, "replaced-by-newer-client"))
            viewer_by_client[key] = ws
        if device_id not in viewers:
            viewers[device_id] = set()
        viewers[device_id].add(ws)
        a = agents.get(device_id)
        if a and a.open:
            safe_send(a, {"type": "viewer-joined", "deviceId": device_id, "viewerId": ws._ws_id})

    log(f"[+] {role} {device_id} ({ws._ws_id[:8]})")


def detach(ws):
    device_id = getattr(ws, "_device_id", None)
    role = getattr(ws, "_role", None)
    if not device_id:
        return

    if role == "agent" and agents.get(device_id) is ws:
        del agents[device_id]
        broadcast_to_viewers(device_id, {"type": "agent-offline", "deviceId": device_id})
    elif role == "viewer":
        s = viewers.get(device_id)
        if s:
            s.discard(ws)
            if not s:
                del viewers[device_id]
            a = agents.get(device_id)
            if a and a.open:
                safe_send(a, {"type": "viewer-left", "deviceId": device_id, "viewerId": ws._ws_id})
        client_id = getattr(ws, "_client_id", None)
        if client_id:
            key = f"{device_id}|{client_id}"
            if viewer_by_client.get(key) is ws:
                del viewer_by_client[key]

    log(f"[-] {role} {device_id} ({ws._ws_id[:8]})")


async def relay_handler(ws):
    # Parse query params from the path
    parsed = urlparse(ws.request.path if hasattr(ws, 'request') and ws.request else str(ws.path))
    params = parse_qs(parsed.query)

    key = params.get("key", [None])[0]
    if not check_key(key):
        await ws.close(4001, "unauthorized")
        return

    ws._ws_id = str(uuid.uuid4())
    ws._role = None
    ws._device_id = None
    ws._client_id = None

    # Attach from query string
    q_role = params.get("role", [None])[0]
    q_device = params.get("device", [None])[0]
    q_client = params.get("clientId", [None])[0]
    if q_role and q_device:
        attach(ws, q_role, q_device, q_client)

    try:
        async for raw in ws:
            # Binary fast path
            if isinstance(raw, bytes):
                if not ws._role or not ws._device_id:
                    continue
                if ws._role == "agent":
                    s = viewers.get(ws._device_id)
                    if not s:
                        continue
                    for v in list(s):
                        if v.open:
                            try:
                                await v.send(raw)
                            except Exception:
                                pass
                else:
                    target = agents.get(ws._device_id)
                    if target and target.open:
                        try:
                            await target.send(raw)
                        except Exception:
                            pass
                continue

            # JSON path
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                safe_send(ws, {"type": "error", "error": "invalid json"})
                continue

            # Hello handshake
            if msg.get("type") == "hello":
                attach(ws, msg.get("role", ""), msg.get("deviceId", ""), msg.get("clientId"))
                safe_send(ws, {"type": "welcome", "id": ws._ws_id, "role": ws._role, "deviceId": ws._device_id})
                continue

            if not ws._role or not ws._device_id:
                safe_send(ws, {"type": "error", "error": "not identified — send {type:\"hello\",role,deviceId}"})
                continue

            # Route messages
            if ws._role == "viewer":
                target = agents.get(ws._device_id)
                if target and target.open:
                    msg["from"] = "viewer"
                    msg["viewerId"] = ws._ws_id
                    try:
                        await target.send(json.dumps(msg))
                    except Exception:
                        pass
                else:
                    safe_send(ws, {"type": "error", "error": "agent offline"})
            elif ws._role == "agent":
                s = viewers.get(ws._device_id)
                if not s:
                    continue
                msg["from"] = "agent"
                wire = json.dumps(msg)
                target_viewer = msg.get("to")
                for v in list(s):
                    if not v.open:
                        continue
                    if target_viewer and target_viewer != v._ws_id:
                        continue
                    try:
                        await v.send(wire)
                    except Exception:
                        pass
    except websockets.ConnectionClosed:
        pass
    finally:
        detach(ws)


# ── Ping/pong liveness ───────────────────────────────────────────────────────

async def ping_loop(wss):
    while True:
        await asyncio.sleep(PING_INTERVAL)
        for ws_set in [wss]:
            for ws in list(ws_set):
                try:
                    await ws.ping()
                except Exception:
                    pass


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    # HTTP server (health/stats)
    http_app = web.Application(middlewares=[cors_middleware])
    http_app.router.add_get("/", handle_root)
    http_app.router.add_get("/health", handle_health)
    http_app.router.add_get("/stats", handle_stats)

    runner = web.AppRunner(http_app)
    await runner.setup()
    http_port = PORT + 1  # HTTP on PORT+1, WS on PORT
    site = web.TCPSite(runner, HOST, http_port)
    await site.start()

    # WebSocket server
    async with ws_serve(
        relay_handler,
        HOST,
        PORT,
        ping_interval=PING_INTERVAL,
        ping_timeout=DEAD_TIMEOUT,
        max_size=16 * 1024 * 1024,
        compression=None,
    ) as server:
        print(f"╔═══════════════════════════════════════════════╗")
        print(f"║  HidenHost WS relay (Python)")
        print(f"║  WS         {HOST}:{PORT}")
        print(f"║  HTTP       {HOST}:{http_port}")
        print(f"║  Public WS  {PUBLIC_WS_URL}")
        print(f"║  Auth       {'ENABLED' if AUTH_KEY else 'DISABLED (dev)'}")
        print(f"║  DB         none — frontend owns Supabase")
        print(f"╚═══════════════════════════════════════════════╝")

        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye")
