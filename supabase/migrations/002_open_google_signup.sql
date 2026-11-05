-- POLICY UPDATE: any verified Google identity may join as a student.
-- Project database owner only. Apply after 001_school_auth.sql (and owner bootstrap).
-- Does not configure OAuth, create Auth users/passwords, or reset blocked accounts.
begin;

-- Only canonical Auth-server app metadata is passed to this helper by server code.
-- A user-editable name/provider/role in raw_user_meta_data never establishes access.
create or replace function school_private.is_google_identity(p_app_metadata jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_app_metadata ->> 'provider' = 'google', false)
    or case when jsonb_typeof(p_app_metadata -> 'providers') = 'array'
      then (p_app_metadata -> 'providers') ? 'google' else false end;
$$;

create or replace function school_private.google_display_name(p_user_metadata jsonb, p_email text)
returns text language sql immutable set search_path = '' as $$
  select left(coalesce(nullif(btrim(regexp_replace(regexp_replace(
    coalesce(
      case when jsonb_typeof(p_user_metadata -> 'full_name') = 'string' then nullif(btrim(p_user_metadata ->> 'full_name'), '') end,
      case when jsonb_typeof(p_user_metadata -> 'name') = 'string' then nullif(btrim(p_user_metadata ->> 'name'), '') end,
      p_email), '[[:cntrl:]]', ' ', 'g'), '[[:space:]]+', ' ', 'g')), ''), p_email), 80);
$$;

create or replace function school_private.ensure_account_profile(p_uid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user auth.users%rowtype; v_account public.allowed_accounts%rowtype; v_email text;
begin
  select * into v_user from auth.users where id = p_uid;
  if not found or v_user.email is null or v_user.email_confirmed_at is null
    or coalesce(v_user.is_anonymous, false) then return; end if;
  v_email := lower(btrim(v_user.email));
  if length(v_email) not between 3 and 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return; end if;
  if school_private.is_google_identity(v_user.raw_app_meta_data) then
    insert into public.allowed_accounts (email, display_name, is_admin, enabled)
      values (v_email, school_private.google_display_name(v_user.raw_user_meta_data, v_email), false, true)
      on conflict (email) do nothing;
  end if;
  -- Existing disabled rows and administrator flags are deliberately preserved.
  select * into v_account from public.allowed_accounts where email = v_email and enabled;
  if found then
    insert into public.student_profiles (id, email, display_name)
      values (v_user.id, v_account.email, v_account.display_name)
      on conflict (id) do update set email = excluded.email,
        display_name = excluded.display_name, updated_at = now();
  end if;
end;
$$;

create or replace function school_private.has_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u left join public.allowed_accounts a
      on a.email = lower(btrim(u.email))
    where u.id = auth.uid() and u.email is not null and u.email_confirmed_at is not null
      and not coalesce(u.is_anonymous, false)
      and (a.enabled = true or (a.email is null and school_private.is_google_identity(u.raw_app_meta_data)))
  );
$$;

create or replace function public.platform_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_email text; v_name text; v_admin boolean; v_allowed boolean;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'is_admin', false, 'reason', 'authentication_required');
  end if;
  select lower(btrim(u.email)), coalesce(a.display_name,
      school_private.google_display_name(u.raw_user_meta_data, lower(btrim(u.email)))),
    coalesce(a.is_admin, false),
    u.email is not null and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
      and coalesce(a.enabled = true or (a.email is null and school_private.is_google_identity(u.raw_app_meta_data)), false)
    into v_email, v_name, v_admin, v_allowed
    from auth.users u left join public.allowed_accounts a on a.email = lower(btrim(u.email))
    where u.id = v_uid;
  v_allowed := coalesce(v_allowed, false);
  return jsonb_build_object('allowed', v_allowed, 'is_admin', v_allowed and coalesce(v_admin, false),
    'user_id', v_uid, 'email', v_email, 'display_name', coalesce(v_name, ''),
    'reason', case when v_allowed then null else 'account_not_allowed' end);
end;
$$;

-- Supabase's trusted hook payload uses user.app_metadata, not user.user_metadata.
-- At this creation stage Google performs email verification; access after creation
-- still requires canonical auth.users.email_confirmed_at to be populated.
create or replace function public.before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_email text := lower(btrim(event -> 'user' ->> 'email'));
begin
  if v_email is not null and length(v_email) between 3 and 254
    and v_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    and not coalesce((event -> 'user' ->> 'is_anonymous')::boolean, false)
    and not exists (select 1 from public.allowed_accounts where email = v_email and not enabled)
    and (school_private.is_google_identity(event -> 'user' -> 'app_metadata')
      or exists (select 1 from public.allowed_accounts where email = v_email and enabled)) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403,
    'message', 'Use a verified Google account or an existing permitted school account.'));
end;
$$;

create or replace function school_private.sync_auth_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform school_private.ensure_account_profile(new.id);
  return new;
end;
$$;
drop trigger if exists school_auth_profile on auth.users;
create trigger school_auth_profile after insert or update of email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, is_anonymous on auth.users
  for each row execute function school_private.sync_auth_profile();

create or replace function school_private.log_auth_session()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text; v_name text; v_provider text; v_allowed boolean;
begin
  perform school_private.ensure_account_profile(new.user_id);
  select lower(btrim(u.email)), coalesce(a.display_name,
      school_private.google_display_name(u.raw_user_meta_data, lower(btrim(u.email)))),
    case when jsonb_typeof(u.raw_app_meta_data -> 'providers') = 'array'
        and jsonb_array_length(u.raw_app_meta_data -> 'providers') > 1 then 'unknown'
      when u.raw_app_meta_data ->> 'provider' in ('email', 'google')
      then u.raw_app_meta_data ->> 'provider' else 'unknown' end,
    u.email is not null and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
      and coalesce(a.enabled = true or (a.email is null and school_private.is_google_identity(u.raw_app_meta_data)), false)
    into v_email, v_name, v_provider, v_allowed
    from auth.users u left join public.allowed_accounts a on a.email = lower(btrim(u.email))
    where u.id = new.user_id;
  if v_email is not null then
    insert into public.login_events (user_id, session_id, email, display_name, at, provider, allowed)
      values (new.user_id, new.id, v_email, coalesce(v_name, ''), new.created_at, v_provider, coalesce(v_allowed, false))
      on conflict (session_id) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.record_login()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access jsonb; v_session uuid; v_claim text; v_at timestamptz;
  v_provider text; v_methods jsonb; v_metadata jsonb;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  v_claim := auth.jwt() ->> 'session_id';
  if v_claim is null or v_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'valid_auth_session_required' using errcode = '42501';
  end if;
  v_session := v_claim::uuid;
  select s.created_at into v_at from auth.sessions s where s.id = v_session and s.user_id = auth.uid()
    and (s.not_after is null or s.not_after > now());
  if not found then raise exception 'valid_auth_session_required' using errcode = '42501'; end if;
  perform school_private.ensure_account_profile(auth.uid());
  v_access := public.platform_access();
  select raw_app_meta_data into v_metadata from auth.users where id = auth.uid();
  v_methods := case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end;
  v_provider := case
    when school_private.is_google_identity(v_metadata)
      and exists (select 1 from jsonb_array_elements(v_methods) m where m ->> 'method' = 'oauth') then 'google'
    when exists (select 1 from jsonb_array_elements(v_methods) m where m ->> 'method' = 'password') then 'email'
    when v_metadata ->> 'provider' in ('email', 'google') then v_metadata ->> 'provider'
    else 'unknown' end;
  -- The server session is the event identity; callers cannot supply its time or owner.
  if v_access ->> 'email' is not null then
    insert into public.login_events (user_id, session_id, email, display_name, at, provider, allowed)
      values (auth.uid(), v_session, v_access ->> 'email', coalesce(v_access ->> 'display_name', ''),
        v_at, v_provider, (v_access ->> 'allowed')::boolean)
      on conflict (session_id) do update set provider = excluded.provider;
  end if;
  return v_access;
end;
$$;

-- Upgrade existing verified Google identities without deleting history, changing
-- administrator roles, or re-enabling rows explicitly disabled by an administrator.
do $$
declare v_uid uuid;
begin
  for v_uid in select id from auth.users where email_confirmed_at is not null and not coalesce(is_anonymous, false)
  loop perform school_private.ensure_account_profile(v_uid); end loop;
end;
$$;

-- Keep every new internal helper out of the API. Existing RLS/CAS and admin role
-- checks from 001 remain in place; no client gains direct INSERT/UPDATE permissions.
revoke all on function school_private.is_google_identity(jsonb),
  school_private.google_display_name(jsonb, text), school_private.ensure_account_profile(uuid),
  school_private.sync_auth_profile(), school_private.log_auth_session() from public, anon, authenticated;
revoke all on function school_private.has_access() from public, anon, authenticated;
grant execute on function school_private.has_access() to authenticated;
revoke all on function public.platform_access(), public.record_login(), public.before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.platform_access(), public.record_login() to authenticated;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;

comment on table public.allowed_accounts is 'Account registry and explicit blocks. Verified Google users join automatically as students; existing enabled school accounts remain supported.';
comment on function public.before_user_created(jsonb) is 'Optional Auth hook: allow Google registration without a manual list, preserve explicit blocks, allow existing enabled school accounts.';
commit;
