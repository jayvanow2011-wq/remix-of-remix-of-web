// HidenHost relay client.
//
// Same `Signal` envelope as `signaling.rs` (Supabase Realtime) so callers can
// swap transports without changing message shapes. Protocol:
//
//   →  { "type":"hello", "role":"agent", "deviceId":"<id>" }
//   ←  { "type":"welcome", ... }
//   ↔  { "type":"offer|answer|ice|cmd|frame|...", "payload": <any>, "from": "viewer"|"agent" }
//
// The relay routes any non-`hello` message between the single agent socket
// and N viewer sockets sharing the same `deviceId`.

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

/// Connect to the HidenHost relay as `role=agent` for `device_id`.
/// Returns `(tx, rx)` matching `signaling::spawn`.
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

    // Handshake — server also accepts query-string identification but the
    // explicit hello makes reconnect logic simpler if we ever proxy through
    // a load balancer that strips the URL.
    let hello = json!({
        "type": "hello",
        "role": "agent",
        "deviceId": device_id,
    });
    write.send(Message::Text(hello.to_string())).await?;

    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Signal>(32);
    let (in_tx, in_rx) = tokio::sync::mpsc::channel::<Signal>(32);

    // Writer: outgoing app frames + 25 s heartbeat ping.
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

    // Reader: route incoming `answer` / `ice` to the app.
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
