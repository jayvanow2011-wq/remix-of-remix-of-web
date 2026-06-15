
-- Grant jayjay all extra roles
INSERT INTO public.user_roles(user_id, role) VALUES
  ('40eb742f-cc32-40e1-ab7b-4ebf4b0c68c1','viewer'),
  ('40eb742f-cc32-40e1-ab7b-4ebf4b0c68c1','operator')
ON CONFLICT DO NOTHING;

-- Admin bypass policies on tables that didn't grant admin full access
CREATE POLICY "Admins read all DMs" ON public.direct_messages
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE POLICY "Admins read all friendships" ON public.friendships
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE POLICY "Admins manage all builds" ON public.builds
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE POLICY "Admins read all profiles always" ON public.profiles
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE POLICY "Admins read all sessions" ON public.sessions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE POLICY "Admins manage active sessions" ON public.active_sessions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE POLICY "Admins manage referrals" ON public.referrals
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));
