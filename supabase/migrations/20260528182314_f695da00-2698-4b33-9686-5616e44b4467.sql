-- Add ban/remove columns to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ban_reason text,
  ADD COLUMN IF NOT EXISTS is_removed boolean NOT NULL DEFAULT false;

-- Enable realtime for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.builds;
ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.direct_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE public.community_posts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.commands;
ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
ALTER PUBLICATION supabase_realtime ADD TABLE public.client_shares;

-- Update build_server_config URL to new project
UPDATE public.build_server_config
SET buildserver_url = 'https://project--53c8bcb9-2188-4404-bb05-84e20505f3a8-dev.lovable.app'
WHERE label = 'default';