/** PostgreSQL execution with Auth/JWT transport fixtures; no live project operation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const [base, bootstrap, google, email, combined] = await Promise.all([
  readFile(new URL('../migrations/001_school_auth.sql',import.meta.url),'utf8'),
  readFile(new URL('../bootstrap-owner.sql',import.meta.url),'utf8'),
  readFile(new URL('../migrations/002_open_google_signup.sql',import.meta.url),'utf8'),
  readFile(new URL('../migrations/003_public_email_signup.sql',import.meta.url),'utf8'),
  readFile(new URL('../setup-school.sql',import.meta.url),'utf8'),
]);
const ownerEmail='ayobalbtoosh41@gmail.com';
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scalar=rows=>Object.values(rows[0])[0];
async function fresh(){const db=new PGlite();await db.exec(`
  create role anon; create role authenticated; create role supabase_auth_admin;
  create schema auth;
  create table auth.users(id uuid primary key,email text unique,created_at timestamptz default now(),email_confirmed_at timestamptz,
    is_anonymous boolean default false,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',encrypted_password text);
  create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz,token text);
  create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
  create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
  grant usage on schema auth to anon,authenticated;
  grant execute on function auth.jwt(),auth.uid() to anon,authenticated;
`);return db;}
async function as(db,n,sql,args=[],claims={},role='authenticated'){
  await db.exec(`begin;set local role ${role}`);
  try{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid(n),session_id:sid(n),amr:[{method:'password'}],...claims})]);
    const result=await db.query(sql,args);await db.exec('commit');return result.rows;
  }catch(error){await db.exec('rollback');throw error;}
}
async function user(db,n,address,confirmed=true,metadata={},provider='email',anonymous=false){
  await db.query('insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,is_anonymous,encrypted_password) values($1,$2,$3,$4,$5,$6,$7)',
    [uid(n),address,confirmed?'2026-11-05T10:00:00Z':null,JSON.stringify({provider,providers:[provider]}),JSON.stringify(metadata),anonymous,'AUTH_HASH_MUST_NOT_LEAVE_DB']);
}
async function session(db,n){await db.query('insert into auth.sessions(id,user_id,created_at,token) values($1,$2,$3,$4)',[sid(n),uid(n),'2026-11-05T11:00:00Z','AUTH_SESSION_TOKEN_MUST_NOT_LEAVE_DB']);}
for(const useGoogle of [false,true])test(`003 upgrade after ${useGoogle?'001+002':'001 only'} protects owner identity and public Email study data`,async t=>{
  const db=await fresh();
  try{
    await user(db,1,ownerEmail);await db.exec(base+'\n'+bootstrap);if(useGoogle)await db.exec(google);
    await session(db,1);
    await as(db,1,'select public.save_user_progress($1,0,$2)',[{profile:{name:'Owner',xp:42}},uid(1)]);
    await db.query("insert into public.allowed_accounts(email,display_name,enabled) values('blocked@example.test','Blocked',false)");
    const oldEvents=(await db.query('select id,user_id,at,allowed from public.login_events order by id')).rows;
    await t.test('binds only preexisting confirmed owner once and preserves installed history/progress',async()=>{
      await db.exec(email);await db.exec(email);
      assert.deepEqual((await db.query('select user_id,email from school_private.admin_bindings')).rows,[{user_id:uid(1),email:ownerEmail}]);
      assert.equal(scalar((await db.query('select count(*) from school_private.admin_initialization')).rows),1);
      assert.equal(scalar(await as(db,1,'select public.platform_access()')).is_admin,true);
      assert.equal((await as(db,1,'select records from public.user_progress'))[0].records.profile.xp,42);
      assert.deepEqual((await db.query('select id,user_id,at,allowed from public.login_events order by id')).rows,oldEvents);
    });
    await t.test('any Email domain registers without approval; confirmation follows Auth session issuance',async()=>{
      await user(db,2,'new@student-domain.example',false,{display_name:'\n Student Two ',role:'admin',is_admin:true});
      assert.equal((await db.query("select is_admin from public.allowed_accounts where email='new@student-domain.example'")).rows[0].is_admin,false);
      await assert.rejects(as(db,2,'select public.record_login()'),/valid_auth_session_required/); // Pending confirmation: Auth issued no session.
      await session(db,2); // ConfirmEmail OFF fixture: Auth has issued an unconfirmed identity a session.
      const access=scalar(await as(db,2,'select public.record_login()',[],{is_admin:true,email:ownerEmail}));
      assert.equal(access.allowed,true);assert.equal(access.is_admin,false);assert.equal(access.display_name,'Student Two');
      await user(db,3,'another@example.org',true,{full_name:'Student Three'});await session(db,3);
      assert.equal(scalar(await as(db,3,'select public.record_login()')).allowed,true);
    });
    await t.test('hook permits arbitrary Email signup, rejects explicit blocks/anonymous/Google and spoofed user roles',async()=>{
      const hook=event=>as(db,1,'select public.before_user_created($1)',[event],{},'supabase_auth_admin').then(scalar);
      assert.deepEqual(await hook({user:{email:'brand.new@any-domain.example',app_metadata:{provider:'email'},user_metadata:{role:'admin'}}}),{});
      for(const u of [{email:'blocked@example.test',app_metadata:{provider:'email'}},{email:'anon@example.test',app_metadata:{provider:'email'},is_anonymous:true},{email:'google@example.test',app_metadata:{provider:'google'}},{email:'bad-address',app_metadata:{provider:'email'}}])assert.equal((await hook({user:u})).error.http_code,403);
      await assert.rejects(as(db,2,'select public.before_user_created($1)',[{user:{email:'new@example.test',app_metadata:{provider:'email'}}}]),/permission denied/);
    });
    await t.test('Google identity and editable metadata cannot claim Email access or administrator authority',async()=>{
      await user(db,4,'google-only@example.test',true,{provider:'email',is_admin:true},'google');await session(db,4);
      assert.equal(scalar(await as(db,4,'select public.platform_access()',[],{app_metadata:{provider:'email'},is_admin:true})).allowed,false);
      await db.query("update public.allowed_accounts set is_admin=true where email='new@student-domain.example'");
      assert.equal(scalar(await as(db,2,'select public.platform_access()',[],{is_admin:true})).is_admin,false);
      await assert.rejects(as(db,2,'select public.platform_admin_roster()'),/administrator_required/);
      await assert.rejects(as(db,2,'select public.platform_admin_student_details($1)',[uid(3)]),/administrator_required/);
      await assert.rejects(as(db,1,'select public.admin_disable_account($1,true)',[ownerEmail]),/last_administrator_required/);
    });
    await t.test('student snapshots remain own-only, CAS guarded and tied to expected immutable identity',async()=>{
      await as(db,2,'select public.save_user_progress($1,0,$2)',[{profile:{name:'Student Two',xp:12}},uid(2)]);
      await as(db,3,'select public.save_user_progress($1,0,$2)',[{profile:{name:'Student Three',xp:30}},uid(3)]);
      assert.equal((await as(db,2,'select * from public.user_progress')).length,1);
      assert.deepEqual(await as(db,2,'select * from public.user_progress where user_id=$1',[uid(3)]),[]);
      assert.equal((await as(db,1,'select * from public.user_progress')).length,1);
      await assert.rejects(as(db,3,'select public.save_user_progress($1,1,$2)',[{profile:{xp:999}},uid(2)]),/progress_identity_mismatch/);
      await assert.rejects(as(db,2,'select public.save_user_progress($1,0,$2)',[{profile:{xp:999}},uid(2)]),/progress_revision_conflict/);
      await assert.rejects(as(db,2,'update public.user_progress set revision=999'),/permission denied/);
    });
    await t.test('bound admin receives all safe results/answers/visits/settings, never arbitrary secrets or Auth credentials',async()=>{
      const result={id:'study-session-1',mode:'training',lessonId:'u01_l01',lessonIds:['u01_l01'],difficulty:'easy',answered:1,correct:1,wrong:0,accuracy:100,totalScore:10,at:'2026-11-05T11:01:00Z',items:[{id:'u01_l01_q001',correct:true,response:'o1',points:10,password:'RAW_SECRET_MARKER'},{id:'u01_l01_q002',response:{l1:'r2',access_token:'RAW_SECRET_MARKER'}}],reward:{xp:10,password:'RAW_SECRET_MARKER'},credentials:{password:'RAW_SECRET_MARKER'}};
      const records={profile:{name:'Student Two',xp:101,coins:20,level:2,lastLessonId:'u01_l01',visitedLessons:{u01_l01:'2026-11-05T11:00:00Z',access_token:'RAW_SECRET_MARKER'},password:'RAW_SECRET_MARKER'},results:Array.from({length:101},(_,n)=>({...result,id:`study-session-${n}`})),mistakes:{u01_l01_q002:{count:2,corrected:1,mastery:20,level:'easy',password:'RAW_SECRET_MARKER'},credentials:{password:'RAW_SECRET_MARKER'}},active:{id:'active-study',mode:'training',phase:'question',current:0,startedAt:1793876400000,questionStartedAt:1793876400000,deadline:1793876500000,players:['One','Two'],lessonIds:['u01_l01'],questions:[{id:'u01_l01_q001',lesson_id:'u01_l01',type:'multiple_choice',payload:{password:'RAW_SECRET_MARKER'}}],answers:[{response:'o1',correct:true,points:10,access_token:'RAW_SECRET_MARKER'}],draft:{l1:'r1',password:'RAW_SECRET_MARKER'},password:'RAW_SECRET_MARKER'},settings:{theme:'light',sounds:true,timers:{easy:'10',refresh_token:'RAW_SECRET_MARKER'},access_token:'RAW_SECRET_MARKER'},achievements:{first:'2026-11-05T11:00:00Z',access_token:'RAW_SECRET_MARKER'},auth:{password:'RAW_SECRET_MARKER'},access_token:'RAW_SECRET_MARKER'};
      await as(db,2,'select public.save_user_progress($1,1,$2)',[records,uid(2)]);
      const details=scalar(await as(db,1,'select public.platform_admin_student_details($1)',[uid(2)]));
      assert.equal(details.user.email,'new@student-domain.example');assert.equal(details.user.email_confirmed,false);assert.equal(details.user.email_ownership_verified,null);
      assert.equal(details.progress.results.length,101);assert.equal(details.profile.visitedLessons.u01_l01,'2026-11-05T11:00:00Z');
      assert.equal(details.progress.active.startedAt,1793876400000);assert.deepEqual(details.progress.active.players,['One','Two']);
      assert.equal(details.progress.results[0].items[0].response,'o1');assert.deepEqual(details.progress.results[0].items[1].response,{l1:'r2'});
      assert.equal(details.progress.mistakes.u01_l01_q002.level,'easy');assert.equal(details.progress.settings.timers.easy,'10');
      assert.ok(!/RAW_SECRET_MARKER|AUTH_HASH_MUST_NOT_LEAVE_DB|AUTH_SESSION_TOKEN_MUST_NOT_LEAVE_DB|"password"|"access_token"|"encrypted_password"|"credentials"/.test(JSON.stringify(details)));
      assert.ok(!/token|encrypted_password|password/.test(JSON.stringify(scalar(await as(db,1,'select public.platform_admin_roster()')))));
      await assert.rejects(as(db,2,'select public.platform_admin_student_details($1)',[uid(999)]),/administrator_required/);
      await assert.rejects(as(db,2,'select public.platform_admin_student_details($1)',[uid(3)],{},'anon'),/permission denied/);
    });
    await t.test('blocking survives repeated signup metadata, login and migration; admin may still inspect safe study records',async()=>{
      await as(db,1,"select public.admin_disable_account('new@student-domain.example',true)");
      await db.query('update auth.users set raw_user_meta_data=$1 where id=$2',[JSON.stringify({display_name:'Re-register',role:'admin'}),uid(2)]);
      assert.equal(scalar(await as(db,2,'select public.record_login()')).allowed,false);
      await db.exec(email);
      assert.equal((await db.query("select enabled from public.allowed_accounts where email='new@student-domain.example'")).rows[0].enabled,false);
      assert.deepEqual(await as(db,2,'select * from public.user_progress'),[]);
      const details=scalar(await as(db,1,'select public.platform_admin_student_details($1)',[uid(2)]));assert.equal(details.user.disabled,true);assert.equal(details.progress.results.length,101);
      await as(db,1,"select public.admin_disable_account('new@student-domain.example',false)");
      assert.equal(scalar(await as(db,2,'select public.platform_access()')).allowed,true);
    });
    await t.test('real session logging is idempotent and private admin tables cannot be read or modified by students',async()=>{
      const count=scalar((await db.query('select count(*) from public.login_events where user_id=$1',[uid(2)])).rows);
      await as(db,2,'select public.record_login()');await as(db,2,'select public.record_login()');
      assert.equal(scalar((await db.query('select count(*) from public.login_events where user_id=$1',[uid(2)])).rows),count);
      assert.equal((await db.query('select provider,allowed from public.login_events where user_id=$1',[uid(2)])).rows[0].provider,'email');
      await assert.rejects(as(db,2,'select public.record_login()',[],{session_id:sid(3)}),/valid_auth_session_required/);
      await assert.rejects(as(db,2,'select * from school_private.admin_bindings'),/permission denied/);
      await assert.rejects(as(db,2,'delete from school_private.admin_initialization'),/permission denied/);
      await assert.rejects(as(db,2,'select * from public.login_events',[],{},'anon'),/permission denied/);
    });
    await t.test('deleting owner removes binding but never initialization; confirmed same-email replacement cannot regain admin',async()=>{
      await db.query('delete from auth.users where id=$1',[uid(1)]);
      assert.equal(scalar((await db.query('select count(*) from school_private.admin_bindings')).rows),0);
      assert.equal((await db.query('select original_owner_id from school_private.admin_initialization')).rows[0].original_owner_id,uid(1));
      await user(db,9,ownerEmail,true,{display_name:'Replacement',is_admin:true,role:'admin'});await session(db,9);
      assert.equal(scalar(await as(db,9,'select public.platform_access()',[],{is_admin:true})).is_admin,false);
      await db.exec(email);await db.exec(email);
      assert.equal(scalar((await db.query('select count(*) from school_private.admin_bindings')).rows),0);
      await assert.rejects(as(db,9,'select public.platform_admin_roster()'),/administrator_required/);
      await assert.rejects(as(db,9,'select public.platform_admin_student_details($1)',[uid(3)]),/administrator_required/);
      await db.exec(bootstrap); // Legacy display flag alone cannot authorize after003.
      assert.equal(scalar(await as(db,9,'select public.platform_access()')).is_admin,false);
    });
  }finally{await db.close();}
});

test('003 first-run prerequisite rolls back cleanly and full setup safely initializes a confirmed owner',async()=>{
  const db=await fresh();
  try{
    await db.exec(base+'\n'+bootstrap);
    await assert.rejects(db.exec(email),/owner_account_required/);await db.exec('rollback');
    assert.equal((await db.query("select to_regclass('school_private.admin_initialization') as x")).rows[0].x,null);
    await user(db,1,ownerEmail,false);
    await assert.rejects(db.exec(email),/owner_account_required/);await db.exec('rollback');
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[uid(1)]);
    await db.exec(email);assert.equal(scalar(await as(db,1,'select public.platform_access()')).is_admin,true);
  }finally{await db.close();}
  const freshDb=await fresh();
  try{
    assert.ok(combined.endsWith(base+'\n'+bootstrap+'\n'+email));
    await assert.rejects(freshDb.exec(combined),/owner_account_required/);await freshDb.exec('rollback');
    assert.equal((await freshDb.query("select to_regclass('public.allowed_accounts') as x")).rows[0].x,null);
    await user(freshDb,1,ownerEmail,true);
    await freshDb.exec(combined);await freshDb.exec(combined);
    assert.equal(scalar(await as(freshDb,1,'select public.platform_access()')).is_admin,true);
    assert.equal(scalar((await freshDb.query('select count(*) from auth.users')).rows),1);
  }finally{await freshDb.close();}
});
