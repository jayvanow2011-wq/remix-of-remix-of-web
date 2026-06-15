import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import {
  Megaphone, X, Search, Save, Plus, Edit3, Eye, ChevronLeft,
  ExternalLink, Loader2, ImageIcon, ShoppingBag,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/ads")({
  component: AdsPage,
});

type Spot = {
  id: string;
  slot_number: number;
  title: string;
  short_description: string;
  long_description: string;
  front_image: string | null;
  images: string[];
  buttons: { label: string; url: string }[];
  owner_user_id: string | null;
  is_for_sale: boolean;
  is_active: boolean;
};

function AdsPage() {
  const { user } = useAuth();
  const [spots, setSpots] = useState<Spot[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Spot | null>(null);
  const [editing, setEditing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminAssign, setAdminAssign] = useState(false);
  const [searchUser, setSearchUser] = useState("");
  const [foundUsers, setFoundUsers] = useState<{ id: string; username: string }[]>([]);

  const load = async () => {
    const { data } = await supabase.from("ad_spots").select("*").order("slot_number");
    setSpots((data ?? []) as any);
    setLoading(false);
  };

  useEffect(() => {
    load();
    if (user) {
      supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle()
        .then(({ data }) => setIsAdmin(!!data));
    }
  }, [user]);

  const searchUsers = async (q: string) => {
    setSearchUser(q);
    if (q.length < 2) { setFoundUsers([]); return; }
    const { data } = await supabase
      .from("profiles")
      .select("id, username")
      .ilike("username", `%${q}%`)
      .limit(10);
    setFoundUsers((data ?? []).filter((u: any) => u.username) as any);
  };

  const assignSpot = async (spotId: string, userId: string) => {
    await supabase.from("ad_spots").update({ owner_user_id: userId, is_for_sale: false } as any).eq("id", spotId);
    toast.success("Spot assigned!");
    setAdminAssign(false);
    setSearchUser("");
    setFoundUsers([]);
    load();
  };

  const saveSpot = async (spot: Spot) => {
    const { error } = await supabase
      .from("ad_spots")
      .update({
        title: spot.title,
        short_description: spot.short_description,
        long_description: spot.long_description,
        front_image: spot.front_image,
        images: spot.images,
        buttons: spot.buttons,
      } as any)
      .eq("id", spot.id);
    if (error) toast.error(error.message);
    else { toast.success("Saved!"); load(); setEditing(false); }
  };

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  if (selected) {
    const isOwner = user?.id === selected.owner_user_id;
    const canEdit = isOwner || isAdmin;

    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <button onClick={() => { setSelected(null); setEditing(false); }} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" /> Back to spots
        </button>

        {editing ? (
          <SpotEditor spot={selected} onSave={saveSpot} onCancel={() => setEditing(false)} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-semibold">{selected.title || `Spot #${selected.slot_number}`}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{selected.short_description}</p>
              </div>
              <div className="flex gap-2">
                {canEdit && (
                  <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
                    <Edit3 className="h-3.5 w-3.5" /> Edit
                  </button>
                )}
                {isAdmin && (
                  <button onClick={() => setAdminAssign(true)} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
                    Assign owner
                  </button>
                )}
              </div>
            </div>

            {selected.front_image && (
              <img src={selected.front_image} alt="" className="w-full rounded-xl border border-border object-cover max-h-80" />
            )}

            {selected.long_description && (
              <div className="rounded-xl border border-border bg-card p-4 text-sm leading-relaxed whitespace-pre-wrap">
                {selected.long_description}
              </div>
            )}

            {selected.images.length > 0 && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {selected.images.map((img, i) => (
                  <img key={i} src={img} alt="" className="rounded-lg border border-border object-cover aspect-video" />
                ))}
              </div>
            )}

            {selected.buttons.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selected.buttons.map((btn, i) => (
                  <a key={i} href={btn.url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                    {btn.label} <ExternalLink className="h-3 w-3" />
                  </a>
                ))}
              </div>
            )}

            {selected.is_for_sale && (
              <div className="rounded-xl border border-border bg-secondary/40 p-4 text-center">
                <ShoppingBag className="mx-auto h-6 w-6 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">This spot is for sale</p>
                <p className="text-xs text-muted-foreground">Contact admin to purchase this advertising slot.</p>
              </div>
            )}
          </div>
        )}

        {adminAssign && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4" onClick={() => setAdminAssign(false)}>
            <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl">
              <h3 className="text-base font-semibold">Assign spot to user</h3>
              <input
                value={searchUser}
                onChange={(e) => searchUsers(e.target.value)}
                placeholder="Search username…"
                className="mt-3 w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
                {foundUsers.map((u) => (
                  <button key={u.id} onClick={() => assignSpot(selected.id, u.id)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent text-left">
                    {u.username}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Megaphone className="h-6 w-6" /> Ad Spots
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Premium advertising slots. Contact admin to buy a spot.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {spots.map((spot) => (
          <button
            key={spot.id}
            onClick={() => setSelected(spot)}
            className="group flex flex-col rounded-xl border border-border bg-card overflow-hidden text-left transition hover:border-primary/40 hover:shadow-lg"
          >
            {spot.front_image ? (
              <img src={spot.front_image} alt="" className="h-36 w-full object-cover" />
            ) : (
              <div className="flex h-36 items-center justify-center bg-secondary/40">
                <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
              </div>
            )}
            <div className="flex-1 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{spot.title || `Spot #${spot.slot_number}`}</span>
                {spot.is_for_sale && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">FOR SALE</span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{spot.short_description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SpotEditor({ spot, onSave, onCancel }: { spot: Spot; onSave: (s: Spot) => void; onCancel: () => void }) {
  const [s, setS] = useState({ ...spot });
  const [newImg, setNewImg] = useState("");
  const [newBtnLabel, setNewBtnLabel] = useState("");
  const [newBtnUrl, setNewBtnUrl] = useState("");

  const update = (key: keyof Spot, value: any) => setS((p) => ({ ...p, [key]: value }));

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">Edit Spot #{s.slot_number}</h2>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Title</span>
        <input value={s.title} onChange={(e) => update("title", e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary" />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Short description</span>
        <input value={s.short_description} onChange={(e) => update("short_description", e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary" />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Long description</span>
        <textarea value={s.long_description} onChange={(e) => update("long_description", e.target.value)} rows={4}
          className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary resize-none" />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Front image URL</span>
        <input value={s.front_image ?? ""} onChange={(e) => update("front_image", e.target.value || null)}
          className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary" />
      </label>

      <div>
        <span className="text-xs font-medium text-muted-foreground">Gallery images</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {s.images.map((img, i) => (
            <div key={i} className="group relative">
              <img src={img} alt="" className="h-16 w-16 rounded border border-border object-cover" />
              <button onClick={() => update("images", s.images.filter((_, j) => j !== i))}
                className="absolute -right-1 -top-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground group-hover:block">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input value={newImg} onChange={(e) => setNewImg(e.target.value)} placeholder="Image URL"
            className="flex-1 rounded-md border border-border bg-input px-3 py-1.5 text-sm outline-none focus:border-primary" />
          <button onClick={() => { if (newImg) { update("images", [...s.images, newImg]); setNewImg(""); } }}
            className="rounded-md bg-secondary px-3 py-1.5 text-sm hover:bg-accent">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground">Buttons</span>
        <div className="mt-1 space-y-1">
          {s.buttons.map((btn, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate">{btn.label} → {btn.url}</span>
              <button onClick={() => update("buttons", s.buttons.filter((_, j) => j !== i))}
                className="text-destructive hover:underline">Remove</button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input value={newBtnLabel} onChange={(e) => setNewBtnLabel(e.target.value)} placeholder="Label"
            className="w-24 rounded-md border border-border bg-input px-2 py-1.5 text-sm outline-none" />
          <input value={newBtnUrl} onChange={(e) => setNewBtnUrl(e.target.value)} placeholder="URL"
            className="flex-1 rounded-md border border-border bg-input px-2 py-1.5 text-sm outline-none" />
          <button onClick={() => { if (newBtnLabel && newBtnUrl) { update("buttons", [...s.buttons, { label: newBtnLabel, url: newBtnUrl }]); setNewBtnLabel(""); setNewBtnUrl(""); } }}
            className="rounded-md bg-secondary px-3 py-1.5 text-sm hover:bg-accent">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <button onClick={onCancel} className="flex-1 rounded-md border border-border bg-secondary px-4 py-2 text-sm hover:bg-accent">Cancel</button>
        <button onClick={() => onSave(s)} className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Save className="mr-1 inline h-4 w-4" /> Save
        </button>
      </div>
    </div>
  );
}
