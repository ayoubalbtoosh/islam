/** Real PostgreSQL engine tests. Auth/JWT fixtures model sessions, not hosted Supabase. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const [base,bootstrap,email,duels]=await Promise.all(['../migrations/001_school_auth.sql','../bootstrap-owner.sql','../migrations/003_public_email_signup.sql','../migrations/004_online_duels.sql'].map(p=>readFile(new URL(p,import.meta.url),'utf8')));
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scalar=rows=>Object.values(rows[0])[0];
async function as(db,n,sql,args=[],role='authenticated'){
  await db.exec(`begin; set local role ${role}`);
  try{
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid(n),session_id:sid(n),amr:[{method:'password'}]})]);
    const result=await db.query(sql,args);await db.exec('commit');return scalar(result.rows);
  }catch(error){await db.exec('rollback');throw error;}
}
async function rpc(db,n,name,args=[]){
  return as(db,n,`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args);
}
async function fixture(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role supabase_auth_admin;
    create schema auth;
    create table auth.users(id uuid primary key,email text unique,created_at timestamptz default now(),email_confirmed_at timestamptz,is_anonymous boolean default false,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',encrypted_password text);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz,token text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated;grant execute on function auth.jwt(),auth.uid() to anon,authenticated;`);
  for(let n=1;n<=5;n++)await db.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,encrypted_password) values($1,$2,now(),'{\"provider\":\"email\"}',$3,'SECRET_HASH')",[uid(n),n===1?'ayobalbtoosh41@gmail.com':`player${n}@example.test`,JSON.stringify({display_name:`لاعب ${n}`,is_admin:true})]);
  await db.exec(base+'\n'+bootstrap+'\n'+email+'\n'+duels);
  for(let n=1;n<=5;n++)await db.query('insert into auth.sessions(id,user_id,token) values($1,$2,$3)',[sid(n),uid(n),'SECRET_SESSION']);
  return db;
}
async function answerAll(db,n,room,correct=true){
  let s=await rpc(db,n,'duel_state',[room]);
  while(s.status==='active'&&s.question){
    const q=(await db.query('select questions from school_private.duel_rooms where id=$1',[room])).rows[0].questions.find(q=>q.id===s.question.id);
    const option=correct?q.correct_answer:q.options.find(o=>o.id!==q.correct_answer).id;
    s=await rpc(db,n,'duel_answer',[room,q.id,JSON.stringify(option)]);
  }
  return s;
}

test('004 additive migration, canonical bank, grants and Auth/progress preservation',async()=>{
  const db=await fixture();
  try{
    await rpc(db,2,'save_user_progress',[{profile:{xp:42}},0,uid(2)]);
    await db.exec(duels); // Repeat migration without overwriting any user data.
    assert.equal((await db.query('select count(*)::int as n from school_private.duel_questions')).rows[0].n,104);
    assert.equal((await rpc(db,2,'platform_access')).allowed,true);
    assert.equal((await rpc(db,1,'platform_access')).is_admin,true);
    assert.equal((await as(db,2,'select records from public.user_progress')).profile.xp,42);
    await assert.rejects(as(db,2,'select public.duel_create()',[],'anon'),/permission denied/);
    for(const table of ['duel_rooms','duel_questions','duel_answers']){
      await assert.rejects(as(db,2,`select * from school_private.${table}`),/permission denied/);
      await assert.rejects(as(db,2,`delete from school_private.${table}`),/permission denied/);
    }
    await assert.rejects(as(db,2,'select school_private.duel_snapshot($1,$2)',[uid(1),uid(2)]),/permission denied/);
    await assert.rejects(rpc(db,2,'platform_admin_duels'),/administrator_required/);
  }finally{await db.close();}
});

test('room joins, own-room recovery, privacy, one guest and valid ordered answers',async()=>{
  const db=await fixture();
  try{
    const room=await rpc(db,2,'duel_create');assert.equal(room.status,'waiting');assert.match(room.code,/^[A-F0-9]{10}$/);
    assert.equal((await rpc(db,2,'duel_create')).id,room.id);
    await assert.rejects(rpc(db,2,'duel_join',[room.code]),/cannot_join_own_room/);
    await assert.rejects(rpc(db,3,'duel_state',[room.id]),/room_not_found/);
    await assert.rejects(rpc(db,3,'duel_join',['bad']),/invalid_room_code/);
    await assert.rejects(rpc(db,3,'duel_join',['FFFFFFFFFF']),/room_not_found/);
    const guest=await rpc(db,3,'duel_join',[room.code.toLowerCase()]);assert.equal(guest.status,'active');assert.equal(guest.players.length,2);
    assert.equal((await rpc(db,3,'duel_join',[room.code])).id,room.id);
    await assert.rejects(rpc(db,4,'duel_join',[room.code]),/room_unavailable/);
    assert.equal((await rpc(db,2,'duel_state',[room.id])).question.id,guest.question.id);
    assert.ok(!/correct_answer|explanation|email|SECRET_HASH|SECRET_SESSION/.test(JSON.stringify(guest)));
    assert.equal(guest.me.score,null);
    const q=guest.question;
    await assert.rejects(rpc(db,3,'duel_answer',[room.id,'other_question',JSON.stringify(q.options[0].id)]),/question_out_of_order/);
    await assert.rejects(rpc(db,3,'duel_answer',[room.id,q.id,JSON.stringify('invalid')]),/invalid_answer/);
    await assert.rejects(rpc(db,4,'duel_answer',[room.id,q.id,JSON.stringify(q.options[0].id)]),/room_not_found/);
    const answered=await rpc(db,3,'duel_answer',[room.id,q.id,JSON.stringify(q.options[0].id)]);assert.equal(answered.me.answered,1);
    assert.equal((await rpc(db,3,'duel_answer',[room.id,q.id,JSON.stringify(q.options[0].id)])).me.answered,1);
    await assert.rejects(rpc(db,3,'duel_answer',[room.id,q.id,JSON.stringify(q.options[1].id)]),/answer_already_submitted/);
    const otherRoom=await rpc(db,4,'duel_create');await assert.rejects(rpc(db,3,'duel_join',[otherRoom.code]),/already_in_room/);
  }finally{await db.close();}
});

test('server scores, terminal persistence, recent history and authorized admin pagination',async()=>{
  const db=await fixture();
  try{
    const room=await rpc(db,2,'duel_create');await rpc(db,3,'duel_join',[room.code]);
    let host=await answerAll(db,2,room.id,true);assert.equal(host.me.answered,5);assert.equal(host.me.score,null);assert.equal(host.status,'active');assert.equal(host.question,null);
    const guest=await answerAll(db,3,room.id,false);assert.equal(guest.status,'completed');assert.equal(guest.result.winner_id,uid(2));assert.equal(guest.result.reason,'answered');assert.deepEqual(guest.result.scores.map(s=>s.score),[5,0]);
    host=await rpc(db,2,'duel_state',[room.id]);assert.equal(host.me.score,5);assert.equal(host.players[1].score,0);
    const before=JSON.stringify(host.result);await rpc(db,2,'duel_leave',[room.id]);assert.equal(JSON.stringify((await rpc(db,2,'duel_state',[room.id])).result),before);
    assert.equal((await rpc(db,2,'duel_recent'))[0].id,room.id);assert.deepEqual(await rpc(db,4,'duel_recent'),[]);
    const admin=await rpc(db,1,'platform_admin_duels',[1,0]);assert.equal(admin.total,1);assert.equal(admin.rooms[0].host_email,'player2@example.test');assert.equal(admin.rooms[0].result.winner_id,uid(2));
    assert.deepEqual((await rpc(db,1,'platform_admin_duels',[1,1])).rooms,[]);
    assert.ok(!/SECRET_HASH|SECRET_SESSION|correct_answer|questions|password|token/.test(JSON.stringify(admin)));
    await assert.rejects(rpc(db,1,'platform_admin_duels',[101,0]),/invalid_pagination/);
    await assert.rejects(rpc(db,2,'platform_admin_duels',[20,0]),/administrator_required/);
    const persisted=(await db.query('select status,result from school_private.duel_rooms where id=$1',[room.id])).rows[0];assert.equal(persisted.status,'completed');assert.equal(persisted.result.winner_id,uid(2));
  }finally{await db.close();}
});

test('tie, timeout, forfeit, expiry, blocked identity and room-rate limits',async()=>{
  const db=await fixture();
  try{
    let room=await rpc(db,2,'duel_create');await rpc(db,3,'duel_join',[room.code]);await answerAll(db,2,room.id,true);let end=await answerAll(db,3,room.id,true);assert.equal(end.result.winner_id,null);
    room=await rpc(db,2,'duel_create');await rpc(db,3,'duel_join',[room.code]);end=await rpc(db,2,'duel_leave',[room.id]);assert.equal(end.result.reason,'forfeit');assert.equal(end.result.winner_id,uid(3));
    room=await rpc(db,2,'duel_create');await rpc(db,3,'duel_join',[room.code]);
    const q=(await rpc(db,2,'duel_state',[room.id])).question;
    await db.query("update school_private.duel_rooms set deadline=clock_timestamp()-interval '1 second' where id=$1",[room.id]);
    end=await rpc(db,2,'duel_answer',[room.id,q.id,JSON.stringify(q.options[0].id)]);assert.equal(end.status,'completed');assert.equal(end.result.reason,'timeout');assert.equal(end.me.answered,0);
    room=await rpc(db,2,'duel_create');await db.query("update school_private.duel_rooms set expires_at=clock_timestamp()-interval '1 second' where id=$1",[room.id]);
    assert.equal((await rpc(db,2,'duel_state',[room.id])).status,'expired');
    await assert.rejects(rpc(db,3,'duel_join',[room.code]),/room_unavailable/);
    room=await rpc(db,2,'duel_create');assert.equal((await rpc(db,2,'duel_leave',[room.id])).status,'cancelled');
    await rpc(db,1,'admin_disable_account',['player2@example.test',true]);
    await assert.rejects(rpc(db,2,'duel_create'),/authentication_required/);
    await assert.rejects(rpc(db,2,'duel_recent'),/authentication_required/);
    await rpc(db,1,'admin_disable_account',['player2@example.test',false]);
    for(let i=0;i<15;i++){room=await rpc(db,2,'duel_create');await rpc(db,2,'duel_leave',[room.id]);}
    await assert.rejects(rpc(db,2,'duel_create'),/room_rate_limit/);
  }finally{await db.close();}
});
