import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const Schema = z.object({
  device_id: z.string().uuid(),
  device_token: z.string().min(32).max(128).regex(/^[a-f0-9]+$/),
  jpeg_b64: z.string().min(100).max(8_000_000),
});

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export const Route = createFileRoute("/api/public/agent/screen")({
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
        const { device_id, device_token, jpeg_b64 } = parsed.data;

        const { data: device } = await supabaseAdmin
          .from("devices")
          .select("id, device_token_hash")
          .eq("id", device_id)
          .maybeSingle();
        if (!device?.device_token_hash || sha256(device_token) !== device.device_token_hash) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const ts = new Date().toISOString();
        // Hot path: broadcast the JPEG to the live viewer channel.
        const { broadcast } = await import("@/lib/realtime-broadcast.server");
        await broadcast(`device-frames-${device_id}`, "screen", {
          jpeg_b64,
          ts,
        });
        // Cold path: stash the latest frame + timestamp on the row so a
        // viewer that opens the page mid-stream sees something immediately.
        // We don't await this — broadcast is the source of truth for FPS.
        void supabaseAdmin
          .from("devices")
          .update({ last_screen_at: ts })
          .eq("id", device_id);

        return Response.json({ ok: true });
      },
    },
  },
});
