import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  listMyLinks, upsertLink, deleteLink, reorderLinks, updateBioProfile,
  type BioLink,
} from "@/lib/bio.functions";
import { useAuth } from "@/lib/auth-context";
import { getProfile, type Profile } from "@/lib/profile";
import { ExternalLink, Trash2, Plus, Eye, ArrowUp, ArrowDown, Sparkles } from "lucide-react";

export function BioPanel() {
  const { user } = useAuth();
  const listFn = useServerFn(listMyLinks);
  const upFn = useServerFn(upsertLink);
  const delFn = useServerFn(deleteLink);
  const reorderFn = useServerFn(reorderLinks);
  const profFn = useServerFn(updateBioProfile);

  const [links, setLinks] = useState<BioLink[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bio, setBio] = useState("");
  const [theme, setTheme] = useState<"terminal" | "card" | "neon">("neon");
  const [isPublic, setIsPublic] = useState(true);
  const [socials, setSocials] = useState<Record<string, string>>({});
  const [newLink, setNewLink] = useState({ title: "", url: "" });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ title: "", url: "" });

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
      setTheme((pany.bio_theme as "terminal" | "card" | "neon") ?? "neon");
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

  const saveEdit = async () => {
    if (!editId) return;
    await upFn({ data: { id: editId, title: editDraft.title, url: editDraft.url } });
    setEditId(null);
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

  const handleTilt = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: py * -14, y: px * 18 });
  };
  const resetTilt = () => setTilt({ x: 0, y: 0 });

  const handle = profile?.username ?? "you";

  return (
    <section className="space-y-5 rounded-xl border border-border bg-card p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="h-4 w-4" /> Biolink
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Your public page at <span className="font-mono">/u/{handle}</span>.
          </p>
        </div>
        <Link to="/u/$handle" params={{ handle }} target="_blank"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs hover:bg-accent">
          <Eye className="h-3.5 w-3.5" /> View
        </Link>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {/* editor */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">bio</label>
            <textarea value={bio} onChange={(e) => setBio(e.target.value.slice(0, 280))} rows={3}
              className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm" />
            <div className="text-right text-[10px] text-muted-foreground">{bio.length}/280</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {["discord","telegram","twitter","website"].map((k) => (
              <div key={k} className="space-y-1">
                <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">{k}</label>
                <input value={socials[k] ?? ""} onChange={(e) => setSocials({ ...socials, [k]: e.target.value })}
                  className="w-full rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs" />
              </div>
            ))}
          </div>

          <div className="flex items-end gap-3">
            <div className="flex-1">
              <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">theme</div>
              <div className="flex gap-1">
                {(["terminal","card","neon"] as const).map((tName) => (
                  <button key={tName} onClick={() => setTheme(tName)}
                    className={`flex-1 rounded-md border px-2.5 py-1.5 text-xs font-mono transition ${theme === tName ? "border-foreground bg-secondary" : "border-border hover:border-foreground/40"}`}>
                    {tName}
                  </button>
                ))}
              </div>
            </div>
            <label className="inline-flex items-center gap-2 pb-1.5 text-xs">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              public
            </label>
          </div>

          <button onClick={saveProfile} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            Save profile
          </button>

          {/* links */}
          <div className="space-y-2 rounded-lg border border-border bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">links</div>
            {links.length === 0 && <div className="text-xs text-muted-foreground">no links yet. add one ↓</div>}
            {links.map((l, i) => (
              <div key={l.id} className="rounded-md border border-border bg-card p-2">
                {editId === l.id ? (
                  <div className="grid grid-cols-[1fr_2fr_auto_auto] gap-1.5">
                    <input value={editDraft.title} onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                      className="rounded border border-border bg-background/60 px-2 py-1 text-xs" />
                    <input value={editDraft.url} onChange={(e) => setEditDraft({ ...editDraft, url: e.target.value })}
                      className="rounded border border-border bg-background/60 px-2 py-1 text-xs" />
                    <button onClick={saveEdit} className="rounded bg-primary px-2 text-xs text-primary-foreground">save</button>
                    <button onClick={() => setEditId(null)} className="rounded border border-border px-2 text-xs">×</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <button onClick={() => move(i, -1)} className="text-muted-foreground hover:text-foreground"><ArrowUp className="h-3 w-3" /></button>
                      <button onClick={() => move(i, 1)} className="text-muted-foreground hover:text-foreground"><ArrowDown className="h-3 w-3" /></button>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{l.title}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{l.url}</div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{l.clicks}↗</span>
                    <button onClick={() => { setEditId(l.id); setEditDraft({ title: l.title, url: l.url }); }}
                      className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">edit</button>
                    <button onClick={() => removeLink(l.id)} className="rounded p-1 text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="mt-2 grid grid-cols-[1fr_2fr_auto] gap-2">
              <input value={newLink.title} onChange={(e) => setNewLink({ ...newLink, title: e.target.value })}
                placeholder="title" className="rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs" />
              <input value={newLink.url} onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
                placeholder="https://…" className="rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs" />
              <button onClick={addLink} className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground hover:opacity-90">
                <Plus className="h-3 w-3" /> add
              </button>
            </div>
          </div>
        </div>

        {/* 3D preview */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">live preview</div>
          <div
            className="bio3d-stage"
            onMouseMove={handleTilt}
            onMouseLeave={resetTilt}
            style={{ perspective: "1200px" }}
          >
            <div
              className={`bio3d-card bio-theme-${theme}`}
              style={{
                transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
                transition: "transform 220ms cubic-bezier(.2,.7,.2,1)",
              }}
            >
              <div className="bio3d-shine" />
              <div className="relative space-y-3 p-5">
                {profile?.avatar_url ? (
                  <img src={profile.avatar_url} alt="" className="mx-auto h-16 w-16 rounded-full border border-white/20 object-cover shadow-lg" />
                ) : <div className="mx-auto h-16 w-16 rounded-full bg-muted" />}
                <div className="text-center font-mono text-sm">@{handle}</div>
                <div className="text-center text-xs text-muted-foreground min-h-[1.5em]">{bio || "no bio yet"}</div>
                <div className="flex flex-wrap justify-center gap-1 text-[10px]">
                  {Object.entries(socials).filter(([,v]) => v).map(([k,v]) => (
                    <span key={k} className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono">{k}:{v}</span>
                  ))}
                </div>
                <div className="space-y-1.5 pt-1">
                  {links.map((l) => (
                    <div key={l.id} className="bio3d-link group">
                      <span className="truncate text-sm">{l.title}</span>
                      <ExternalLink className="h-3 w-3 opacity-50 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                    </div>
                  ))}
                  {links.length === 0 && <div className="text-center text-[11px] text-muted-foreground">no links</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .bio3d-stage { width: 100%; }
        .bio3d-card {
          position: relative;
          border-radius: 18px;
          overflow: hidden;
          transform-style: preserve-3d;
          background: linear-gradient(140deg,
            color-mix(in oklab, var(--color-card) 92%, transparent),
            color-mix(in oklab, var(--color-background) 70%, transparent));
          border: 1px solid color-mix(in oklab, var(--color-foreground) 12%, transparent);
          box-shadow:
            0 30px 60px -25px rgba(0,0,0,0.6),
            0 10px 24px -12px rgba(0,0,0,0.45),
            inset 0 1px 0 rgba(255,255,255,0.06);
          will-change: transform;
        }
        .bio3d-card.bio-theme-neon {
          background:
            radial-gradient(120% 80% at 50% 0%, rgba(139,92,246,0.22), transparent 60%),
            linear-gradient(160deg, #0b0717, #15082b 60%, #1a0530);
          border-color: rgba(168,85,247,0.35);
          box-shadow:
            0 40px 80px -30px rgba(139,92,246,0.5),
            0 0 0 1px rgba(168,85,247,0.15) inset,
            0 0 60px -20px rgba(236,72,153,0.4);
          color: #f3e8ff;
        }
        .bio3d-card.bio-theme-terminal {
          background: linear-gradient(160deg, #050505, #0a0a0a);
          border-color: rgba(80,255,120,0.25);
          box-shadow:
            0 30px 70px -28px rgba(0,0,0,0.9),
            0 0 40px -20px rgba(80,255,120,0.35);
          color: #b6ffc7;
          font-family: 'Geist Mono', ui-monospace, monospace;
        }
        .bio3d-card.bio-theme-card {
          background: linear-gradient(160deg, #fafafa, #ececec);
          color: #111;
          border-color: rgba(0,0,0,0.08);
        }
        .bio3d-shine {
          position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.10) 50%, transparent 65%);
          mix-blend-mode: overlay;
          transform: translateZ(40px);
        }
        .bio3d-link {
          display: flex; align-items: center; justify-content: space-between;
          gap: 0.5rem; padding: 0.55rem 0.8rem;
          border-radius: 10px;
          background: color-mix(in oklab, currentColor 6%, transparent);
          border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
          transform: translateZ(22px);
          transition: transform 180ms ease, background 180ms ease;
        }
        .bio3d-link:hover {
          transform: translateZ(40px) scale(1.02);
          background: color-mix(in oklab, currentColor 12%, transparent);
        }
      `}</style>
    </section>
  );
}
