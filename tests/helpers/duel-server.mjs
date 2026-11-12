/** Local PostgreSQL fixture. Auth session issuance is simulated; game RPCs and RLS are real SQL. */
import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
export const ids={host:'11111111-1111-4111-8111-111111111111',guest:'22222222-2222-4222-8222-222222222222',admin:'33333333-3333-4333-8333-333333333333',outsider:'44444444-4444-4444-8444-444444444444'};
const sessionID=id=>'a'+id.slice(1);
export async function createDuelServer(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role supabase_auth_admin;
 create schema auth;
 create table auth.users(id uuid primary key,email text unique,created_at timestamptz default now(),email_confirmed_at timestamptz,is_anonymous boolean default false,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',encrypted_password text);
 create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz,token text);
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.jwt(),auth.uid() to anon,authenticated;`);
 const users=[
  {id:ids.admin,email:'ayobalbtoosh41@gmail.com',name:'مدير الاختبار'},
  {id:ids.host,email:'host@example.test',name:'لاعب الهاتف'},
  {id:ids.guest,email:'guest@example.test',name:'لاعب الحاسوب'},
  {id:ids.outsider,email:'outsider@example.test',name:'لاعب ثالث'},
 ];
 for(const u of users)await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,encrypted_password) values($1,$2,now(),'{"provider":"email","providers":["email"]}',$3,'TEST_HASH_NOT_RETURNED')`,[u.id,u.email,JSON.stringify({display_name:u.name})]);
 for(const file of ['migrations/001_school_auth.sql','bootstrap-owner.sql','migrations/003_public_email_signup.sql','migrations/004_online_duels.sql'])await db.exec(await readFile(new URL('../../supabase/'+file,import.meta.url),'utf8'));
 for(const u of users)await db.query('insert into auth.sessions(id,user_id,token) values($1,$2,$3)',[sessionID(u.id),u.id,'TEST_SESSION_NOT_RETURNED']);
 let queue=Promise.resolve();
 const serialize=fn=>{const op=queue.then(fn);queue=op.catch(()=>{});return op;};
 const offline=new Set(),calls=[];
 const sql={
  record_login:['select public.record_login() as value',()=>[]],
  read_progress:['select row_to_json(p) as value from public.user_progress p where user_id=$1',a=>[a.user_id]],
  save_user_progress:['select public.save_user_progress($1::jsonb,$2::bigint,$3::uuid) as value',a=>[JSON.stringify(a.p_records),a.p_expected_revision,a.p_user_id]],
  platform_admin_roster:['select public.platform_admin_roster() as value',()=>[]],
  duel_create:['select public.duel_create() as value',()=>[]],
  duel_join:['select public.duel_join($1::text) as value',a=>[a.p_code]],
  duel_state:['select public.duel_state($1::uuid) as value',a=>[a.p_room_id]],
  duel_answer:['select public.duel_answer($1::uuid,$2::text,$3::jsonb) as value',a=>[a.p_room_id,a.p_question_id,JSON.stringify(a.p_answer)]],
  duel_leave:['select public.duel_leave($1::uuid) as value',a=>[a.p_room_id]],
  duel_recent:['select public.duel_recent() as value',()=>[]],
  platform_admin_duels:['select public.platform_admin_duels($1::integer,$2::integer) as value',a=>[a.p_limit??20,a.p_offset??0]],
 };
 const call=payload=>serialize(async()=>{
  const {name,args={},user}=payload;calls.push({name,args,user_id:user?.id||null});
  if(offline.has(user?.id))return{data:null,error:{code:'NETWORK',message:'Local test disconnected'}};
  const known=users.find(u=>u.id===user?.id&&u.email===user?.email);
  if(!known||!sql[name])return{data:null,error:{code:'42501',message:'Test transport rejected identity or RPC'}};
  try{
   await db.exec('begin;set local role authenticated');
   await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:known.id,session_id:sessionID(known.id),amr:[{method:'password'}]})]);
   const [query,params]=sql[name],rows=(await db.query(query,params(args))).rows;
   await db.exec('commit');return{data:rows[0]?.value??null,error:null};
  }catch(error){await db.exec('rollback');return{data:null,error:{code:error.code,message:error.message}};}
 });
 return{db,users,calls,offline,serialize,call,async auth({email,password}){
  const u=users.find(u=>u.email===email&&password==='local-test-password');
  return u?{data:{session:{user:{id:u.id,email:u.email,email_confirmed_at:new Date().toISOString(),app_metadata:{provider:'email'},user_metadata:{display_name:u.name}}}},error:null}:{data:{session:null},error:{message:'Test credentials rejected'}};
 }};
}
