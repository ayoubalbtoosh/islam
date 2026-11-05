/** Standalone one-paste setup smoke test; uses local PostgreSQL via PGlite only. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const [combined, migration, owner] = await Promise.all([
  readFile(new URL('../setup-school.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/001_school_auth.sql', import.meta.url), 'utf8'),
  readFile(new URL('../bootstrap-owner.sql', import.meta.url), 'utf8'),
]);
assert.ok(combined.endsWith(migration + '\n' + owner), 'Both source files must be included byte-for-byte.');
assert.equal((combined.match(/^begin;$/gm) || []).length, 2, 'Keep the two original transactions.');
const database = new PGlite();
try {
  await database.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz,
      is_anonymous boolean default false, raw_app_meta_data jsonb default '{}', encrypted_password text);
    create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id),
      created_at timestamptz not null default now(), not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  `);
  for (let run = 1; run <= 2; run++) {
    await database.exec(combined);
    const tables = (await database.query(`select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' order by c.relname`)).rows;
    assert.deepEqual(tables.map(row => row.relname), ['allowed_accounts', 'login_events', 'student_profiles', 'user_progress']);
    assert.ok(tables.every(row => row.relrowsecurity), 'All application tables require RLS.');
    const accounts = (await database.query('select email,display_name,is_admin,enabled from public.allowed_accounts')).rows;
    assert.deepEqual(accounts, [{ email: 'ayobalbtoosh41@gmail.com', display_name: 'أيوب محمد البطوش', is_admin: true, enabled: true }]);
    for (const table of ['auth.users', 'auth.sessions', 'public.student_profiles', 'public.login_events', 'public.user_progress']) {
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
    console.log(`PASS run ${run}: four RLS tables, four policies, exact administrator allowlist, fenced RPC grants; no Auth users/passwords/student records created.`);
  }
  console.log('PASS exact source concatenation and two-transaction preservation.');
  console.log('RESULT: fresh local PostgreSQL setup and idempotent second run passed. No live Supabase operation was performed.');
} finally {
  await database.close();
}
