create table if not exists public.commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','running','done','error')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index idx_commands_device_status on public.commands(device_id, status, created_at desc);
alter table public.commands enable row level security;
create policy "Operators read commands" on public.commands for select to authenticated
  using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators insert commands" on public.commands for insert to authenticated
  with check (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators update commands" on public.commands for update to authenticated
  using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commands TO authenticated;
GRANT ALL ON public.commands TO service_role;
ALTER PUBLICATION supabase_realtime ADD TABLE public.commands;
ALTER TABLE public.commands REPLICA IDENTITY FULL;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan text not null default 'free',
  status text not null default 'active',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.build_server_config (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null default 'default',
  buildserver_url text,
  created_at timestamptz not null default now()
);
alter table public.build_server_config enable row level security;
create policy "Admins manage build server config" on public.build_server_config for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create policy "Authenticated read build server config" on public.build_server_config for select to authenticated using (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.build_server_config TO authenticated;
GRANT ALL ON public.build_server_config TO service_role;

create or replace function public.admin_adjust_subscription(_user_id uuid, _plan text, _period_end timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(),'admin') then raise exception 'admin only'; end if;
  insert into public.subscriptions (user_id, plan, status, current_period_end)
  values (_user_id, _plan, 'active', _period_end)
  on conflict (user_id) do update set plan = excluded.plan, current_period_end = excluded.current_period_end, status='active', updated_at = now();
end; $$;

create or replace function public.admin_ban_user(_target_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(),'admin') then raise exception 'admin only'; end if;
  delete from public.user_roles where user_id = _target_user;
end; $$;

revoke execute on function public.has_role(uuid, public.app_role) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.admin_adjust_subscription(uuid, text, timestamptz) from public, anon;
revoke execute on function public.admin_ban_user(uuid) from public, anon;
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;
grant execute on function public.admin_adjust_subscription(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.admin_ban_user(uuid) to authenticated, service_role;