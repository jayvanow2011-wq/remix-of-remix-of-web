
DO $$
DECLARE
  uid uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'jayjay@admin.local') THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      'jayjay@admin.local', crypt('jayjay100!', gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username','jayjay','full_name','jayjay'),
      now(), now(), '', '', '', ''
    );
    INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', 'jayjay@admin.local'), 'email', uid::text, now(), now(), now());
  ELSE
    SELECT id INTO uid FROM auth.users WHERE email = 'jayjay@admin.local';
    UPDATE auth.users SET encrypted_password = crypt('jayjay100!', gen_salt('bf')), email_confirmed_at = now(), updated_at = now() WHERE id = uid;
  END IF;

  UPDATE public.profiles SET username = 'jayjay' WHERE id = uid;
  INSERT INTO public.user_roles (user_id, role) VALUES (uid, 'admin') ON CONFLICT (user_id, role) DO NOTHING;
END $$;
