
-- Add platform + capabilities to devices
DO $$ BEGIN ALTER TABLE public.devices ADD COLUMN platform text NOT NULL DEFAULT 'windows'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.devices ADD COLUMN capabilities jsonb DEFAULT '{}'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Add platform to builds
DO $$ BEGIN ALTER TABLE public.builds ADD COLUMN platform text NOT NULL DEFAULT 'windows'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Create server_endpoints if not exists
CREATE TABLE IF NOT EXISTS public.server_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('frontend', 'ws_relay', 'buildserver', 'lunes_host')),
  label text NOT NULL DEFAULT '',
  url text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_server_endpoints_default_per_kind ON public.server_endpoints (kind) WHERE is_default = true;

GRANT SELECT ON public.server_endpoints TO authenticated;
GRANT ALL ON public.server_endpoints TO service_role;

ALTER TABLE public.server_endpoints ENABLE ROW LEVEL SECURITY;

-- Drop policies if they exist from partial previous run, then recreate
DROP POLICY IF EXISTS "Authenticated users can read endpoints" ON public.server_endpoints;
CREATE POLICY "Authenticated users can read endpoints" ON public.server_endpoints
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins can manage endpoints" ON public.server_endpoints;
CREATE POLICY "Admins can manage endpoints" ON public.server_endpoints
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
