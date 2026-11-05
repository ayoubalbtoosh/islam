-- FINAL POLICY: public Email/password signup; no Google approval or Google UI.
-- Project owner only. Works after 001, with or without 002. Existing data is kept.
-- FIRST RUN PREREQUISITE: the operator-created, confirmed owner Auth account
-- ayobalbtoosh41@gmail.com must already exist. Otherwise this transaction aborts.
begin;

create table if not exists school_private.admin_bindings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (email = 'ayobalbtoosh41@gmail.com'),
  bound_at timestamptz not null default now()
);
create table if not exists school_private.admin_initialization (
  singleton boolean primary key default true check (singleton),
  initialized_at timestamptz not null default now(),
  -- Deliberately NO foreign key: deletion of the owner must not erase this guard.
  original_owner_id uuid not null
);
revoke all on school_private.admin_bindings, school_private.admin_initialization
  from public, anon, authenticated, supabase_auth_admin;

do $$
declare v_uid uuid;
begin
  perform pg_advisory_xact_lock(648231774);
  if not exists (select 1 from school_private.admin_initialization where singleton) then
    select u.id into v_uid from auth.users u
      left join public.allowed_accounts a on a.email = lower(btrim(u.email))
      where lower(btrim(u.email)) = 'ayobalbtoosh41@gmail.com'
        and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
        and (a.email is null or a.enabled)
      order by u.id limit 1;
    if v_uid is null then
      raise exception 'owner_account_required: create and confirm the operator-owned ayobalbtoosh41@gmail.com Auth account before applying 003'
        using errcode = '22023';
    end if;
    insert into public.allowed_accounts(email, display_name, is_admin, enabled)
      values ('ayobalbtoosh41@gmail.com', 'أيوب محمد البطوش', true, true)
      on conflict (email) do update set is_admin = true;
    insert into school_private.admin_bindings(user_id, email)
      values (v_uid, 'ayobalbtoosh41@gmail.com');
    insert into school_private.admin_initialization(singleton, original_owner_id) values (true, v_uid);
  end if;
end;
$$;

create or replace function school_private.is_email_identity(p_app_metadata jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_app_metadata ->> 'provider' = 'email', false)
    or case when jsonb_typeof(p_app_metadata -> 'providers') = 'array'
      then (p_app_metadata -> 'providers') ? 'email' else false end;
$$;

create or replace function school_private.account_display_name(p_metadata jsonb, p_email text)
returns text language sql immutable set search_path = '' as $$
  select left(coalesce(nullif(btrim(regexp_replace(regexp_replace(coalesce(
    case when jsonb_typeof(p_metadata -> 'display_name') = 'string' then nullif(btrim(p_metadata ->> 'display_name'), '') end,
    case when jsonb_typeof(p_metadata -> 'full_name') = 'string' then nullif(btrim(p_metadata ->> 'full_name'), '') end,
    case when jsonb_typeof(p_metadata -> 'name') = 'string' then nullif(btrim(p_metadata ->> 'name'), '') end,
    p_email), '[[:cntrl:]]', ' ', 'g'), '[[:space:]]+', ' ', 'g')), ''), p_email), 80);
$$;

create or replace function school_private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from school_private.admin_bindings b join auth.users u on u.id = b.user_id
      join public.allowed_accounts a on a.email = b.email
    where b.user_id = auth.uid() and lower(btrim(u.email)) = b.email
      and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false) and a.enabled
  );
$$;

create or replace function school_private.ensure_account_profile(p_uid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text; v_app jsonb; v_metadata jsonb; v_anonymous boolean; v_account public.allowed_accounts%rowtype;
begin
  select lower(btrim(email)), raw_app_meta_data, raw_user_meta_data, is_anonymous
    into v_email, v_app, v_metadata, v_anonymous from auth.users where id = p_uid;
  if not found or v_email is null or coalesce(v_anonymous, false)
    or length(v_email) not between 3 and 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return; end if;
  if not school_private.is_email_identity(v_app)
    and not exists (select 1 from school_private.admin_bindings where user_id = p_uid and email = v_email) then return; end if;
  -- Confirmation is an Auth session-issuance setting, not an extra student gate.
  -- Registration never promotes a role or re-enables an explicitly disabled row.
  insert into public.allowed_accounts(email, display_name, is_admin, enabled)
    values (v_email, school_private.account_display_name(v_metadata, v_email), false, true)
    on conflict (email) do nothing;
  select * into v_account from public.allowed_accounts where email = v_email and enabled;
  if found then
    insert into public.student_profiles(id, email, display_name) values(p_uid, v_email, v_account.display_name)
      on conflict (id) do update set email = excluded.email, display_name = excluded.display_name, updated_at = now();
  end if;
end;
$$;

create or replace function school_private.has_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u left join public.allowed_accounts a on a.email = lower(btrim(u.email))
    where u.id = auth.uid() and u.email is not null and not coalesce(u.is_anonymous, false)
      and (school_private.is_email_identity(u.raw_app_meta_data)
        or exists (select 1 from school_private.admin_bindings b where b.user_id = u.id and b.email = lower(btrim(u.email))))
      and (a.email is null or a.enabled)
  );
$$;

create or replace function public.platform_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_email text; v_name text; v_allowed boolean;
begin
  if v_uid is null then return jsonb_build_object('allowed', false, 'is_admin', false, 'reason', 'authentication_required'); end if;
  select lower(btrim(u.email)), coalesce(a.display_name,
    school_private.account_display_name(u.raw_user_meta_data, lower(btrim(u.email))))
    into v_email, v_name from auth.users u left join public.allowed_accounts a on a.email = lower(btrim(u.email)) where u.id = v_uid;
  v_allowed := school_private.has_access();
  return jsonb_build_object('allowed', v_allowed, 'is_admin', school_private.is_admin(), 'user_id', v_uid,
    'email', v_email, 'display_name', coalesce(v_name, ''), 'reason', case when v_allowed then null else 'account_not_allowed' end);
end;
$$;

create or replace function public.before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_email text := lower(btrim(event -> 'user' ->> 'email'));
begin
  if v_email is not null and length(v_email) between 3 and 254
    and v_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    and not coalesce((event -> 'user' ->> 'is_anonymous')::boolean, false)
    and school_private.is_email_identity(event -> 'user' -> 'app_metadata')
    and not exists (select 1 from public.allowed_accounts where email = v_email and not enabled) then return '{}'::jsonb; end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Use an enabled Email/password account.'));
end;
$$;

create or replace function school_private.sync_auth_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform school_private.ensure_account_profile(new.id); return new; end;
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
  select lower(btrim(u.email)), coalesce(a.display_name, school_private.account_display_name(u.raw_user_meta_data, u.email)),
    case when school_private.is_email_identity(u.raw_app_meta_data) then 'email' else 'unknown' end,
    not coalesce(u.is_anonymous, false) and (school_private.is_email_identity(u.raw_app_meta_data)
      or exists(select 1 from school_private.admin_bindings b where b.user_id = u.id and b.email = lower(btrim(u.email))))
      and coalesce(a.enabled, false)
    into v_email, v_name, v_provider, v_allowed from auth.users u
      left join public.allowed_accounts a on a.email = lower(btrim(u.email)) where u.id = new.user_id;
  if v_email is not null then
    insert into public.login_events(user_id, session_id, email, display_name, at, provider, allowed)
      values(new.user_id, new.id, v_email, coalesce(v_name, ''), new.created_at, v_provider, coalesce(v_allowed, false))
      on conflict(session_id) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.record_login()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_claim text; v_session uuid; v_at timestamptz; v_access jsonb; v_provider text;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  v_claim := auth.jwt() ->> 'session_id';
  if v_claim is null or v_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'valid_auth_session_required' using errcode = '42501'; end if;
  v_session := v_claim::uuid;
  select created_at into v_at from auth.sessions where id = v_session and user_id = auth.uid() and (not_after is null or not_after > now());
  if not found then raise exception 'valid_auth_session_required' using errcode = '42501'; end if;
  perform school_private.ensure_account_profile(auth.uid());
  v_access := public.platform_access();
  select case when school_private.is_email_identity(raw_app_meta_data) then 'email' else 'unknown' end
    into v_provider from auth.users where id = auth.uid();
  if v_access ->> 'email' is not null then
    insert into public.login_events(user_id, session_id, email, display_name, at, provider, allowed)
      values(auth.uid(), v_session, v_access ->> 'email', coalesce(v_access ->> 'display_name', ''), v_at, v_provider, (v_access ->> 'allowed')::boolean)
      on conflict(session_id) do update set provider = excluded.provider;
  end if;
  return v_access;
end;
$$;

-- Registry flags are presentation/legacy data, never authorization. Clear stale
-- email-only administrator flags without reassigning the immutable owner binding.
update public.allowed_accounts a set is_admin = exists (
  select 1 from school_private.admin_bindings b join auth.users u on u.id = b.user_id
  where b.email = a.email and lower(btrim(u.email)) = b.email and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
);

create or replace function public.platform_admin_roster()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not school_private.is_admin() then raise exception 'administrator_required' using errcode = '42501'; end if;
  return jsonb_build_object('accounts', coalesce((select jsonb_agg(to_jsonb(r) order by r.email) from (
    select a.email, a.display_name, a.enabled, u.id as user_id, u.created_at, u.email_confirmed_at,
      exists(select 1 from school_private.admin_bindings b where b.user_id = u.id and b.email = a.email
        and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false) and a.enabled) as is_admin,
      max(e.at) as last_login_at, count(e.id) as login_count
    from public.allowed_accounts a left join auth.users u on lower(btrim(u.email)) = a.email
      left join public.login_events e on e.user_id = u.id
    group by a.email, a.display_name, a.enabled, u.id, u.created_at, u.email_confirmed_at, u.is_anonymous
  ) r), '[]'::jsonb), 'login_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc) from (
    select id, user_id, email, display_name, at, provider, allowed from public.login_events order by at desc, id desc limit 500
  ) e), '[]'::jsonb));
end;
$$;

create or replace function public.admin_allow_account(p_email text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account public.allowed_accounts%rowtype; v_email text := lower(btrim(p_email)); v_admin boolean;
begin
  if not school_private.is_admin() then raise exception 'administrator_required' using errcode = '42501'; end if;
  if v_email is null or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_display_name is null or length(btrim(p_display_name)) not between 1 and 80 then raise exception 'invalid_account' using errcode = '22023'; end if;
  insert into public.allowed_accounts(email, display_name, is_admin, enabled) values(v_email, btrim(p_display_name), false, true)
    on conflict(email) do update set display_name = excluded.display_name, enabled = true, updated_at = now() returning * into v_account;
  perform school_private.ensure_account_profile(u.id) from auth.users u where lower(btrim(u.email)) = v_email;
  select exists(select 1 from school_private.admin_bindings b join auth.users u on u.id = b.user_id
    where b.email = v_email and lower(btrim(u.email)) = b.email and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)) into v_admin;
  return jsonb_build_object('email', v_account.email, 'display_name', v_account.display_name, 'enabled', true, 'is_admin', v_admin);
end;
$$;

create or replace function public.admin_disable_account(p_email text, p_disabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account public.allowed_accounts%rowtype; v_email text := lower(btrim(p_email)); v_admin boolean;
begin
  if not school_private.is_admin() then raise exception 'administrator_required' using errcode = '42501'; end if;
  if p_disabled is null then raise exception 'invalid_account' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(72846320);
  select * into v_account from public.allowed_accounts where email = v_email for update;
  if not found then raise exception 'account_not_found' using errcode = 'P0002'; end if;
  select exists(select 1 from school_private.admin_bindings b join auth.users u on u.id = b.user_id
    where b.email = v_email and lower(btrim(u.email)) = b.email and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)) into v_admin;
  if p_disabled and v_admin and v_account.enabled and (select count(*) from school_private.admin_bindings b
    join auth.users u on u.id = b.user_id join public.allowed_accounts a on a.email = b.email
    where lower(btrim(u.email)) = b.email and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false) and a.enabled) <= 1 then
    raise exception 'last_administrator_required' using errcode = '22023'; end if;
  update public.allowed_accounts set enabled = not p_disabled, updated_at = now() where email = v_email returning * into v_account;
  return jsonb_build_object('email', v_account.email, 'display_name', v_account.display_name, 'enabled', v_account.enabled, 'is_admin', v_admin and v_account.enabled);
end;
$$;

-- The following projection helpers never copy arbitrary object keys or Auth rows.
-- Progress is client-reported study data, not a source of authentication facts.
create or replace function school_private.study_fields(p_object jsonb, p_keys text[])
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_result jsonb := '{}'::jsonb; v_key text; v_value jsonb; v_type text;
begin
  if jsonb_typeof(p_object) <> 'object' then return v_result; end if;
  foreach v_key in array p_keys loop
    v_value := p_object -> v_key; v_type := jsonb_typeof(v_value);
    if v_type = 'number' then
      if (v_value::text)::numeric between 0 and (case when v_key in ('startedAt','questionStartedAt','questionDeadline','deadline','pausedAt')
        then 8640000000000000 else 1000000000000 end) then v_result := v_result || jsonb_build_object(v_key, v_value); end if;
    elsif v_type = 'boolean' or v_type = 'null' then v_result := v_result || jsonb_build_object(v_key, v_value);
    elsif v_type = 'string' and v_key not in ('xp','coins','level','answered','correct','wrong','unanswered','accuracy','duration','totalScore','bestStreak','average','points','elapsed','count','corrected','mastery','current','hearts','requestedCount','countPerPlayer','player','startedAt','questionStartedAt','questionDeadline','deadline','pausedAt') then
      v_result := v_result || jsonb_build_object(v_key, left(p_object ->> v_key, 160));
    end if;
  end loop;
  return v_result;
end;
$$;

create or replace function school_private.study_response(p_response jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_result jsonb; v_item jsonb; v_key text; v_text text;
begin
  if p_response is null or jsonb_typeof(p_response) in ('null','boolean') then return coalesce(p_response, 'null'::jsonb); end if;
  if jsonb_typeof(p_response) = 'string' then
    if (p_response #>> '{}') ~ '^[oirl][0-9]{1,3}$' then return p_response; end if; return 'null'::jsonb;
  elsif jsonb_typeof(p_response) = 'array' then
    v_result := '[]'::jsonb;
    for v_item in select value from jsonb_array_elements(p_response) with ordinality e(value,n) where n <= 100 loop
      if jsonb_typeof(v_item) = 'string' and (v_item #>> '{}') ~ '^[oi][0-9]{1,3}$' then v_result := v_result || jsonb_build_array(v_item); end if;
    end loop; return v_result;
  elsif jsonb_typeof(p_response) = 'object' then
    v_result := '{}'::jsonb;
    for v_key, v_item in select key,value from jsonb_each(p_response) limit 100 loop
      if v_key ~ '^l[0-9]{1,3}$' and jsonb_typeof(v_item) = 'string' and (v_item #>> '{}') ~ '^r[0-9]{1,3}$' then
        v_result := v_result || jsonb_build_object(v_key, v_item); end if;
    end loop; return v_result;
  end if; return 'null'::jsonb;
end;
$$;

create or replace function school_private.study_answers(p_array jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_result jsonb := '[]'::jsonb; v_item jsonb;
begin
  if jsonb_typeof(p_array) <> 'array' then return v_result; end if;
  for v_item in select value from jsonb_array_elements(p_array) with ordinality e(value,n) where n <= 2340 loop
    if jsonb_typeof(v_item) = 'null' then v_result := v_result || jsonb_build_array(null::jsonb);
    elsif jsonb_typeof(v_item) = 'object' then
      v_result := v_result || jsonb_build_array(school_private.study_fields(v_item,
        array['id','lesson_id','difficulty','correct','points','elapsed','timedOut','player','timestamp'])
        || jsonb_build_object('response', school_private.study_response(v_item -> 'response')));
    end if;
  end loop; return v_result;
end;
$$;

create or replace function school_private.study_result_row(p_item jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_item jsonb := p_item; v_row jsonb; v_players jsonb;
begin
    if jsonb_typeof(v_item) <> 'object' then return '{}'::jsonb; end if;
    v_row := school_private.study_fields(v_item, array['id','mode','lessonId','difficulty','scope','timerSeconds','requestedCount','countPerPlayer','periodKey','answered','correct','wrong','unanswered','accuracy','duration','totalScore','bestStreak','average','at','winner']);
    v_row := v_row || jsonb_build_object('items', school_private.study_answers(v_item -> 'items'),
      'reward', school_private.study_fields(v_item -> 'reward', array['xp','coins']));
    if jsonb_typeof(v_item -> 'players') = 'array' then
      select coalesce(jsonb_agg(to_jsonb(left(value #>> '{}',80)) order by n), '[]'::jsonb) into v_players
        from jsonb_array_elements(v_item -> 'players') with ordinality e(value,n) where n <= 2 and jsonb_typeof(value) = 'string';
      v_row := v_row || jsonb_build_object('players', v_players);
    end if;
    if jsonb_typeof(v_item -> 'duelScores') = 'array' then
      select coalesce(jsonb_agg(value order by n), '[]'::jsonb) into v_players
        from jsonb_array_elements(v_item -> 'duelScores') with ordinality e(value,n) where n <= 2 and jsonb_typeof(value) = 'number';
      v_row := v_row || jsonb_build_object('duelScores', v_players);
    end if;
    if jsonb_typeof(v_item -> 'lessonIds') = 'array' then
      select coalesce(jsonb_agg(value order by n), '[]'::jsonb) into v_players
        from jsonb_array_elements(v_item -> 'lessonIds') with ordinality e(value,n)
        where n <= 26 and jsonb_typeof(value) = 'string' and (value #>> '{}') ~ '^u0[1-4]_l[0-9]{2}$';
      v_row := v_row || jsonb_build_object('lessonIds',v_players);
    end if;
    if jsonb_typeof(v_item -> 'duelStats') = 'array' then
      select coalesce(jsonb_agg(school_private.study_fields(value,array['answered','correct','wrong','unanswered','accuracy','duration','average','bestStreak','totalScore']) order by n), '[]'::jsonb)
        into v_players from jsonb_array_elements(v_item -> 'duelStats') with ordinality e(value,n) where n <= 2 and jsonb_typeof(value) = 'object';
      v_row := v_row || jsonb_build_object('duelStats',v_players);
    end if;
    return v_row;
end;
$$;

create or replace function school_private.study_results(p_array jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(school_private.study_result_row(value) order by n),'[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_array) = 'array' then p_array else '[]'::jsonb end)
      with ordinality e(value,n) where n <= 20000 and jsonb_typeof(value) = 'object';
$$;

create or replace function school_private.study_mistakes(p_object jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_result jsonb := '{}'::jsonb; v_key text; v_item jsonb;
begin
  if jsonb_typeof(p_object) <> 'object' then return v_result; end if;
  for v_key,v_item in select key,value from jsonb_each(p_object) where key ~ '^u0[1-4]_l[0-9]{2}_q[0-9]{3}$' limit 2340 loop
    v_result := v_result || jsonb_build_object(v_key, school_private.study_fields(v_item, array['count','corrected','mastery','lastAt','lessonId'])
      || case when v_item ->> 'level' in ('easy','medium','hard') then jsonb_build_object('level',v_item ->> 'level') else '{}'::jsonb end);
  end loop; return v_result;
end;
$$;

create or replace function public.platform_admin_student_details(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user jsonb; v_records jsonb := '{}'::jsonb; v_updated timestamptz; v_revision bigint;
  v_settings jsonb; v_active jsonb; v_achievements jsonb := '{}'::jsonb; v_visits jsonb := '{}'::jsonb;
  v_key text; v_value jsonb; v_questions jsonb; v_profile jsonb;
begin
  if not school_private.is_admin() then raise exception 'administrator_required' using errcode = '42501'; end if;
  select jsonb_build_object('id',u.id,'email',lower(btrim(u.email)),
    'display_name',coalesce(a.display_name,school_private.account_display_name(u.raw_user_meta_data,u.email)),
    'created_at',u.created_at,'email_confirmed_at',u.email_confirmed_at,'email_confirmed',u.email_confirmed_at is not null,
    'confirmation_source','supabase_auth_record','email_ownership_verified',null,
    'provider',case when school_private.is_email_identity(u.raw_app_meta_data) then 'email' else 'unknown' end,
    'disabled',not coalesce(a.enabled,false)) into v_user
    from auth.users u left join public.allowed_accounts a on a.email = lower(btrim(u.email)) where u.id = p_user_id;
  if v_user is null then raise exception 'student_not_found' using errcode = 'P0002'; end if;
  select records,updated_at,revision into v_records,v_updated,v_revision from public.user_progress where user_id = p_user_id;
  v_records := coalesce(v_records, '{}'::jsonb);
  v_settings := school_private.study_fields(v_records -> 'settings', array['theme','sounds','feedback','roundTimer'])
    || jsonb_build_object('timers',school_private.study_fields(v_records -> 'settings' -> 'timers',array['easy','medium','hard']));
  if jsonb_typeof(v_records -> 'active') = 'object' then
    v_active := school_private.study_fields(v_records -> 'active',array['id','mode','lessonId','difficulty','scope','current','phase','startedAt','questionStartedAt','questionDeadline','deadline','pausedAt','timerSeconds','hearts','requestedCount','feedback','finished','day','week','elapsedBefore']);
    select coalesce(jsonb_agg(school_private.study_fields(value,array['id','lesson_id','difficulty','type']) order by n), '[]'::jsonb)
      into v_questions from jsonb_array_elements(case when jsonb_typeof(v_records -> 'active' -> 'questions') = 'array'
        then v_records -> 'active' -> 'questions' else '[]'::jsonb end) with ordinality e(value,n) where n <= 2340;
    v_active := v_active || jsonb_build_object('questions',v_questions,'answers',school_private.study_answers(v_records -> 'active' -> 'answers'),
      'draft',school_private.study_response(v_records -> 'active' -> 'draft'));
    if jsonb_typeof(v_records -> 'active' -> 'players') = 'array' then
      select coalesce(jsonb_agg(to_jsonb(left(value #>> '{}',80)) order by n), '[]'::jsonb) into v_questions
        from jsonb_array_elements(v_records -> 'active' -> 'players') with ordinality e(value,n) where n <= 2 and jsonb_typeof(value) = 'string';
      v_active := v_active || jsonb_build_object('players',v_questions);
    end if;
    if jsonb_typeof(v_records -> 'active' -> 'lessonIds') = 'array' then
      select coalesce(jsonb_agg(value order by n), '[]'::jsonb) into v_questions
        from jsonb_array_elements(v_records -> 'active' -> 'lessonIds') with ordinality e(value,n)
        where n <= 26 and jsonb_typeof(value) = 'string' and (value #>> '{}') ~ '^u0[1-4]_l[0-9]{2}$';
      v_active := v_active || jsonb_build_object('lessonIds',v_questions);
    end if;
  end if;
  if jsonb_typeof(v_records -> 'profile' -> 'visitedLessons') = 'object' then
    for v_key,v_value in select key,value from jsonb_each(v_records -> 'profile' -> 'visitedLessons')
      where key ~ '^u0[1-4]_l[0-9]{2}$' limit 26 loop
      if jsonb_typeof(v_value) = 'string' and (v_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then
        v_visits := v_visits || jsonb_build_object(v_key,left(v_value #>> '{}',80)); end if;
    end loop;
  end if;
  v_profile := school_private.study_fields(v_records -> 'profile',array['name','xp','coins','level','lastLessonId'])
    || jsonb_build_object('visitedLessons',v_visits);
  if jsonb_typeof(v_records -> 'achievements') = 'object' then
    for v_key,v_value in select key,value from jsonb_each(v_records -> 'achievements') where key in ('first','ten','streak','perfect','hundred','duel','master','review','unit','journey') loop
      if jsonb_typeof(v_value) = 'string' and (v_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then
        v_achievements := v_achievements || jsonb_build_object(v_key,left(v_value #>> '{}',80)); end if;
    end loop;
  end if;
  return jsonb_build_object('user',v_user,'profile',v_profile,
    'progress',jsonb_build_object('results',school_private.study_results(v_records -> 'results'),
      'mistakes',school_private.study_mistakes(v_records -> 'mistakes'),'active',v_active,'achievements',v_achievements,
      'settings',v_settings,'updated_at',v_updated,'revision',v_revision),
    'login_events',coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc) from (
      select id,email,display_name,at,provider,allowed from public.login_events where user_id = p_user_id order by at desc,id desc
    ) e),'[]'::jsonb), 'limits',jsonb_build_object('results',20000,
      'total_results',case when jsonb_typeof(v_records -> 'results') = 'array' then jsonb_array_length(v_records -> 'results') else 0 end));
end;
$$;

do $$
declare v_uid uuid;
begin for v_uid in select id from auth.users where email is not null and not coalesce(is_anonymous,false)
  loop perform school_private.ensure_account_profile(v_uid); end loop; end;
$$;

-- Retain own-only direct progress RLS and the existing three-argument CAS/identity
-- fence. The admin details RPC is the only newly granted path to another snapshot.
revoke all on all functions in schema school_private from public, anon, authenticated;
grant execute on function school_private.has_access(),school_private.is_admin() to authenticated;
revoke all on function public.platform_access(),public.record_login(),public.before_user_created(jsonb),
  public.platform_admin_roster(),public.admin_allow_account(text,text),public.admin_disable_account(text,boolean),
  public.platform_admin_student_details(uuid) from public,anon,authenticated;
grant execute on function public.platform_access(),public.record_login(),public.platform_admin_roster(),
  public.admin_allow_account(text,text),public.admin_disable_account(text,boolean),public.platform_admin_student_details(uuid) to authenticated;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;
comment on table public.allowed_accounts is 'Email account registry and explicit blocks. is_admin is legacy display data; immutable private UID bindings authorize administration.';
comment on function public.platform_admin_student_details(uuid) is 'Bound administrator only. Curated client-reported study records; no passwords, tokens, raw Auth rows or arbitrary JSON fields. Auth confirmation flags are not asserted mailbox proof.';
commit;
