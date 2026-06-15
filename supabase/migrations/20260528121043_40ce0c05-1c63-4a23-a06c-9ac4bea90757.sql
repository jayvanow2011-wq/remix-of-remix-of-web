INSERT INTO public.build_server_config (key, label, buildserver_url)
VALUES ('bsk_09133724febe40978cf57e5f58fb5aecd7a0fece736378d8c5c04e8d7743c293', 'default', 'https://project--1a0b51d8-d25c-4c46-91fb-1c21567333c1-dev.lovable.app')
ON CONFLICT (key) DO UPDATE SET buildserver_url = EXCLUDED.buildserver_url, label = EXCLUDED.label;