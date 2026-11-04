-- PROJECT OWNER ONLY: execute in Supabase SQL Editor after 001_school_auth.sql.
-- Never execute from browser code or expose a service-role/database credential.
-- This permits the requested administrator; it does not create an Auth user,
-- assign a password, or seed any student accounts.
begin;
do $$
begin
  if current_user in ('anon', 'authenticated', 'supabase_auth_admin') then
    raise exception 'project_database_owner_required' using errcode = '42501';
  end if;
end;
$$;
insert into public.allowed_accounts (email, display_name, is_admin, enabled)
values ('ayobalbtoosh41@gmail.com', 'أيوب محمد البطوش', true, true)
on conflict (email) do update set display_name = excluded.display_name,
  is_admin = true, enabled = true, updated_at = now();

-- Also synchronize a verified Auth account if it already exists.
insert into public.student_profiles (id, email, display_name)
select u.id, a.email, a.display_name from auth.users u
join public.allowed_accounts a on a.email = lower(btrim(u.email))
where a.email = 'ayobalbtoosh41@gmail.com' and u.email_confirmed_at is not null
  and not coalesce(u.is_anonymous, false)
on conflict (id) do update set email = excluded.email,
  display_name = excluded.display_name, updated_at = now();
commit;
