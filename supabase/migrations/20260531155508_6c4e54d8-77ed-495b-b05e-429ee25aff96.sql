-- Add missing profile columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ban_reason text,
  ADD COLUMN IF NOT EXISTS is_removed boolean NOT NULL DEFAULT false;

-- turn_servers table
CREATE TABLE IF NOT EXISTS public.turn_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL DEFAULT 'custom',
  url text NOT NULL,
  username text,
  credential text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.turn_servers TO authenticated;
GRANT ALL ON public.turn_servers TO service_role;

ALTER TABLE public.turn_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage TURN servers" ON public.turn_servers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Authenticated read TURN servers" ON public.turn_servers FOR SELECT TO authenticated
  USING (true);

CREATE TRIGGER trg_turn_servers_updated_at BEFORE UPDATE ON public.turn_servers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();