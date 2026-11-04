/** Real PostgreSQL semantics via PGlite; Auth/JWT transport is stubbed, not a hosted Auth test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const database = new PGlite();
const sql = await readFile(new URL('../migrations/001_school_auth.sql', import.meta.url), 'utf8');
const uid = { admin: '00000000-0000-4000-8000-000000000001', student: '00000000-0000-4000-8000-000000000002', other: '00000000-0000-4000-8000-000000000003', denied: '00000000-0000-4000-8000-000000000004', unverified: '00000000-0000-4000-8000-000000000005' };
const sid = { admin: '10000000-0000-4000-8000-000000000001', student: '10000000-0000-4000-8000-000000000002', other: '10000000-0000-4000-8000-000000000003', denied: '10000000-0000-4000-8000-000000000004', unverified: '10000000-0000-4000-8000-000000000005' };
async function as(role, user, query, values = [], claims = {}) {
  await database.exec(`begin; set local role ${role};`);
  try {
    await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid[user], session_id: sid[user], amr: [{ method: 'password' }], ...claims })]);
    const result = await database.query(query, values);
    await database.exec('commit');
    return result.rows;
  } catch (error) {
    await database.exec('rollback');
    throw error;
  }
}
const auth = (user, query, values, claims) => as('authenticated', user, query, values, claims);
const scalar = rows => Object.values(rows[0])[0];

test('school authorization, RLS, server activity and progress revisions', async t => {
  await database.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz, is_anonymous boolean default false, raw_app_meta_data jsonb default '{}');
    create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id), created_at timestamptz not null default now(), not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  `);
  await t.test('migration compiles and reapplication is idempotent', async () => {
    await database.exec(sql);
    await database.exec("create function public.save_user_progress(jsonb,bigint) returns jsonb language sql as $$ select '{}'::jsonb $$");
    await database.exec(sql);
    assert.equal(scalar((await database.query("select to_regprocedure('public.save_user_progress(jsonb,bigint)')")).rows), null);
  });
  await database.query(`insert into public.allowed_accounts (email, display_name, is_admin) values
    ('admin@example.test', 'Admin', true), ('student@example.test', 'Student', false),
    ('other@example.test', 'Other', false), ('unverified@example.test', 'Unverified', false)`);
  for (const key of Object.keys(uid)) {
    await database.query('insert into auth.users (id,email,email_confirmed_at,raw_app_meta_data) values ($1,$2,$3,$4)', [uid[key], `${key}@example.test`, key === 'unverified' ? null : '2026-11-04T10:00:00Z', JSON.stringify({ provider: 'email', providers: key === 'student' ? ['email', 'google'] : ['email'] })]);
    await database.query('insert into auth.sessions (id,user_id,created_at) values ($1,$2,$3)', [sid[key], uid[key], '2026-11-04T11:00:00Z']);
  }
  await t.test('server session trigger records actual canonical identity/time, including denied sessions', async () => {
    const events = (await database.query('select * from public.login_events order by email')).rows;
    assert.equal(events.length, 5);
    assert.equal(events.find(x => x.email === 'denied@example.test').allowed, false);
    assert.equal(events.find(x => x.email === 'unverified@example.test').allowed, false);
    assert.equal(new Date(events[0].at).toISOString(), '2026-11-04T11:00:00.000Z');
    assert.equal(events.find(x => x.email === 'student@example.test').provider, 'unknown');
  });
  await t.test('anon has no protected table or RPC grants', async () => {
    await assert.rejects(as('anon', 'student', 'select public.platform_access()'), /permission denied/);
    await assert.rejects(as('anon', 'student', 'select * from public.allowed_accounts'), /permission denied/);
    await assert.rejects(as('anon', 'student', 'select * from public.user_progress'), /permission denied/);
  });
  await t.test('canonical verified identity overrides spoofed client email and admin claims', async () => {
    const access = scalar(await auth('student', 'select public.platform_access()', [], { email: 'admin@example.test', is_admin: true, user_metadata: { role: 'admin' } }));
    assert.equal(access.allowed, true); assert.equal(access.is_admin, false);
    assert.equal(access.email, 'student@example.test'); assert.equal(access.user_id, uid.student);
    assert.equal(scalar(await auth('denied', 'select public.platform_access()')).allowed, false);
    assert.equal(scalar(await auth('unverified', 'select public.platform_access()')).allowed, false);
  });
  await t.test('students cannot promote self, mutate identity, add accounts or read login roster', async () => {
    await assert.rejects(auth('student', "update public.allowed_accounts set is_admin=true where email='student@example.test'"), /permission denied/);
    await assert.rejects(auth('student', "update public.student_profiles set email='admin@example.test'"), /permission denied/);
    await assert.rejects(auth('student', 'select public.platform_admin_roster()'), /administrator_required/);
    await assert.rejects(auth('student', "select public.admin_allow_account('intruder@example.test','Intruder')"), /administrator_required/);
    assert.deepEqual(await auth('student', 'select * from public.login_events'), []);
    assert.deepEqual(await auth('student', 'select * from public.allowed_accounts'), []);
    assert.deepEqual((await auth('student', 'select id from public.student_profiles')).map(x => x.id), [uid.student]);
  });
  await t.test('record_login requires actual owned Auth session and cannot fabricate timestamps or repeated events', async () => {
    const before = scalar((await database.query('select count(*) from public.login_events')).rows);
    await auth('student', 'select public.record_login()', [], { amr: [{ method: 'oauth' }] });
    await auth('student', 'select public.record_login()', [], { amr: [{ method: 'oauth' }] });
    assert.equal(scalar((await database.query('select count(*) from public.login_events')).rows), before);
    assert.equal((await database.query('select provider from public.login_events where user_id=$1', [uid.student])).rows[0].provider, 'google');
    await assert.rejects(auth('student', 'select public.record_login()', [], { session_id: sid.other }), /valid_auth_session_required/);
    await assert.rejects(auth('student', 'select public.record_login()', [], { session_id: 'not-a-session' }), /valid_auth_session_required/);
    await assert.rejects(auth('student', "insert into public.login_events(user_id,session_id,email,display_name,at,provider,allowed) values ($1,$2,'fake@example.test','Fake',now(),'google',true)", [uid.student, sid.student]), /permission denied/);
  });
  await t.test('changed SDK identity cannot save another account snapshot, and no unfenced overload remains', async () => {
    const mismatch = await auth('other', 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 987 } }, uid.student]).then(() => null, error => error);
    assert.ok(mismatch); assert.equal(mismatch.code, '42501');
    assert.match(mismatch.message, /progress_identity_mismatch/);
    assert.equal(scalar((await database.query('select count(*) from public.user_progress')).rows), 0);
    await assert.rejects(auth('other', 'select public.save_user_progress($1,0,$2)', [{ profile: {} }, null]), /progress_identity_mismatch/);
    await assert.rejects(auth('student', 'select public.save_user_progress($1,0)', [{ profile: { xp: 987 } }]), /does not exist/);
  });
  await t.test('progress is own-only; direct writes and client timestamps are forbidden', async () => {
    const first = scalar(await auth('student', 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 10 } }, uid.student]));
    assert.equal(first.revision, 1); assert.equal(first.user_id, uid.student);
    await auth('other', 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 20 } }, uid.other]);
    const rows = await auth('student', 'select * from public.user_progress');
    assert.equal(rows.length, 1); assert.equal(rows[0].user_id, uid.student);
    assert.deepEqual(await auth('student', 'select * from public.user_progress where user_id=$1', [uid.other]), []);
    assert.deepEqual(await auth('admin', 'select * from public.user_progress'), []);
    await assert.rejects(auth('student', "update public.user_progress set updated_at='2000-01-01', revision=100"), /permission denied/);
    await assert.rejects(auth('student', 'delete from public.user_progress'), /permission denied/);
  });
  await t.test('CAS rejects stale/missing revisions without overwriting newer records', async () => {
    await assert.rejects(auth('student', 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 99 } }, uid.student]), /progress_revision_conflict/);
    const next = scalar(await auth('student', 'select public.save_user_progress($1,1,$2)', [{ profile: { xp: 30 } }, uid.student]));
    assert.equal(next.revision, 2);
    await assert.rejects(auth('student', 'select public.save_user_progress($1,1,$2)', [{ profile: { xp: 999 } }, uid.student]), /progress_revision_conflict/);
    assert.equal((await auth('student', 'select records from public.user_progress'))[0].records.profile.xp, 30);
    await assert.rejects(auth('student', 'select public.save_user_progress($1,2,$2)', [[], uid.student]), /invalid_progress/);
  });
  await t.test('disabled existing sessions immediately lose RPC, RLS and admin access', async () => {
    await auth('admin', "select public.admin_disable_account('student@example.test', true)");
    assert.equal(scalar(await auth('student', 'select public.platform_access()')).allowed, false);
    assert.deepEqual(await auth('student', 'select * from public.student_profiles'), []);
    assert.deepEqual(await auth('student', 'select * from public.user_progress'), []);
    await assert.rejects(auth('student', 'select public.save_user_progress($1,2,$2)', [{ profile: {} }, uid.student]), /account_not_allowed/);
    assert.equal(scalar(await auth('student', 'select public.record_login()')).allowed, false);
    await auth('admin', "select public.admin_disable_account('student@example.test', false)");
    assert.equal(scalar(await auth('student', 'select public.platform_access()')).allowed, true);
  });
  await t.test('admin normalizes new allowlist identities without creating Auth accounts/admin privileges', async () => {
    const created = scalar(await auth('admin', "select public.admin_allow_account(' New.Student@Example.Test ', ' New Student ' )"));
    assert.equal(created.email, 'new.student@example.test'); assert.equal(created.is_admin, false);
    assert.equal(created.display_name, 'New Student');
    assert.equal(scalar((await database.query("select count(*) from auth.users where email='new.student@example.test'")).rows), 0);
    await assert.rejects(auth('admin', "select public.admin_allow_account('invalid','Name')"), /invalid_account/);
    await assert.rejects(auth('admin', "select public.admin_disable_account('admin@example.test',true)"), /last_administrator_required/);
  });
  await t.test('changing canonical Auth email invalidates access despite an old allowed email claim', async () => {
    await database.query("update auth.users set email='not.allowed@example.test' where id=$1", [uid.student]);
    assert.equal(scalar(await auth('student', 'select public.platform_access()', [], { email: 'student@example.test' })).allowed, false);
    assert.deepEqual(await auth('student', 'select * from public.user_progress'), []);
    await database.query("update auth.users set email='student@example.test' where id=$1", [uid.student]);
    assert.equal(scalar(await auth('student', 'select public.platform_access()')).allowed, true);
  });
  await t.test('disabled admin token loses administration and anonymous Auth identity has no access', async () => {
    await database.exec("update public.allowed_accounts set is_admin=true where email='other@example.test'");
    await auth('other', "select public.admin_disable_account('admin@example.test',true)");
    await assert.rejects(auth('admin', 'select public.platform_admin_roster()', [], { is_admin: true }), /administrator_required/);
    await auth('other', "select public.admin_disable_account('admin@example.test',false)");
    await database.exec("update public.allowed_accounts set is_admin=false where email='other@example.test'");
    await database.query('update auth.users set is_anonymous=true where id=$1', [uid.other]);
    assert.equal(scalar(await auth('other', 'select public.platform_access()')).allowed, false);
    await database.query('update auth.users set is_anonymous=false where id=$1', [uid.other]);
  });
  await t.test('admin roster exposes names/email/login facts and no password/session/token material', async () => {
    const roster = scalar(await auth('admin', 'select public.platform_admin_roster()'));
    assert.ok(roster.accounts.some(x => x.email === 'student@example.test'));
    assert.equal(roster.login_events.length, 5);
    assert.equal(roster.accounts.find(x => x.email === 'student@example.test').login_count, 1);
    assert.ok(!/password|token|session_id|encrypted/i.test(JSON.stringify(roster)));
  });
  await t.test('before-user-created hook is Auth-only and rejects nonallowed/disabled accounts', async () => {
    const allowed = scalar(await as('supabase_auth_admin', 'student', 'select public.before_user_created($1)', [{ user: { email: ' STUDENT@EXAMPLE.TEST ' } }]));
    assert.deepEqual(allowed, {});
    const denied = scalar(await as('supabase_auth_admin', 'denied', 'select public.before_user_created($1)', [{ user: { email: 'denied@example.test' } }]));
    assert.equal(denied.error.http_code, 403);
    await auth('admin', "select public.admin_disable_account('student@example.test',true)");
    const disabled = scalar(await as('supabase_auth_admin', 'student', 'select public.before_user_created($1)', [{ user: { email: 'student@example.test' } }]));
    assert.equal(disabled.error.http_code, 403);
    await auth('admin', "select public.admin_disable_account('student@example.test',false)");
    await assert.rejects(auth('student', 'select public.before_user_created($1)', [{ user: { email: 'student@example.test' } }]), /permission denied/);
  });
  await t.test('migration reapplication preserves stored progress and logs', async () => {
    await database.exec(sql);
    assert.equal((await auth('student', 'select records from public.user_progress'))[0].records.profile.xp, 30);
    assert.equal(scalar((await database.query('select count(*) from public.login_events')).rows), 5);
  });
  await t.test('owner bootstrap permits only the requested administrator and rejects browser roles', async () => {
    const bootstrap = await readFile(new URL('../bootstrap-owner.sql', import.meta.url), 'utf8');
    await database.exec('set role authenticated');
    await assert.rejects(database.exec(bootstrap), /project_database_owner_required/);
    await database.exec('rollback; reset role');
    await database.exec(bootstrap);
    await database.exec(bootstrap);
    const owner = (await database.query("select * from public.allowed_accounts where email='ayobalbtoosh41@gmail.com'")).rows;
    assert.equal(owner.length, 1); assert.equal(owner[0].display_name, 'أيوب محمد البطوش');
    assert.equal(owner[0].is_admin, true); assert.equal(owner[0].enabled, true);
    assert.equal(scalar((await database.query("select count(*) from auth.users where email='ayobalbtoosh41@gmail.com'")).rows), 0);
  });
  await t.test('offline provisioning escapes SQL, normalizes identities and rejects secrets/duplicates/overwrite', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'school-roster-test-'));
    const input = path.join(directory, 'input.json'), output = path.join(directory, 'output.sql');
    const tool = fileURLToPath(new URL('../provision-allowlist.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [tool, input, output], { encoding: 'utf8' });
    try {
      const name = "O'Neil'); DROP TABLE public.user_progress; --";
      await writeFile(input, JSON.stringify([{ email: " O'NEIL@example.test ", display_name: name }]));
      assert.equal(run().status, 0);
      await database.exec(await readFile(output, 'utf8'));
      const account = (await database.query('select display_name,is_admin from public.allowed_accounts where email=$1', ["o'neil@example.test"])).rows[0];
      assert.equal(account.display_name, name); assert.equal(account.is_admin, false);
      assert.equal(scalar((await database.query('select count(*) from public.user_progress')).rows), 2);
      assert.notEqual(run().status, 0); // Existing generated file is never overwritten.
      await rm(output);
      await writeFile(input, JSON.stringify([{ email: 'one@example.test', display_name: 'One', password: null }]));
      assert.notEqual(run().status, 0);
      await writeFile(input, JSON.stringify([{ email: 'one@example.test', display_name: 'One' }, { email: ' ONE@example.test ', display_name: 'Duplicate' }]));
      assert.notEqual(run().status, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await database.close();
});
