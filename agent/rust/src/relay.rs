// Persistent HidenHost relay client used by the agent for low-latency
// TCP streaming (screen + camera JPEGs) and command dispatch.
//
// On startup, `start(device_id)` spins up a background task that maintains
// a WebSocket connection to the relay. Inbound messages are placed on a
// crossbeam-style std mpsc channel for synchronous consumption from the
// main command-dispatch worker; outbound frames/results are pushed through
// an `UnboundedSender<Signal>` stored in a global OnceLock.

use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use std::sync::mpsc::{self as std_mpsc, Receiver as StdReceiver};
use std::sync::Mutex;
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::mpsc::Sender as TokioSender;

use crate::hiden;
use crate::signaling::Signal;

/// Inbound command envelope routed to the sync worker.
#[derive(Debug)]
pub struct InboundCmd {
    pub event: String,
    pub payload: Value,
}

static RT: OnceCell<Runtime> = OnceCell::new();
static OUT_TX: OnceCell<Mutex<Option<TokioSender<Signal>>>> = OnceCell::new();

fn runtime() -> &'static Runtime {
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("sentinel-relay")
            .enable_all()
            .build()
            .expect("failed to build relay tokio runtime")
    })
}

/// Start the relay client. Returns a blocking receiver of inbound command
/// envelopes. Call once at startup.
pub fn start(device_id: String) -> StdReceiver<InboundCmd> {
    let (sync_tx, sync_rx) = std_mpsc::channel::<InboundCmd>();
    OUT_TX.get_or_init(|| Mutex::new(None));

    runtime().spawn(async move {
        loop {
            match hiden::spawn(device_id.clone()).await {
                Ok((out_tx, mut in_rx)) => {
                    if let Some(slot) = OUT_TX.get() {
                        *slot.lock().unwrap() = Some(out_tx);
                    }
                    eprintln!("[relay] connected as agent for {}", device_id);

                    while let Some(sig) = in_rx.recv().await {
                        let _ = sync_tx.send(InboundCmd {
                            event: sig.event,
                            payload: sig.payload,
                        });
                    }

                    eprintln!("[relay] disconnected — will reconnect");
                    if let Some(slot) = OUT_TX.get() {
                        *slot.lock().unwrap() = None;
                    }
                }
                Err(e) => {
                    eprintln!("[relay] connect error: {} — retry in 5s", e);
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    sync_rx
}

/// Is the relay connected right now?
pub fn connected() -> bool {
    OUT_TX
        .get()
        .and_then(|m| m.lock().ok().map(|g| g.is_some()))
        .unwrap_or(false)
}

/// Send a JSON frame to all viewers. No-op if the relay is currently
/// disconnected; the next frame/result will go through after reconnect.
pub fn send(event: &str, payload: Value) {
    let Some(slot) = OUT_TX.get() else { return };
    let Ok(guard) = slot.lock() else { return };
    if let Some(tx) = guard.as_ref() {
        // Non-blocking — drop the frame on backpressure rather than stalling
        // the capture loop or growing memory.
        let _ = tx.try_send(Signal {
            event: event.to_string(),
            payload,
        });
    }
}

/// Convenience helpers for the streaming threads.
pub fn send_screen_frame(jpeg_b64: &str) {
    send("frame", json!({ "jpeg_b64": jpeg_b64, "ts": now_ms() }));
}
pub fn send_camera_frame(jpeg_b64: &str) {
    send("camera-frame", json!({ "camera_b64": jpeg_b64, "ts": now_ms() }));
}

pub fn send_result(id: &str, ok: bool, result: Value, error: Option<String>) {
    send(
        "result",
        json!({ "id": id, "ok": ok, "result": result, "error": error }),
    );
}

fn now_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
