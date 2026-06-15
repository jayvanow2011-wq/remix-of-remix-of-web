
-- Profiles additions
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS totp_secret text,
  ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS socials jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS bio_theme text NOT NULL DEFAULT 'terminal',
  ADD COLUMN IF NOT EXISTS bio_public boolean NOT NULL DEFAULT true;

-- recovery_codes table
CREATE TABLE IF NOT EXISTS public.recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON public.recovery_codes(user_id);

GRANT SELECT ON public.recovery_codes TO authenticated;
GRANT ALL ON public.recovery_codes TO service_role;
ALTER TABLE public.recovery_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own recovery codes" ON public.recovery_codes;
CREATE POLICY "users read own recovery codes" ON public.recovery_codes
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- bio_links table
CREATE TABLE IF NOT EXISTS public.bio_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  url text NOT NULL,
  icon text,
  position int NOT NULL DEFAULT 0,
  clicks int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bio_links_user_pos_idx ON public.bio_links(user_id, position);

GRANT SELECT ON public.bio_links TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bio_links TO authenticated;
GRANT ALL ON public.bio_links TO service_role;
ALTER TABLE public.bio_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner full" ON public.bio_links;
CREATE POLICY "owner full" ON public.bio_links
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "public read when bio_public" ON public.bio_links;
CREATE POLICY "public read when bio_public" ON public.bio_links
  FOR SELECT TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = bio_links.user_id AND p.bio_public = true AND COALESCE(p.is_banned,false) = false));

CREATE TRIGGER bio_links_touch BEFORE UPDATE ON public.bio_links
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- consume_recovery_code: returns true and marks used, false otherwise
CREATE OR REPLACE FUNCTION public.consume_recovery_code(_user_id uuid, _code_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE rid uuid;
BEGIN
  SELECT id INTO rid FROM public.recovery_codes
   WHERE user_id = _user_id AND code_hash = _code_hash AND used_at IS NULL
   LIMIT 1;
  IF rid IS NULL THEN RETURN false; END IF;
  UPDATE public.recovery_codes SET used_at = now() WHERE id = rid;
  RETURN true;
END;
$$;

-- Allow anon profile read of public bio fields via a view-safe policy addition
DROP POLICY IF EXISTS "Public bio profile read" ON public.profiles;
CREATE POLICY "Public bio profile read" ON public.profiles
  FOR SELECT TO anon
  USING (bio_public = true AND COALESCE(is_banned, false) = false);
