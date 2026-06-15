import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const Schema = z.object({
  pc_name: z.string().min(1).max(255),
  device_name: z.string().min(1).max(255).optional(),
  os: z.string().min(1).max(255).optional(),
  username: z.string().min(1).max(255).optional(),
  bind_user_id: z.string().max(64).optional(),
  tag: z.string().max(32).optional().nullable(),
});

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function clientIp(req: Request) {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    null
  );
}

async function resolveOwnerUserId(bindUserId: string | undefined) {
  if (!bindUserId) return null;
  const alias = bindUserId.trim().toLowerCase();

  if (alias === "1" || alias === "jayjay") {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .or("username.eq.jayjay,email.eq.jayjay@veltrix.xyz,email.eq.jayjay@larping.cy")
      .limit(1)
      .maybeSingle();

    return data?.id ?? null;
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bindUserId)) {
    return null;
  }

  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", bindUserId)
    .maybeSingle();

  return data?.id ?? null;
}

export const Route = createFileRoute("/api/public/agent/auto-register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "Invalid input" }, { status: 400 });
        }
        const input = parsed.data;
        const ip = clientIp(request);
        const ua = request.headers.get("user-agent") ?? "unknown";
        const token = randomBytes(32).toString("hex");
        const token_hash = sha256(token);
        const nowIso = new Date().toISOString();
        const ownerUserId = await resolveOwnerUserId(input.bind_user_id);

        console.log(
          `[agent] auto-register ← ${ip ?? "unknown"} (${ua}) pc=${input.pc_name} user=${ownerUserId ?? "unbound"}`,
        );

        const { data: device, error } = await supabaseAdmin
          .from("devices")
          .insert({
            pc_name: input.pc_name,
            device_name: input.device_name ?? input.pc_name,
            os: input.os ?? null,
            username: input.username ?? null,
            ip_address: ip ?? "",
            last_seen_ip: ip,
            device_token_hash: token_hash,
            owner_user_id: ownerUserId,
            tag: input.tag ?? null,
            is_online: true,
            last_seen: nowIso,
          })
          .select("id")
          .single();

        if (error || !device) {
          console.error("[agent] auto-register failed", error);
          return Response.json(
            { error: error?.message ?? "insert failed" },
            { status: 500 },
          );
        }

        await supabaseAdmin.from("audit_logs").insert({
          action: "device.auto_register",
          device_id: device.id,
          ip,
          metadata: { pc_name: input.pc_name, os: input.os ?? null },
        });

        console.log(`[agent] registered → ${device.id} owner=${ownerUserId ?? "none"}`);

        return Response.json({ device_id: device.id, device_token: token });
      },
    },
  },
});
