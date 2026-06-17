import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { ArrowLeft, Monitor, Info, Terminal, FileBox, Cpu, Settings, X, Camera, Activity, Sparkles, PartyPopper } from "lucide-react";
import { webrtcDiagnostics, type WebRtcDiagnostics } from "@/lib/webrtc-diagnostics";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Lazy-load all panels — they use browser-only APIs that crash during SSR.
const ScreenPanel = lazy(() => import("@/components/control/ScreenPanel").then(m => ({ default: m.ScreenPanel })));
const CameraPanel = lazy(() => import("@/components/control/CameraPanel").then(m => ({ default: m.CameraPanel })));
const ShellPanel = lazy(() => import("@/components/control/ShellPanel").then(m => ({ default: m.ShellPanel })));
const FilesPanel = lazy(() => import("@/components/control/FilesPanel").then(m => ({ default: m.FilesPanel })));
const ProcessesPanel = lazy(() => import("@/components/control/ProcessesPanel").then(m => ({ default: m.ProcessesPanel })));
const SystemPanel = lazy(() => import("@/components/control/SystemPanel").then(m => ({ default: m.SystemPanel })));
const InfoPanel = lazy(() => import("@/components/control/InfoPanel").then(m => ({ default: m.InfoPanel })));
const AIPanel = lazy(() => import("@/components/control/AIPanel").then(m => ({ default: m.AIPanel })));
const FunPanel = lazy(() => import("@/components/control/FunPanel").then(m => ({ default: m.FunPanel })));

export const Route = createFileRoute("/control/$id")({
  component: ControlPage,
});

type Device = {
  id: string;
  pc_name: string;
  device_name: string;
  ip_address: string | null;
  os: string | null;
  username: string | null;
  is_online: boolean;
  last_seen: string;
  last_seen_ip: string | null;
  created_at: string;
};

type Metric = {
  cpu_percent: number | null;
  ram_percent: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  uptime_seconds: number | null;
};

type TabKey = "screen" | "camera" | "shell" | "files" | "processes" | "system" | "ai" | "fun" | "info";

const TABS: Array<{ key: TabKey; label: string; icon: typeof Info }> = [
  { key: "screen", label: "Live Screen", icon: Monitor },
  { key: "camera", label: "Live Camera", icon: Camera },
  { key: "shell", label: "Shell", icon: Terminal },
  { key: "files", label: "Files", icon: FileBox },
  { key: "processes", label: "Processes", icon: Cpu },
  { key: "system", label: "System", icon: Settings },
  { key: "ai", label: "AI Agent", icon: Sparkles },
  { key: "fun", label: "Fun", icon: PartyPopper },
  { key: "info", label: "Info", icon: Info },
];

function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading session…</div>;
  return <>{children}</>;
}

function ControlPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { authed, loading: authLoading } = useAuth();
  const [device, setDevice] = useState<Device | null>(null);
  const [metric, setMetric] = useState<Metric | null>(null);
  const [tab, setTab] = useState<TabKey>("screen");
  const [loading, setLoading] = useState(true);
  const [sessionStart] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!authLoading && !authed) navigate({ to: "/" });
  }, [authed, authLoading, navigate]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const { data } = await supabase.from("devices").select("*").eq("id", id).maybeSingle();
      if (!mounted) return;
      if (!data) {
        navigate({ to: "/dashboard/clients" });
        return;
      }
      setDevice(data as Device);
      const { data: m } = await supabase
        .from("device_metrics")
        .select("*")
        .eq("device_id", id)
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (mounted && m) setMetric(m as Metric);
      setLoading(false);
    };
    load();

    const deviceCh = supabase
      .channel(`ctrl-dev-${id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "devices", filter: `id=eq.${id}` },
        (p: any) => setDevice((prev) => ({ ...(prev as Device), ...p.new })),
      )
      .subscribe();
    const metricsCh = supabase
      .channel(`ctrl-met-${id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "device_metrics", filter: `device_id=eq.${id}` },
        (p: any) => setMetric(p.new as Metric),
      )
      .subscribe();
    return () => {
      mounted = false;
      supabase.removeChannel(deviceCh);
      supabase.removeChannel(metricsCh);
    };
  }, [id, navigate]);

  if (authLoading || loading || !device) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading session…
      </div>
    );
  }

  const elapsed = Math.floor((now - sessionStart) / 1000);
  const hh = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,oklch(0.6_0.18_280/0.12),transparent_55%),radial-gradient(circle_at_85%_90%,oklch(0.78_0.16_155/0.1),transparent_55%)]" />

      <div className="relative flex h-screen">
        {/* Sidebar */}
        <aside className="flex w-56 flex-col border-r border-border/60 bg-card/40 backdrop-blur-xl">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <button
              onClick={() => window.close()}
              className="rounded-md border border-border/60 p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Close"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{device.pc_name}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    device.is_online
                      ? "bg-emerald-400 shadow-[0_0_8px_oklch(0.7_0.18_155)] animate-pulse"
                      : "bg-muted-foreground"
                  }`}
                />
                {device.is_online ? "Online" : "Offline"}
              </div>
            </div>
          </div>

          <nav className="flex-1 space-y-1 p-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition ${
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="border-t border-border/60 p-3 text-[11px] text-muted-foreground">
            <div className="font-mono">{device.ip_address ?? "no ip"}</div>
            <div className="mt-0.5">{device.username ?? "unknown user"}</div>
            <div className="mt-2 flex items-center justify-between">
              <span>Session</span>
              <span className="font-mono text-primary">{hh}:{mm}:{ss}</span>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 overflow-auto">
          <div className="flex items-center justify-between border-b border-border/60 bg-card/40 px-6 py-3 backdrop-blur-xl">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Remote control
              </div>
              <h1 className="text-lg font-semibold">{TABS.find((t) => t.key === tab)?.label}</h1>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <Chip label="CPU" value={metric?.cpu_percent != null ? `${metric.cpu_percent.toFixed(0)}%` : "—"} />
              <Chip label="RAM" value={metric?.ram_percent != null ? `${metric.ram_percent.toFixed(0)}%` : "—"} />
            <StatusIndicator />
              <button
                onClick={() => window.close()}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 px-3 py-1.5 text-xs transition hover:bg-accent"
              >
                <X className="h-3 w-3" /> End session
              </button>
            </div>
          </div>

          <div className="p-6">
            <ClientOnly>
              <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
                {/* Keep all panels mounted so live streams persist across tab switches */}
                <div className={tab === "screen" ? "" : "hidden"}><ScreenPanel deviceId={id} /></div>
                <div className={tab === "camera" ? "" : "hidden"}><CameraPanel deviceId={id} /></div>
                <div className={tab === "shell" ? "" : "hidden"}><ShellPanel deviceId={id} /></div>
                <div className={tab === "files" ? "" : "hidden"}><FilesPanel deviceId={id} /></div>
                <div className={tab === "processes" ? "" : "hidden"}><ProcessesPanel deviceId={id} /></div>
                <div className={tab === "system" ? "" : "hidden"}><SystemPanel deviceId={id} /></div>
                <div className={tab === "ai" ? "" : "hidden"}><AIPanel deviceId={id} /></div>
                <div className={tab === "fun" ? "" : "hidden"}><FunPanel deviceId={id} /></div>
                {tab === "info" && <InfoPanel device={device} metric={metric} />}
              </Suspense>
            </ClientOnly>
          </div>
        </main>
      </div>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/60 px-2.5 py-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label} </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function StatusIndicator() {
  const [d, setD] = useState<WebRtcDiagnostics>(() => webrtcDiagnostics.get());
  useEffect(() => {
    const unsub = webrtcDiagnostics.subscribe(setD);
    return () => {
      unsub();
    };
  }, []);

  const ok =
    d.transport === "webrtc" ||
    d.connectionState === "connected" ||
    d.iceConnectionState === "completed";
  const bad =
    d.connectionState === "failed" ||
    d.iceConnectionState === "failed" ||
    !!d.lastError;
  const color = ok
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shadow-[0_0_8px_oklch(0.7_0.18_155/0.6)]"
    : bad
    ? "bg-red-500/15 text-red-300 border-red-500/40 shadow-[0_0_8px_oklch(0.65_0.22_25/0.5)]"
    : "bg-muted/40 text-muted-foreground border-border/60";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/status"
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition ${color}`}
            aria-label="WebRTC status"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                ok ? "bg-emerald-400 animate-pulse" : bad ? "bg-red-400" : "bg-muted-foreground"
              }`}
            />
            <Activity className="h-3 w-3" />
            Status
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-0.5 text-[11px]">
            <div>Transport: <b>{d.transport}</b></div>
            <div>Connection: <b>{d.connectionState}</b></div>
            <div>ICE: <b>{d.iceConnectionState}</b> · gather <b>{d.iceGatheringState}</b></div>
            <div>Candidates: {d.localCandidates} local / {d.remoteCandidates} remote</div>
            {d.lastError && <div className="text-red-300">Error: {d.lastError}</div>}
            <div className="pt-1 opacity-70">Click for full diagnostics</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
