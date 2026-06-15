
CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_name text NOT NULL,
  device_name text NOT NULL,
  ip_address text NOT NULL,
  os text,
  is_online boolean NOT NULL DEFAULT false,
  last_seen timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tmp read devices" ON public.devices FOR SELECT USING (true);
CREATE POLICY "tmp insert devices" ON public.devices FOR INSERT WITH CHECK (true);
CREATE POLICY "tmp update devices" ON public.devices FOR UPDATE USING (true);
ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
ALTER TABLE public.devices REPLICA IDENTITY FULL;

create type public.app_role as enum ('admin', 'operator', 'viewer');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.user_roles where user_id = _user_id and role = _role) $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at = now(); return new; end; $$;

create trigger trg_profiles_updated_at before update on public.profiles for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$ begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  insert into public.user_roles (user_id, role) values (new.id, 'operator');
  return new;
end; $$;

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create policy "Profiles readable by authenticated" on public.profiles for select to authenticated using (true);
create policy "Users update own profile" on public.profiles for update to authenticated using (auth.uid() = id);
create policy "Users read own roles" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy "Admins manage roles" on public.user_roles for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

drop policy if exists "tmp read devices" on public.devices;
drop policy if exists "tmp insert devices" on public.devices;
drop policy if exists "tmp update devices" on public.devices;

alter table public.devices
  add column if not exists device_token_hash text,
  add column if not exists enrollment_code text unique,
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists username text,
  add column if not exists last_seen_ip text,
  add column if not exists updated_at timestamptz not null default now();

create trigger trg_devices_updated_at before update on public.devices for each row execute function public.touch_updated_at();
create index if not exists idx_devices_owner on public.devices(owner_user_id);
create index if not exists idx_devices_enrollment_code on public.devices(enrollment_code);
create index if not exists idx_devices_token_hash on public.devices(device_token_hash);

create policy "Operators read devices" on public.devices for select to authenticated
  using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'viewer'));
create policy "Operators enroll devices" on public.devices for insert to authenticated
  with check (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators update own devices" on public.devices for update to authenticated
  using (owner_user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Admins delete devices" on public.devices for delete to authenticated
  using (public.has_role(auth.uid(),'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices TO authenticated;
GRANT ALL ON public.devices TO service_role;

create table public.device_metrics (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  cpu_percent numeric, ram_percent numeric, ram_used_mb bigint, ram_total_mb bigint,
  gpu_info text, network_rx_kbps numeric, network_tx_kbps numeric, uptime_seconds bigint,
  recorded_at timestamptz not null default now()
);
create index idx_device_metrics_device_recorded on public.device_metrics(device_id, recorded_at desc);
alter table public.device_metrics enable row level security;
create policy "Operators read metrics" on public.device_metrics for select to authenticated
  using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'viewer'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_metrics TO authenticated;
GRANT ALL ON public.device_metrics TO service_role;
ALTER PUBLICATION supabase_realtime ADD TABLE public.device_metrics;
ALTER TABLE public.device_metrics REPLICA IDENTITY FULL;

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  operator_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz, end_reason text,
  permissions jsonb not null default '{}'::jsonb, client_ip text
);
create index idx_sessions_device on public.sessions(device_id, started_at desc);
create index idx_sessions_operator on public.sessions(operator_id, started_at desc);
alter table public.sessions enable row level security;
create policy "Operators read own sessions" on public.sessions for select to authenticated
  using (operator_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Operators create own sessions" on public.sessions for insert to authenticated
  with check (operator_id = auth.uid() and (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin')));
create policy "Operators end own sessions" on public.sessions for update to authenticated
  using (operator_id = auth.uid() or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT ALL ON public.sessions TO service_role;

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  operator_id uuid references auth.users(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  ip text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_device on public.audit_logs(device_id, created_at desc);
create index idx_audit_operator on public.audit_logs(operator_id, created_at desc);
alter table public.audit_logs enable row level security;
create policy "Operators read audit logs" on public.audit_logs for select to authenticated
  using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators insert own audit logs" on public.audit_logs for insert to authenticated
  with check (operator_id = auth.uid() and (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;

create table public.device_permissions (
  device_id uuid primary key references public.devices(id) on delete cascade,
  screen_view boolean not null default false, camera boolean not null default false,
  remote_shell boolean not null default false, file_access boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.device_permissions enable row level security;
create trigger trg_device_perms_updated_at before update on public.device_permissions for each row execute function public.touch_updated_at();
create policy "Operators read device permissions" on public.device_permissions for select to authenticated
  using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'viewer'));
create policy "Admins manage device permissions" on public.device_permissions for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_permissions TO authenticated;
GRANT ALL ON public.device_permissions TO service_role;

alter table public.devices
  add column if not exists last_screen_b64 text,
  add column if not exists last_screen_at timestamptz,
  add column if not exists last_camera_b64 text,
  add column if not exists last_camera_at timestamptz,
  add column if not exists pending_commands jsonb not null default '[]'::jsonb;

create table if not exists public.command_results (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  command_id text not null,
  result jsonb,
  created_at timestamptz not null default now()
);
alter table public.command_results enable row level security;
create policy "Operators read command results" on public.command_results for select to authenticated using (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.command_results TO authenticated;
GRANT ALL ON public.command_results TO service_role;
ALTER PUBLICATION supabase_realtime ADD TABLE public.command_results;
ALTER TABLE public.command_results REPLICA IDENTITY FULL;

create table if not exists public.builds (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  status text not null default 'pending',
  config jsonb not null default '{}'::jsonb,
  download_url text, error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.builds enable row level security;
create trigger trg_builds_updated_at before update on public.builds for each row execute function public.touch_updated_at();
create policy "Users read own builds" on public.builds for select to authenticated using (owner_user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Users insert own builds" on public.builds for insert to authenticated with check (owner_user_id = auth.uid());
create policy "Users update own builds" on public.builds for update to authenticated using (owner_user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Users delete own builds" on public.builds for delete to authenticated using (owner_user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.builds TO authenticated;
GRANT ALL ON public.builds TO service_role;

create table if not exists public.build_configs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.build_configs enable row level security;
create trigger trg_build_configs_updated_at before update on public.build_configs for each row execute function public.touch_updated_at();
create policy "Users manage own build configs" on public.build_configs for all to authenticated using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.build_configs TO authenticated;
GRANT ALL ON public.build_configs TO service_role;

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  unique(requester_id, addressee_id)
);
alter table public.friendships enable row level security;
create policy "Users read own friendships" on public.friendships for select to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy "Users create friendships" on public.friendships for insert to authenticated with check (requester_id = auth.uid());
create policy "Users update own friendships" on public.friendships for update to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy "Users delete own friendships" on public.friendships for delete to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friendships TO authenticated;
GRANT ALL ON public.friendships TO service_role;
ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
ALTER TABLE public.friendships REPLICA IDENTITY FULL;

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_dm_pair on public.direct_messages(sender_id, recipient_id, created_at desc);
alter table public.direct_messages enable row level security;
create policy "Users read own dms" on public.direct_messages for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy "Users send dms" on public.direct_messages for insert to authenticated with check (sender_id = auth.uid());
create policy "Users update own dms" on public.direct_messages for update to authenticated using (recipient_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.direct_messages TO authenticated;
GRANT ALL ON public.direct_messages TO service_role;
ALTER PUBLICATION supabase_realtime ADD TABLE public.direct_messages;
ALTER TABLE public.direct_messages REPLICA IDENTITY FULL;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null, title text not null, body text, link text,
  read_at timestamptz, created_at timestamptz not null default now()
);
create index idx_notif_user on public.notifications(user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "Users read own notifications" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "Users update own notifications" on public.notifications for update to authenticated using (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan text not null default 'free',
  status text not null default 'active',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create trigger trg_subs_updated_at before update on public.subscriptions for each row execute function public.touch_updated_at();
create policy "Users read own subscription" on public.subscriptions for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Admins manage subscriptions" on public.subscriptions for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  amount_cents bigint not null, currency text not null default 'USD',
  status text not null default 'pending', provider text, provider_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.payments enable row level security;
create policy "Users read own payments" on public.payments for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users(id) on delete cascade,
  referred_email text, referred_user_id uuid references auth.users(id) on delete set null,
  code text not null unique, claimed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.referrals enable row level security;
create policy "Users read own referrals" on public.referrals for select to authenticated using (referrer_id = auth.uid() or referred_user_id = auth.uid());
create policy "Users create referrals" on public.referrals for insert to authenticated with check (referrer_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  title text, body text not null, tags text[] not null default '{}',
  upvotes int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.community_posts enable row level security;
create trigger trg_cposts_updated_at before update on public.community_posts for each row execute function public.touch_updated_at();
create policy "Anyone authenticated reads posts" on public.community_posts for select to authenticated using (true);
create policy "Users create own posts" on public.community_posts for insert to authenticated with check (author_id = auth.uid());
create policy "Users edit own posts" on public.community_posts for update to authenticated using (author_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Users delete own posts" on public.community_posts for delete to authenticated using (author_id = auth.uid() or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_posts TO authenticated;
GRANT ALL ON public.community_posts TO service_role;

create table if not exists public.recovery_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.recovery_tokens enable row level security;
create policy "Users read own recovery tokens" on public.recovery_tokens for select to authenticated using (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recovery_tokens TO authenticated;
GRANT ALL ON public.recovery_tokens TO service_role;

create table if not exists public.leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null default 'global',
  score int not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, category)
);
alter table public.leaderboard_entries enable row level security;
create trigger trg_lb_updated_at before update on public.leaderboard_entries for each row execute function public.touch_updated_at();
create policy "Anyone authenticated reads leaderboard" on public.leaderboard_entries for select to authenticated using (true);
create policy "Users update own leaderboard" on public.leaderboard_entries for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leaderboard_entries TO authenticated;
GRANT ALL ON public.leaderboard_entries TO service_role;

-- WebRTC signaling table — used by control browser ↔ agent to exchange offers/answers/ICE
create table if not exists public.webrtc_signals (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  session_id text not null,
  sender text not null check (sender in ('operator','agent')),
  kind text not null check (kind in ('offer','answer','ice','bye')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index idx_signals_device_session on public.webrtc_signals(device_id, session_id, created_at);
alter table public.webrtc_signals enable row level security;
create policy "Operators read signals" on public.webrtc_signals for select to authenticated
  using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators send signals" on public.webrtc_signals for insert to authenticated
  with check (sender = 'operator' and (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webrtc_signals TO authenticated;
GRANT ALL ON public.webrtc_signals TO service_role;
ALTER PUBLICATION supabase_realtime ADD TABLE public.webrtc_signals;
ALTER TABLE public.webrtc_signals REPLICA IDENTITY FULL;
