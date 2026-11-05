/** Real PostgreSQL/RLS upgrade tests; Supabase Auth transport and JWT signatures are stubbed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const [original, owner, upgrade, combined] = await Promise.all([
  readFile(new URL('../migrations/001_school_auth.sql', import.meta.url), 'utf8'),
  readFile(new URL('../bootstrap-owner.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/002_open_google_signup.sql', import.meta.url), 'utf8'),
  readFile(new URL('../setup-school.sql', import.meta.url), 'utf8'),
]);
const ownerEmail = 'ayobalbtoosh41@gmail.com';
const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const session = index => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const scalar = rows => Object.values(rows[0])[0];
async function makeDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz,
      is_anonymous boolean default false, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}');
    create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id),
      created_at timestamptz not null default now(), not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  `);
  return db;
}
async function as(db, index, query, values = [], claims = {}, role = 'authenticated') {
  await db.exec(`begin; set local role ${role};`);
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id(index), session_id: session(index), amr: [{ method: 'oauth' }], ...claims })]);
    const result = await db.query(query, values); await db.exec('commit'); return result.rows;
  } catch (error) { await db.exec('rollback'); throw error; }
}
async function addUser(db, index, email, app = { provider: 'google', providers: ['google'] }, metadata = {}, verified = true, anonymous = false) {
  await db.query('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,is_anonymous) values($1,$2,$3,$4,$5,$6)',
    [id(index), email, JSON.stringify(app), JSON.stringify(metadata), verified ? '2026-11-05T10:00:00Z' : null, anonymous]);
}
async function addSession(db, index, sessionIndex = index) {
  await db.query('insert into auth.sessions(id,user_id,created_at) values($1,$2,$3)', [session(sessionIndex), id(index), '2026-11-05T11:00:00Z']);
}

test('002 upgrades installed data to open verified-Google registration without relaxing identity/RLS/admin controls', async t => {
  const db = await makeDatabase();
  try {
    await db.exec(original + '\n' + owner);
    await addUser(db, 1, ownerEmail, { provider: 'email', providers: ['email'] }, { full_name: 'Owner' });
    await db.query("insert into public.allowed_accounts(email,display_name,enabled) values('blocked@school.example','Blocked',false),('legacy@school.example','Legacy',true)");
    await addUser(db, 2, 'existing-google@school.example', undefined, { full_name: 'Existing Google' });
    await addUser(db, 3, 'blocked@school.example', undefined, { full_name: 'Blocked Google' });
    await addUser(db, 4, 'legacy@school.example', { provider: 'email', providers: ['email'] }, { full_name: 'Legacy' });
    await addSession(db, 1); await addSession(db, 2); await addSession(db, 3); await addSession(db, 4);
    await as(db, 1, 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 42 } }, id(1)], { amr: [{ method: 'password' }] });
    const beforeEvents = (await db.query('select id,user_id,at,allowed from public.login_events order by id')).rows;
    await t.test('upgrade backfills verified Google users without deleting existing progress/history or re-enabling blocks', async () => {
      await db.exec(upgrade);
      assert.equal((await db.query('select is_admin from public.allowed_accounts where email=$1', [ownerEmail])).rows[0].is_admin, true);
      assert.equal((await db.query("select enabled from public.allowed_accounts where email='blocked@school.example'")).rows[0].enabled, false);
      assert.equal((await db.query("select is_admin from public.allowed_accounts where email='existing-google@school.example'")).rows[0].is_admin, false);
      assert.equal((await db.query('select records from public.user_progress where user_id=$1', [id(1)])).rows[0].records.profile.xp, 42);
      assert.deepEqual((await db.query('select id,user_id,at,allowed from public.login_events order by id')).rows, beforeEvents);
      assert.equal(scalar(await as(db, 2, 'select public.platform_access()')).allowed, true);
      assert.equal(scalar(await as(db, 4, 'select public.platform_access()')).allowed, true);
    });
    await t.test('unlisted first-time Google and custom-domain Workspace accounts auto-register as students', async () => {
      await addUser(db, 5, 'first.google@gmail.com', undefined, { full_name: 'First Google', is_admin: true, role: 'admin' });
      await addUser(db, 6, 'student@workspace.school', undefined, { name: 'Workspace Student' });
      for (const index of [5, 6]) {
        const access = scalar(await as(db, index, 'select public.platform_access()'));
        assert.equal(access.allowed, true); assert.equal(access.is_admin, false);
        assert.equal((await as(db, index, 'select * from public.student_profiles')).length, 1);
      }
      const roster = scalar(await as(db, 1, 'select public.platform_admin_roster()'));
      assert.ok(roster.accounts.some(x => x.email === 'first.google@gmail.com'));
      assert.ok(roster.accounts.some(x => x.email === 'student@workspace.school'));
      assert.deepEqual(roster.accounts.filter(x => x.is_admin).map(x => x.email), [ownerEmail]);
    });
    await t.test('spoofed user metadata/JWT Google claims and unknown verified Email identities are denied', async () => {
      await addUser(db, 7, 'spoofed@school.example', { provider: 'email', providers: ['email'] }, { provider: 'google', providers: ['google'], is_admin: true, email_verified: true });
      await addUser(db, 8, 'unlisted-email@school.example', { provider: 'email', providers: ['email'] });
      await addUser(db, 9, 'malformed-provider@school.example', { provider: 'email', providers: { google: true } });
      for (const index of [7, 8, 9]) {
        const access = scalar(await as(db, index, 'select public.platform_access()', [], { app_metadata: { provider: 'google' }, is_admin: true, email: ownerEmail }));
        assert.equal(access.allowed, false); assert.equal(access.is_admin, false);
        await assert.rejects(as(db, index, 'select public.save_user_progress($1,0,$2)', [{ profile: {} }, id(index)]), /account_not_allowed/);
        assert.deepEqual(await as(db, index, 'select * from public.user_progress'), []);
      }
      assert.equal(scalar((await db.query("select count(*) from public.allowed_accounts where email in ('spoofed@school.example','unlisted-email@school.example','malformed-provider@school.example')")).rows), 0);
    });
    await t.test('unverified or anonymous Google users have no access; real confirmation enrolls later', async () => {
      await addUser(db, 10, 'pending-google@school.example', undefined, {}, false);
      await addUser(db, 11, 'anonymous-google@school.example', undefined, {}, true, true);
      for (const index of [10, 11]) assert.equal(scalar(await as(db, index, 'select public.platform_access()')).allowed, false);
      assert.equal(scalar((await db.query("select count(*) from public.allowed_accounts where email in ('pending-google@school.example','anonymous-google@school.example')")).rows), 0);
      await db.query('update auth.users set email_confirmed_at=now() where id=$1', [id(10)]);
      assert.equal(scalar(await as(db, 10, 'select public.platform_access()')).allowed, true);
    });
    await t.test('linking Google via canonical provider metadata triggers enrollment, while owner role remains unchanged', async () => {
      await db.query('update auth.users set raw_app_meta_data=$1 where id=$2', [JSON.stringify({ provider: 'email', providers: ['email', 'google'] }), id(8)]);
      assert.equal(scalar(await as(db, 8, 'select public.platform_access()')).allowed, true);
      await db.query('update auth.users set raw_app_meta_data=$1,raw_user_meta_data=$2 where id=$3', [JSON.stringify({ provider: 'email', providers: ['email', 'google'] }), JSON.stringify({ is_admin: false, full_name: 'Changed User Name' }), id(1)]);
      const access = scalar(await as(db, 1, 'select public.platform_access()'));
      assert.equal(access.is_admin, true); assert.equal(access.display_name, 'أيوب محمد البطوش');
    });
    await t.test('display names use bounded display-only metadata with control characters removed and email fallback', async () => {
      await addUser(db, 12, 'long-name@school.example', undefined, { full_name: '\u0001\n' + 'س'.repeat(120), role: 'admin' });
      const name = (await db.query("select display_name from public.allowed_accounts where email='long-name@school.example'")).rows[0].display_name;
      assert.equal([...name].length, 80); assert.ok(!/[\u0000-\u001f]/.test(name));
      await addUser(db, 13, 'fallback@school.example', undefined, { full_name: [], name: '  ' });
      assert.equal(scalar(await as(db, 13, 'select public.platform_access()')).display_name, 'fallback@school.example');
    });
    await t.test('Google accounts cannot promote themselves or access administrative tables/functions', async () => {
      await assert.rejects(as(db, 5, "update public.allowed_accounts set is_admin=true where email='first.google@gmail.com'"), /permission denied/);
      await assert.rejects(as(db, 5, 'select public.platform_admin_roster()'), /administrator_required/);
      await assert.rejects(as(db, 5, "select public.admin_allow_account('intruder@school.example','Intruder')"), /administrator_required/);
      assert.deepEqual(await as(db, 5, 'select * from public.allowed_accounts'), []);
      assert.deepEqual(await as(db, 5, 'select * from public.login_events'), []);
      await assert.rejects(as(db, 5, 'select school_private.ensure_account_profile($1)', [id(1)]), /permission denied/);
    });
    await t.test('disabled Google identities stay blocked through profile changes, login RPC and repeated migration', async () => {
      await db.query('update auth.users set raw_user_meta_data=$1 where id=$2', [JSON.stringify({ full_name: 'Try Again' }), id(3)]);
      assert.equal(scalar(await as(db, 3, 'select public.record_login()')).allowed, false);
      await db.exec(upgrade);
      assert.equal((await db.query("select enabled from public.allowed_accounts where email='blocked@school.example'")).rows[0].enabled, false);
      assert.equal(scalar(await as(db, 3, 'select public.platform_access()')).allowed, false);
      assert.deepEqual(await as(db, 3, 'select * from public.student_profiles'), []);
      await assert.rejects(as(db, 3, 'select public.save_user_progress($1,0,$2)', [{ profile: {} }, id(3)]), /account_not_allowed/);
    });
    await t.test('Google session activity is server-owned, allowed and idempotent; fallback enrolls missing registry rows', async () => {
      await addSession(db, 5); await addSession(db, 6);
      const event = (await db.query('select * from public.login_events where user_id=$1', [id(5)])).rows[0];
      assert.equal(event.allowed, true); assert.equal(event.provider, 'google');
      assert.equal(event.email, 'first.google@gmail.com');
      assert.equal(new Date(event.at).toISOString(), '2026-11-05T11:00:00.000Z');
      await db.query("delete from public.allowed_accounts where email='first.google@gmail.com'");
      await as(db, 5, 'select public.record_login()'); await as(db, 5, 'select public.record_login()');
      assert.equal(scalar((await db.query('select count(*) from public.login_events where user_id=$1', [id(5)])).rows), 1);
      assert.equal((await db.query("select is_admin from public.allowed_accounts where email='first.google@gmail.com'")).rows[0].is_admin, false);
      await assert.rejects(as(db, 5, 'select public.record_login()', [], { session_id: session(6) }), /valid_auth_session_required/);
    });
    await t.test('own-only progress RLS, identity fence and CAS still protect newly registered Google users', async () => {
      await as(db, 5, 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 5 } }, id(5)]);
      await as(db, 6, 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 6 } }, id(6)]);
      const rows = await as(db, 5, 'select * from public.user_progress');
      assert.equal(rows.length, 1); assert.equal(rows[0].user_id, id(5));
      assert.deepEqual(await as(db, 5, 'select * from public.user_progress where user_id=$1', [id(6)]), []);
      assert.equal((await as(db, 1, 'select * from public.user_progress')).length, 1);
      await assert.rejects(as(db, 6, 'select public.save_user_progress($1,1,$2)', [{ profile: { xp: 999 } }, id(5)]), /progress_identity_mismatch/);
      await assert.rejects(as(db, 5, 'select public.save_user_progress($1,0,$2)', [{ profile: { xp: 999 } }, id(5)]), /progress_revision_conflict/);
      assert.equal((await as(db, 6, 'select records from public.user_progress'))[0].records.profile.xp, 6);
      await assert.rejects(as(db, 5, 'update public.user_progress set revision=999'), /permission denied/);
    });
    await t.test('hook allows new Google/Workspace, preserves blocks and manual Email accounts, rejects spoofed or unknown Email', async () => {
      const hook = event => as(db, 1, 'select public.before_user_created($1)', [event], {}, 'supabase_auth_admin').then(scalar);
      await db.query("insert into public.allowed_accounts(email,display_name,enabled) values('deleted-block@school.example','Previously blocked',false)");
      assert.equal(scalar((await db.query("select count(*) from auth.users where email='deleted-block@school.example'")).rows), 0);
      for (const email of ['new@gmail.com', 'new@workspace.school']) assert.deepEqual(await hook({ user: { email, app_metadata: { provider: 'google' } } }), {});
      assert.deepEqual(await hook({ user: { email: ownerEmail, app_metadata: { provider: 'email' } } }), {});
      for (const event of [
        { user: { email: 'blocked@school.example', app_metadata: { provider: 'google' } } },
        { user: { email: 'deleted-block@school.example', app_metadata: { provider: 'google' } } },
        { user: { email: 'unlisted@school.example', app_metadata: { provider: 'email' } } },
        { user: { email: 'spoof@school.example', app_metadata: { provider: 'email' }, user_metadata: { provider: 'google' } } },
        { user: { email: 'anonymous@school.example', app_metadata: { provider: 'google' }, is_anonymous: true } },
      ]) assert.equal((await hook(event)).error.http_code, 403);
      await assert.rejects(as(db, 5, 'select public.before_user_created($1)', [{ user: { email: 'new@gmail.com', app_metadata: { provider: 'google' } } }]), /permission denied/);
    });
    await t.test('anonymous API role and non-Google Github identities remain denied', async () => {
      await addUser(db, 14, 'github-only@school.example', { provider: 'github', providers: ['github'] }, { provider: 'google' });
      assert.equal(scalar(await as(db, 14, 'select public.platform_access()')).allowed, false);
      await assert.rejects(as(db, 5, 'select public.platform_access()', [], {}, 'anon'), /permission denied/);
      await assert.rejects(as(db, 5, 'select * from public.user_progress', [], {}, 'anon'), /permission denied/);
    });
  } finally { await db.close(); }
});

test('fresh three-part setup admits first Google user and remains idempotent', async () => {
  const db = await makeDatabase();
  try {
    assert.ok(combined.endsWith(original + '\n' + owner + '\n' + upgrade));
    await db.exec(combined); await db.exec(combined);
    assert.deepEqual((await db.query('select email,is_admin from public.allowed_accounts')).rows, [{ email: ownerEmail, is_admin: true }]);
    assert.equal(scalar((await db.query('select count(*) from auth.users')).rows), 0);
    await addUser(db, 20, 'fresh-google@school.example', undefined, { full_name: 'Fresh Google' });
    await addSession(db, 20);
    const access = scalar(await as(db, 20, 'select public.record_login()'));
    assert.equal(access.allowed, true); assert.equal(access.is_admin, false);
    assert.equal((await db.query('select allowed from public.login_events')).rows[0].allowed, true);
    await db.exec(upgrade);
    assert.equal(scalar((await db.query('select count(*) from public.allowed_accounts')).rows), 2);
    assert.deepEqual((await db.query('select email from public.allowed_accounts where is_admin')).rows, [{ email: ownerEmail }]);
  } finally { await db.close(); }
});
