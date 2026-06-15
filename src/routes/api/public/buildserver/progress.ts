import { createFileRoute } from '@tanstack/react-router'
import { supabaseAdmin } from '@/integrations/supabase/client.server'

async function verifyBuildserverKey(request: Request): Promise<boolean> {
  const key = request.headers.get('x-buildserver-key')
  if (!key) return false
  const { data } = await supabaseAdmin
    .from('build_server_config')
    .select('id')
    .eq('key', key)
    .maybeSingle()
  return !!data
}

export const Route = createFileRoute('/api/public/buildserver/progress')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await verifyBuildserverKey(request))) {
          return new Response('Unauthorized', { status: 401 })
        }

        const body = await request.json() as {
          build_id: string
          progress: number
          status: string
          error?: string
          download_url?: string
        }

        const update = {
          progress: body.progress,
          status: body.status,
          error: body.error ?? null,
          download_url: body.download_url ?? null,
          completed_at: (body.status === 'success' || body.status === 'failed')
            ? new Date().toISOString()
            : undefined,
        }

        const { error } = await supabaseAdmin
          .from('builds')
          .update(update as any)
          .eq('id', body.build_id)

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), { status: 500 })
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
