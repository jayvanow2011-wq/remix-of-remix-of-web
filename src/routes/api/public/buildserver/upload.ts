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

export const Route = createFileRoute('/api/public/buildserver/upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get('x-buildserver-key')
        if (!key) return new Response('Unauthorized', { status: 401 })

        // Verify key
        const { data: keyRow } = await supabaseAdmin
          .from('build_server_config')
          .select('id')
          .eq('key', key)
          .maybeSingle()
        if (!keyRow) return new Response('Unauthorized', { status: 401 })

        // Parse multipart
        const formData = await request.formData()
        const file = formData.get('file') as File | null
        const buildId = formData.get('build_id') as string | null

        if (!file || !buildId) {
          return new Response(JSON.stringify({ error: 'Missing file or build_id' }), { status: 400 })
        }

        const arrayBuf = await file.arrayBuffer()
        const buffer = new Uint8Array(arrayBuf)
        const fileName = `${buildId}/${file.name}`

        const { error: uploadError } = await supabaseAdmin.storage
          .from('builds')
          .upload(fileName, buffer, {
            contentType: 'application/octet-stream',
            upsert: true,
          })

        if (uploadError) {
          return new Response(JSON.stringify({ error: uploadError.message }), { status: 500 })
        }

        const { data: urlData } = supabaseAdmin.storage
          .from('builds')
          .getPublicUrl(fileName)

        return new Response(JSON.stringify({ download_url: urlData.publicUrl }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
