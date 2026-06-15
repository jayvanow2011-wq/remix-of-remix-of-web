import { Activity } from "lucide-react";

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

export function InfoPanel({ device, metric }: { device: Device; metric: Metric | null }) {
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "PC name", value: device.pc_name },
    { label: "Device name", value: device.device_name },
    { label: "Operating system", value: device.os ?? "Unknown" },
    { label: "Logged-in user", value: device.username ?? "—" },
    { label: "IP address", value: device.ip_address ?? "—", mono: true },
    { label: "Last seen IP", value: device.last_seen_ip ?? "—", mono: true },
    { label: "Status", value: device.is_online ? "Online" : "Offline" },
    { label: "Last seen", value: new Date(device.last_seen).toLocaleString() },
    { label: "Device ID", value: device.id, mono: true },
    { label: "Registered", value: new Date(device.created_at).toLocaleString() },
  ];

  const uptime = metric?.uptime_seconds ?? 0;
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/60 backdrop-blur-xl lg:col-span-2">
        <div className="border-b border-border/40 px-5 py-3 text-sm font-medium">Device information</div>
        <dl className="divide-y divide-border/40">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-3 gap-4 px-5 py-3 text-sm">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className={`col-span-2 ${r.mono ? "font-mono text-xs" : ""}`}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-border/60 bg-card/60 p-5 backdrop-blur-xl">
          <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
            <span>Live metrics</span>
            <Activity className="h-3 w-3" />
          </div>
          <Bar label="CPU" pct={metric?.cpu_percent ?? null} />
          <Bar label="RAM" pct={metric?.ram_percent ?? null} />
          {metric?.ram_total_mb ? (
            <div className="mt-2 text-xs text-muted-foreground">
              {(metric.ram_used_mb ?? 0).toLocaleString()} MB /{" "}
              {metric.ram_total_mb.toLocaleString()} MB
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border/60 bg-card/60 p-5 backdrop-blur-xl">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Uptime</div>
          <div className="mt-2 text-lg font-semibold">{uptime ? `${days}d ${hours}h` : "—"}</div>
        </div>
      </div>
    </div>
  );
}

function Bar({ label, pct }: { label: string; pct: number | null }) {
  const value = pct ?? 0;
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{pct != null ? `${value.toFixed(0)}%` : "—"}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}
