import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useRouter } from "@tanstack/react-router";
import { Bot, X, Send, Trash2, Link as LinkIcon, Loader2, GripVertical, Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { chatWithAI, fetchUrlText, type ChatMsg, type AIAction } from "@/lib/ai-chat.functions";
import { useAuth } from "@/lib/auth-context";
import { useCustomization } from "@/lib/customization-context";

const HISTORY_KEY = "veltrix-ai-chat-history";
const POS_KEY = "veltrix-ai-chat-pos";

type Msg = ChatMsg & { id: string; ts: number; actions?: AIAction[] };

function loadHistory(): Msg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveHistory(msgs: Msg[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-100))); } catch {}
}

export function AIWidget() {
  const { authed } = useAuth();
  const { customization } = useCustomization();
  const router = useRouter();
  const chat = useServerFn(chatWithAI);
  const fetchUrl = useServerFn(fetchUrlText);

  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 24, y: 24 });
  const dragRef = useRef<{ dx: number; dy: number; dragging: boolean }>({ dx: 0, dy: 0, dragging: false });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMsgs(loadHistory());
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) setPos(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs, open]);

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, dragging: true };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current.dragging) return;
      const x = Math.max(8, Math.min(window.innerWidth - 64, ev.clientX - dragRef.current.dx));
      const y = Math.max(8, Math.min(window.innerHeight - 64, ev.clientY - dragRef.current.dy));
      setPos({ x, y });
    };
    const onUp = () => {
      dragRef.current.dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: text, ts: Date.now() };
    const next = [...msgs, userMsg];
    setMsgs(next);
    saveHistory(next);
    setInput("");
    setLoading(true);
    try {
      const pageUrl = typeof window !== "undefined" ? window.location.href : router.state.location.pathname;
      const payload: ChatMsg[] = next.slice(-20).map(({ role, content }) => ({ role, content }));
      const res = await chat({ data: { messages: payload, pageUrl, personality: customization.aiPersonality, brief: customization.aiBrief } });
      const aiMsg: Msg = { id: crypto.randomUUID(), role: "assistant", content: res.content, ts: Date.now(), actions: res.actions };
      const withAi = [...next, aiMsg];
      setMsgs(withAi);
      saveHistory(withAi);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI failed");
    } finally {
      setLoading(false);
    }
  }, [input, loading, msgs, chat, router, customization.aiPersonality, customization.aiBrief]);

  const readUrl = async () => {
    const url = window.prompt("Paste a URL to read");
    if (!url) return;
    setLoading(true);
    try {
      const { text, title } = await fetchUrl({ data: { url } });
      await send(`Please summarize this page (${title || url}):\n\n${text}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't fetch URL");
      setLoading(false);
    }
  };

  const clear = () => {
    setMsgs([]);
    try { localStorage.removeItem(HISTORY_KEY); } catch {}
  };

  // Hide widget when AI is disabled or user isn't signed in
  if (!authed || !customization.aiEnabled) return null;

  return (
    <>
      {/* Floating draggable button */}
      <button
        onMouseDown={onMouseDown}
        onClick={(e) => {
          // Only open if it wasn't a drag (basic check: short move)
          if (!dragRef.current.dragging) setOpen((v) => !v);
        }}
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-[9998] flex h-14 w-14 cursor-grab items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:cursor-grabbing"
        aria-label="Open AI assistant"
      >
        {open ? <X className="h-6 w-6" /> : <Bot className="h-6 w-6" />}
      </button>

      {open && (
        <div
          style={{
            left: Math.min(pos.x, Math.max(8, (typeof window !== "undefined" ? window.innerWidth : 800) - 388)),
            top: Math.min(pos.y + 64, Math.max(8, (typeof window !== "undefined" ? window.innerHeight : 600) - 520)),
          }}
          className="fixed z-[9999] flex h-[500px] w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <GripVertical className="h-4 w-4 text-muted-foreground" />
              <Bot className="h-4 w-4 text-primary" />
              Veltrix AI
            </div>
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={readUrl} title="Read URL">
                <LinkIcon className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={clear} title="Clear history">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setOpen(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div ref={scrollRef} className="flex flex-col gap-3 p-3">
              {msgs.length === 0 && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-center">
                  <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-semibold">Welcome to veltrixrat AI</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Ask questions or control your clients. Try: <span className="font-mono">"list my clients"</span> or <span className="font-mono">"screenshot pc-01"</span>.
                  </div>
                </div>
              )}
              {msgs.map((m) => (
                <div key={m.id} className="flex flex-col gap-1">
                  <div
                    className={
                      m.role === "user"
                        ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                        : "mr-auto max-w-[90%] whitespace-pre-wrap text-sm text-foreground"
                    }
                  >
                    {m.content}
                  </div>
                  {m.actions && m.actions.length > 0 && (
                    <div className="mr-auto flex max-w-[90%] flex-col gap-1">
                      {m.actions.map((a, i) => (
                        <details key={i} className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                          <summary className="flex cursor-pointer items-center gap-1 font-mono"><Terminal className="h-3 w-3" /> {a.name}</summary>
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">{a.result}</pre>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
                </div>
              )}
            </div>
          </ScrollArea>

          <form
            onSubmit={(e) => { e.preventDefault(); void send(); }}
            className="flex items-center gap-2 border-t border-border p-2"
          >
            <Input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything…"
              disabled={loading}
              className="h-9"
            />
            <Button type="submit" size="icon" disabled={loading || !input.trim()} className="h-9 w-9 shrink-0">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </form>
        </div>
      )}
    </>
  );
}