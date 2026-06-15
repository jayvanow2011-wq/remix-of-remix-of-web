CREATE TABLE public.turn_servers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label TEXT NOT NULL DEFAULT 'custom',
  url TEXT NOT NULL,
  username TEXT,
  credential TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT ON public.turn_servers TO authenticated;
GRANT ALL ON public.turn_servers TO service_role;

ALTER TABLE public.turn_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read enabled turn servers"
ON public.turn_servers FOR SELECT TO authenticated
USING (enabled = true OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins manage turn servers"
ON public.turn_servers FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER turn_servers_touch
BEFORE UPDATE ON public.turn_servers
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();