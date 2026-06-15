
-- Ensure pgcrypto is available for password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  v_email text := 'jayjay@veltrix.xyz';
  v_password text := 'jayjay100!';
  v_user_id uuid;
  v_encrypted text;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(v_email) LIMIT 1;
  v_encrypted := crypt(v_password, gen_salt('bf'));

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change,
      email_change_token_new, recovery_token, is_super_admin
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_user_id, 'authenticated', 'authenticated', v_email, v_encrypted,
      now(),
      jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
      jsonb_build_object('username','jayjay','full_name','JayJay'),
      now(), now(), '', '', '', '', false
    );

    INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true),
      'email', v_user_id::text, now(), now(), now());
  ELSE
    UPDATE auth.users
       SET encrypted_password = v_encrypted,
           email_confirmed_at = COALESCE(email_confirmed_at, now()),
           updated_at = now(),
           raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
             || jsonb_build_object('username','jayjay','full_name','JayJay'),
           banned_until = NULL
     WHERE id = v_user_id;
  END IF;

  -- Profile
  INSERT INTO public.profiles (id, email, full_name, username, profile_completed, referral_code)
  VALUES (v_user_id, v_email, 'JayJay', 'jayjay', true,
          upper(substring(replace(gen_random_uuid()::text,'-',''),1,8)))
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    username = COALESCE(public.profiles.username, EXCLUDED.username),
    full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
    is_banned = false,
    is_removed = false;

  -- Roles
  INSERT INTO public.user_roles (user_id, role) VALUES (v_user_id, 'admin') ON CONFLICT DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES (v_user_id, 'operator') ON CONFLICT DO NOTHING;

  -- Active 365-day admin subscription
  UPDATE public.subscriptions SET status = 'cancelled'
   WHERE user_id = v_user_id AND status = 'active';
  INSERT INTO public.subscriptions (user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
  VALUES (v_user_id, 'admin_grant', 'active', now(), now() + interval '365 days', 'admin', 0, 'ADMIN');
END $$;
