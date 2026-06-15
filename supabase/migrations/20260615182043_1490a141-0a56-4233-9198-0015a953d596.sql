
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS user_number BIGINT UNIQUE;
CREATE SEQUENCE IF NOT EXISTS public.profile_user_number_seq START WITH 1;
ALTER TABLE public.profiles ALTER COLUMN user_number SET DEFAULT nextval('public.profile_user_number_seq');
ALTER SEQUENCE public.profile_user_number_seq OWNED BY public.profiles.user_number;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  meta jsonb := COALESCE(new.raw_user_meta_data, '{}'::jsonb);
  ref_code text; ref_user uuid; is_admin boolean := false;
  uname text := lower(COALESCE(meta->>'username', ''));
  next_num bigint := nextval('public.profile_user_number_seq');
BEGIN
  ref_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  IF meta ? 'ref_code' AND length(meta->>'ref_code') > 0 THEN
    SELECT id INTO ref_user FROM public.profiles WHERE referral_code = upper(meta->>'ref_code') LIMIT 1;
  END IF;
  INSERT INTO public.profiles (id, email, full_name, avatar_url, discord_id, discord_username, profile_completed, referral_code, referred_by, username, user_number)
  VALUES (new.id, new.email, COALESCE(meta->>'full_name', meta->>'discord_username', meta->>'username', new.email),
    meta->>'avatar_url', meta->>'discord_id', meta->>'discord_username', false, ref_code, ref_user, NULLIF(uname, ''), next_num)
  ON CONFLICT (id) DO UPDATE SET
    avatar_url = COALESCE(excluded.avatar_url, public.profiles.avatar_url),
    referral_code = COALESCE(public.profiles.referral_code, excluded.referral_code),
    referred_by = COALESCE(public.profiles.referred_by, excluded.referred_by),
    username = COALESCE(public.profiles.username, excluded.username),
    user_number = COALESCE(public.profiles.user_number, excluded.user_number);
  INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'operator') ON CONFLICT DO NOTHING;
  IF lower(new.email) IN ('jayjay@veltrix.xyz','jayjay@larping.cy') OR uname = 'jayjay' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'admin') ON CONFLICT DO NOTHING;
    is_admin := true;
  END IF;
  INSERT INTO public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
  VALUES (new.id, CASE WHEN is_admin THEN 'admin_grant' ELSE 'trial' END, 'active', now(),
    now() + CASE WHEN is_admin THEN interval '365 days' ELSE interval '3 days' END,
    CASE WHEN is_admin THEN 'admin' ELSE 'trial' END, 0,
    CASE WHEN is_admin THEN 'ADMIN' ELSE 'TRIAL' END);
  RETURN new;
END; $function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
