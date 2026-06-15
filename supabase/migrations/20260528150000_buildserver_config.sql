-- Insert build server config with generated key
-- This key must match the one in buildserver/config.json and buildserver1/config.json

INSERT INTO public.build_server_config (key, label, buildserver_url)
VALUES (
  'bsk_09133724febe40978cf57e5f58fb5aecd7a0fece736378d8c5c04e8d7743c293',
  'default',
  'https://id-preview--1a0b51d8-d25c-4c46-91fb-1c21567333c1.lovable.app'
)
ON CONFLICT DO NOTHING;
