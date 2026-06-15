import { useEffect, useState } from "react";
import { useRelaySocket } from "@/lib/relay";
import { useDeviceCommands } from "@/hooks/use-device-commands";
import { supabase } from "@/integrations/supabase/client";
import { Play, Square, Camera as CamIcon, WifiOff, Wifi, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";

const QUALITIES = [40, 60, 75, 90] as const;

export function CameraPanel({ deviceId }: { deviceId: string }) {
  const { send } = useDeviceCommands(deviceId);
  const { connected: relayConnected, send: relaySend, onMessage } = useRelaySocket(deviceId);
  const [streaming, setStreaming] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [transport, setTransport] = useState<"idle" | "relay" | "http">("idle");
  const [quality, setQuality] = useState<number>(65);

  // Relay frames
  useEffect(() => {
    const unsub = onMessage((msg) => {
      if ((msg.type === "camera-frame" || msg.type === "frame") && msg.payload?.camera_b64) {
        setFrame(msg.payload.camera_b64);
        setUpdatedAt(new Date().toISOString());
        setFrameCount((c) => c + 1);
        if (streaming) setTransport("relay");
      }
    });
    return unsub;
  }, [onMessage, streaming]);

  // Realtime broadcast — agent pushes JPEG frames to a low-latency
  // ephemeral channel. Postgres replication can't handle multi-MB frames
  // per second; broadcast can.
  useEffect(() => {
    const topic = `device-frames-${deviceId}`;
    const ch = supabase
      .channel(topic, { config: { broadcast: { ack: false, self: false } } })
      .on("broadcast", { event: "camera" }, (msg: any) => {
        const b64: string | undefined = msg?.payload?.jpeg_b64;
        if (!b64) return;
        setFrame(b64);
        setUpdatedAt(msg.payload?.ts ?? new Date().toISOString());
        setFrameCount((c) => c + 1);
        if (streaming && transport !== "relay") setTransport("http");
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [deviceId, streaming, transport]);

  useEffect(() => {
    const t = setInterval(() => { setFps(frameCount); setFrameCount(0); }, 1000);
    return () => clearInterval(t);
  }, [frameCount]);

  // Start/stop streaming → tell agent via HTTP command queue + relay
  useEffect(() => {
    if (!streaming) {
      setTransport("idle");
      relaySend({ type: "cmd", payload: { action: "camera.stream.stop" } });
      send("camera.stream.stop", {}, 5000).catch(() => {});
      return;
    }
    setTransport("relay");
    relaySend({ type: "cmd", payload: { action: "camera.stream.start", quality } });
    send("camera.stream.start", { quality }, 8000).catch((e) => {
      toast.error(e?.message ?? "Failed to start camera");
    });

    // HTTP fallback poll if relay isn't delivering frames after 4s
    let cancelled = false;
    const httpLoop = async () => {
      while (!cancelled && streaming) {
        if (transport !== "relay") {
          try {
            await send("camera.capture", { quality }, 15000);
          } catch { /* swallow */ }
          await new Promise((r) => setTimeout(r, 1200));
        } else {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    };
    const flipTimer = setTimeout(() => {
      if (!cancelled && frameCount === 0) setTransport("http");
    }, 4000);
    httpLoop();

    return () => {
      cancelled = true;
      clearTimeout(flipTimer);
      relaySend({ type: "cmd", payload: { action: "camera.stream.stop" } });
      send("camera.stream.stop", {}, 5000).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, quality]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          {!streaming ? (
            <button
              onClick={() => setStreaming(true)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Play className="h-4 w-4" /> Start camera
            </button>
          ) : (
            <button
              onClick={() => setStreaming(false)}
              className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
            >
              <Square className="h-4 w-4" /> Stop
            </button>
          )}
          <select
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
          >
            {QUALITIES.map((q) => <option key={q} value={q}>Q {q}</option>)}
          </select>
          <button
            onClick={() => {
              relaySend({ type: "cmd", payload: { action: "camera.capture", quality } });
              send("camera.capture", { quality }, 15000).catch((e) => toast.error(e.message));
            }}
            className="inline-flex items-center gap-2 rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-accent"
          >
            <CamIcon className="h-4 w-4" /> Snapshot
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {streaming && (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                LIVE · {fps} fps
              </span>
              <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                transport === "relay"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              }`}>
                {transport === "relay" ? <Wifi className="h-3 w-3" /> : <ImageIcon className="h-3 w-3" />}
                {transport === "relay" ? "TCP" : "HTTP"}
              </span>
            </>
          )}
          <span className={`inline-flex items-center gap-1 text-[10px] ${relayConnected ? "text-emerald-400" : "text-muted-foreground"}`}>
            <span className={`h-1 w-1 rounded-full ${relayConnected ? "bg-emerald-400" : "bg-muted-foreground"}`} />
            Relay {relayConnected ? "ON" : "OFF"}
          </span>
          {!relayConnected && !streaming && (
            <span className="inline-flex items-center gap-1 text-amber-400"><WifiOff className="h-3 w-3" /></span>
          )}
          {updatedAt && <span>updated {new Date(updatedAt).toLocaleTimeString()}</span>}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-black/40">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt="Remote camera"
            className="block w-full"
          />
        ) : (
          <div className="flex h-[420px] items-center justify-center text-sm text-muted-foreground">
            No camera frame yet — click "Start camera" or "Snapshot". (Requires ffmpeg.exe in PATH on the agent.)
          </div>
        )}
      </div>
    </div>
  );
}
