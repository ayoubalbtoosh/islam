/** Standalone one-paste setup smoke test; uses local PostgreSQL via PGlite only. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const [combined, migration, owner, email] = await Promise.all([
  readFile(new URL('../setup-school.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/001_school_auth.sql', import.meta.url), 'utf8'),
  readFile(new URL('../bootstrap-owner.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/003_public_email_signup.sql', import.meta.url), 'utf8'),
]);
assert.ok(combined.endsWith(migration + '\n' + owner + '\n' + email), 'All three current source files must be included byte-for-byte.');
assert.equal((combined.match(/^begin;$/gm) || []).length, 3, 'Keep the three original transactions.');
const database = new PGlite();
try {
  await database.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now(), email_confirmed_at timestamptz,
      is_anonymous boolean default false, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}', encrypted_password text);
    create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id),
      created_at timestamptz not null default now(), not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  `);
  await assert.rejects(database.exec(combined),/owner_account_required/);
  await database.exec('rollback');
  assert.equal((await database.query("select to_regclass('public.allowed_accounts') as x")).rows[0].x,null);
  await database.query('insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,$2,now(),$3)',
    ['00000000-0000-4000-8000-000000000001','ayobalbtoosh41@gmail.com',JSON.stringify({provider:'email',providers:['email']})]);
  for (let run = 1; run <= 2; run++) {
    await database.exec(combined);
    const tables = (await database.query(`select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' order by c.relname`)).rows;
    assert.deepEqual(tables.map(row => row.relname), ['allowed_accounts', 'login_events', 'student_profiles', 'user_progress']);
    assert.ok(tables.every(row => row.relrowsecurity), 'All application tables require RLS.');
    const accounts = (await database.query('select email,display_name,is_admin,enabled from public.allowed_accounts')).rows;
    assert.deepEqual(accounts, [{ email: 'ayobalbtoosh41@gmail.com', display_name: 'أيوب محمد البطوش', is_admin: true, enabled: true }]);
    assert.equal((await database.query('select count(*)::integer as count from auth.users')).rows[0].count,1,'Existing owner remains the only Auth user.');
    assert.equal((await database.query('select count(*)::integer as count from public.student_profiles')).rows[0].count,1,'Only the existing owner profile is synchronized.');
    assert.equal((await database.query('select count(*)::integer as count from school_private.admin_bindings')).rows[0].count,1);
    for (const table of ['auth.sessions', 'public.login_events', 'public.user_progress']) {
      const { rows } = await database.query(`select count(*)::integer as count from ${table}`);
      assert.equal(rows[0].count, 0, `${table}: setup must not create Auth accounts, passwords or student records.`);
    }
    const rpc = (await database.query(`select
      to_regprocedure('public.save_user_progress(jsonb,bigint)') as old_rpc,
      to_regprocedure('public.save_user_progress(jsonb,bigint,uuid)') as new_rpc,
      has_function_privilege('anon','public.save_user_progress(jsonb,bigint,uuid)','EXECUTE') as anon_write,
      has_function_privilege('authenticated','public.save_user_progress(jsonb,bigint,uuid)','EXECUTE') as member_write`)).rows[0];
    assert.equal(rpc.old_rpc, null); assert.ok(rpc.new_rpc);
    assert.equal(rpc.anon_write, false); assert.equal(rpc.member_write, true);
    const policies = (await database.query("select count(*)::integer as count from pg_policies where schemaname='public'")).rows[0].count;
    assert.equal(policies, 4);
    console.log(`PASS run ${run}: four RLS tables, four policies, exact owner UID binding and fenced RPC grants; existing owner only, no Auth users/passwords added.`);
  }
  console.log('PASS owner preflight before policy changes, exact source concatenation, and three-transaction preservation including public Email/password migration003.');
  console.log('RESULT: fresh local PostgreSQL setup and idempotent second run passed. No live Supabase operation was performed.');
} finally {
  await database.close();
}
