import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { aiGenerateScript } from "@/lib/ai-exec.functions";
import { useDeviceCommands } from "@/hooks/use-device-commands";
import { Sparkles, Play, Loader2, Copy, Terminal } from "lucide-react";
import { toast } from "sonner";

export function AIPanel({ deviceId }: { deviceId: string }) {
  const generate = useServerFn(aiGenerateScript);
  const { send } = useDeviceCommands(deviceId);
  const [prompt, setPrompt] = useState("");
  const [lang, setLang] = useState<"powershell" | "cmd">("powershell");
  const [script, setScript] = useState("");
  const [output, setOutput] = useState<{ stdout?: string; stderr?: string; exit_code?: number } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState(false);

  const onGenerate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setScript("");
    try {
      const r = await generate({ data: { prompt, lang } });
      setScript(r.script);
    } catch (e: any) {
      toast.error(e.message ?? "AI failed");
    } finally {
      setGenerating(false);
    }
  };

  const onRun = async () => {
    if (!script.trim()) return;
    setRunning(true);
    setOutput(null);
    try {
      const r = await send("system.run_script", { script, lang }, 60_000);
      setOutput(r.result ?? {});
      toast.success(`exit ${r.result?.exit_code ?? 0}`);
    } catch (e: any) {
      toast.error(e.message ?? "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const onGenerateAndRun = async () => {
    await onGenerate();
    // small tick so script state updates
    setTimeout(onRun, 50);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-xl">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" /> AI Agent — code & execute on this machine
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder='e.g. "list all running services using more than 200MB", "open notepad with my hosts file"'
          className="w-full resize-none rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as any)}
            className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
          >
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
          </select>
          <button
            disabled={generating || !prompt.trim()}
            onClick={onGenerate}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate
          </button>
          <button
            disabled={generating || running || !prompt.trim()}
            onClick={onGenerateAndRun}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" /> Generate & Run
          </button>
        </div>
      </div>

      {(script || generating) && (
        <div className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-xl">
          <div className="mb-2 flex items-center justify-between text-xs">
            <div className="font-medium text-muted-foreground">Script ({lang})</div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => { navigator.clipboard.writeText(script); toast.success("Copied"); }}
                className="inline-flex items-center gap-1 rounded border border-border/60 px-2 py-1 hover:bg-accent"
              >
                <Copy className="h-3 w-3" /> Copy
              </button>
              <button
                disabled={running || !script.trim()}
                onClick={onRun}
                className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run
              </button>
            </div>
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={Math.min(20, Math.max(6, script.split("\n").length))}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          />
        </div>
      )}

      {output && (
        <div className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Terminal className="h-3.5 w-3.5" /> Output · exit {output.exit_code ?? "?"}
          </div>
          {output.stdout && (
            <pre className="max-h-64 overflow-auto rounded-md bg-black/40 p-3 font-mono text-xs text-emerald-200">{output.stdout}</pre>
          )}
          {output.stderr && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-black/40 p-3 font-mono text-xs text-red-300">{output.stderr}</pre>
          )}
        </div>
      )}
    </div>
  );
}
