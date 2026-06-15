import { useCallback, useEffect, useRef, useState } from "react";
import { useRelaySocket } from "@/lib/relay";
import { useDeviceCommands } from "@/hooks/use-device-commands";
import { supabase } from "@/integrations/supabase/client";
import {
  Play, Square, Maximize2, WifiOff, MousePointer2, Keyboard,
  Pencil, Eraser, Clipboard, ClipboardPaste, Lock, Unlock,
  Wifi, Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";

type Stroke = { points: { xRel: number; yRel: number }[]; color: string; width: number };

// Fixed sensible defaults — no user-facing quality/fps controls.
const STREAM_QUALITY = 60;
const STREAM_FPS = 30;
const MOUSE_MOVE_MIN_MS = 16; // ~60 Hz cap on input.mouse move spam

export function ScreenPanel({ deviceId }: { deviceId: string }) {
  const { send } = useDeviceCommands(deviceId);
  const { connected: relayConnected, send: relaySend, onMessage } = useRelaySocket(deviceId);
  const [streaming, setStreaming] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [transport, setTransport] = useState<"idle" | "relay" | "http">("idle");
  const [mouseControl, setMouseControl] = useState(false);
  const [keyboardControl, setKeyboardControl] = useState(false);
  const [inputLocked, setInputLocked] = useState(false);

  const [drawMode, setDrawMode] = useState(false);
  const [drawColor, setDrawColor] = useState("#22d3ee");
  const [drawWidth, setDrawWidth] = useState(3);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);

  const [clip, setClip] = useState("");

  const imgRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const lastMoveTsRef = useRef(0);
  const mouseDownRef = useRef(false);

  // Refs so listeners always see current state without re-subscribing.
  const transportRef = useRef(transport);
  useEffect(() => { transportRef.current = transport; }, [transport]);

  // --- Realtime frames over the always-on WS relay ---
  // Subscribe ONCE — re-subscribing on `streaming` churn drops frames.
  useEffect(() => {
    let firstLogged = false;
    const unsub = onMessage((msg) => {
      // Agent → relay envelope: { type, payload, from: "agent" }
      if (msg.type !== "frame" && msg.type !== "screen-frame") return;
      const b64 = msg.payload?.jpeg_b64;
      if (!b64) return;
      if (!firstLogged) {
        firstLogged = true;
        // eslint-disable-next-line no-console
        console.log("[screen] first WS frame received", { bytes: b64.length });
      }
      setFrame(b64);
      setUpdatedAt(
        typeof msg.payload?.ts === "number"
          ? new Date(msg.payload.ts).toISOString()
          : new Date().toISOString(),
      );
      setFrameCount((c) => c + 1);
      if (transportRef.current !== "relay") setTransport("relay");
    });
    return unsub;
  }, [onMessage]);

  // --- Fallback: Supabase Realtime broadcast (used only when WS relay isn't delivering). ---
  useEffect(() => {
    const topic = `device-frames-${deviceId}`;
    const ch = supabase
      .channel(topic, { config: { broadcast: { ack: false, self: false } } })
      .on("broadcast", { event: "screen" }, (msg: any) => {
        const b64: string | undefined = msg?.payload?.jpeg_b64;
        if (!b64) return;
        setFrame(b64);
        setUpdatedAt(msg.payload?.ts ?? new Date().toISOString());
        setFrameCount((c) => c + 1);
        if (transportRef.current !== "relay") setTransport("http");
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [deviceId]);

  // FPS counter — ref-based so it doesn't restart every frame.
  const frameCountRef = useRef(0);
  useEffect(() => { frameCountRef.current = frameCount; }, [frameCount]);
  useEffect(() => {
    const t = setInterval(() => {
      setFps(frameCountRef.current);
      setFrameCount(0);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // --- Start/stop streaming. Use HTTP command queue (agent polls it) AND relay. ---
  useEffect(() => {
    if (!streaming) {
      setTransport("idle");
      relaySend({ type: "cmd", payload: { action: "screen.stream.stop" } });
      send("screen.stream.stop", {}, 5000).catch(() => {});
      return;
    }
    setTransport("relay");
    relaySend({
      type: "cmd",
      payload: { action: "screen.stream.start", quality: STREAM_QUALITY, fps: STREAM_FPS },
    });
    send("screen.stream.start", { quality: STREAM_QUALITY, fps: STREAM_FPS }, 8000).catch((e) => {
      toast.error(e?.message ?? "Failed to start screen stream");
    });
    return () => {
      relaySend({ type: "cmd", payload: { action: "screen.stream.stop" } });
      send("screen.stream.stop", {}, 5000).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // --- Mouse/keyboard input via relay ---
  const remoteCoords = useCallback((evt: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const xRel = (evt.clientX - r.left) / r.width;
    const yRel = (evt.clientY - r.top) / r.height;
    if (xRel < 0 || xRel > 1 || yRel < 0 || yRel > 1) return null;
    return { xRel, yRel };
  }, []);

  const sendMouse = useCallback(
    (event: string, extra: any = {}) => {
      relaySend({ type: "cmd", payload: { action: "input.mouse", event, ...extra } });
    },
    [relaySend],
  );

  const onImgMouseMove = (e: React.MouseEvent) => {
    if (!mouseControl || drawMode) return;
    const c = remoteCoords(e);
    if (c) sendMouse("move", c);
  };
  const onImgMouseDown = (e: React.MouseEvent) => {
    if (!mouseControl || drawMode) return;
    const c = remoteCoords(e);
    if (c) sendMouse("down", { ...c, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
  };
  const onImgMouseUp = (e: React.MouseEvent) => {
    if (!mouseControl || drawMode) return;
    const c = remoteCoords(e);
    if (c) sendMouse("up", { ...c, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
  };
  const onImgWheel = (e: React.WheelEvent) => {
    if (!mouseControl || drawMode) return;
    sendMouse("scroll", { dx: e.deltaX, dy: e.deltaY });
  };
  const onImgContextMenu = (e: React.MouseEvent) => {
    if (mouseControl) e.preventDefault();
  };

  useEffect(() => {
    if (!keyboardControl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" || (e.ctrlKey && ["r", "R", "t", "T", "w", "W"].includes(e.key))) return;
      e.preventDefault();
      relaySend({
        type: "cmd",
        payload: {
          action: "input.key",
          key: e.key, code: e.code, type: e.type,
          ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
        },
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [keyboardControl, relaySend]);

  // --- Drawing ---
  const onDrawDown = (e: React.MouseEvent) => {
    if (!drawMode) return;
    const c = remoteCoords(e);
    if (!c) return;
    drawingRef.current = { points: [c], color: "#22d3ee" };
  };
  const onDrawMove = (e: React.MouseEvent) => {
    if (!drawMode || !drawingRef.current) return;
    const c = remoteCoords(e);
    if (!c) return;
    drawingRef.current.points.push(c);
    setStrokes((s) => {
      const base = s.length && s[s.length - 1] === drawingRef.current ? s.slice(0, -1) : s;
      return [...base, { ...drawingRef.current! }];
    });
  };
  const onDrawUp = () => {
    if (!drawMode || !drawingRef.current) return;
    const stroke = drawingRef.current;
    drawingRef.current = null;
    relaySend({ type: "cmd", payload: { action: "overlay.draw", stroke } });
  };
  const clearDrawing = () => {
    setStrokes([]);
    relaySend({ type: "cmd", payload: { action: "overlay.clear" } });
  };

  // --- Clipboard ---
  const pullClipboard = async () => {
    try {
      const r = await send("clipboard.get", {}, 5000);
      setClip(r.result?.text ?? "");
      toast.success("Pulled remote clipboard");
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    }
  };
  const pushClipboard = async () => {
    try {
      await send("clipboard.set", { text: clip }, 5000);
      toast.success("Pushed to remote clipboard");
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    }
  };

  const toggleLock = async () => {
    const next = !inputLocked;
    try {
      await send("input.lock", { locked: next }, 3000);
      setInputLocked(next);
    } catch (e: any) {
      toast.error(e.message ?? "Lock failed");
    }
  };

  const fullscreen = () => {
    const el = document.getElementById("remote-screen-img");
    if (el && (el as any).requestFullscreen) (el as any).requestFullscreen();
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3 backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-2">
          {!streaming ? (
            <button
              onClick={() => setStreaming(true)}
              disabled={false}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Play className="h-4 w-4" /> Start
            </button>
          ) : (
            <button
              onClick={() => setStreaming(false)}
              className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
            >
              <Square className="h-4 w-4" /> Stop
            </button>
          )}

          <ToolButton active={mouseControl} onClick={() => setMouseControl((v) => !v)} icon={MousePointer2} label="Mouse" />
          <ToolButton active={keyboardControl} onClick={() => setKeyboardControl((v) => !v)} icon={Keyboard} label="Keyboard" />
          <ToolButton active={drawMode} onClick={() => setDrawMode((v) => !v)} icon={Pencil} label="Draw" />
          <button
            onClick={clearDrawing}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1.5 text-xs hover:bg-accent"
          >
            <Eraser className="h-3.5 w-3.5" /> Clear
          </button>
          <ToolButton active={inputLocked} onClick={toggleLock} icon={inputLocked ? Lock : Unlock} label={inputLocked ? "Locked" : "Lock input"} />
          <button onClick={fullscreen} className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1.5 text-xs hover:bg-accent">
            <Maximize2 className="h-3.5 w-3.5" /> Full
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
            {relayConnected
              ? <span className="h-1 w-1 rounded-full bg-emerald-400" />
              : <WifiOff className="h-3 w-3" />}
            Relay {relayConnected ? "ON" : "OFF"}
          </span>
          {updatedAt && <span>updated {new Date(updatedAt).toLocaleTimeString()}</span>}
        </div>
      </div>

      {/* Viewport */}
      <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-black/40">
        {frame ? (
          <div
            ref={overlayRef}
            className="relative select-none"
            onMouseDown={(e) => { onImgMouseDown(e); onDrawDown(e); }}
            onMouseMove={(e) => { onImgMouseMove(e); onDrawMove(e); }}
            onMouseUp={(e) => { onImgMouseUp(e); onDrawUp(); }}
            onWheel={onImgWheel}
            onContextMenu={onImgContextMenu}
          >
            <img
              ref={imgRef}
              id="remote-screen-img"
              src={`data:image/jpeg;base64,${frame}`}
              alt="Remote screen"
              className="block w-full"
              draggable={false}
            />
            {strokes.length > 0 && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                {strokes.map((s, i) => (
                  <polyline
                    key={i}
                    points={s.points.map((p) => `${p.xRel * 100}%,${p.yRel * 100}%`).join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
            )}
          </div>
        ) : (
          <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
            No screen frame yet — click Start to begin streaming.
          </div>
        )}
      </div>

      {/* Clipboard */}
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 p-3 backdrop-blur-xl">
        <textarea
          value={clip}
          onChange={(e) => setClip(e.target.value)}
          rows={1}
          placeholder="Remote clipboard"
          className="flex-1 resize-none rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <button onClick={pullClipboard} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent" title="Pull from remote">
          <Clipboard className="h-3.5 w-3.5" /> Pull
        </button>
        <button onClick={pushClipboard} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent" title="Push to remote">
          <ClipboardPaste className="h-3.5 w-3.5" /> Push
        </button>
      </div>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition ${
        active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border/60 hover:bg-accent"
      }`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}
