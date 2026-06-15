import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  listMyLinks, upsertLink, deleteLink, reorderLinks, updateBioProfile,
  type BioLink,
} from "@/lib/bio.functions";
import { useAuth } from "@/lib/auth-context";
import { getProfile, type Profile } from "@/lib/profile";
import { ExternalLink, Trash2, GripVertical, Plus, Eye } from "lucide-react";

export const Route = createFileRoute("/dashboard/bio")({
  component: BioEditor,
  head: () => ({ meta: [{ title: "bio — veltrix" }] }),
});

function BioEditor() {
  const { user } = useAuth();
  const listFn = useServerFn(listMyLinks);
  const upFn = useServerFn(upsertLink);
  const delFn = useServerFn(deleteLink);
  const reorderFn = useServerFn(reorderLinks);
  const profFn = useServerFn(updateBioProfile);

  const [links, setLinks] = useState<BioLink[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bio, setBio] = useState("");
  const [theme, setTheme] = useState<"terminal" | "card" | "neon">("terminal");
  const [isPublic, setIsPublic] = useState(true);
  const [socials, setSocials] = useState<Record<string, string>>({});
  const [newLink, setNewLink] = useState({ title: "", url: "" });

  const refresh = async () => {
    const r = await listFn({});
    setLinks(r.links);
  };

  useEffect(() => {
    if (!user) return;
    refresh();
    getProfile(user.id).then((p) => {
      if (!p) return;
      setProfile(p);
      setBio(p.bio ?? "");
      const pany = p as unknown as { bio_theme?: string; bio_public?: boolean; socials?: Record<string, string> };
      setTheme((pany.bio_theme as "terminal" | "card" | "neon") ?? "terminal");
      setIsPublic(pany.bio_public ?? true);
      setSocials(pany.socials ?? {});
    });
  }, [user?.id]);

  const addLink = async () => {
    if (!newLink.title || !newLink.url) return toast.error("title + url plz");
    await upFn({ data: { title: newLink.title, url: newLink.url, position: links.length } });
    setNewLink({ title: "", url: "" });
    refresh();
  };

  const removeLink = async (id: string) => {
    await delFn({ data: { id } });
    refresh();
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const newOrder = [...links];
    const swap = idx + dir;
    if (swap < 0 || swap >= newOrder.length) return;
    [newOrder[idx], newOrder[swap]] = [newOrder[swap], newOrder[idx]];
    setLinks(newOrder);
    await reorderFn({ data: { ids: newOrder.map((l) => l.id) } });
  };

  const saveProfile = async () => {
    await profFn({ data: { bio, socials, bio_theme: theme, bio_public: isPublic } });
    toast.success("saved");
  };

  const handle = profile?.username ?? "";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1>biolinks</h1>
        {handle && (
          <Link to="/u/$handle" params={{ handle }} target="_blank"
            className="inline-flex items-center gap-1 px-3 py-1.5 font-mono text-xs">
            <Eye className="h-3.5 w-3.5" /> /u/{handle}
          </Link>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* editor */}
        <div className="space-y-4">
          <div className="term-frame">
            <div className="term-bar">~/profile.cfg</div>
            <div className="term-body space-y-3">
              <div>
                <label className="prompt-label block text-[11px] uppercase tracking-wider text-muted-foreground">bio</label>
                <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={2} maxLength={280}
                  className="mt-1 w-full px-3 py-2 font-mono text-sm resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {["discord","telegram","twitter","website"].map((k) => (
                  <div key={k}>
                    <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">{k}</label>
                    <input value={socials[k] ?? ""} onChange={(e) => setSocials({ ...socials, [k]: e.target.value })}
                      className="mt-1 w-full px-2 py-1.5 font-mono text-xs" />
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">theme</div>
                  <div className="mt-1 flex gap-1">
                    {(["terminal","card","neon"] as const).map((t) => (
                      <button key={t} onClick={() => setTheme(t)} className={`flex-1 px-2 py-1.5 font-mono text-xs ${theme === t ? "!border-primary" : ""}`}>{t}</button>
                    ))}
                  </div>
                </div>
                <label className="mt-4 inline-flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
                  public
                </label>
              </div>
              <button onClick={saveProfile} className="w-full px-3 py-2 font-mono text-sm">$ save_profile</button>
            </div>
          </div>

          <div className="term-frame">
            <div className="term-bar">~/links/</div>
            <div className="term-body space-y-2">
              {links.length === 0 && <div className="text-xs text-muted-foreground">no links yet. add one ↓</div>}
              {links.map((l, i) => (
                <div key={l.id} className="flex items-center gap-2 border border-border px-2 py-1.5">
                  <div className="flex flex-col">
                    <button onClick={() => move(i, -1)} className="border-0 p-0 text-[10px]">▲</button>
                    <button onClick={() => move(i, 1)} className="border-0 p-0 text-[10px]">▼</button>
                  </div>
                  <GripVertical className="h-3 w-3 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-mono">{l.title}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{l.url}</div>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{l.clicks}↗</span>
                  <button onClick={() => removeLink(l.id)} className="border-0 p-1 text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <div className="mt-2 grid grid-cols-[1fr_2fr_auto] gap-2">
                <input value={newLink.title} onChange={(e) => setNewLink({ ...newLink, title: e.target.value })}
                  placeholder="title" className="px-2 py-1.5 font-mono text-xs" />
                <input value={newLink.url} onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
                  placeholder="https://…" className="px-2 py-1.5 font-mono text-xs" />
                <button onClick={addLink} className="inline-flex items-center gap-1 px-2 py-1.5 text-xs">
                  <Plus className="h-3 w-3" /> add
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* live preview */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <div className="term-frame">
            <div className="term-bar">preview /u/{handle || "you"}</div>
            <div className={`term-body bio-theme-${theme} space-y-3`}>
              {profile?.avatar_url && (
                <img src={profile.avatar_url} className="mx-auto h-16 w-16 object-cover border border-border" />
              )}
              <div className="text-center font-mono text-sm">@{handle}</div>
              <div className="text-center text-xs text-muted-foreground">{bio || "no bio yet"}</div>
              <div className="flex flex-wrap justify-center gap-1 text-[11px]">
                {Object.entries(socials).filter(([,v]) => v).map(([k,v]) => (
                  <span key={k} className="border border-border px-2 py-0.5">{k}:{v}</span>
                ))}
              </div>
              <div className="space-y-1.5">
                {links.map((l) => (
                  <div key={l.id} className="bio-link">
                    <span className="truncate text-sm">{l.title}</span>
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </div>
                ))}
                {links.length === 0 && <div className="text-center text-[11px] text-muted-foreground">no links</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}