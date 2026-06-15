DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role;

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
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.devices; EXCEPTION WHEN others THEN NULL; END $wrap$;
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
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();

alter table public.devices
  add column if not exists device_token_hash text,
  add column if not exists enrollment_code text unique,
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists username text,
  add column if not exists last_seen_ip text,
  add column if not exists updated_at timestamptz not null default now();

create trigger trg_devices_updated_at before update on public.devices
  for each row execute function public.touch_updated_at();

create index if not exists idx_devices_owner on public.devices(owner_user_id);
create index if not exists idx_devices_enrollment_code on public.devices(enrollment_code);
create index if not exists idx_devices_token_hash on public.devices(device_token_hash);

create table public.device_metrics (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  cpu_percent numeric,
  ram_percent numeric,
  ram_used_mb bigint,
  ram_total_mb bigint,
  gpu_info text,
  network_rx_kbps numeric,
  network_tx_kbps numeric,
  uptime_seconds bigint,
  recorded_at timestamptz not null default now()
);
create index idx_device_metrics_device_recorded on public.device_metrics(device_id, recorded_at desc);
alter table public.device_metrics enable row level security;

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  operator_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  permissions jsonb not null default '{}'::jsonb,
  client_ip text
);
create index idx_sessions_device on public.sessions(device_id, started_at desc);
create index idx_sessions_operator on public.sessions(operator_id, started_at desc);
alter table public.sessions enable row level security;

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  operator_id uuid references auth.users(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  ip text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_device on public.audit_logs(device_id, created_at desc);
create index idx_audit_operator on public.audit_logs(operator_id, created_at desc);
alter table public.audit_logs enable row level security;

create table public.device_permissions (
  device_id uuid primary key references public.devices(id) on delete cascade,
  screen_view boolean not null default false,
  camera boolean not null default false,
  remote_shell boolean not null default false,
  file_access boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.device_permissions enable row level security;
create trigger trg_device_perms_updated_at before update on public.device_permissions
  for each row execute function public.touch_updated_at();

create policy "Profiles readable by authenticated" on public.profiles for select to authenticated using (true);
create policy "Users update own profile" on public.profiles for update to authenticated using (auth.uid() = id);
create policy "Users read own roles" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy "Admins manage roles" on public.user_roles for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create policy "Anyone can read devices" on public.devices for select using (true);
create policy "Anyone can enroll devices" on public.devices for insert with check (true);
create policy "Anyone can update devices" on public.devices for update using (true);
create policy "Admins delete devices" on public.devices for delete to authenticated using (public.has_role(auth.uid(), 'admin'));

create policy "Anyone can read metrics" on public.device_metrics for select using (true);
create policy "Anyone can read sessions" on public.sessions for select using (true);

create policy "Operators read audit logs" on public.audit_logs for select to authenticated
  using (public.has_role(auth.uid(), 'operator') or public.has_role(auth.uid(), 'admin'));
create policy "Operators insert own audit logs" on public.audit_logs for insert to authenticated
  with check (operator_id = auth.uid() and (public.has_role(auth.uid(), 'operator') or public.has_role(auth.uid(), 'admin')));

create policy "Operators read device permissions" on public.device_permissions for select to authenticated
  using (public.has_role(auth.uid(), 'operator') or public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'viewer'));
create policy "Owners update device permissions" on public.device_permissions for all to authenticated
  using (public.has_role(auth.uid(), 'admin') or exists (select 1 from public.devices d where d.id = device_id and d.owner_user_id = auth.uid()))
  with check (public.has_role(auth.uid(), 'admin') or exists (select 1 from public.devices d where d.id = device_id and d.owner_user_id = auth.uid()));

create policy "Operators create own sessions" on public.sessions for insert to authenticated
  with check (operator_id = auth.uid() and (public.has_role(auth.uid(), 'operator') or public.has_role(auth.uid(), 'admin')));
create policy "Operators end own sessions" on public.sessions for update to authenticated
  using (operator_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

alter table public.devices replica identity full;
alter table public.device_metrics replica identity full;
alter table public.sessions replica identity full;
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.device_metrics; EXCEPTION WHEN others THEN NULL; END $wrap$;
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions; EXCEPTION WHEN others THEN NULL; END $wrap$;

revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.has_role(uuid, public.app_role) from public, anon;

create table if not exists public.commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index if not exists commands_device_status_idx on public.commands (device_id, status, created_at);
alter table public.commands enable row level security;
create policy "Anyone read commands"  on public.commands for select using (true);
create policy "Anyone insert commands" on public.commands for insert with check (true);
create policy "Anyone update commands" on public.commands for update using (true);

alter table public.devices
  add column if not exists last_screen_b64 text,
  add column if not exists last_screen_at timestamptz,
  add column if not exists last_camera_b64 text,
  add column if not exists last_camera_at timestamptz;

DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.commands; EXCEPTION WHEN others THEN NULL; END $wrap$;
alter table public.commands replica identity full;

alter table public.profiles
  add column if not exists username text unique,
  add column if not exists avatar_url text,
  add column if not exists bio text,
  add column if not exists discord_id text unique,
  add column if not exists discord_username text,
  add column if not exists theme text not null default 'dark',
  add column if not exists profile_completed boolean not null default false,
  add column if not exists discord_rpc_enabled boolean not null default false,
  add column if not exists discord_status_enabled boolean not null default false;
create index if not exists profiles_username_idx on public.profiles (lower(username));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, email, full_name, avatar_url, discord_id, discord_username, profile_completed)
  values (new.id, new.email, coalesce(meta->>'full_name', meta->>'discord_username', new.email),
    meta->>'avatar_url', meta->>'discord_id', meta->>'discord_username', false)
  on conflict (id) do update set
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    discord_id = coalesce(excluded.discord_id, public.profiles.discord_id),
    discord_username = coalesce(excluded.discord_username, public.profiles.discord_username);
  insert into public.user_roles (user_id, role) values (new.id, 'operator') on conflict do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null,
  status text not null default 'pending',
  provider text not null default 'nowpayments',
  provider_payment_id text,
  amount_usd numeric,
  currency text,
  started_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions(user_id);
alter table public.subscriptions enable row level security;
create policy "Users read own subs" on public.subscriptions for select to authenticated
  using (user_id = auth.uid() or has_role(auth.uid(),'admin'));
create policy "Service inserts subs" on public.subscriptions for insert to authenticated
  with check (user_id = auth.uid());

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('news','reviews','chat')),
  body text,
  image_url text,
  kind text,
  created_at timestamptz not null default now()
);
create index if not exists community_posts_channel_idx on public.community_posts(channel, created_at desc);
alter table public.community_posts enable row level security;
create policy "Anyone read community" on public.community_posts for select to authenticated using (true);
create policy "Admins post news" on public.community_posts for insert to authenticated
  with check ((channel='news' and has_role(auth.uid(),'admin')) or (channel in ('reviews','chat') and author_id = auth.uid()));
create policy "Authors delete own" on public.community_posts for delete to authenticated
  using (author_id = auth.uid() or has_role(auth.uid(),'admin'));

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "Users read own notifs" on public.notifications for select to authenticated
  using (user_id = auth.uid() or user_id is null);
create policy "Users update own notifs" on public.notifications for update to authenticated
  using (user_id = auth.uid());
create policy "Admins create notifs" on public.notifications for insert to authenticated
  with check (has_role(auth.uid(),'admin'));

create table if not exists public.active_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id text not null,
  user_agent text,
  ip text,
  updated_at timestamptz not null default now()
);
alter table public.active_sessions enable row level security;
create policy "Users read own session" on public.active_sessions for select to authenticated using (user_id = auth.uid());
create policy "Users upsert own session" on public.active_sessions for insert to authenticated with check (user_id = auth.uid());
create policy "Users update own session" on public.active_sessions for update to authenticated using (user_id = auth.uid());
create policy "Users delete own session" on public.active_sessions for delete to authenticated using (user_id = auth.uid());

insert into storage.buckets (id, name, public) values ('avatars','avatars',true) on conflict do nothing;
insert into storage.buckets (id, name, public) values ('chat','chat',true) on conflict do nothing;
insert into storage.buckets (id, name, public) values ('builds','builds',true) on conflict do nothing;

create policy "Avatar public read" on storage.objects for select using (bucket_id='avatars');
create policy "Avatar owner write" on storage.objects for insert to authenticated
  with check (bucket_id='avatars' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Avatar owner update" on storage.objects for update to authenticated
  using (bucket_id='avatars' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Chat public read" on storage.objects for select using (bucket_id='chat');
create policy "Chat owner write" on storage.objects for insert to authenticated
  with check (bucket_id='chat' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Builds public read" on storage.objects for select using (bucket_id='builds');
create policy "Users upload build icons" on storage.objects for insert to authenticated
  with check (bucket_id='builds' and (storage.foldername(name))[1] = auth.uid()::text);

DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.community_posts; EXCEPTION WHEN others THEN NULL; END $wrap$;
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications; EXCEPTION WHEN others THEN NULL; END $wrap$;
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.active_sessions; EXCEPTION WHEN others THEN NULL; END $wrap$;

create table if not exists public.builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  startup boolean not null default false,
  startup_name text,
  debug boolean not null default false,
  output_kind text not null default 'exe',
  icon_url text,
  status text not null default 'queued',
  download_url text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists builds_user_idx on public.builds(user_id, created_at desc);
alter table public.builds enable row level security;
create policy "Users read own builds" on public.builds for select to authenticated using (user_id = auth.uid());
create policy "Users insert own builds" on public.builds for insert to authenticated with check (user_id = auth.uid());
create policy "Users delete own builds" on public.builds for delete to authenticated using (user_id = auth.uid());
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.builds; EXCEPTION WHEN others THEN NULL; END $wrap$;

DO $cronwrap$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('sentinel-offline-sweep', '15 seconds',
    $sweep$ UPDATE public.devices SET is_online = false WHERE is_online = true AND last_seen < now() - interval '25 seconds'; $sweep$);
EXCEPTION WHEN others THEN NULL; END $cronwrap$;

INSERT INTO public.devices (pc_name, device_name, ip_address, os, is_online, last_seen)
SELECT 'DESKTOP-TEST01', 'Test Workstation', '192.168.1.42', 'Windows 11 Pro', true, now()
WHERE NOT EXISTS (SELECT 1 FROM public.devices WHERE pc_name = 'DESKTOP-TEST01');

ALTER TABLE public.builds ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.build_server_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.build_server_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage build server config"
  ON public.build_server_config FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

INSERT INTO public.build_server_config (key, label)
VALUES ('bsk_' || encode(gen_random_bytes(32), 'hex'), 'default')
ON CONFLICT DO NOTHING;

CREATE POLICY "Service update builds" ON public.builds FOR UPDATE TO anon
  USING (true) WITH CHECK (true);

alter table public.build_server_config
  add column if not exists buildserver_url text;

alter table public.builds
  add column if not exists target_server_url text;

alter table public.notifications
  add column if not exists kind text not null default 'system',
  add column if not exists payload jsonb not null default '{}'::jsonb;

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null,
  addressee_id uuid not null,
  status text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_distinct check (requester_id <> addressee_id),
  constraint friendships_unique_pair unique (requester_id, addressee_id)
);
create index if not exists idx_friendships_addressee on public.friendships(addressee_id);
create index if not exists idx_friendships_requester on public.friendships(requester_id);

alter table public.friendships enable row level security;

create policy "Friendship readable by either party"
  on public.friendships for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "Users send friend requests"
  on public.friendships for insert to authenticated
  with check (auth.uid() = requester_id);
create policy "Either party updates friendship"
  on public.friendships for update to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "Either party deletes friendship"
  on public.friendships for delete to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

create trigger friendships_touch
  before update on public.friendships
  for each row execute function public.touch_updated_at();

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_key text not null,
  sender_id uuid not null,
  recipient_id uuid not null,
  kind text not null default 'text' check (kind in ('text','image','share_client','request_client','system')),
  body text,
  image_url text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists idx_dm_conv on public.direct_messages(conversation_key, created_at desc);
create index if not exists idx_dm_recipient on public.direct_messages(recipient_id, read_at);

alter table public.direct_messages enable row level security;

create policy "DM readable by participants"
  on public.direct_messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "Send DM as self to friend"
  on public.direct_messages for insert to authenticated
  with check (
    auth.uid() = sender_id
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = sender_id and f.addressee_id = recipient_id)
          or (f.addressee_id = sender_id and f.requester_id = recipient_id))
    )
  );
create policy "Recipient marks DM read"
  on public.direct_messages for update to authenticated
  using (auth.uid() = recipient_id);

create table if not exists public.device_access (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null,
  user_id uuid not null,
  role text not null default 'controller' check (role in ('host','controller','viewer')),
  granted_by uuid,
  created_at timestamptz not null default now(),
  unique (device_id, user_id)
);
create index if not exists idx_device_access_user on public.device_access(user_id);
create index if not exists idx_device_access_device on public.device_access(device_id);

alter table public.device_access enable row level security;

insert into public.device_access (device_id, user_id, role, granted_by)
select d.id, d.owner_user_id, 'host', d.owner_user_id
from public.devices d
where d.owner_user_id is not null
on conflict do nothing;

create table if not exists public.client_shares (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null,
  host_user_id uuid not null,
  shared_with_user_id uuid not null,
  initiator_id uuid not null,
  flow text not null check (flow in ('share','request')),
  status text not null default 'pending' check (status in ('pending','accepted','declined','revoked')),
  dm_id uuid,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create index if not exists idx_client_shares_recipient on public.client_shares(shared_with_user_id);
create index if not exists idx_client_shares_host on public.client_shares(host_user_id);

alter table public.client_shares enable row level security;

create policy "Share readable by participants"
  on public.client_shares for select to authenticated
  using (auth.uid() in (host_user_id, shared_with_user_id, initiator_id) or has_role(auth.uid(),'admin'::app_role));
create policy "Initiator creates share"
  on public.client_shares for insert to authenticated
  with check (
    auth.uid() = initiator_id
    and (
      (flow = 'share' and exists (
        select 1 from public.devices d
        where d.id = device_id and d.owner_user_id = host_user_id and host_user_id = auth.uid()
      ))
      or
      (flow = 'request' and exists (
        select 1 from public.devices d
        where d.id = device_id and d.owner_user_id = host_user_id and shared_with_user_id = auth.uid()
      ))
    )
  );
create policy "Participants update share"
  on public.client_shares for update to authenticated
  using (auth.uid() in (host_user_id, shared_with_user_id));

CREATE OR REPLACE FUNCTION public.is_device_owner(_device_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.devices WHERE id = _device_id AND owner_user_id = _user_id)
$$;

CREATE OR REPLACE FUNCTION public.has_device_access(_device_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.device_access WHERE device_id = _device_id AND user_id = _user_id)
$$;

CREATE POLICY "Authenticated read accessible devices"
ON public.devices FOR SELECT TO authenticated
USING (
  owner_user_id = auth.uid()
  OR public.has_device_access(id, auth.uid())
  OR public.has_role(auth.uid(), 'admin'::app_role)
);

CREATE POLICY "Read device access rows"
ON public.device_access FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_device_owner(device_id, auth.uid())
  OR public.has_role(auth.uid(), 'admin'::app_role)
);

CREATE POLICY "Host or admin manages device access"
ON public.device_access FOR ALL TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_device_owner(device_id, auth.uid())
)
WITH CHECK (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_device_owner(device_id, auth.uid())
);

DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.direct_messages; EXCEPTION WHEN others THEN NULL; END $wrap$;
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships; EXCEPTION WHEN others THEN NULL; END $wrap$;
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.client_shares; EXCEPTION WHEN others THEN NULL; END $wrap$;
DO $wrap$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.device_access; EXCEPTION WHEN others THEN NULL; END $wrap$;

alter table public.profiles
  add column if not exists referral_code text unique,
  add column if not exists referred_by uuid;
create index if not exists profiles_referral_code_idx on public.profiles (referral_code);

update public.profiles
   set referral_code = upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8))
 where referral_code is null;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null,
  referee_id uuid not null unique,
  bonus_days_awarded int not null default 0,
  milestone_awarded boolean not null default false,
  activated_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.referrals enable row level security;
create policy "Referrer or referee reads referral"
  on public.referrals for select to authenticated
  using (auth.uid() = referrer_id or auth.uid() = referee_id or public.has_role(auth.uid(),'admin'));

create or replace function public.extend_subscription(_user_id uuid, _days int)
returns void language plpgsql security definer set search_path = public as $$
declare existing public.subscriptions%rowtype;
begin
  select * into existing from public.subscriptions
   where user_id = _user_id and status = 'active'
   order by expires_at desc nulls last limit 1;
  if found then
    update public.subscriptions
       set expires_at = coalesce(expires_at, now()) + (_days || ' days')::interval
     where id = existing.id;
  else
    insert into public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
    values (_user_id, 'referral_bonus', 'active', now(), now() + (_days || ' days')::interval, 'referral', 0, 'BONUS');
  end if;
end;
$$;

create or replace function public.handle_subscription_activation()
returns trigger language plpgsql security definer set search_path = public as $$
declare ref_row public.referrals%rowtype; total_count int; referrer uuid;
begin
  if new.status <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' then return new; end if;
  select referred_by into referrer from public.profiles where id = new.user_id;
  if referrer is null then return new; end if;
  select * into ref_row from public.referrals where referee_id = new.user_id for update;
  if not found then
    insert into public.referrals(referrer_id, referee_id, bonus_days_awarded, activated_at)
    values (referrer, new.user_id, 30, now()) returning * into ref_row;
    perform public.extend_subscription(referrer, 30);
  elsif ref_row.activated_at is null then
    update public.referrals set bonus_days_awarded = 30, activated_at = now() where id = ref_row.id;
    perform public.extend_subscription(referrer, 30);
  else
    return new;
  end if;
  select count(*) into total_count from public.referrals where referrer_id = referrer and activated_at is not null;
  if total_count > 0 and total_count % 5 = 0 then
    perform public.extend_subscription(referrer, 30);
    update public.referrals set milestone_awarded = true where id = ref_row.id;
    insert into public.notifications(user_id, title, body, kind, payload)
    values (referrer, 'Milestone bonus!', 'You hit ' || total_count || ' referrals — +30 days added.',
            'system', jsonb_build_object('milestone', total_count));
  end if;
  insert into public.notifications(user_id, title, body, kind, payload)
  values (referrer, 'Referral activated', 'A user you referred just subscribed — +30 days added.',
          'system', jsonb_build_object('referee_id', new.user_id));
  return new;
end;
$$;

drop trigger if exists on_subscription_activation on public.subscriptions;
create trigger on_subscription_activation
  after insert or update of status on public.subscriptions
  for each row execute function public.handle_subscription_activation();

drop policy if exists "Admins insert subs" on public.subscriptions;
create policy "Admins insert subs" on public.subscriptions for insert to authenticated
  with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists "Admins update subs" on public.subscriptions;
create policy "Admins update subs" on public.subscriptions for update to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create or replace function public.admin_adjust_subscription(_target_user uuid, _days integer)
returns void language plpgsql security definer set search_path = public as $$
declare existing public.subscriptions%rowtype;
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admin only'; end if;
  select * into existing from public.subscriptions
   where user_id = _target_user and status = 'active'
   order by expires_at desc nulls last limit 1;
  if found then
    update public.subscriptions
       set expires_at = greatest(now(), coalesce(expires_at, now())) + (_days || ' days')::interval
     where id = existing.id;
  elsif _days > 0 then
    insert into public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
    values (_target_user, 'admin_grant', 'active', now(), now() + (_days || ' days')::interval, 'admin', 0, 'ADMIN');
  end if;
end;
$$;

create or replace function public.admin_ban_user(_target_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admin only'; end if;
  update public.subscriptions set status = 'cancelled', expires_at = now()
   where user_id = _target_user and status = 'active';
end;
$$;

drop policy if exists "Users insert own profile" on public.profiles;
create policy "Users insert own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

ALTER TABLE public.build_server_config ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

ALTER TABLE public.direct_messages REPLICA IDENTITY FULL;
ALTER TABLE public.friendships REPLICA IDENTITY FULL;
ALTER TABLE public.client_shares REPLICA IDENTITY FULL;
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

CREATE OR REPLACE FUNCTION public.respond_to_share(_share_id uuid, _accept boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  s public.client_shares%rowtype;
  v_device_name text;
  responder uuid := auth.uid();
  granted_user uuid;
  notify_user uuid;
  conv_key text;
begin
  select * into s from public.client_shares where id = _share_id for update;
  if not found then raise exception 'Share not found'; end if;
  if s.status <> 'pending' then raise exception 'Already resolved'; end if;
  if s.flow = 'share' and responder <> s.shared_with_user_id then raise exception 'Not allowed'; end if;
  if s.flow = 'request' and responder <> s.host_user_id then raise exception 'Not allowed'; end if;
  update public.client_shares set status = case when _accept then 'accepted' else 'declined' end, responded_at = now() where id = _share_id;
  select d.device_name into v_device_name from public.devices d where d.id = s.device_id;
  if _accept then
    granted_user := s.shared_with_user_id;
    insert into public.device_access (device_id, user_id, role, granted_by)
      values (s.device_id, granted_user, 'controller', s.host_user_id) on conflict do nothing;
  end if;
  notify_user := s.initiator_id;
  insert into public.notifications (user_id, title, body, kind, payload)
    values (notify_user,
      case when _accept then 'Access granted' else 'Access declined' end,
      coalesce(v_device_name, 'Device') || (case when _accept then ' is now shared' else ' was declined' end),
      'system',
      jsonb_build_object('share_id', s.id, 'device_id', s.device_id, 'accepted', _accept));
  conv_key := case when s.host_user_id < s.shared_with_user_id
                then s.host_user_id::text || '_' || s.shared_with_user_id::text
                else s.shared_with_user_id::text || '_' || s.host_user_id::text end;
  insert into public.direct_messages (conversation_key, sender_id, recipient_id, kind, body, payload)
  values (conv_key, responder,
     case when responder = s.host_user_id then s.shared_with_user_id else s.host_user_id end,
     'system',
     coalesce(v_device_name, 'Device') || (case when _accept then ' — access accepted' else ' — declined' end),
     jsonb_build_object('share_id', s.id, 'device_id', s.device_id, 'accepted', _accept));
end;
$function$;

revoke execute on function public.respond_to_share(uuid, boolean) from public, anon;
grant execute on function public.respond_to_share(uuid, boolean) to authenticated;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS recovery_token_hash text,
  ADD COLUMN IF NOT EXISTS recovery_token_set_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_ci_uidx
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  ref_code text;
  ref_user uuid;
  is_admin boolean := false;
  uname text := lower(coalesce(meta->>'username', ''));
begin
  ref_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  if meta ? 'ref_code' and length(meta->>'ref_code') > 0 then
    select id into ref_user from public.profiles where referral_code = upper(meta->>'ref_code') limit 1;
  end if;
  insert into public.profiles (id, email, full_name, avatar_url, discord_id, discord_username, profile_completed, referral_code, referred_by, username)
  values (new.id, new.email, coalesce(meta->>'full_name', meta->>'discord_username', meta->>'username', new.email),
    meta->>'avatar_url', meta->>'discord_id', meta->>'discord_username', false, ref_code, ref_user, nullif(uname, ''))
  on conflict (id) do update set
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    discord_id = coalesce(excluded.discord_id, public.profiles.discord_id),
    discord_username = coalesce(excluded.discord_username, public.profiles.discord_username),
    referral_code = coalesce(public.profiles.referral_code, excluded.referral_code),
    referred_by = coalesce(public.profiles.referred_by, excluded.referred_by),
    username = coalesce(public.profiles.username, excluded.username);
  insert into public.user_roles (user_id, role) values (new.id, 'operator') on conflict do nothing;
  if lower(new.email) in ('jayjay@veltrix.xyz', 'jayjay@larping.cy') or uname = 'jayjay' then
    insert into public.user_roles (user_id, role) values (new.id, 'admin') on conflict do nothing;
    is_admin := true;
  end if;
  insert into public.subscriptions(user_id, plan, status, started_at, expires_at, provider, amount_usd, currency)
  values (new.id,
    case when is_admin then 'admin_grant' else 'trial' end,
    'active', now(),
    now() + case when is_admin then interval '365 days' else interval '3 days' end,
    case when is_admin then 'admin' else 'trial' end, 0,
    case when is_admin then 'ADMIN' else 'TRIAL' end);
  return new;
end;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

INSERT INTO public.user_roles (user_id, role)
SELECT p.id, 'admin'::app_role FROM public.profiles p
WHERE lower(p.username) = 'jayjay' OR lower(p.email) IN ('jayjay@veltrix.xyz','jayjay@larping.cy')
ON CONFLICT DO NOTHING;

UPDATE public.subscriptions s
   SET expires_at = greatest(coalesce(s.expires_at, now()), now() + interval '365 days'),
       plan = 'admin_grant', provider = 'admin', status = 'active'
 WHERE s.user_id IN (
   SELECT p.id FROM public.profiles p
   WHERE lower(p.username) = 'jayjay' OR lower(p.email) IN ('jayjay@veltrix.xyz','jayjay@larping.cy')
 );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.devices TO anon;
GRANT ALL ON public.devices TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

GRANT SELECT, INSERT ON public.device_metrics TO authenticated;
GRANT SELECT, INSERT ON public.device_metrics TO anon;
GRANT ALL ON public.device_metrics TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.sessions TO authenticated;
GRANT ALL ON public.sessions TO service_role;

GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT INSERT ON public.audit_logs TO anon;
GRANT ALL ON public.audit_logs TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_permissions TO authenticated;
GRANT ALL ON public.device_permissions TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.commands TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.commands TO anon;
GRANT ALL ON public.commands TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;

GRANT SELECT, INSERT, DELETE ON public.community_posts TO authenticated;
GRANT ALL ON public.community_posts TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.active_sessions TO authenticated;
GRANT ALL ON public.active_sessions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.builds TO authenticated;
GRANT UPDATE ON public.builds TO anon;
GRANT ALL ON public.builds TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.build_server_config TO authenticated;
GRANT ALL ON public.build_server_config TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.friendships TO authenticated;
GRANT ALL ON public.friendships TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.direct_messages TO authenticated;
GRANT ALL ON public.direct_messages TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_access TO authenticated;
GRANT ALL ON public.device_access TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.client_shares TO authenticated;
GRANT ALL ON public.client_shares TO service_role;

GRANT SELECT, INSERT ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;