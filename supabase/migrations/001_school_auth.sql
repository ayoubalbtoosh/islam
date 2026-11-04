-- Run as the project database owner, never from the browser.
-- Idempotent for this schema version; no credentials or real student data are seeded.
begin;

create schema if not exists school_private;
revoke all on schema school_private from public, anon, authenticated;
grant usage on schema school_private to authenticated;

create table if not exists public.allowed_accounts (
  email text primary key check (email = lower(btrim(email)) and length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  is_admin boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.student_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.login_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null unique,
  email text not null,
  display_name text not null,
  at timestamptz not null,
  provider text not null check (provider in ('email', 'google', 'unknown')),
  allowed boolean not null
);
create index if not exists login_events_user_at on public.login_events (user_id, at desc);
create index if not exists login_events_at on public.login_events (at desc);

create table if not exists public.user_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  records jsonb not null default '{}'::jsonb check (jsonb_typeof(records) = 'object' and octet_length(records::text) <= 20000000),
  updated_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision > 0)
);

alter table public.allowed_accounts enable row level security;
alter table public.student_profiles enable row level security;
alter table public.login_events enable row level security;
alter table public.user_progress enable row level security;

-- Every decision uses the live canonical Auth user and live allowlist, not editable
-- user_metadata, JWT email, client-provided identifiers, or stale admin JWT claims.
create or replace function school_private.has_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join public.allowed_accounts a
      on a.email = lower(btrim(u.email))
    where u.id = auth.uid() and u.email_confirmed_at is not null
      and a.enabled and not coalesce(u.is_anonymous, false)
  );
$$;

create or replace function school_private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join public.allowed_accounts a
      on a.email = lower(btrim(u.email))
    where u.id = auth.uid() and u.email_confirmed_at is not null
      and a.enabled and a.is_admin and not coalesce(u.is_anonymous, false)
  );
$$;

drop policy if exists allowed_admin_read on public.allowed_accounts;
create policy allowed_admin_read on public.allowed_accounts for select to authenticated
  using ((select school_private.is_admin()));
drop policy if exists profiles_read on public.student_profiles;
create policy profiles_read on public.student_profiles for select to authenticated
  using (((select auth.uid()) = id and (select school_private.has_access())) or (select school_private.is_admin()));
drop policy if exists events_admin_read on public.login_events;
create policy events_admin_read on public.login_events for select to authenticated
  using ((select school_private.is_admin()));
drop policy if exists progress_own_read on public.user_progress;
create policy progress_own_read on public.user_progress for select to authenticated
  using ((select auth.uid()) = user_id and (select school_private.has_access()));

-- No API table INSERT/UPDATE/DELETE grants: identity, permissions, activity and
-- timestamps are exclusively written by the following checked server functions.
revoke all on public.allowed_accounts, public.student_profiles, public.login_events, public.user_progress from public, anon, authenticated;
revoke all on sequence public.login_events_id_seq from public, anon, authenticated;
grant select on public.allowed_accounts, public.student_profiles, public.login_events, public.user_progress to authenticated;

create or replace function public.platform_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_email text; v_name text; v_admin boolean; v_allowed boolean;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'is_admin', false, 'reason', 'authentication_required');
  end if;
  select lower(btrim(u.email)), a.display_name,
    coalesce(a.is_admin, false),
    coalesce(a.enabled, false) and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
    into v_email, v_name, v_admin, v_allowed
    from auth.users u left join public.allowed_accounts a on a.email = lower(btrim(u.email))
    where u.id = v_uid;
  v_allowed := coalesce(v_allowed, false);
  return jsonb_build_object('allowed', v_allowed, 'is_admin', v_allowed and coalesce(v_admin, false),
    'user_id', v_uid, 'email', v_email, 'display_name', coalesce(v_name, ''),
    'reason', case when v_allowed then null else 'account_not_allowed' end);
end;
$$;

-- Optional Before User Created hook. MUST also be enabled in the Auth dashboard;
-- merely creating this function does not configure Supabase Auth.
create or replace function public.before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.allowed_accounts a
    where a.email = lower(btrim(event -> 'user' ->> 'email')) and a.enabled) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403,
    'message', 'This account is not authorized for the school platform.'));
end;
$$;

create or replace function school_private.sync_auth_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_account public.allowed_accounts%rowtype;
begin
  select * into v_account from public.allowed_accounts
    where email = lower(btrim(new.email)) and enabled;
  if found and new.email_confirmed_at is not null and not coalesce(new.is_anonymous, false) then
    insert into public.student_profiles (id, email, display_name)
      values (new.id, v_account.email, v_account.display_name)
      on conflict (id) do update set email = excluded.email,
        display_name = excluded.display_name, updated_at = now();
  end if;
  return new;
end;
$$;
drop trigger if exists school_auth_profile on auth.users;
create trigger school_auth_profile after insert or update of email, email_confirmed_at on auth.users
  for each row execute function school_private.sync_auth_profile();

-- Session creation is an actual Auth-server event; API callers cannot insert
-- fabricated successful logins, arbitrary identities or arbitrary event times.
create or replace function school_private.log_auth_session()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text; v_name text; v_provider text; v_allowed boolean;
begin
  select lower(btrim(u.email)), coalesce(a.display_name, 'غير مدرج'),
    case when jsonb_typeof(u.raw_app_meta_data -> 'providers') = 'array'
        and jsonb_array_length(u.raw_app_meta_data -> 'providers') > 1 then 'unknown'
      when u.raw_app_meta_data ->> 'provider' in ('email', 'google')
      then u.raw_app_meta_data ->> 'provider' else 'unknown' end,
    coalesce(a.enabled, false) and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
    into v_email, v_name, v_provider, v_allowed
    from auth.users u left join public.allowed_accounts a on a.email = lower(btrim(u.email))
    where u.id = new.user_id;
  if v_email is not null then
    insert into public.login_events (user_id, session_id, email, display_name, at, provider, allowed)
      values (new.user_id, new.id, v_email, v_name, new.created_at, v_provider, coalesce(v_allowed, false))
      on conflict (session_id) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists school_login_event on auth.sessions;
create trigger school_login_event after insert on auth.sessions
  for each row execute function school_private.log_auth_session();

create or replace function public.record_login()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access jsonb; v_session uuid; v_claim text; v_at timestamptz; v_provider text; v_methods jsonb;
begin
  v_access := public.platform_access();
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  v_claim := auth.jwt() ->> 'session_id';
  if v_claim is null or v_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'valid_auth_session_required' using errcode = '42501';
  end if;
  v_session := v_claim::uuid;
  select s.created_at into v_at from auth.sessions s
    where s.id = v_session and s.user_id = auth.uid()
      and (s.not_after is null or s.not_after > now());
  if not found then raise exception 'valid_auth_session_required' using errcode = '42501'; end if;
  v_methods := coalesce(auth.jwt() -> 'amr', '[]'::jsonb);
  v_provider := case
    when exists (select 1 from jsonb_array_elements(v_methods) m where m ->> 'method' = 'oauth') then 'google'
    when exists (select 1 from jsonb_array_elements(v_methods) m where m ->> 'method' = 'password') then 'email'
    when auth.jwt() -> 'app_metadata' ->> 'provider' in ('email', 'google') then auth.jwt() -> 'app_metadata' ->> 'provider'
    else 'unknown' end;
  -- Backfill sessions created before the migration, preserving the real Auth time.
  insert into public.login_events (user_id, session_id, email, display_name, at, provider, allowed)
    values (auth.uid(), v_session, v_access ->> 'email', coalesce(v_access ->> 'display_name', ''),
      v_at, v_provider, (v_access ->> 'allowed')::boolean)
    on conflict (session_id) do update set provider = excluded.provider;
  return v_access;
end;
$$;

-- Remove the former overload: every write must carry the client's expected
-- identity so an SDK token change cannot silently write account A's snapshot as B.
drop function if exists public.save_user_progress(jsonb, bigint);
create or replace function public.save_user_progress(p_records jsonb, p_expected_revision bigint, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_row public.user_progress%rowtype;
begin
  if v_uid is null or p_user_id is distinct from v_uid then
    raise exception 'progress_identity_mismatch' using errcode = '42501';
  end if;
  if not school_private.has_access() then raise exception 'account_not_allowed' using errcode = '42501'; end if;
  if p_records is null or jsonb_typeof(p_records) <> 'object' or octet_length(p_records::text) > 20000000
    or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid_progress' using errcode = '22023';
  end if;
  -- Serialize first insert and concurrent updates for this identity, including two tabs/devices.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  select * into v_row from public.user_progress where user_id = v_uid for update;
  if (found and v_row.revision <> p_expected_revision) or (not found and p_expected_revision <> 0) then
    raise exception 'progress_revision_conflict' using errcode = '40001';
  end if;
  insert into public.user_progress (user_id, records, revision, updated_at)
    values (v_uid, p_records, coalesce(v_row.revision, 0) + 1, now())
    on conflict (user_id) do update set records = excluded.records,
      revision = excluded.revision, updated_at = excluded.updated_at
    returning * into v_row;
  return jsonb_build_object('user_id', v_row.user_id, 'revision', v_row.revision, 'updated_at', v_row.updated_at);
end;
$$;

create or replace function public.platform_admin_roster()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not school_private.is_admin() then raise exception 'administrator_required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(to_jsonb(roster) order by roster.email) from (
      select a.email, a.display_name, a.is_admin, a.enabled, u.id as user_id,
        max(e.at) as last_login_at, count(e.id) as login_count
      from public.allowed_accounts a left join auth.users u on lower(btrim(u.email)) = a.email
      left join public.login_events e on e.user_id = u.id
      group by a.email, a.display_name, a.is_admin, a.enabled, u.id
    ) roster), '[]'::jsonb),
    'login_events', coalesce((select jsonb_agg(to_jsonb(activity) order by activity.at desc) from (
      select id, user_id, email, display_name, at, provider, allowed
      from public.login_events order by at desc, id desc limit 500
    ) activity), '[]'::jsonb));
end;
$$;

create or replace function public.admin_allow_account(p_email text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account public.allowed_accounts%rowtype; v_email text := lower(btrim(p_email));
begin
  if not school_private.is_admin() then raise exception 'administrator_required' using errcode = '42501'; end if;
  if v_email is null or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_display_name is null or length(btrim(p_display_name)) not between 1 and 80 then
    raise exception 'invalid_account' using errcode = '22023';
  end if;
  insert into public.allowed_accounts (email, display_name, is_admin, enabled)
    values (v_email, btrim(p_display_name), false, true)
    on conflict (email) do update set display_name = excluded.display_name,
      enabled = true, updated_at = now() returning * into v_account;
  insert into public.student_profiles (id, email, display_name)
    select u.id, v_email, v_account.display_name from auth.users u
      where lower(btrim(u.email)) = v_email and u.email_confirmed_at is not null
        and not coalesce(u.is_anonymous, false)
    on conflict (id) do update set email = excluded.email,
      display_name = excluded.display_name, updated_at = now();
  return jsonb_build_object('email', v_account.email, 'display_name', v_account.display_name,
    'enabled', v_account.enabled, 'is_admin', v_account.is_admin);
end;
$$;

create or replace function public.admin_disable_account(p_email text, p_disabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account public.allowed_accounts%rowtype; v_email text := lower(btrim(p_email));
begin
  if not school_private.is_admin() then raise exception 'administrator_required' using errcode = '42501'; end if;
  if p_disabled is null then raise exception 'invalid_account' using errcode = '22023'; end if;
  -- Prevent two admins concurrently disabling the final remaining administrator.
  perform pg_advisory_xact_lock(72846320);
  select * into v_account from public.allowed_accounts where email = v_email for update;
  if not found then raise exception 'account_not_found' using errcode = 'P0002'; end if;
  if p_disabled and v_account.is_admin and v_account.enabled
    and (select count(*) from public.allowed_accounts where is_admin and enabled) <= 1 then
    raise exception 'last_administrator_required' using errcode = '22023';
  end if;
  update public.allowed_accounts set enabled = not p_disabled, updated_at = now()
    where email = v_email returning * into v_account;
  return jsonb_build_object('email', v_account.email, 'display_name', v_account.display_name,
    'enabled', v_account.enabled, 'is_admin', v_account.is_admin);
end;
$$;

-- Backfill authorized verified accounts already present before this migration.
insert into public.student_profiles (id, email, display_name)
  select u.id, a.email, a.display_name from auth.users u
    join public.allowed_accounts a on a.email = lower(btrim(u.email))
    where a.enabled and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
  on conflict (id) do update set email = excluded.email, display_name = excluded.display_name, updated_at = now();

-- PostgreSQL grants EXECUTE to PUBLIC on newly created functions by default.
revoke all on all functions in schema school_private from public, anon, authenticated;
grant execute on function school_private.has_access(), school_private.is_admin() to authenticated;
revoke all on function public.platform_access(), public.record_login(), public.save_user_progress(jsonb, bigint, uuid),
  public.platform_admin_roster(), public.admin_allow_account(text, text), public.admin_disable_account(text, boolean),
  public.before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.platform_access(), public.record_login(), public.save_user_progress(jsonb, bigint, uuid),
  public.platform_admin_roster(), public.admin_allow_account(text, text), public.admin_disable_account(text, boolean) to authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;

comment on table public.login_events is 'Actual Supabase Auth sessions only. No passwords, tokens, IP addresses, or browser-supplied event times.';
comment on table public.user_progress is 'Own-user cloud snapshots. Writes require save_user_progress identity-fenced CAS revision RPC; admin has no access to students progress.';
comment on function public.before_user_created(jsonb) is 'Enable as Before User Created hook in Supabase Auth; rejects unlisted/disabled identities.';
commit;
