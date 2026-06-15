// Supabase Realtime (phoenix) signaling client for WebRTC offer/answer/ICE.
//
// The browser viewer uses `supabase.channel('webrtc:{device}', { config: {
// broadcast: { self: false, ack: false } } })` and exchanges three broadcast
// events: "offer" (agent -> viewer), "answer" (viewer -> agent), "ice"
// (both directions, with `from: "agent" | "viewer"` to deduplicate).
//
// Phoenix wire format we send / receive (Realtime v1):
//   join:       {"topic":"realtime:webrtc:DEV","event":"phx_join",
//                "payload":{"config":{"broadcast":{"self":false,"ack":false},
//                "presence":{"key":""}}},
//                "ref":"1","join_ref":"1"}
//   broadcast:  {"topic":"realtime:webrtc:DEV","event":"broadcast",
//                "payload":{"type":"broadcast","event":"offer",
//                "payload":{...app payload...}},
//                "ref":"N","join_ref":"1"}
//   heartbeat:  {"topic":"phoenix","event":"heartbeat","payload":{},"ref":"H"}
//
// Incoming broadcasts arrive as:
//   {"topic":"realtime:webrtc:DEV","event":"broadcast",
//    "payload":{"event":"answer","payload":{...},"type":"broadcast"},
//    "ref":null}

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
    pub event: String, // "answer" | "ice"
    pub payload: Value,
}

/// Spawn a phoenix signaling task for `realtime:webrtc:{device_id}`.
///
/// Returns:
///   * `Sender<Signal>`: app pushes outgoing signals (offer / ice) here.
///   * `Receiver<Signal>`: app reads incoming signals (answer / ice) here.
///
/// The task ends when the sender is dropped or the websocket fails.
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

    // Join the channel.
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

    // Writer task: outgoing broadcasts + heartbeat.
    let topic_w = topic.clone();
    tokio::spawn(async move {
        let mut ref_id: u64 = 2;
        let mut hb = time::interval(Duration::from_secs(25));
        hb.tick().await; // skip first immediate tick
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

    // Reader task: route incoming broadcasts to the app.
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
            // We only care about answers/ICE *from the viewer*.
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

