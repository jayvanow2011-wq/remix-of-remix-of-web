import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const Schema = z.object({
  device_id: z.string().uuid(),
  device_token: z.string().min(32).max(128).regex(/^[a-f0-9]+$/),
  command_id: z.string().uuid(),
  ok: z.boolean(),
  result: z.any().optional(),
  error: z.string().max(4000).optional(),
});

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export const Route = createFileRoute("/api/public/agent/result")({
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
        if (!parsed.success) return Response.json({ error: "Invalid input" }, { status: 400 });
        const { device_id, device_token, command_id, ok, result, error } = parsed.data;

        const { data: device } = await supabaseAdmin
          .from("devices")
          .select("id, device_token_hash")
          .eq("id", device_id)
          .maybeSingle();
        if (!device?.device_token_hash || sha256(device_token) !== device.device_token_hash) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        await supabaseAdmin
          .from("commands")
          .update({
            status: ok ? "done" : "error",
            result: result ?? null,
            error: error ?? null,
            completed_at: new Date().toISOString(),
          })
          .eq("id", command_id)
          .eq("device_id", device_id);

        return Response.json({ ok: true });
      },
    },
  },
});
