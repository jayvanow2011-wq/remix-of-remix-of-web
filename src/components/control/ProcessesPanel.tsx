import { useEffect, useState } from "react";
import { useDeviceCommands } from "@/hooks/use-device-commands";
import { RefreshCcw, X } from "lucide-react";
import { toast } from "sonner";

type Proc = { pid: number; name: string; memory_mb: number };

export function ProcessesPanel({ deviceId }: { deviceId: string }) {
  const { send } = useDeviceCommands(deviceId);
  const [procs, setProcs] = useState<Proc[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await send("proc.list", {}, 15000);
      if (res.status === "error") throw new Error(res.error ?? "failed");
      setProcs((res.result?.processes ?? []) as Proc[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kill = async (p: Proc) => {
    if (!confirm(`Kill ${p.name} (PID ${p.pid})?`)) return;
    try {
      const res = await send("proc.kill", { pid: p.pid });
      if (res.status === "error") throw new Error(res.error ?? "failed");
      toast.success(`Killed PID ${p.pid}`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const filtered = procs.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 p-2 backdrop-blur-xl">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="flex-1 rounded-md border border-border/60 bg-input/60 px-3 py-1.5 text-xs outline-none"
        />
        <button
          onClick={load}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1.5 text-xs hover:bg-accent"
        >
          <RefreshCcw className="h-3 w-3" /> Refresh
        </button>
        <span className="text-xs text-muted-foreground">{filtered.length} / {procs.length}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/60 backdrop-blur-xl">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">PID</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Memory</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((p) => (
                <tr key={p.pid} className="border-t border-border/40 hover:bg-muted/20">
                  <td className="px-4 py-1.5 font-mono text-xs">{p.pid}</td>
                  <td className="px-4 py-1.5">{p.name}</td>
                  <td className="px-4 py-1.5 text-xs text-muted-foreground">
                    {p.memory_mb ? `${p.memory_mb.toFixed(1)} MB` : "—"}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <button
                      onClick={() => kill(p)}
                      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/10"
                    >
                      <X className="h-3 w-3" /> Kill
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
