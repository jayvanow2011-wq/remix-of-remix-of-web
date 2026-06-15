import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type BioLink = {
  id: string;
  title: string;
  url: string;
  icon: string | null;
  position: number;
  clicks: number;
};

export const listMyLinks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("bio_links").select("id,title,url,icon,position,clicks")
      .eq("user_id", context.userId).order("position");
    return { links: (data ?? []) as BioLink[] };
  });

export const upsertLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id?: string; title: string; url: string; icon?: string; position?: number }) => d)
  .handler(async ({ data, context }) => {
    const row = {
      user_id: context.userId,
      title: data.title.trim().slice(0, 60),
      url: data.url.trim().slice(0, 500),
      icon: data.icon?.slice(0, 30) ?? null,
      position: data.position ?? 0,
    } as never;
    if (data.id) {
      const { error } = await context.supabase.from("bio_links").update(row).eq("id", data.id);
      if (error) throw error;
    } else {
      const { error } = await context.supabase.from("bio_links").insert(row);
      if (error) throw error;
    }
    return { ok: true };
  });

export const deleteLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    await context.supabase.from("bio_links").delete().eq("id", data.id);
    return { ok: true };
  });

export const reorderLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[] }) => d)
  .handler(async ({ data, context }) => {
    await Promise.all(
      data.ids.map((id, i) =>
        context.supabase.from("bio_links").update({ position: i } as never).eq("id", id)
      )
    );
    return { ok: true };
  });

export const updateBioProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    bio?: string;
    socials?: Record<string, string>;
    bio_theme?: "terminal" | "card" | "neon";
    bio_public?: boolean;
    display_name?: string;
  }) => d)
  .handler(async ({ data, context }) => {
    await context.supabase.from("profiles").update({
      bio: data.bio?.slice(0, 280),
      socials: data.socials,
      bio_theme: data.bio_theme,
      bio_public: data.bio_public,
      display_name: data.display_name?.slice(0, 60),
    } as never).eq("id", context.userId);
    return { ok: true };
  });

// Public — no auth. Used by /u/$handle
export const getPublicBio = createServerFn({ method: "POST" })
  .inputValidator((d: { handle: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const handle = data.handle.trim().toLowerCase();
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("id,username,full_name,display_name,avatar_url,bio,socials,bio_theme,bio_public,is_banned,is_removed")
      .ilike("username", handle).maybeSingle();
    if (!prof || (prof as any).is_banned || (prof as any).is_removed || !(prof as any).bio_public) {
      return { profile: null, links: [] };
    }
    const { data: links } = await supabaseAdmin
      .from("bio_links").select("id,title,url,icon,position,clicks")
      .eq("user_id", (prof as any).id).order("position");
    return { profile: prof, links: (links ?? []) as BioLink[] };
  });

export const bumpClick = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("bio_links").select("clicks").eq("id", data.id).maybeSingle();
    const cur = (row as { clicks?: number } | null)?.clicks ?? 0;
    await supabaseAdmin.from("bio_links")
      .update({ clicks: cur + 1 } as never).eq("id", data.id);
    return { ok: true };
  });