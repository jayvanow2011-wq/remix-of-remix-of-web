-- Consolidated finishing migration: add missing tables, columns, functions, policies, grants.

-- Profile extensions
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS discord_id text,
  ADD COLUMN IF NOT EXISTS discord_username text,
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'dark',
  ADD COLUMN IF NOT EXISTS profile_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discord_rpc_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discord_status_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS referred_by uuid,
  ADD COLUMN IF NOT EXISTS recovery_token_hash text,
  ADD COLUMN IF NOT EXISTS recovery_token_set_at timestamptz;

DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_username_unique UNIQUE (username);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_discord_id_unique UNIQUE (discord_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_referral_code_unique UNIQUE (referral_code);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS profiles_username_idx ON public.profiles (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_ci_uidx
  ON public.profiles (lower(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS profiles_referral_code_idx ON public.profiles (referral_code);

UPDATE public.profiles
   SET referral_code = upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8))
 WHERE referral_code IS NULL;

DROP POLICY IF EXISTS "Users insert own profile" ON public.profiles;
CREATE POLICY "Users insert own profile" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- commands (raw queue)
CREATE TABLE IF NOT EXISTS public.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS commands_device_status_idx ON public.commands (device_id, status, created_at);
ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read commands" ON public.commands;
DROP POLICY IF EXISTS "Operators insert commands" ON public.commands;
DROP POLICY IF EXISTS "Operators update commands" ON public.commands;
CREATE POLICY "Operators read commands"  ON public.commands FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'operator') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Operators insert commands" ON public.commands FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'operator') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Operators update commands" ON public.commands FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'operator') OR public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE ON public.commands TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.commands TO anon;
GRANT ALL ON public.commands TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.commands; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.commands REPLICA IDENTITY FULL;

-- subscriptions
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  provider text NOT NULL DEFAULT 'nowpayments',
  provider_payment_id text,
  amount_usd numeric,
  currency text,
  started_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'nowpayments',
  ADD COLUMN IF NOT EXISTS provider_payment_id text,
  ADD COLUMN IF NOT EXISTS amount_usd numeric,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON public.subscriptions(user_id);
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own subs" ON public.subscriptions;
DROP POLICY IF EXISTS "Service inserts subs" ON public.subscriptions;
DROP POLICY IF EXISTS "Admins insert subs" ON public.subscriptions;
DROP POLICY IF EXISTS "Admins update subs" ON public.subscriptions;
CREATE POLICY "Users read own subs" ON public.subscriptions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Service inserts subs" ON public.subscriptions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admins insert subs" ON public.subscriptions FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins update subs" ON public.subscriptions FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
GRANT SELECT, INSERT, UPDATE ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;

-- community_posts
CREATE TABLE IF NOT EXISTS public.community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('news','reviews','chat')),
  body text, image_url text, kind text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_posts_channel_idx ON public.community_posts(channel, created_at DESC);
ALTER TABLE public.community_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone read community" ON public.community_posts;
DROP POLICY IF EXISTS "Admins post news" ON public.community_posts;
DROP POLICY IF EXISTS "Authors delete own" ON public.community_posts;
CREATE POLICY "Anyone read community" ON public.community_posts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins post news" ON public.community_posts FOR INSERT TO authenticated
  WITH CHECK ((channel='news' AND public.has_role(auth.uid(),'admin')) OR (channel IN ('reviews','chat') AND author_id = auth.uid()));
CREATE POLICY "Authors delete own" ON public.community_posts FOR DELETE TO authenticated
  USING (author_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, DELETE ON public.community_posts TO authenticated;
GRANT ALL ON public.community_posts TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.community_posts; EXCEPTION WHEN others THEN NULL; END $w$;

-- notifications
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text,
  kind text NOT NULL DEFAULT 'system',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS notifications_user_idx ON public.notifications(user_id, created_at DESC);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own notifs" ON public.notifications;
DROP POLICY IF EXISTS "Users update own notifs" ON public.notifications;
DROP POLICY IF EXISTS "Admins create notifs" ON public.notifications;
CREATE POLICY "Users read own notifs" ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL);
CREATE POLICY "Users update own notifs" ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Admins create notifs" ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

-- active_sessions
CREATE TABLE IF NOT EXISTS public.active_sessions (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  user_agent text, ip text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.active_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own session" ON public.active_sessions;
DROP POLICY IF EXISTS "Users upsert own session" ON public.active_sessions;
DROP POLICY IF EXISTS "Users update own session" ON public.active_sessions;
DROP POLICY IF EXISTS "Users delete own session" ON public.active_sessions;
CREATE POLICY "Users read own session" ON public.active_sessions FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users upsert own session" ON public.active_sessions FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users update own session" ON public.active_sessions FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users delete own session" ON public.active_sessions FOR DELETE TO authenticated USING (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.active_sessions TO authenticated;
GRANT ALL ON public.active_sessions TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.active_sessions; EXCEPTION WHEN others THEN NULL; END $w$;

-- storage buckets
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars','avatars',true) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('chat','chat',true) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('builds','builds',true) ON CONFLICT DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "Avatar public read" ON storage.objects FOR SELECT USING (bucket_id='avatars');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Avatar owner write" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id='avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Avatar owner update" ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id='avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Chat public read" ON storage.objects FOR SELECT USING (bucket_id='chat');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Chat owner write" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id='chat' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Builds public read" ON storage.objects FOR SELECT USING (bucket_id='builds');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Users upload build icons" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id='builds' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- builds
CREATE TABLE IF NOT EXISTS public.builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  startup boolean NOT NULL DEFAULT false,
  startup_name text,
  debug boolean NOT NULL DEFAULT false,
  output_kind text NOT NULL DEFAULT 'exe',
  icon_url text,
  status text NOT NULL DEFAULT 'queued',
  download_url text,
  error text,
  progress integer NOT NULL DEFAULT 0,
  target_server_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS target_server_url text;
CREATE INDEX IF NOT EXISTS builds_user_idx ON public.builds(user_id, created_at DESC);
ALTER TABLE public.builds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own builds" ON public.builds;
DROP POLICY IF EXISTS "Users insert own builds" ON public.builds;
DROP POLICY IF EXISTS "Users delete own builds" ON public.builds;
DROP POLICY IF EXISTS "Service update builds" ON public.builds;
CREATE POLICY "Users read own builds" ON public.builds FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users insert own builds" ON public.builds FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users delete own builds" ON public.builds FOR DELETE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Service update builds" ON public.builds FOR UPDATE TO anon USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.builds TO authenticated;
GRANT UPDATE ON public.builds TO anon;
GRANT ALL ON public.builds TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.builds; EXCEPTION WHEN others THEN NULL; END $w$;

-- build_server_config buildserver_url and last_seen
ALTER TABLE public.build_server_config
  ADD COLUMN IF NOT EXISTS buildserver_url text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
INSERT INTO public.build_server_config (key, label)
SELECT 'bsk_' || encode(gen_random_bytes(32), 'hex'), 'default'
WHERE NOT EXISTS (SELECT 1 FROM public.build_server_config);

-- friendships
CREATE TABLE IF NOT EXISTS public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL,
  addressee_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friendships_distinct CHECK (requester_id <> addressee_id),
  CONSTRAINT friendships_unique_pair UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON public.friendships(addressee_id);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON public.friendships(requester_id);
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Friendship readable by either party" ON public.friendships;
DROP POLICY IF EXISTS "Users send friend requests" ON public.friendships;
DROP POLICY IF EXISTS "Either party updates friendship" ON public.friendships;
DROP POLICY IF EXISTS "Either party deletes friendship" ON public.friendships;
CREATE POLICY "Friendship readable by either party" ON public.friendships FOR SELECT TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);
CREATE POLICY "Users send friend requests" ON public.friendships FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = requester_id);
CREATE POLICY "Either party updates friendship" ON public.friendships FOR UPDATE TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);
CREATE POLICY "Either party deletes friendship" ON public.friendships FOR DELETE TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);
DROP TRIGGER IF EXISTS friendships_touch ON public.friendships;
CREATE TRIGGER friendships_touch BEFORE UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friendships TO authenticated;
GRANT ALL ON public.friendships TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.friendships REPLICA IDENTITY FULL;

-- direct_messages
CREATE TABLE IF NOT EXISTS public.direct_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_key text NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','share_client','request_client','system')),
  body text, image_url text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dm_conv ON public.direct_messages(conversation_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON public.direct_messages(recipient_id, read_at);
ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DM readable by participants" ON public.direct_messages;
DROP POLICY IF EXISTS "Send DM as self to friend" ON public.direct_messages;
DROP POLICY IF EXISTS "Recipient marks DM read" ON public.direct_messages;
CREATE POLICY "DM readable by participants" ON public.direct_messages FOR SELECT TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
CREATE POLICY "Send DM as self to friend" ON public.direct_messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id AND EXISTS (
    SELECT 1 FROM public.friendships f WHERE f.status = 'accepted'
      AND ((f.requester_id = sender_id AND f.addressee_id = recipient_id)
        OR (f.addressee_id = sender_id AND f.requester_id = recipient_id))
  ));
CREATE POLICY "Recipient marks DM read" ON public.direct_messages FOR UPDATE TO authenticated
  USING (auth.uid() = recipient_id);
GRANT SELECT, INSERT, UPDATE ON public.direct_messages TO authenticated;
GRANT ALL ON public.direct_messages TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.direct_messages; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.direct_messages REPLICA IDENTITY FULL;

-- device_access
CREATE TABLE IF NOT EXISTS public.device_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'controller' CHECK (role IN ('host','controller','viewer')),
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_device_access_user ON public.device_access(user_id);
CREATE INDEX IF NOT EXISTS idx_device_access_device ON public.device_access(device_id);
ALTER TABLE public.device_access ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_device_owner(_device_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.devices WHERE id = _device_id AND owner_user_id = _user_id)
$$;

CREATE OR REPLACE FUNCTION public.has_device_access(_device_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.device_access WHERE device_id = _device_id AND user_id = _user_id)
$$;

DROP POLICY IF EXISTS "Read device access rows" ON public.device_access;
DROP POLICY IF EXISTS "Host or admin manages device access" ON public.device_access;
CREATE POLICY "Read device access rows" ON public.device_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_device_owner(device_id, auth.uid()) OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Host or admin manages device access" ON public.device_access FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.is_device_owner(device_id, auth.uid()))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR public.is_device_owner(device_id, auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_access TO authenticated;
GRANT ALL ON public.device_access TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.device_access; EXCEPTION WHEN others THEN NULL; END $w$;

INSERT INTO public.device_access (device_id, user_id, role, granted_by)
SELECT d.id, d.owner_user_id, 'host', d.owner_user_id
FROM public.devices d WHERE d.owner_user_id IS NOT NULL
ON CONFLICT DO NOTHING;

DROP POLICY IF EXISTS "Authenticated read accessible devices" ON public.devices;
CREATE POLICY "Authenticated read accessible devices" ON public.devices FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid()
    OR public.has_device_access(id, auth.uid())
    OR public.has_role(auth.uid(),'admin'));

-- client_shares
CREATE TABLE IF NOT EXISTS public.client_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  host_user_id uuid NOT NULL,
  shared_with_user_id uuid NOT NULL,
  initiator_id uuid NOT NULL,
  flow text NOT NULL CHECK (flow IN ('share','request')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
  dm_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_client_shares_recipient ON public.client_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_client_shares_host ON public.client_shares(host_user_id);
ALTER TABLE public.client_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Share readable by participants" ON public.client_shares;
DROP POLICY IF EXISTS "Initiator creates share" ON public.client_shares;
DROP POLICY IF EXISTS "Participants update share" ON public.client_shares;
CREATE POLICY "Share readable by participants" ON public.client_shares FOR SELECT TO authenticated
  USING (auth.uid() IN (host_user_id, shared_with_user_id, initiator_id) OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Initiator creates share" ON public.client_shares FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = initiator_id AND (
    (flow = 'share' AND EXISTS (SELECT 1 FROM public.devices d WHERE d.id = device_id AND d.owner_user_id = host_user_id AND host_user_id = auth.uid()))
    OR (flow = 'request' AND EXISTS (SELECT 1 FROM public.devices d WHERE d.id = device_id AND d.owner_user_id = host_user_id AND shared_with_user_id = auth.uid()))
  ));
CREATE POLICY "Participants update share" ON public.client_shares FOR UPDATE TO authenticated
  USING (auth.uid() IN (host_user_id, shared_with_user_id));
GRANT SELECT, INSERT, UPDATE ON public.client_shares TO authenticated;
GRANT ALL ON public.client_shares TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.client_shares; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.client_shares REPLICA IDENTITY FULL;

-- referrals
CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL,
  referee_id uuid NOT NULL UNIQUE,
  bonus_days_awarded int NOT NULL DEFAULT 0,
  milestone_awarded boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Referrer or referee reads referral" ON public.referrals;
CREATE POLICY "Referrer or referee reads referral" ON public.referrals FOR SELECT TO authenticated
  USING (auth.uid() = referrer_id OR auth.uid() = referee_id OR public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;

-- subscription/referral helpers
CREATE OR REPLACE FUNCTION public.extend_subscription(_user_id uuid, _days int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE existing public.subscriptions%rowtype;
BEGIN
  SELECT * INTO existing FROM public.subscriptions
   WHERE user_id = _user_id AND status = 'active'
   ORDER BY expires_at DESC NULLS LAST LIMIT 1;
  IF FOUND THEN
    UPDATE public.subscriptions
       SET expires_at = COALESCE(expires_at, now()) + (_days || ' days')::interval
     WHERE id = existing.id;
  ELSE
    INSERT INTO public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
    VALUES (_user_id, 'referral_bonus', 'active', now(), now() + (_days || ' days')::interval, 'referral', 0, 'BONUS');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_subscription_activation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ref_row public.referrals%rowtype; total_count int; referrer uuid;
BEGIN
  IF new.status <> 'active' THEN RETURN new; END IF;
  IF tg_op = 'UPDATE' AND old.status = 'active' THEN RETURN new; END IF;
  SELECT referred_by INTO referrer FROM public.profiles WHERE id = new.user_id;
  IF referrer IS NULL THEN RETURN new; END IF;
  SELECT * INTO ref_row FROM public.referrals WHERE referee_id = new.user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.referrals(referrer_id, referee_id, bonus_days_awarded, activated_at)
    VALUES (referrer, new.user_id, 30, now()) RETURNING * INTO ref_row;
    PERFORM public.extend_subscription(referrer, 30);
  ELSIF ref_row.activated_at IS NULL THEN
    UPDATE public.referrals SET bonus_days_awarded = 30, activated_at = now() WHERE id = ref_row.id;
    PERFORM public.extend_subscription(referrer, 30);
  ELSE
    RETURN new;
  END IF;
  SELECT count(*) INTO total_count FROM public.referrals WHERE referrer_id = referrer AND activated_at IS NOT NULL;
  IF total_count > 0 AND total_count % 5 = 0 THEN
    PERFORM public.extend_subscription(referrer, 30);
    UPDATE public.referrals SET milestone_awarded = true WHERE id = ref_row.id;
    INSERT INTO public.notifications(user_id, title, body, kind, payload)
    VALUES (referrer, 'Milestone bonus!', 'You hit ' || total_count || ' referrals — +30 days added.',
            'system', jsonb_build_object('milestone', total_count));
  END IF;
  INSERT INTO public.notifications(user_id, title, body, kind, payload)
  VALUES (referrer, 'Referral activated', 'A user you referred just subscribed — +30 days added.',
          'system', jsonb_build_object('referee_id', new.user_id));
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_subscription_activation ON public.subscriptions;
CREATE TRIGGER on_subscription_activation
  AFTER INSERT OR UPDATE OF status ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.handle_subscription_activation();

CREATE OR REPLACE FUNCTION public.admin_adjust_subscription(_target_user uuid, _days integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE existing public.subscriptions%rowtype;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT * INTO existing FROM public.subscriptions
   WHERE user_id = _target_user AND status = 'active'
   ORDER BY expires_at DESC NULLS LAST LIMIT 1;
  IF FOUND THEN
    UPDATE public.subscriptions
       SET expires_at = GREATEST(now(), COALESCE(expires_at, now())) + (_days || ' days')::interval
     WHERE id = existing.id;
  ELSIF _days > 0 THEN
    INSERT INTO public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
    VALUES (_target_user, 'admin_grant', 'active', now(), now() + (_days || ' days')::interval, 'admin', 0, 'ADMIN');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_ban_user(_target_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  UPDATE public.subscriptions SET status = 'cancelled', expires_at = now()
   WHERE user_id = _target_user AND status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_to_share(_share_id uuid, _accept boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  s public.client_shares%rowtype;
  v_device_name text;
  responder uuid := auth.uid();
  granted_user uuid;
  notify_user uuid;
  conv_key text;
BEGIN
  SELECT * INTO s FROM public.client_shares WHERE id = _share_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Share not found'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'Already resolved'; END IF;
  IF s.flow = 'share' AND responder <> s.shared_with_user_id THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF s.flow = 'request' AND responder <> s.host_user_id THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE public.client_shares SET status = CASE WHEN _accept THEN 'accepted' ELSE 'declined' END, responded_at = now() WHERE id = _share_id;
  SELECT d.device_name INTO v_device_name FROM public.devices d WHERE d.id = s.device_id;
  IF _accept THEN
    granted_user := s.shared_with_user_id;
    INSERT INTO public.device_access (device_id, user_id, role, granted_by)
      VALUES (s.device_id, granted_user, 'controller', s.host_user_id) ON CONFLICT DO NOTHING;
  END IF;
  notify_user := s.initiator_id;
  INSERT INTO public.notifications (user_id, title, body, kind, payload)
    VALUES (notify_user,
      CASE WHEN _accept THEN 'Access granted' ELSE 'Access declined' END,
      COALESCE(v_device_name, 'Device') || (CASE WHEN _accept THEN ' is now shared' ELSE ' was declined' END),
      'system',
      jsonb_build_object('share_id', s.id, 'device_id', s.device_id, 'accepted', _accept));
  conv_key := CASE WHEN s.host_user_id < s.shared_with_user_id
                THEN s.host_user_id::text || '_' || s.shared_with_user_id::text
                ELSE s.shared_with_user_id::text || '_' || s.host_user_id::text END;
  INSERT INTO public.direct_messages (conversation_key, sender_id, recipient_id, kind, body, payload)
  VALUES (conv_key, responder,
     CASE WHEN responder = s.host_user_id THEN s.shared_with_user_id ELSE s.host_user_id END,
     'system',
     COALESCE(v_device_name, 'Device') || (CASE WHEN _accept THEN ' — access accepted' ELSE ' — declined' END),
     jsonb_build_object('share_id', s.id, 'device_id', s.device_id, 'accepted', _accept));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.respond_to_share(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_share(uuid, boolean) TO authenticated;

-- replace handle_new_user with the full version (admin auto-grant + trial sub)
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  meta jsonb := COALESCE(new.raw_user_meta_data, '{}'::jsonb);
  ref_code text;
  ref_user uuid;
  is_admin boolean := false;
  uname text := lower(COALESCE(meta->>'username', ''));
BEGIN
  ref_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  IF meta ? 'ref_code' AND length(meta->>'ref_code') > 0 THEN
    SELECT id INTO ref_user FROM public.profiles WHERE referral_code = upper(meta->>'ref_code') LIMIT 1;
  END IF;
  INSERT INTO public.profiles (id, email, full_name, avatar_url, discord_id, discord_username, profile_completed, referral_code, referred_by, username)
  VALUES (new.id, new.email, COALESCE(meta->>'full_name', meta->>'discord_username', meta->>'username', new.email),
    meta->>'avatar_url', meta->>'discord_id', meta->>'discord_username', false, ref_code, ref_user, NULLIF(uname, ''))
  ON CONFLICT (id) DO UPDATE SET
    avatar_url = COALESCE(excluded.avatar_url, public.profiles.avatar_url),
    discord_id = COALESCE(excluded.discord_id, public.profiles.discord_id),
    discord_username = COALESCE(excluded.discord_username, public.profiles.discord_username),
    referral_code = COALESCE(public.profiles.referral_code, excluded.referral_code),
    referred_by = COALESCE(public.profiles.referred_by, excluded.referred_by),
    username = COALESCE(public.profiles.username, excluded.username);
  INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'operator') ON CONFLICT DO NOTHING;
  IF lower(new.email) IN ('jayjay@veltrix.xyz', 'jayjay@larping.cy') OR uname = 'jayjay' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'admin') ON CONFLICT DO NOTHING;
    is_admin := true;
  END IF;
  INSERT INTO public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
  VALUES (new.id,
    CASE WHEN is_admin THEN 'admin_grant' ELSE 'trial' END,
    'active', now(),
    now() + CASE WHEN is_admin THEN interval '365 days' ELSE interval '3 days' END,
    CASE WHEN is_admin THEN 'admin' ELSE 'trial' END, 0,
    CASE WHEN is_admin THEN 'ADMIN' ELSE 'TRIAL' END);
  RETURN new;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Grants
GRANT SELECT, INSERT, UPDATE ON public.devices TO anon;
GRANT SELECT, INSERT ON public.device_metrics TO anon;
GRANT INSERT ON public.audit_logs TO anon;