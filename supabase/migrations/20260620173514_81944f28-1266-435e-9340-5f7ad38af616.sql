
-- Admin: cancel/expire all active subs for a target user (used by ban + remove)
CREATE OR REPLACE FUNCTION public.admin_ban_user(_target_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  UPDATE public.subscriptions
    SET status = 'cancelled', expires_at = now()
    WHERE user_id = _target_user AND status = 'active';
END;
$$;

-- Admin: extend or reduce the user's active sub by N days (negative = reduce).
-- If no active sub exists and days > 0, create a granted one.
CREATE OR REPLACE FUNCTION public.admin_adjust_subscription(_target_user uuid, _days int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE sub_id uuid; cur_exp timestamptz;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  SELECT id, expires_at INTO sub_id, cur_exp
    FROM public.subscriptions
    WHERE user_id = _target_user AND status = 'active'
    ORDER BY expires_at DESC NULLS LAST LIMIT 1;
  IF sub_id IS NULL THEN
    IF _days <= 0 THEN RETURN; END IF;
    INSERT INTO public.subscriptions (user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
    VALUES (_target_user, 'admin_grant', 'active', now(), now() + make_interval(days => _days), 'admin', 0, 'ADMIN');
  ELSE
    UPDATE public.subscriptions
      SET expires_at = GREATEST(now(), COALESCE(cur_exp, now())) + make_interval(days => _days),
          status = CASE WHEN GREATEST(now(), COALESCE(cur_exp, now())) + make_interval(days => _days) <= now()
                        THEN 'expired' ELSE 'active' END
      WHERE id = sub_id;
  END IF;
END;
$$;

-- Public-ish helper: is a given user banned? Returns true even when caller is unauthenticated.
CREATE OR REPLACE FUNCTION public.is_user_banned(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT is_banned FROM public.profiles WHERE id = _user_id), false)
$$;

GRANT EXECUTE ON FUNCTION public.admin_ban_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_subscription(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_banned(uuid) TO authenticated, anon;
