import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const UuidSchema = z.string().uuid();

export const listFriendDevices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ friend_id: UuidSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: f } = await supabase
      .from("friendships")
      .select("id")
      .eq("status", "accepted")
      .or(
        `and(requester_id.eq.${userId},addressee_id.eq.${data.friend_id}),and(requester_id.eq.${data.friend_id},addressee_id.eq.${userId})`,
      )
      .maybeSingle();
    if (!f) throw new Error("Not friends");
    const { data: devs } = await supabaseAdmin
      .from("devices")
      .select("id,device_name,pc_name,is_online")
      .eq("owner_user_id", data.friend_id);
    return { devices: devs ?? [] };
  });

function convKey(a: string, b: string): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

// Host shares one of their own devices with a friend.
export const shareClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ device_id: UuidSchema, to_user_id: UuidSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: dev } = await supabase
      .from("devices")
      .select("id,device_name,owner_user_id")
      .eq("id", data.device_id)
      .maybeSingle();
    if (!dev || dev.owner_user_id !== userId) throw new Error("Not your device");

    const { data: share, error } = await supabase
      .from("client_shares")
      .insert({
        device_id: data.device_id,
        host_user_id: userId,
        shared_with_user_id: data.to_user_id,
        initiator_id: userId,
        flow: "share",
        status: "pending",
      } as any)
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const key = convKey(userId, data.to_user_id);
    const { data: dm } = await supabase
      .from("direct_messages")
      .insert({
        conversation_key: key,
        sender_id: userId,
        recipient_id: data.to_user_id,
        kind: "share_client",
        body: `Sharing access to ${dev.device_name}`,
        payload: { share_id: share.id, device_id: dev.id, device_name: dev.device_name, flow: "share" },
      } as any)
      .select("id")
      .single();
    if (dm) await supabase.from("client_shares").update({ dm_id: dm.id } as any).eq("id", share.id);

    await supabase.from("notifications").insert({
      user_id: data.to_user_id,
      title: "Client shared",
      body: `${dev.device_name} was shared with you`,
      kind: "client_share",
      payload: { share_id: share.id, device_id: dev.id, device_name: dev.device_name },
    } as any);

    return { ok: true, share_id: share.id };
  });

// Friend requests access to a device the friend owns.
export const requestClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ device_id: UuidSchema, host_id: UuidSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: dev } = await supabase
      .from("devices")
      .select("id,device_name,owner_user_id")
      .eq("id", data.device_id)
      .maybeSingle();
    if (!dev || dev.owner_user_id !== data.host_id) throw new Error("Invalid device/host");

    const { data: share, error } = await supabase
      .from("client_shares")
      .insert({
        device_id: data.device_id,
        host_user_id: data.host_id,
        shared_with_user_id: userId,
        initiator_id: userId,
        flow: "request",
        status: "pending",
      } as any)
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const key = convKey(userId, data.host_id);
    const { data: dm } = await supabase
      .from("direct_messages")
      .insert({
        conversation_key: key,
        sender_id: userId,
        recipient_id: data.host_id,
        kind: "request_client",
        body: `Requesting access to ${dev.device_name}`,
        payload: { share_id: share.id, device_id: dev.id, device_name: dev.device_name, flow: "request" },
      } as any)
      .select("id")
      .single();
    if (dm) await supabase.from("client_shares").update({ dm_id: dm.id } as any).eq("id", share.id);

    await supabase.from("notifications").insert({
      user_id: data.host_id,
      title: "Client access requested",
      body: `Someone wants access to ${dev.device_name}`,
      kind: "client_request",
      payload: { share_id: share.id, device_id: dev.id, device_name: dev.device_name },
    } as any);

    return { ok: true, share_id: share.id };
  });

export const respondShare = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ share_id: UuidSchema, accept: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await (supabase.rpc as any)("respond_to_share", {
      _share_id: data.share_id,
      _accept: data.accept,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listDeviceAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ device_id: UuidSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows } = await supabase
      .from("device_access")
      .select("id,user_id,role,created_at")
      .eq("device_id", data.device_id);
    const ids = (rows ?? []).map((r) => r.user_id);
    const { data: profiles } = ids.length
      ? await supabase.from("profiles").select("id,username,full_name,avatar_url").in("id", ids)
      : { data: [] as any[] };
    const pmap = new Map((profiles ?? []).map((p) => [p.id, p]));
    return {
      access: (rows ?? []).map((r) => ({ ...r, profile: pmap.get(r.user_id) ?? null })),
    };
  });

export const revokeAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ device_id: UuidSchema, user_id: UuidSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: dev } = await supabase
      .from("devices")
      .select("owner_user_id")
      .eq("id", data.device_id)
      .maybeSingle();
    if (!dev || dev.owner_user_id !== userId) throw new Error("Not your device");
    if (data.user_id === userId) throw new Error("Cannot revoke host");
    await supabase
      .from("device_access")
      .delete()
      .eq("device_id", data.device_id)
      .eq("user_id", data.user_id);
    return { ok: true };
  });
