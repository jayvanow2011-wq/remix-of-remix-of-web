import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Send, Image as ImageIcon, Newspaper, MessageSquare, Crown, Trophy, Medal, X } from "lucide-react";

export const Route = createFileRoute("/dashboard/community")({
  component: CommunityPage,
});

type Post = {
  id: string;
  author_id: string;
  channel: string;
  body: string | null;
  image_url: string | null;
  created_at: string;
  author_name?: string;
  author_avatar?: string;
};

type TabKey = "news" | "reviews" | "leaderboard";

function CommunityPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("news");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  const tabs: { key: TabKey; label: string; icon: typeof Newspaper }[] = [
    { key: "news", label: "News", icon: Newspaper },
    { key: "reviews", label: "Reviews", icon: MessageSquare },
    { key: "leaderboard", label: "Leaderboard", icon: Crown },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row">
      {/* Left sidebar tabs */}
      <aside className="lg:w-56 lg:shrink-0">
        <div className="sticky top-4">
          <h1 className="mb-4 text-2xl font-semibold tracking-tight">Community</h1>
          <nav className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 lg:flex-col lg:overflow-visible">
            {tabs.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </aside>

      {/* Full page content */}
      <main className="min-w-0 flex-1">
        {tab === "news" && <FeedPanel channel="news" userId={user?.id} canPost={isAdmin} />}
        {tab === "reviews" && <FeedPanel channel="reviews" userId={user?.id} canPost={!!user} />}
        {tab === "leaderboard" && <LeaderboardPanel />}
      </main>
    </div>
  );
}

/* ─── Feed (per-channel) ─── */
function FeedPanel({ channel, userId, canPost }: { channel: "news" | "reviews"; userId?: string; canPost: boolean }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("community_posts")
      .select("*")
      .eq("channel", channel)
      .order("created_at", { ascending: false })
      .limit(100);
    if (!data) return;
    const authorIds = [...new Set(data.map((p) => p.author_id))];
    const { data: profiles } = authorIds.length
      ? await supabase.from("profiles").select("id,username,avatar_url").in("id", authorIds)
      : { data: [] };
    const pm = new Map((profiles ?? []).map((p) => [p.id, p]));
    setPosts(data.map((p) => ({
      ...p,
      author_name: pm.get(p.author_id)?.username ?? "anon",
      author_avatar: pm.get(p.author_id)?.avatar_url ?? undefined,
    })));
  };

  useEffect(() => { load(); }, [channel]);

  useEffect(() => {
    const ch = supabase
      .channel(`community-${channel}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "community_posts", filter: `channel=eq.${channel}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [channel]);

  useEffect(() => {
    if (!imageFile) { setImagePreview(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const send = async () => {
    if (!userId || (!body.trim() && !imageFile)) return;
    setSending(true);
    let imageUrl: string | null = null;
    if (imageFile) {
      const path = `${userId}/${Date.now()}-${imageFile.name}`;
      const { error } = await supabase.storage.from("chat").upload(path, imageFile);
      if (error) { toast.error(error.message); setSending(false); return; }
      imageUrl = supabase.storage.from("chat").getPublicUrl(path).data.publicUrl;
    }
    const { error } = await supabase.from("community_posts").insert({
      author_id: userId,
      channel,
      body: body.trim() || null,
      image_url: imageUrl,
    });
    setSending(false);
    if (error) { toast.error(error.message); return; }
    setBody("");
    setImageFile(null);
  };

  const emptyText = channel === "news"
    ? "No announcements yet. Check back soon."
    : "No reviews yet — be the first to share your experience.";

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3">
        {posts.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card/40 py-20 text-center">
            {channel === "news" ? <Newspaper className="h-10 w-10 text-muted-foreground/60" /> : <MessageSquare className="h-10 w-10 text-muted-foreground/60" />}
            <p className="mt-3 text-sm text-muted-foreground">{emptyText}</p>
          </div>
        )}
        {posts.map((p) => (
          <article key={p.id} className="rounded-xl border border-border bg-card p-5 animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
            <header className="flex items-center gap-3">
              {p.author_avatar ? (
                <img src={p.author_avatar} alt="" className="h-9 w-9 rounded-full object-cover ring-2 ring-border" />
              ) : <div className="h-9 w-9 rounded-full bg-muted" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{p.author_name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${p.channel === "news" ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-400"}`}>
                    {p.channel}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground">{new Date(p.created_at).toLocaleString()}</div>
              </div>
            </header>
            {p.body && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{p.body}</p>}
            {p.image_url && <img src={p.image_url} alt="" className="mt-3 max-h-96 rounded-md" />}
          </article>
        ))}
      </div>

      {canPost && (
        <div className="sticky bottom-2 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur-xl">
          {imagePreview && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-background/50 p-2">
              <img src={imagePreview} alt="" className="h-14 w-14 rounded object-cover" />
              <div className="flex-1 truncate text-xs text-muted-foreground">{imageFile?.name}</div>
              <button onClick={() => setImageFile(null)} className="rounded p-1 text-muted-foreground hover:text-destructive"><X className="h-4 w-4" /></button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 1000))}
              rows={2}
              placeholder={channel === "news" ? "Post an announcement…" : "Write a review…"}
              className="flex-1 resize-none rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <label className="cursor-pointer rounded-md border border-border bg-secondary p-2 hover:bg-accent">
              <input type="file" accept="image/*" className="hidden" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
              <ImageIcon className="h-4 w-4" />
            </label>
            <button onClick={send} disabled={sending || (!body.trim() && !imageFile)} className="rounded-md bg-primary p-2 text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      {!canPost && channel === "news" && (
        <p className="text-center text-xs text-muted-foreground">Only admins can post news.</p>
      )}
    </div>
  );
}

/* ─── Leaderboard ─── */
type LbEntry = { id: string; username: string | null; avatar_url: string | null; count: number };

function LeaderboardPanel() {
  const [entries, setEntries] = useState<LbEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data: devices } = await supabase.from("devices").select("owner_user_id");
    const counts = new Map<string, number>();
    (devices ?? []).forEach((d) => {
      if (d.owner_user_id) counts.set(d.owner_user_id, (counts.get(d.owner_user_id) ?? 0) + 1);
    });
    if (counts.size === 0) { setEntries([]); setLoading(false); return; }
    const { data: profiles } = await supabase.from("profiles").select("id,username,avatar_url").in("id", [...counts.keys()]);
    const result: LbEntry[] = (profiles ?? []).map((p) => ({
      id: p.id, username: p.username, avatar_url: p.avatar_url, count: counts.get(p.id) ?? 0,
    })).sort((a, b) => b.count - a.count);
    setEntries(result);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase.channel("leaderboard-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const medals = [
    { icon: Trophy, color: "text-yellow-400" },
    { icon: Medal, color: "text-gray-300" },
    { icon: Medal, color: "text-amber-700" },
  ];

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No clients enrolled yet.</p>;

  return (
    <div className="space-y-2">
      {entries.map((e, i) => {
        const M = medals[i];
        return (
          <div key={e.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition hover:border-primary/40">
            <div className="w-8 text-center">
              {M ? <M.icon className={`h-5 w-5 ${M.color}`} /> : <span className="text-sm text-muted-foreground">{i + 1}</span>}
            </div>
            {e.avatar_url ? (
              <img src={e.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover ring-2 ring-border" />
            ) : <div className="h-10 w-10 rounded-full bg-muted" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{e.username ?? "anonymous"}</div>
            </div>
            <div className="text-xl font-bold text-primary">{e.count}</div>
            <span className="text-xs text-muted-foreground">clients</span>
          </div>
        );
      })}
    </div>
  );
}
