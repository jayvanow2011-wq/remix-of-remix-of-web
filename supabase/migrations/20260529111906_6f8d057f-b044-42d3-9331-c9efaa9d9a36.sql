ALTER TABLE public.devices REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
ALTER TABLE public.commands REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.commands;