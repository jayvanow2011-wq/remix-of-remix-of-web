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