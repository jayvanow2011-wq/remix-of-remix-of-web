// Real WebRTC live-stream module.
//
// Pipeline (Windows only — only platform with screen capture wired up):
//   1. Open Supabase Realtime channel  `realtime:webrtc:{device_id}`
//      via `signaling::spawn` (phoenix WS).
//   2. Build an `RTCPeerConnection` with the ICE servers the browser sent
//      (TURN-relay only on the viewer side, but we let the agent gather any
//      candidate type — TURN will be used when no direct path is reachable).
//   3. Add a `TrackLocalStaticSample` (H.264 baseline) and create an offer.
//      Send the offer over the signaling channel; await `answer`; trickle
//      ICE in both directions.
//   4. Capture screen at ~20 fps with the `screenshots` crate, convert
//      RGBA→I420, encode with openh264, push each access unit to the
//      sample track. Keyframes every 2s by setting `idr_period`.
//
// Non-Windows builds skip capture entirely — the session task just keeps the
// peer alive so the browser can still negotiate (and immediately fall back
// to JPEG when no frames arrive).

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{runtime::Runtime, sync::oneshot, task::JoinHandle};
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
        media_engine::MIME_TYPE_H264, APIBuilder,
    },
    ice_transport::{
        ice_candidate::RTCIceCandidateInit, ice_connection_state::RTCIceConnectionState,
        ice_server::RTCIceServer,
    },
    interceptor::registry::Registry,
    media::Sample,
    peer_connection::{
        configuration::RTCConfiguration,
        sdp::session_description::RTCSessionDescription,
    },
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
};

use crate::signaling::{self, Signal};

fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("sentinel-webrtc")
            .enable_all()
            .build()
            .expect("failed to build webrtc tokio runtime")
    })
}

struct Session {
    cancel: Option<oneshot::Sender<()>>,
    _task: JoinHandle<()>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn start_session(
    device_id: &str,
    _device_token: &str,
    session_id: &str,
    ice_servers: &Value,
) -> Result<(), String> {
    let mut map = sessions().lock().map_err(|e| e.to_string())?;
    if map.contains_key(session_id) {
        return Ok(());
    }

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let dev = device_id.to_string();
    let sid = session_id.to_string();
    let ice = parse_ice_servers(ice_servers);

    let task = runtime().spawn(async move {
        match run_session(dev.clone(), sid.clone(), ice, cancel_rx).await {
            Ok(_) => eprintln!("[webrtc] session {} ended cleanly", sid),
            Err(e) => eprintln!("[webrtc] session {} error: {:#}", sid, e),
        }
    });

    map.insert(
        session_id.to_string(),
        Session {
            cancel: Some(cancel_tx),
            _task: task,
        },
    );
    Ok(())
}

pub fn stop_session(session_id: &str) {
    if let Ok(mut map) = sessions().lock() {
        if let Some(mut s) = map.remove(session_id) {
            if let Some(tx) = s.cancel.take() {
                let _ = tx.send(());
            }
        }
    }
}

fn parse_ice_servers(v: &Value) -> Vec<RTCIceServer> {
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for s in arr {
            let urls: Vec<String> = match s.get("urls") {
                Some(Value::String(u)) => vec![u.clone()],
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect(),
                _ => continue,
            };
            out.push(RTCIceServer {
                urls,
                username: s
                    .get("username")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                credential: s
                    .get("credential")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                ..Default::default()
            });
        }
    }
    if out.is_empty() {
        out.push(RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        });
    }
    out
}

async fn run_session(
    device_id: String,
    session_id: String,
    ice_servers: Vec<RTCIceServer>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<()> {
    // ---- signaling ----
    let (sig_tx, mut sig_rx) = signaling::spawn(device_id.clone()).await?;
    // Wait briefly to let the channel actually join before sending the offer.
    tokio::time::sleep(Duration::from_millis(400)).await;

    // ---- peer connection ----
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media)?;
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();

    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };
    let peer = Arc::new(api.new_peer_connection(config).await?);

    // H.264 video track.
    let track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90000,
            ..Default::default()
        },
        "video".to_owned(),
        "sentinel".to_owned(),
    ));
    let _rtp_sender = peer
        .add_track(Arc::clone(&track) as Arc<dyn webrtc::track::track_local::TrackLocal + Send + Sync>)
        .await?;

    // Trickle local ICE candidates to the viewer.
    let sig_tx_ice = sig_tx.clone();
    let session_for_ice = session_id.clone();
    peer.on_ice_candidate(Box::new(move |c| {
        let tx = sig_tx_ice.clone();
        let sid = session_for_ice.clone();
        Box::pin(async move {
            if let Some(c) = c {
                if let Ok(init) = c.to_json() {
                    let _ = tx
                        .send(Signal {
                            event: "ice".to_string(),
                            payload: json!({
                                "from": "agent",
                                "session": sid,
                                "candidate": serde_json::to_value(init).unwrap_or(Value::Null),
                            }),
                        })
                        .await;
                }
            }
        })
    }));

    peer.on_ice_connection_state_change(Box::new(|state: RTCIceConnectionState| {
        eprintln!("[webrtc] ice state: {}", state);
        Box::pin(async {})
    }));

    // Create offer and send it.
    let offer = peer.create_offer(None).await?;
    peer.set_local_description(offer.clone()).await?;
    sig_tx
        .send(Signal {
            event: "offer".to_string(),
            payload: json!({
                "from": "agent",
                "session": session_id,
                "sdp": offer.sdp,
            }),
        })
        .await
        .map_err(|_| anyhow!("signaling send failed"))?;

    // ---- capture+encode loop (Windows only) ----
    #[cfg(windows)]
    let capture_handle = {
        let track = Arc::clone(&track);
        Some(tokio::task::spawn_blocking(move || capture_loop(track)))
    };
    #[cfg(not(windows))]
    let capture_handle: Option<tokio::task::JoinHandle<()>> = None;

    // ---- main event loop: signals + cancel ----
    loop {
        tokio::select! {
            _ = &mut cancel_rx => break,
            sig = sig_rx.recv() => {
                let Some(sig) = sig else { break };
                match sig.event.as_str() {
                    "answer" => {
                        if let Some(sdp) = sig.payload.get("sdp").and_then(|s| s.as_str()) {
                            let answer = RTCSessionDescription::answer(sdp.to_string())?;
                            if let Err(e) = peer.set_remote_description(answer).await {
                                eprintln!("[webrtc] set_remote_description failed: {}", e);
                            }
                        }
                    }
                    "ice" => {
                        if sig.payload.get("from").and_then(|f| f.as_str()) == Some("agent") {
                            continue; // our own echo (shouldn't happen with self:false but be safe)
                        }
                        if let Some(cand) = sig.payload.get("candidate") {
                            if let Ok(init) =
                                serde_json::from_value::<RTCIceCandidateInit>(cand.clone())
                            {
                                if let Err(e) = peer.add_ice_candidate(init).await {
                                    eprintln!("[webrtc] add_ice_candidate failed: {}", e);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = peer.close().await;
    #[cfg(windows)]
    if let Some(h) = capture_handle {
        h.abort();
    }
    let _ = capture_handle; // silence unused warning on non-windows
    Ok(())
}

#[cfg(windows)]
fn capture_loop(track: Arc<TrackLocalStaticSample>) {
    use openh264::{
        encoder::{Encoder, EncoderConfig},
        formats::YUVBuffer,
    };
    use screenshots::Screen;
    use std::time::Instant;

    let screen = match Screen::all().ok().and_then(|s| s.into_iter().next()) {
        Some(s) => s,
        None => {
            eprintln!("[webrtc] capture: no screens found");
            return;
        }
    };

    // Cap dimensions to keep encoder fast over TURN.
    const TARGET_W: u32 = 1280;
    let info = screen.display_info;
    let scale = (TARGET_W as f32 / info.width as f32).min(1.0);
    let w = ((info.width as f32 * scale) as u32) & !1;
    let h = ((info.height as f32 * scale) as u32) & !1;

    let cfg = EncoderConfig::new(w, h)
        .max_frame_rate(20.0)
        .set_bitrate_bps(2_000_000);
    let mut encoder = match Encoder::with_config(cfg) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[webrtc] openh264 init failed: {}", e);
            return;
        }
    };

    let mut yuv = YUVBuffer::new(w as usize, h as usize);
    let target_dt = Duration::from_millis(50); // ~20 fps
    let mut last = Instant::now();

    loop {
        let elapsed = last.elapsed();
        if elapsed < target_dt {
            std::thread::sleep(target_dt - elapsed);
        }
        let frame_dt = last.elapsed();
        last = Instant::now();

        let image = match screen.capture() {
            Ok(img) => img,
            Err(_) => continue,
        };
        let rgba = image.rgba();
        // Resize via nearest-neighbour into a packed RGB (drop alpha).
        let src_w = info.width as usize;
        let src_h = info.height as usize;
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for y in 0..h as usize {
            let sy = y * src_h / h as usize;
            for x in 0..w as usize {
                let sx = x * src_w / w as usize;
                let si = (sy * src_w + sx) * 4;
                let di = (y * w as usize + x) * 3;
                rgb[di] = rgba[si];
                rgb[di + 1] = rgba[si + 1];
                rgb[di + 2] = rgba[si + 2];
            }
        }
        yuv.read_rgb(&rgb);

        let bitstream = match encoder.encode(&yuv) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[webrtc] encode error: {}", e);
                continue;
            }
        };
        let nal = bitstream.to_vec();
        if nal.is_empty() {
            continue;
        }

        let sample = Sample {
            data: nal.into(),
            duration: frame_dt,
            ..Default::default()
        };

        // Push the sample. `write_sample` is async; block_in_place isn't
        // available outside a runtime, so use a tiny per-frame mini-runtime.
        if let Err(e) = futures_executor_block_on(track.write_sample(&sample)) {
            eprintln!("[webrtc] write_sample error: {}", e);
        }
    }
}

#[cfg(windows)]
fn futures_executor_block_on<F: std::future::Future>(f: F) -> F::Output {
    // Avoid pulling in futures-executor; spin up a single-threaded
    // current-thread runtime for the in-flight future.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("nested runtime")
        .block_on(f)
}
