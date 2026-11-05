import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
const core=fs.readFileSync(new URL('../src/core.js',import.meta.url),'utf8');
const storage=fs.readFileSync(new URL('../src/storage.js',import.meta.url),'utf8');
const auth=fs.readFileSync(new URL('../src/auth.js',import.meta.url),'utf8');
const bank=JSON.parse(fs.readFileSync(new URL('../data/questions.json',import.meta.url),'utf8'));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const config={url:'https://school-test.supabase.co',publishableKey:'sb_publishable_test_public_key_not_a_secret'};
const plain=x=>JSON.parse(JSON.stringify(x));
function runtime({configured=true,sessionUser=A,allowed=true,admin=false,remote=null,networkError=false,confirmEmail=false,signupError=false}={}){
 const local=new Map(),calls=[],events=[];let reloads=0,listener;const server={remote:remote&&plain(remote),networkError,sessionUser,allowed,admin,confirmEmail,signupError};
 const client={auth:{
  getSession:async()=>({data:{session:server.sessionUser?{user:{id:server.sessionUser,email:'student@example.com'}}:null},error:null}),
  onAuthStateChange:fn=>{listener=fn;return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async payload=>{calls.push({api:'password',payload:plain(payload)});server.sessionUser=server.sessionUser||A;return{data:{session:{user:{id:server.sessionUser}}},error:null};},
  signUp:async payload=>{
   calls.push({api:'signup',payload:plain(payload)});
   if(server.signupError)return{data:null,error:{message:'private provider error'}};
   if(server.confirmEmail)return{data:{user:{id:A},session:null},error:null};
   server.sessionUser=A;return{data:{session:{user:{id:A}}},error:null};
  },
  signOut:async()=>{calls.push({api:'signOut'});return{error:null};}
 },
 rpc:async(name,args)=>{
  calls.push({api:name,args:args&&plain(args)});
  if(server.networkError)return{data:null,error:{code:'network'}};
  if(name==='record_login')return{data:{allowed:server.allowed,is_admin:server.admin,user_id:server.sessionUser,email:'student@example.com',display_name:'طالب مسموح'},error:null};
  if(name==='platform_admin_student_details'){
   if(server.switchDuringDetails)server.sessionUser=B;
   return{data:{user:{id:args.p_user_id,email:'student@example.com'},profile:{name:'طالب'},progress:{results:[]},login_events:[]},error:null};
  }
  if(name==='save_user_progress'){
   if(server.raceToUser){server.sessionUser=server.raceToUser;server.raceToUser=null;}
   if(args.p_user_id!==server.sessionUser)return{data:null,error:{code:'42501'}};
   if((server.remote?.revision||0)!==args.p_expected_revision)return{data:null,error:{code:'40001'}};
   server.remote={user_id:server.sessionUser,revision:(server.remote?.revision||0)+1,updated_at:new Date().toISOString(),records:plain(args.p_records)};
   return{data:{user_id:server.remote.user_id,revision:server.remote.revision,updated_at:server.remote.updated_at},error:null};
  }
  return {data:{accounts:[],login_events:[]},error:null};
 },
 from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){return server.networkError?{data:null,error:{code:'network'}}:{data:server.remote&&plain(server.remote),error:null};}})};
 const ctx=vm.createContext({console,URL,TextEncoder,crypto:webcrypto,atob,structuredClone,Date,Map,Set,Promise,
  setTimeout:()=>1,clearTimeout(){},CustomEvent:class{constructor(name,options){this.type=name;this.detail=options.detail;}},
  location:{protocol:'https:',href:'https://example.org/islam/?code=test#test',reload(){reloads++;}},window:{dispatchEvent:e=>events.push(e)},
  localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)},
  AUTH_CONFIG:configured?config:{url:'',publishableKey:''},EMBEDDED_QUESTIONS:bank,
  SupabaseSDK:{createClient:()=>client}
 });
 vm.runInContext(core+'\n'+storage+'\n'+auth+'\nglobalThis.api={Auth,db};',ctx);
 return{...ctx.api,ctx,server,calls,local,events,trigger:(event,session)=>listener(event,session),reloads:()=>reloads};
}
test('unconfigured service is honest and guest progress never persists',async()=>{
 const r=runtime({configured:false});await r.Auth.init();await r.Auth.prepareStorage();await r.Auth.enterGuest();await r.db.put('profile',{name:'ضيف',xp:20});
 assert.equal(r.Auth.current().configured,false);assert.equal(r.Auth.current().mode,'guest');assert.equal(r.local.size,0);assert.equal(r.db.status().guest,true);
 const fresh=runtime({configured:false});await fresh.Auth.init();await fresh.Auth.prepareStorage();assert.equal(await fresh.db.get('profile',null),null);
 await assert.rejects(r.Auth.signInEmail('x@example.com','test-password'),/غير مفعّل/);
});
test('public configuration rejects service-role secrets and invalid origins',()=>{
 const r=runtime();for(const value of [{url:config.url,publishableKey:'sb_secret_test_secret_value'},{url:'http://insecure.test',publishableKey:config.publishableKey},{url:config.url,publishableKey:'a.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.b'}])assert.throws(()=>r.Auth.publicConfig(value));
 assert.equal(r.Auth.publicConfig(config).url,config.url);
});
test('server-approved identity alone sets admin role and prepares isolated account storage',async()=>{
 const r=runtime({admin:false});await r.Auth.init();await r.Auth.prepareStorage();assert.equal(r.Auth.current().mode,'account');assert.equal(r.Auth.current().isAdmin,false);assert.equal(r.db.status().userId,A);
 await assert.rejects(r.Auth.adminRoster(),/مخصصة/);assert.equal(r.calls.some(c=>c.api==='platform_admin_roster'),false);
});
test('server-disabled identity is signed out and no account progress opened',async()=>{
 const r=runtime({allowed:false});await r.Auth.init();await r.Auth.prepareStorage();assert.equal(r.Auth.current().mode,'signed-out');assert.equal(r.db.status().guest,true);assert.equal(r.calls.some(c=>c.api==='signOut'),true);
});
test('password is sent only to official SDK, never app state, progress or admin RPC',async()=>{
 const r=runtime({sessionUser:null});await r.Auth.init();await r.Auth.prepareStorage();const password='dummy-password-for-test-only';await r.Auth.signInEmail('student@example.com',password);
 assert.equal(r.reloads(),1);assert.equal(r.calls.find(c=>c.api==='password').payload.password,password);
 assert.equal(JSON.stringify(r.Auth.current()).includes(password),false);assert.equal(JSON.stringify(await r.db.all()).includes(password),false);assert.equal(JSON.stringify(r.calls.filter(c=>c.api!=='password')).includes(password),false);
});
test('email signup sends site password only to official SDK and reloads only a server-approved session',async()=>{
 const r=runtime({sessionUser:null});await r.Auth.init();await r.Auth.prepareStorage();const password='dummy-signup-password-only';
 assert.deepEqual(plain(await r.Auth.signUpEmail(' طالب جديد ',' new@example.org ',password)),{confirmationRequired:false});
 assert.equal(r.reloads(),1);assert.equal(r.Auth.current().mode,'account');
 assert.deepEqual(r.calls.find(c=>c.api==='signup').payload,{email:'new@example.org',password,options:{data:{display_name:'طالب جديد'},emailRedirectTo:'https://example.org/islam/'}});
 assert.equal(JSON.stringify(r.Auth.current()).includes(password),false);assert.equal(JSON.stringify(await r.db.all()).includes(password),false);assert.equal(JSON.stringify(r.calls.filter(c=>c.api!=='signup')).includes(password),false);
 assert.equal('signInGoogle' in r.Auth,false);
});
test('confirmation-required signup never creates an authenticated state or a progress scope',async()=>{
 const r=runtime({sessionUser:null,confirmEmail:true});await r.Auth.init();await r.Auth.prepareStorage();
 const result=await r.Auth.signUpEmail('طالب','new@example.org','dummy-signup-password');assert.equal(result.confirmationRequired,true);assert.match(result.message,/إذا كان/);
 assert.equal(r.Auth.current().mode,'signed-out');assert.equal(r.db.status().guest,true);assert.equal(r.reloads(),0);assert.equal(r.calls.some(c=>c.api==='record_login'),false);
});
test('signup validation and provider errors never claim successful registration',async()=>{
 const r=runtime({sessionUser:null,signupError:true});await r.Auth.init();
 for(const args of [['','a@example.org','dummy-password'],['طالب','invalid','dummy-password'],['طالب','a@example.org','short'],['طالب','a@example.org','x'.repeat(257)]])await assert.rejects(r.Auth.signUpEmail(...args),/أدخل اسمك/);
 assert.equal(r.calls.some(c=>c.api==='signup'),false);
 await assert.rejects(r.Auth.signUpEmail('طالب','a@example.org','dummy-password'),/تعذر إنشاء/);assert.equal(r.Auth.current().mode,'signed-out');assert.equal(r.reloads(),0);
});
test('signup never opens an account rejected by the server or replaces an authenticated account',async()=>{
 const rejected=runtime({sessionUser:null,allowed:false});await rejected.Auth.init();await assert.rejects(rejected.Auth.signUpEmail('طالب','a@example.org','dummy-password'),/تعذر فتح الحساب/);assert.equal(rejected.Auth.current().mode,'signed-out');assert.equal(rejected.reloads(),0);
 const active=runtime();await active.Auth.init();await assert.rejects(active.Auth.signUpEmail('طالب','a@example.org','dummy-password'),/سجّل الخروج/);assert.equal(active.calls.some(c=>c.api==='signup'),false);
});
test('cloud restore validates record schema and canonical bank before local hydration',async()=>{
 const r=runtime({remote:{user_id:A,revision:3,updated_at:new Date().toISOString(),records:{profile:{name:'محفوظ',xp:40,coins:0,level:1}}}});await r.Auth.init();await r.Auth.prepareStorage();assert.equal((await r.db.get('profile')).name,'محفوظ');assert.equal(r.Auth.current().cloudStatus,'synced');assert.equal((await r.db.get('cloud-sync')).revision,3);
 const broken=runtime({remote:{user_id:A,revision:1,records:{profile:{name:'bad',xp:'invalid'}}}});await broken.Auth.init();await broken.Auth.prepareStorage();assert.equal(await broken.db.get('profile',null),null);assert.equal(broken.Auth.current().cloudStatus,'offline');
});
test('cloud saves use per-account CAS and internal metadata is never uploaded',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'طالب',xp:20,coins:0,level:1});await r.Auth.flush();
 assert.equal(r.server.remote.revision,1);assert.equal(r.server.remote.records.profile.xp,20);assert.equal('cloud-sync' in r.server.remote.records,false);assert.equal(r.Auth.current().cloudStatus,'synced');
 const saves=r.calls.filter(c=>c.api==='save_user_progress').length;await r.Auth.syncNow();assert.equal(r.calls.filter(c=>c.api==='save_user_progress').length,saves);
});
test('concurrent-device revision conflict preserves local progress rather than overwriting remote',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'local',xp:10});r.server.remote={user_id:A,revision:4,updated_at:new Date().toISOString(),records:{profile:{name:'remote',xp:80}}};await assert.rejects(r.Auth.syncNow(),/تقدم أحدث/);
 assert.equal(r.Auth.current().cloudStatus,'conflict');assert.equal((await r.db.get('profile')).name,'local');assert.equal(r.server.remote.records.profile.name,'remote');
});
test('failed cloud request reports no confirmed save and leaves account cache intact',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'offline',xp:10});r.server.networkError=true;await assert.rejects(r.Auth.flush(),/لم تُؤكد/);assert.equal((await r.db.get('profile')).name,'offline');assert.equal(r.Auth.current().cloudStatus,'error');
});
test('reset advances cloud revision to empty snapshot and prevents restored deleted progress',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'old',xp:80});await r.Auth.flush();await r.Auth.resetProgress();assert.deepEqual(r.server.remote.records,{});assert.equal(r.server.remote.revision,2);assert.equal(await r.db.get('profile',null),null);assert.equal((await r.db.get('cloud-sync')).revision,2);
});
test('failed cloud reset does not erase local account progress',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'keep',xp:30});await r.Auth.flush();r.server.networkError=true;await assert.rejects(r.Auth.resetProgress(),/بقيت النسخة/);assert.equal((await r.db.get('profile')).name,'keep');
});
test('administrator APIs use server RPC checks without submitting passwords or roles',async()=>{
 const r=runtime({admin:true});await r.Auth.init();await r.Auth.prepareStorage();await r.Auth.adminRoster();await r.Auth.adminAllowAccount('student2@example.com','طالب ثان');await r.Auth.adminDisableAccount('student2@example.com',true);
 assert.deepEqual(r.calls.find(c=>c.api==='admin_allow_account').args,{p_email:'student2@example.com',p_display_name:'طالب ثان'});assert.deepEqual(r.calls.find(c=>c.api==='admin_disable_account').args,{p_email:'student2@example.com',p_disabled:true});
});
test('student details require an administrator and valid target, then check identity again before return',async()=>{
 const student=runtime();await student.Auth.init();await assert.rejects(student.Auth.adminStudentDetails(B),/مخصصة/);assert.equal(student.calls.some(c=>c.api==='platform_admin_student_details'),false);
 const r=runtime({admin:true});await r.Auth.init();await r.Auth.prepareStorage();await assert.rejects(r.Auth.adminStudentDetails('bad-id'),/معرّف/);
 const detail=await r.Auth.adminStudentDetails(B);assert.equal(detail.user.id,B);assert.deepEqual(r.calls.find(c=>c.api==='platform_admin_student_details').args,{p_user_id:B});
 r.server.switchDuringDetails=true;await assert.rejects(r.Auth.adminStudentDetails(B),/تغير حساب/);assert.equal(r.Auth.current().mode,'signed-out');
});
test('choosing another identity never imports previous account or guest data',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'A',xp:10});await r.Auth.flush();r.server.sessionUser=B;r.server.remote=null;
 await r.db.useAccount(B);assert.equal(await r.db.get('profile',null),null);await r.db.useGuest();await r.db.put('profile',{name:'guest',xp:99});await r.db.useAccount(B);assert.equal(await r.db.get('profile',null),null);
});
test('offline cloud failure cannot prevent local logout or erase saved account cache',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'keep local',xp:20});r.server.networkError=true;await r.Auth.signOut();
 assert.equal(r.Auth.current().mode,'signed-out');assert.equal(r.reloads(),1);assert.equal(r.db.status().guest,true);await r.db.useAccount(A);assert.equal((await r.db.get('profile')).name,'keep local');
});

test('SDK identity changes suspend account writes before another identity can use its cached records',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'A-only',xp:20});r.server.sessionUser=B;r.trigger('SIGNED_IN',{user:{id:B,email:'b@example.com'}});await r.db.flush();
 assert.equal(r.Auth.current().mode,'signed-out');assert.equal(r.db.status().guest,true);assert.equal(r.server.remote,null);
 await assert.rejects(r.Auth.syncNow(),/سجّل الدخول/);
});
test('save RPC carries expected user identity so token-change race cannot write A progress under B',async()=>{
 const r=runtime();await r.Auth.init();await r.Auth.prepareStorage();await r.db.put('profile',{name:'A-only',xp:20});r.server.raceToUser=B;await assert.rejects(r.Auth.syncNow());
 assert.equal(r.calls.find(c=>c.api==='save_user_progress').args.p_user_id,A);assert.equal(r.server.remote,null);assert.equal((await r.db.get('profile')).name,'A-only');
});
