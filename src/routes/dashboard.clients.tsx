import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";

import { Monitor, Smartphone, Download, Search, ExternalLink, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/dashboard/clients")({
  component: ClientsPage,
});

type Device = {
  id: string;
  pc_name: string;
  device_name: string;
  ip_address: string | null;
  os: string | null;
  username: string | null;
  tag: string | null;
  platform: string;
  is_online: boolean;
  last_seen: string;
  enrollment_code: string | null;
};

const ONLINE_TIMEOUT_MS = 10_000;

function isDeviceOnline(d: { last_seen: string; is_online: boolean }) {
  if (!d.is_online) return false;
  return Date.now() - new Date(d.last_seen).getTime() < ONLINE_TIMEOUT_MS;
}

type PlatformFilter = "all" | "pc" | "mobile";

function ClientsPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [toDelete, setToDelete] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) return;
    let mounted = true;
    const load = async () => {
      const ownedQ = supabase
        .from("devices")
        .select("id,pc_name,device_name,ip_address,os,username,tag,platform,is_online,last_seen,enrollment_code,created_at")
        .eq("owner_user_id", user.id)
        .order("created_at", { ascending: false });
      const sharedIdsQ = supabase
        .from("device_access")
        .select("device_id")
        .eq("user_id", user.id);
      const [{ data: owned, error }, { data: sharedRows }] = await Promise.all([
        ownedQ,
        sharedIdsQ,
      ]);
      let shared: Device[] = [];
      const sharedIds = (sharedRows ?? []).map((r: any) => r.device_id);
      if (sharedIds.length) {
        const { data } = await supabase
          .from("devices")
          .select("id,pc_name,device_name,ip_address,os,username,tag,platform,is_online,last_seen,enrollment_code,created_at")
          .in("id", sharedIds);
        shared = (data as Device[]) ?? [];
      }
      const map = new Map<string, Device>();
      for (const d of [...(owned ?? []), ...shared] as Device[]) map.set(d.id, d);
      const data = Array.from(map.values());
      if (mounted) {
        if (error) toast.error(error.message);
        setDevices(data);
        setLoading(false);
      }
    };
    load();

    const channel = supabase
      .channel("devices-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, load)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "devices", filter: `owner_user_id=eq.${user.id}` },
        (payload) => {
          const row = payload.new as Partial<Device>;
          const name = row.pc_name || row.device_name || "new client";
          const icon = row.platform === "android" ? "📱" : "🖥️";
          toast.success(`${icon} new client online`, {
            description: name,
            position: "top-right",
          });
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [user]);

  const filtered = useMemo(() => {
    let list = devices;
    if (platformFilter === "pc") list = list.filter((d) => (d.platform || "windows") === "windows");
    if (platformFilter === "mobile") list = list.filter((d) => d.platform === "android");

    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (d) =>
        d.pc_name.toLowerCase().includes(q) ||
        d.device_name.toLowerCase().includes(q) ||
        (d.ip_address ?? "").toLowerCase().includes(q) ||
        (d.username ?? "").toLowerCase().includes(q),
    );
  }, [devices, query, platformFilter]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">clients</h1>
        </div>
        <a
          href="/downloads/agent.exe"
          download="sentinel-agent.exe"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Download className="h-4 w-4" />
          grab exe
        </a>
      </div>

      <div className="mt-4 flex items-center gap-2">
        {(["all", "pc", "mobile"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setPlatformFilter(f)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              platformFilter === f ? "bg-primary/15 text-primary border border-primary/30" : "bg-secondary text-muted-foreground border border-border/60 hover:bg-accent"
            }`}
          >
            {f === "pc" && <Monitor className="h-3 w-3" />}
            {f === "mobile" && <Smartphone className="h-3 w-3" />}
            {f === "all" ? "All" : f === "pc" ? "PC" : "Mobile"}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-md border border-border/60 bg-card/60 px-3 py-2 backdrop-blur-xl">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search name, ip, user…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border/60 bg-card/60 backdrop-blur-xl">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">device</th>
              <th className="px-5 py-3 font-medium">tag</th>
              <th className="px-5 py-3 font-medium">user</th>
              <th className="px-5 py-3 font-medium">os</th>
              <th className="px-5 py-3 font-medium">ip</th>
              <th className="px-5 py-3 font-medium">status</th>
              <th className="px-5 py-3 font-medium">last seen</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-muted-foreground">
                  loading…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-muted-foreground">
                  —
                </td>
              </tr>
            )}
            {filtered.map((d) => (
              <tr key={d.id} className="border-t border-border/40 transition hover:bg-muted/20">
                <td className="px-5 py-3 font-medium">
                  <div className="flex items-center gap-2">
                    {d.platform === "android" ? (
                      <Smartphone className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Monitor className="h-4 w-4 text-muted-foreground" />
                    )}
                    {d.pc_name}
                  </div>
                </td>
                <td className="px-5 py-3">
                  {d.tag ? (
                    <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {d.tag}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-muted-foreground">{d.username ?? "—"}</td>
                <td className="px-5 py-3 text-muted-foreground">{d.os ?? "—"}</td>
                <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                  {d.ip_address ?? "—"}
                </td>
                <td className="px-5 py-3">
                  <StatusBadge online={d.is_online} />
                </td>
                <td className="px-5 py-3 text-xs text-muted-foreground">
                  {new Date(d.last_seen).toLocaleString()}
                </td>
                <td className="px-5 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button
                      onClick={() => window.open(`/control/${d.id}`, "_blank", "noopener")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition hover:bg-accent"
                    >
                      <ExternalLink className="h-3 w-3" />
                      open
                    </button>
                    <button
                      onClick={() => setToDelete(d)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20"
                    >
                      <Trash2 className="h-3 w-3" />
                      yeet
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>yeet this client?</AlertDialogTitle>
            <AlertDialogDescription>
              gonna nuke <span className="font-medium text-foreground">{toDelete?.pc_name}</span> from your list. agent stops responding. no take-backs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>nah</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={async (e) => {
                e.preventDefault();
                if (!toDelete) return;
                setDeleting(true);
                const { error } = await supabase.from("devices").delete().eq("id", toDelete.id);
                setDeleting(false);
                if (error) {
                  toast.error(error.message);
                  return;
                }
                toast.success("gone");
                setDevices((prev) => prev.filter((x) => x.id !== toDelete.id));
                setToDelete(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "removing…" : "yeet"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
        online ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          online ? "bg-emerald-400 shadow-[0_0_8px_oklch(0.7_0.18_155)] animate-pulse" : "bg-muted-foreground"
        }`}
      />
      {online ? "online" : "offline"}
    </span>
  );
}
