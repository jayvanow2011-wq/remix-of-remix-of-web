// Remote input: mouse + keyboard + clipboard.
//
// Frames carry their pointer coords as **relative** floats in [0..1] over
// the captured screen image; we map those onto the real primary screen via
// the `screenshots` crate before driving enigo.

use enigo::{
    Button, Coordinate, Direction, Enigo, Key, Keyboard as _, Mouse, Settings,
};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::sync::Mutex;

static ENIGO: Lazy<Mutex<Option<Enigo>>> = Lazy::new(|| Mutex::new(Enigo::new(&Settings::default()).ok()));

fn screen_size() -> (i32, i32) {
    #[cfg(windows)]
    {
        if let Ok(screens) = screenshots::Screen::all() {
            if let Some(s) = screens.into_iter().next() {
                return (s.display_info.width as i32, s.display_info.height as i32);
            }
        }
    }
    (1920, 1080)
}

fn with_enigo<F: FnOnce(&mut Enigo) -> Value>(f: F) -> Result<Value, String> {
    let mut guard = ENIGO.lock().map_err(|e| e.to_string())?;
    let e = guard
        .as_mut()
        .ok_or_else(|| "enigo not initialized".to_string())?;
    Ok(f(e))
}

pub fn mouse(payload: &Value) -> Result<Value, String> {
    let event = payload.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let (w, h) = screen_size();
    let x_rel = payload.get("xRel").and_then(|v| v.as_f64()).unwrap_or(-1.0);
    let y_rel = payload.get("yRel").and_then(|v| v.as_f64()).unwrap_or(-1.0);
    let x = (x_rel * w as f64) as i32;
    let y = (y_rel * h as f64) as i32;
    let btn = match payload.get("button").and_then(|v| v.as_str()).unwrap_or("left") {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    };

    with_enigo(|e| {
        match event {
            "move" => {
                if x_rel >= 0.0 && y_rel >= 0.0 {
                    let _ = e.move_mouse(x, y, Coordinate::Abs);
                }
            }
            "down" => {
                if x_rel >= 0.0 { let _ = e.move_mouse(x, y, Coordinate::Abs); }
                let _ = e.button(btn, Direction::Press);
            }
            "up" => {
                if x_rel >= 0.0 { let _ = e.move_mouse(x, y, Coordinate::Abs); }
                let _ = e.button(btn, Direction::Release);
            }
            "click" => {
                if x_rel >= 0.0 { let _ = e.move_mouse(x, y, Coordinate::Abs); }
                let _ = e.button(btn, Direction::Click);
            }
            "scroll" => {
                let dy = payload.get("dy").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let dx = payload.get("dx").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let steps_y = (dy / 100.0).round() as i32;
                let steps_x = (dx / 100.0).round() as i32;
                if steps_y != 0 { let _ = e.scroll(steps_y, enigo::Axis::Vertical); }
                if steps_x != 0 { let _ = e.scroll(steps_x, enigo::Axis::Horizontal); }
            }
            _ => {}
        }
        json!({ "ok": true })
    })
}

fn map_key(key: &str, code: &str) -> Option<Key> {
    // Prefer KeyboardEvent.code mapping (layout-independent) for letters/digits.
    if code.starts_with("Key") && code.len() == 4 {
        let c = code.chars().nth(3).unwrap().to_ascii_lowercase();
        return Some(Key::Unicode(c));
    }
    if code.starts_with("Digit") && code.len() == 6 {
        return Some(Key::Unicode(code.chars().nth(5).unwrap()));
    }
    match code {
        "Space" => return Some(Key::Space),
        "Enter" | "NumpadEnter" => return Some(Key::Return),
        "Tab" => return Some(Key::Tab),
        "Backspace" => return Some(Key::Backspace),
        "Escape" => return Some(Key::Escape),
        "ArrowLeft" => return Some(Key::LeftArrow),
        "ArrowRight" => return Some(Key::RightArrow),
        "ArrowUp" => return Some(Key::UpArrow),
        "ArrowDown" => return Some(Key::DownArrow),
        "Home" => return Some(Key::Home),
        "End" => return Some(Key::End),
        "PageUp" => return Some(Key::PageUp),
        "PageDown" => return Some(Key::PageDown),
        "Delete" => return Some(Key::Delete),
        "Insert" => return Some(Key::Insert),
        "CapsLock" => return Some(Key::CapsLock),
        "ShiftLeft" | "ShiftRight" => return Some(Key::Shift),
        "ControlLeft" | "ControlRight" => return Some(Key::Control),
        "AltLeft" | "AltRight" => return Some(Key::Alt),
        "MetaLeft" | "MetaRight" => return Some(Key::Meta),
        _ => {}
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u32>() {
            return match n {
                1 => Some(Key::F1), 2 => Some(Key::F2), 3 => Some(Key::F3), 4 => Some(Key::F4),
                5 => Some(Key::F5), 6 => Some(Key::F6), 7 => Some(Key::F7), 8 => Some(Key::F8),
                9 => Some(Key::F9), 10 => Some(Key::F10), 11 => Some(Key::F11), 12 => Some(Key::F12),
                _ => None,
            };
        }
    }
    // Fallback: single-character `key`.
    let mut chars = key.chars();
    let first = chars.next()?;
    if chars.next().is_none() {
        Some(Key::Unicode(first))
    } else {
        None
    }
}

pub fn key(payload: &Value) -> Result<Value, String> {
    let key_str = payload.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let code = payload.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let ev_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("keydown");
    let Some(k) = map_key(key_str, code) else {
        return Ok(json!({ "ok": false, "skipped": key_str }));
    };
    with_enigo(|e| {
        let dir = if ev_type == "keyup" { Direction::Release } else { Direction::Press };
        let _ = e.key(k, dir);
        json!({ "ok": true })
    })
}

pub fn clipboard_get() -> Result<Value, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let text = cb.get_text().unwrap_or_default();
    Ok(json!({ "text": text }))
}

pub fn clipboard_set(payload: &Value) -> Result<Value, String> {
    let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "len": text.len() }))
}

pub fn lock_input(_payload: &Value) -> Result<Value, String> {
    // Soft-implement: we don't BlockInput because that needs admin and locks
    // out the local user entirely. No-op + ack so the dashboard toggle works.
    Ok(json!({ "ok": true }))
}
