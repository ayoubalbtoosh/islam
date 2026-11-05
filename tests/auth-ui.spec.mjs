import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
await mkdir(path.join(root,'artifacts'),{recursive:true});
await mkdir(path.join(root,'test-results'),{recursive:true});
const testedBuildSha256=createHash('sha256').update(await readFile(path.join(root,'dist/index.html'))).digest('hex');
if(process.env.TEST_EXPECT_BUILD_SHA)assert.equal(testedBuildSha256,process.env.TEST_EXPECT_BUILD_SHA,'Expected the frozen production build');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
const results=[],errors=[],blockedExternalRequests=[];let context,page;
const localOrigin=new URL(base).origin;
function withAuthConfig(html,config){const marker=/^const AUTH_CONFIG=[^\r\n]*;$/gm;assert.equal([...html.matchAll(marker)].length,1,'Expected exactly one auth configuration marker');return html.replace(marker,'const AUTH_CONFIG='+JSON.stringify(config)+';');}
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ADMIN='33333333-3333-4333-8333-333333333333',OUT='44444444-4444-4444-8444-444444444444',G='55555555-5555-4555-8555-555555555555',H='66666666-6666-4666-8666-666666666666';
const clone=x=>JSON.parse(JSON.stringify(x));
function server(){
 const state={offline:false,confirmationRequired:false,signupCalls:0};
 const accounts=new Map([
  ['a@example.test',{email:'a@example.test',display_name:'طالب ألف',is_admin:false,enabled:true,user_id:A,last_login_at:null,login_count:0}],
  ['b@example.test',{email:'b@example.test',display_name:'<img src=x onerror=alert(1)>',is_admin:false,enabled:true,user_id:B,last_login_at:null,login_count:0}],
  ['admin@example.test',{email:'admin@example.test',display_name:'مدير الاختبار',is_admin:true,enabled:true,user_id:ADMIN,last_login_at:null,login_count:0}]
 ]),cloud=new Map(),events=[],writes=[];
 const users=new Map([...accounts.values()].map(a=>[a.email,{id:a.user_id,email:a.email,name:a.display_name,password:'test-platform-password',confirmed:true}]));
 const denied=()=>({data:null,error:{message:'server denied operation'}});
 const sessionFor=user=>({user:{id:user.id,email:user.email,email_confirmed_at:user.confirmed?new Date().toISOString():null,app_metadata:{provider:'email'},user_metadata:{display_name:user.name,is_admin:true}}});
 async function auth(payload){
  const email=String(payload.email||'').trim().toLowerCase();
  if(payload.action==='signup'){
   state.signupCalls++;
   if(users.has(email))return{data:{session:null,user:null},error:{message:'mock duplicate signup'}};
   const id=[G,H,OUT][users.size-3]||'77777777-7777-4777-8777-777777777777';
   const user={id,email,name:payload.name,password:payload.password,confirmed:!state.confirmationRequired};users.set(email,user);
   const session=sessionFor(user);return{data:{user:session.user,session:user.confirmed?session:null},error:null};
  }
  const user=users.get(email);if(!user||user.password!==payload.password||!user.confirmed)return{data:{session:null},error:{message:'mock rejected credentials'}};
  return{data:{session:sessionFor(user)},error:null};
 }
 async function call(payload){
  if(state.offline&&payload.name==='save_user_progress')return{data:null,error:{message:'mock offline cloud'}};
  let account=accounts.get(payload.user?.email);const verified=!!payload.user?.email_confirmed_at;
  if(payload.name==='record_login'&&!account&&verified){account={email:payload.user.email,display_name:payload.user.user_metadata?.display_name||payload.user.email,is_admin:false,enabled:true,user_id:payload.user.id,created_at:new Date().toISOString(),last_login_at:null,login_count:0};accounts.set(account.email,account);}
  const allowed=!!account&&account.enabled&&account.user_id===payload.user?.id&&verified;
  if(payload.name==='record_login'){
   events.unshift({id:events.length+1,user_id:payload.user?.id,email:payload.user?.email,display_name:account?.display_name||'',at:new Date().toISOString(),provider:'email',allowed});
   if(allowed){account.login_count++;account.last_login_at=new Date().toISOString();}
   return{data:{allowed,user_id:payload.user?.id,email:payload.user?.email,display_name:account?.display_name,is_admin:!!account?.is_admin},error:null};
  }
  if(!allowed)return denied();
  if(payload.name==='read_progress')return payload.args.user_id===account.user_id?{data:clone(cloud.get(account.user_id)||null),error:null}:denied();
  if(payload.name==='save_user_progress'){
   writes.push(clone(payload));if(payload.args.p_user_id!==account.user_id)return denied();
   const previous=cloud.get(account.user_id),expected=previous?.revision||0;if(payload.args.p_expected_revision!==expected)return{data:null,error:{code:'40001',message:'mock revision conflict'}};
   const row={user_id:account.user_id,records:clone(payload.args.p_records),revision:expected+1,updated_at:new Date().toISOString()};cloud.set(account.user_id,row);return{data:clone(row),error:null};
  }
  if(!account.is_admin)return denied();
  if(payload.name==='platform_admin_roster')return{data:{accounts:clone([...accounts.values()]),login_events:clone(events)},error:null};
  if(payload.name==='platform_admin_student_details'){
   if(Object.hasOwn(state,'detailsPayload'))return{data:clone(state.detailsPayload),error:null};
   const target=[...accounts.values()].find(a=>a.user_id===payload.args.p_user_id);if(!target)return denied();const row=cloud.get(target.user_id),records=row?.records||{},user=users.get(target.email);
   return{data:{user:{id:target.user_id,email:target.email,display_name:target.display_name,created_at:target.created_at||new Date().toISOString(),email_confirmed_at:user?.confirmed?new Date().toISOString():null,email_confirmed:!!user?.confirmed,provider:'email',disabled:!target.enabled},profile:clone(records.profile||{}),progress:{results:clone(records.results||[]),mistakes:clone(records.mistakes||{}),active:clone(records.active||null),achievements:clone(records.achievements||{}),settings:clone(records.settings||{}),updated_at:row?.updated_at||null,revision:row?.revision||0},login_events:clone(events.filter(e=>e.user_id===target.user_id))},error:null};
  }
  if(payload.name==='admin_disable_account'){
   const row=accounts.get(payload.args.p_email);if(!row||row.is_admin)return denied();row.enabled=!payload.args.p_disabled;return{data:{email:row.email,enabled:row.enabled},error:null};
  }
  return denied();
 }
 return{accounts,cloud,events,writes,call,auth,state,confirm(email){users.get(email).confirmed=true;}};
}
async function newContext({mock=false,backend=server(),viewport={width:1366,height:768}}={}){
 const ctx=await browser.newContext({viewport});
 if(mock){
  await ctx.exposeBinding('__testBackend',(_,payload)=>backend.call(payload));await ctx.exposeBinding('__testAuth',(_,payload)=>backend.auth(payload));
  await ctx.addInitScript(()=>{
   const key='test-only-auth-session';let session;try{session=JSON.parse(localStorage.getItem(key)||'null');}catch{session=null;}
   const callbacks=[],answer=(data,error=null)=>Promise.resolve({data,error});
   const persist=next=>{session=next;if(session)localStorage.setItem(key,JSON.stringify(session));else localStorage.removeItem(key);callbacks.forEach(cb=>cb(session?'SIGNED_IN':'SIGNED_OUT',session));};
   window.__testSession=()=>session;window.__testSwitchUser=(id,email)=>persist({user:{id,email,email_confirmed_at:new Date().toISOString(),app_metadata:{provider:'email'}}});
   window.__testSupabaseSDK={createClient(){return{
    auth:{getSession:()=>answer({session}),onAuthStateChange:cb=>{callbacks.push(cb);return{data:{subscription:{unsubscribe(){}}}};},
     signInWithPassword:async({email,password})=>{const result=await window.__testAuth({action:'signin',email,password});if(result.data.session)persist(result.data.session);return result;},
     signUp:async({email,password,options})=>{const result=await window.__testAuth({action:'signup',email,password,name:options?.data?.display_name});if(result.data.session)persist(result.data.session);return result;},
     signOut:async()=>{persist(null);return{error:null};}
    },
    rpc:(name,args={})=>window.__testBackend({name,args,user:session?.user||null}),
    from:()=>({select(){return this;},eq(_,id){this.id=id;return this;},maybeSingle(){return window.__testBackend({name:'read_progress',args:{user_id:this.id},user:session?.user||null});}})
   };}};
  });
 }
 await ctx.route('**/*',async route=>{
  const target=new URL(route.request().url());
  if(target.origin!==localOrigin){blockedExternalRequests.push(target.origin);await route.abort('blockedbyclient');return;}
  if(route.request().resourceType()!=='document'||!['/','/index.html'].includes(target.pathname)){await route.continue();return;}
  let html=withAuthConfig(await readFile(path.join(root,'dist/index.html'),'utf8'),mock?{url:'https://mock-project.supabase.test',publishableKey:'sb_publishable_test_only_browser_1234567890'}:{url:'',publishableKey:''});
  if(mock){assert.ok(html.includes('const Auth=(()=>{'),'Auth bridge marker missing from production build');html=html.replace('const Auth=(()=>{','SupabaseSDK=window.__testSupabaseSDK;\nconst Auth=(()=>{');}
  await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
 });
 return{ctx,backend};
}
async function fresh(options={}){await context?.close();const next=await newContext(options);context=next.ctx;page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(base);await page.waitForFunction(()=>typeof S!=='undefined'&&S.ready&&document.querySelector('#main-content'));return next.backend;}
async function test(name,fn){const at=Date.now();try{await fn();results.push({name,status:'passed',milliseconds:Date.now()-at});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:error.stack,milliseconds:Date.now()-at});console.error('FAIL '+name+': '+error.message);}}
async function login(email,password='test-platform-password'){await page.locator('[data-action=auth-tab][data-mode=login]').click();await page.locator('#auth-email').fill(email);await page.locator('#auth-password').fill(password);await page.locator('#auth-email-form button[type=submit]').click();await page.waitForFunction(()=>Auth.current().mode==='account'&&S.ready&&db.status().userId===Auth.current().user.id);}
async function signup(email,{name='طالب جديد',password='test-site-password-12',confirm=password,confirmation=false}={}){await page.locator('[data-action=auth-tab][data-mode=signup]').click();await page.locator('#signup-name').fill(name);await page.locator('#signup-email').fill(email);await page.locator('#signup-password').fill(password);await page.locator('#signup-password-confirm').fill(confirm);await page.locator('#auth-signup-form button[type=submit]').click();if(confirmation)await page.waitForFunction(()=>S.ready&&!S.authBusy&&Auth.current().mode==='signed-out'&&!document.querySelector('#signup-password')?.value);else await page.waitForFunction(()=>S.ready&&!S.authBusy&&Auth.current().mode==='account'&&db.status().userId===Auth.current().user?.id);}
async function capture(options){if(process.env.CAPTURE_SCREENSHOTS==='1')await page.screenshot(options);}
async function logout(){await page.evaluate(()=>go('settings'));await page.locator('.account-card [data-action=auth-signout]').click();await page.locator('[data-action=auth-confirm-signout]').click();await page.waitForFunction(()=>Auth.current().mode==='signed-out'&&S.ready&&document.querySelector('#auth-email-form'));}
async function oneRound(){await page.evaluate(async()=>{await createSession('training','u01_l01','easy','all',2,['a','b'],'none');while(S.session){const q=S.session.questions[S.session.current],a=q.answer;const r=q.type==='true_false'?a.value:['multiple_choice','fill_blank'].includes(q.type)?a.option_id:q.type==='multi_select'?a.option_ids:q.type==='ordering'?a.ordered_ids:Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id]));await autoAnswer(r);}await Auth.syncNow();});}

await test('explicit unconfigured fixture shows honest login gate without nickname bypass',async()=>{
 await fresh();assert.equal(await page.locator('.auth-screen').count(),1);assert.ok((await page.locator('.auth-panel').textContent()).includes('تسجيل الحسابات بانتظار التفعيل'));
 assert.equal(await page.locator('[data-action=auth-google]').count(),0);assert.equal(await page.locator('#auth-email-form button[type=submit]').isDisabled(),true);assert.equal(await page.locator('[data-action=save-name]').count(),0);
 assert.equal(await page.locator('#admin-allow-form').count(),0);assert.equal(await page.locator('[data-page=admin]').count(),0);assert.ok(!(await page.locator('.auth-panel').textContent()).includes('Google'));await page.locator('[data-action=auth-tab][data-mode=signup]').click();assert.equal(await page.locator('#auth-signup-form button[type=submit]').isDisabled(),true);assert.ok(!(await page.locator('.auth-panel').textContent()).includes('لا يوجد تسجيل عام'));
});
await test('production guest bridge under unconfigured fixture is temporary isolated and cleared by reload',async()=>{
 await fresh();await page.locator('[data-action=guest-name]').click();await page.waitForFunction(()=>Auth.current().mode==='guest'&&S.profile.name==='ضيف'&&!S.authBusy);
 assert.ok((await page.locator('.identity-guest').textContent()).includes('ضيف — تقدمك مؤقت ويُمسح عند إغلاق/تحديث الصفحة'));assert.equal(await page.evaluate(()=>db.status().persistent),false);
 await page.evaluate(async()=>{await createSession('training','u01_l01','easy','all',1,['a','b'],'none');const q=S.session.questions[0],a=q.answer;await autoAnswer(q.type==='true_false'?a.value:['multiple_choice','fill_blank'].includes(q.type)?a.option_id:q.type==='multi_select'?a.option_ids:q.type==='ordering'?a.ordered_ids:Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id])));});
 assert.equal(await page.evaluate(()=>S.results.length),1);await page.evaluate(()=>go('settings'));assert.equal(await page.locator('[data-action=export]').count(),0);assert.equal(await page.locator('#import-file').count(),0);
 assert.equal(await page.locator('[data-page=admin]').count(),0);await page.reload();await page.waitForFunction(()=>S.ready&&Auth.current().mode==='signed-out');assert.equal(await page.evaluate(()=>S.results.length),0);assert.equal(await page.evaluate(()=>S.session),null);assert.equal(await page.evaluate(()=>S.profile.xp),0);
});
await test('auth gate and guest banner fit phone tablet desktop and preserve source attribution',async()=>{
 for(const [width,height] of [[360,800],[390,844],[768,1024],[1366,768],[1920,1080]]){
  await fresh({viewport:{width,height}});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await capture({path:path.join(root,`artifacts/auth-gate-${width}.png`),fullPage:true});await page.locator('[data-action=guest-name]').click();await page.waitForFunction(()=>Auth.current().mode==='guest'&&!S.authBusy);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.ok((await page.locator('.dashboard-kicker').textContent()).includes('توجيهي'));assert.ok(!(await page.locator('.dashboard-kicker').textContent()).includes('الحادي عشر'));
  await capture({path:path.join(root,`artifacts/auth-guest-${width}.png`),fullPage:true});await page.evaluate(()=>go('about'));assert.ok(!(await page.locator('#main-content').textContent()).includes('الحادي عشر'));assert.ok((await page.locator('#main-content').textContent()).includes('كتاب التربية الإسلامية المرفق'));assert.ok(!(await page.locator('body').innerText()).includes('الحادي عشر'));await page.evaluate(()=>{S.settings.theme='light';render();});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 }
});
await test('public email signup confirmation leaves user signed out and clears site passwords',async()=>{
 const backend=await fresh({mock:true});backend.state.confirmationRequired=true;await signup('confirm@academy.example.test',{confirmation:true});assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.equal(await page.evaluate(()=>db.status().guest),true);assert.equal(backend.accounts.has('confirm@academy.example.test'),false);assert.equal(await page.locator('#signup-password').inputValue(),'');assert.equal(await page.locator('#signup-password-confirm').inputValue(),'');assert.ok(/البريد|رسالة|صندوق/.test(await page.locator('.auth-panel').textContent()));assert.ok(!(await page.evaluate(()=>JSON.stringify(S))).includes('test-site-password-12'));
 backend.confirm('confirm@academy.example.test');await login('confirm@academy.example.test','test-site-password-12');assert.equal(await page.evaluate(()=>Auth.current().isAdmin),false);
});
await test('signup tabs are accessible and mismatched site passwords never reach authentication',async()=>{
 const backend=await fresh({mock:true});await page.locator('[data-action=auth-tab][data-mode=signup]').click();assert.equal(await page.locator('[data-action=auth-tab][data-mode=signup]').getAttribute('role'),'tab');assert.equal(await page.locator('[data-action=auth-tab][data-mode=signup]').getAttribute('aria-selected'),'true');const controls=await page.locator('[data-action=auth-tab][data-mode=signup]').getAttribute('aria-controls');assert.equal(await page.locator('#'+controls).count(),1);await page.locator('[data-action=auth-tab][data-mode=signup]').press('ArrowLeft');assert.equal(await page.locator('#auth-email-form').count(),1);await page.locator('[data-action=auth-tab][data-mode=login]').press('ArrowRight');assert.equal(await page.locator('#signup-password').getAttribute('type'),'password');assert.equal(await page.locator('#signup-password-confirm').getAttribute('type'),'password');await page.locator('#signup-name').fill('طالب');await page.locator('#signup-email').fill('student@example.test');await page.locator('#signup-password').fill('test-site-password-12');await page.locator('#signup-password-confirm').fill('different-site-password-12');await page.locator('#auth-signup-form button[type=submit]').click();await page.waitForFunction(()=>!S.authBusy);assert.equal(backend.state.signupCalls,0);assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.equal(await page.locator('#signup-password').inputValue(),'');assert.equal(await page.locator('#signup-password-confirm').inputValue(),'');assert.ok(!(await page.evaluate(()=>JSON.stringify(S))).includes('test-site-password-12'));assert.ok(/مسؤول|مدير|الإدارة/.test(await page.locator('.auth-panel').textContent()));
});
await test('mocked rejected credentials stay signed out and clear password without logging it',async()=>{
 await fresh({mock:true});await page.locator('#auth-email').fill('a@example.test');await page.locator('#auth-password').fill('wrong-test-password');await page.locator('#auth-email-form button[type=submit]').click();await page.waitForFunction(()=>!S.authBusy&&!!S.authMessage);
 assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.equal(await page.locator('#auth-password').inputValue(),'');assert.ok(!(await page.locator('.auth-panel').textContent()).includes('mock rejected credentials'));assert.ok(!(await page.evaluate(()=>JSON.stringify(S))).includes('wrong-test-password'));
});
await test('public email signup accepts other domains and Gmail with private progress and no self-admin',async()=>{
 const backend=await fresh({mock:true});await signup('new@academy.example.test',{name:'طالب مدرسة جديد'});assert.equal(await page.evaluate(()=>Auth.current().mode),'account');assert.equal(await page.evaluate(()=>Auth.current().isAdmin),false);assert.equal(backend.accounts.get('new@academy.example.test').is_admin,false);assert.equal(await page.locator('[data-page=admin]').count(),0);
 await oneRound();const expected=await page.evaluate(()=>({xp:S.profile.xp,results:S.results.length}));assert.ok(expected.xp>0);assert.equal(backend.cloud.get(G).records.results.length,1);const denied=await page.evaluate(async()=>{try{await Auth.adminStudentDetails('33333333-3333-4333-8333-333333333333');return false;}catch{return true;}});assert.ok(denied);const rpcDenied=await page.evaluate(()=>window.__testBackend({name:'platform_admin_student_details',args:{p_user_id:'33333333-3333-4333-8333-333333333333'},user:window.__testSession().user}));assert.ok(rpcDenied.error);
 await logout();await signup('new.learner@gmail.com');assert.equal(await page.evaluate(()=>S.results.length),0);assert.equal(await page.evaluate(()=>S.profile.xp),0);assert.equal(backend.accounts.get('new.learner@gmail.com').is_admin,false);
 await fresh({mock:true,backend});await login('new@academy.example.test','test-site-password-12');assert.deepEqual(await page.evaluate(()=>({xp:S.profile.xp,results:S.results.length})),expected);assert.ok(!(await page.evaluate(()=>JSON.stringify(S))).includes('test-site-password-12'));
});
await test('mocked account A/B storage is separate and account A restores from cloud in fresh browser context',async()=>{
 const backend=await fresh({mock:true});await login('a@example.test');await oneRound();const expected=await page.evaluate(()=>({xp:S.profile.xp,results:S.results.length}));assert.ok(expected.xp>0);assert.equal(expected.results,1);
 await logout();await login('b@example.test');assert.equal(await page.evaluate(()=>S.profile.xp),0);assert.equal(await page.evaluate(()=>S.results.length),0);assert.equal(await page.locator('[data-page=admin]').count(),0);
 const denied=await page.evaluate(async()=>{try{await Auth.adminRoster();return false;}catch{return true;}});assert.ok(denied);await page.evaluate(()=>go('admin'));assert.notEqual(await page.evaluate(()=>S.page),'admin');
 await logout();await login('a@example.test');assert.deepEqual(await page.evaluate(()=>({xp:S.profile.xp,results:S.results.length})),expected);
 const other=await newContext({mock:true,backend});const otherPage=await other.ctx.newPage();await otherPage.goto(base);await otherPage.waitForFunction(()=>S.ready&&Auth.current().configured);const oldPage=page;page=otherPage;await login('a@example.test');assert.deepEqual(await page.evaluate(()=>({xp:S.profile.xp,results:S.results.length})),expected);assert.equal(await page.evaluate(()=>Auth.current().cloudStatus),'synced');page=oldPage;await other.ctx.close();
});
await test('mocked SDK identity change cannot upload account A progress under account B',async()=>{
 const backend=await fresh({mock:true});await login('a@example.test');await oneRound();const aResultIDs=await page.evaluate(()=>S.results.map(r=>r.id)),aCloud=clone(backend.cloud.get(A).records);
 const reloaded=page.waitForNavigation({waitUntil:'load'});await page.evaluate(({id,email})=>window.__testSwitchUser(id,email),{id:B,email:'b@example.test'});await reloaded;
 await page.waitForFunction(()=>S.ready&&((Auth.current().mode==='account'&&Auth.current().user?.id==='22222222-2222-4222-8222-222222222222'&&db.status().userId===Auth.current().user.id)||Auth.current().mode==='signed-out'));
 if(await page.evaluate(()=>Auth.current().mode)==='signed-out')await login('b@example.test');
 assert.equal(await page.evaluate(()=>S.results.length),0);assert.equal(await page.evaluate(()=>S.profile.xp),0);await page.evaluate(()=>Auth.syncNow());
 assert.deepEqual(backend.cloud.get(A).records,aCloud);assert.ok(!backend.writes.some(w=>w.user.id===B&&(w.args.p_records.results||[]).some(r=>aResultIDs.includes(r.id))));
});
await test('owner roster and student details expose safe progress without credentials and preserve disable controls',async()=>{
 const backend=await fresh({mock:true});await signup('new@academy.example.test',{name:'<img src=x onerror=alert(1)>'});await oneRound();const resultPrompt=await page.evaluate(()=>S.byId.get(S.results[0].items[0].id).prompt);const visitInfo=await page.evaluate(async()=>{const ids=['u01_l01','u01_l02'],dates=['2026-10-01T12:00:00.000Z','2026-10-02T12:00:00.000Z'];S.profile.visitedLessons=Object.fromEntries(ids.map((id,index)=>[id,dates[index]]));S.profile.lastLessonId=ids[1];await saveState();return{names:ids.map(id=>byLesson(id).name),lastName:byLesson(ids[1]).name,dates:dates.map(date=>new Date(date).toLocaleString('ar-JO'))};});await page.evaluate(async()=>{await createSession('training','u01_l01','easy','all',3,['a','b'],'none');await saveSession();await Auth.syncNow();});const activePrompt=await page.evaluate(()=>S.session.questions[S.session.current].prompt);await logout();await login('admin@example.test');await page.locator('.sidebar [data-page=admin]').click();await page.waitForFunction(()=>S.adminLoaded&&!S.adminLoading);
 assert.equal(await page.locator('img[src=x]').count(),0);assert.ok((await page.locator('.admin-roster').textContent()).includes('<img src=x onerror=alert(1)>'));assert.ok((await page.locator('.admin-roster').textContent()).includes('new@academy.example.test'));assert.equal(await page.locator('input[type=password]').count(),0);assert.equal(await page.locator('#admin-allow-form').count(),0);
 await page.locator('[data-action=admin-student-details][data-user-id="55555555-5555-4555-8555-555555555555"]').click();await page.waitForFunction(()=>document.querySelector('.admin-student-details')&&!document.querySelector('.admin-student-details [aria-busy=true]'));await page.waitForFunction(()=>document.querySelector('.admin-student-details')?.textContent.includes('new@academy.example.test'));const details=page.locator('.admin-student-details');for(const item of await details.locator('details').all())if(!await item.getAttribute('open'))await item.locator('summary').click();const text=await details.textContent();assert.ok(text.includes(resultPrompt));assert.ok(text.includes(activePrompt));assert.ok(text.includes('الدروس التي زارها الطالب'));assert.ok(text.includes('آخر درس: '+visitInfo.lastName));const visitText=await details.locator('.student-visited-lessons').textContent();for(const label of [...visitInfo.names,...visitInfo.dates])assert.ok(visitText.includes(label));assert.equal(await details.locator('.student-visited-lessons li').count(),2);assert.ok(text.includes('<img src=x onerror=alert(1)>'));assert.ok(!text.includes('test-site-password-12'));assert.equal(await details.locator('input[type=password]').count(),0);assert.equal(await details.locator('img[src=x]').count(),0);await page.locator('[data-action=admin-student-close]').click();backend.state.detailsPayload={user:null,profile:null,progress:null,login_events:null};await page.locator('[data-action=admin-student-details][data-user-id="55555555-5555-4555-8555-555555555555"]').click();await page.waitForFunction(()=>S.adminDetails&&!S.adminDetails.loading);assert.equal(await page.locator('.admin-student-details .admin-answer').count(),0);assert.ok((await page.locator('.admin-student-details').textContent()).includes('لا توجد جلسة جارية'));await page.locator('[data-action=admin-student-close]').click();backend.state.detailsPayload=null;await page.locator('[data-action=admin-student-details][data-user-id="55555555-5555-4555-8555-555555555555"]').click();await page.waitForFunction(()=>!!S.adminDetails?.error);assert.equal(await page.locator('.admin-student-details [role=alert]').count(),1);await page.locator('[data-action=admin-student-close]').click();delete backend.state.detailsPayload;
 await page.locator('[data-action=admin-toggle][data-email="new@academy.example.test"]').click();await page.locator('[data-action=admin-confirm-toggle]').click();await page.waitForFunction(()=>!S.adminLoading&&S.adminData.accounts.some(a=>a.email==='new@academy.example.test'&&a.enabled===false));assert.equal(backend.accounts.get('new@academy.example.test').enabled,false);
 await page.setViewportSize({width:360,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);const scrollRegion=page.locator('.admin-roster .admin-table-wrap');await scrollRegion.focus();assert.ok(await scrollRegion.getAttribute('aria-label'));for(let i=0;i<14;i++)await page.keyboard.press('ArrowLeft');await page.waitForTimeout(120);assert.ok(Math.abs(await scrollRegion.evaluate(el=>el.scrollLeft))>0);
 await logout();await page.locator('#auth-email').fill('new@academy.example.test');await page.locator('#auth-password').fill('test-site-password-12');await page.locator('#auth-email-form button[type=submit]').click();await page.waitForFunction(()=>!S.authBusy&&!!S.authMessage);assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.equal(backend.accounts.get('new@academy.example.test').enabled,false);
 await login('admin@example.test');await page.evaluate(()=>go('admin'));await page.waitForFunction(()=>S.adminLoaded&&!S.adminLoading);await page.locator('[data-action=admin-toggle][data-email="new@academy.example.test"]').click();await page.locator('[data-action=admin-confirm-toggle]').click();await page.waitForFunction(()=>!S.adminLoading&&S.adminData.accounts.some(a=>a.email==='new@academy.example.test'&&a.enabled===true));await logout();await login('new@academy.example.test','test-site-password-12');assert.equal(await page.evaluate(()=>Auth.current().isAdmin),false);assert.equal(await page.evaluate(()=>S.results.length),1);
});
await test('mocked offline cloud cannot trap sign-out and preserves account cache',async()=>{
 const backend=await fresh({mock:true});await login('a@example.test');await oneRound();const prior=await page.evaluate(()=>S.results.length);backend.state.offline=true;
 await page.evaluate(async()=>{S.profile.coins+=1;await saveState();});await logout();assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.equal(await page.locator('#auth-email-form').count(),1);
 backend.state.offline=false;await login('a@example.test');assert.equal(await page.evaluate(()=>S.results.length),prior);assert.ok((await page.evaluate(()=>S.profile.coins))>0);
});
await test('mocked cloud conflict requires explicit choice and cancellation does not overwrite data',async()=>{
 const backend=await fresh({mock:true});await login('a@example.test');await oneRound();
 await page.evaluate(async()=>{await createSession('training','u01_l01','easy','all',3,['a','b'],'none');const token=db.scopeToken();await db.put('profile',{...S.profile,name:'نسخة محلية مستقلة'},{silent:true,scopeToken:token});});
 const remote=backend.cloud.get(A);backend.cloud.set(A,{...remote,revision:remote.revision+1,records:{...remote.records,profile:{...remote.records.profile,name:'نسخة سحابية مستقلة'}}});
 await page.reload();await page.waitForFunction(()=>S.ready&&Auth.current().cloudStatus==='conflict');assert.ok(await page.evaluate(()=>!!S.session));await page.setViewportSize({width:360,height:800});await page.evaluate(()=>go('settings'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await capture({path:path.join(root,'artifacts/auth-conflict-phone.png'),fullPage:true});
 const before=await page.evaluate(()=>S.profile.name);await page.locator('[data-action=auth-conflict][data-choice=cloud]').click();assert.ok(await page.locator('[data-action=auth-confirm-conflict]').count());await page.locator('[data-action=close-modal]').last().click();assert.equal(await page.evaluate(()=>S.profile.name),before);
 await page.locator('[data-action=auth-conflict][data-choice=cloud]').click();await page.locator('[data-action=auth-confirm-conflict]').click();await page.waitForFunction(()=>S.ready&&S.profile.name==='نسخة سحابية مستقلة'&&Auth.current().cloudStatus==='synced');assert.equal(await page.evaluate(()=>S.session),null);await page.reload();await page.waitForFunction(()=>S.ready&&Auth.current().mode==='account');assert.equal(await page.evaluate(()=>S.profile.name),'نسخة سحابية مستقلة');assert.equal(await page.evaluate(()=>S.session),null);
});
await test('no unexpected browser errors in auth UI checks',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(blockedExternalRequests,[]);assert.equal(createHash('sha256').update(await readFile(path.join(root,'dist/index.html'))).digest('hex'),testedBuildSha256,'Production build changed during UI checks');});
await context?.close();await browser.close();
const report={generatedAt:new Date().toISOString(),testedBuildSha256,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,results,errors,blockedExternalRequests,screenshotsCaptured:process.env.CAPTURE_SCREENSHOTS==='1',limitations:['Guest/unconfigured checks use the production bridge and browser memory storage with an explicitly empty test-response configuration, independent of deployed public settings.','Configured account, admin, Public email signup, confirmation-required and admin student-detail and cloud checks replace SDK transport in a routed HTML response with a deterministic test double. Every fixture replaces the configuration generically and blocks external network requests. No production test switch exists.','These checks do not prove live email delivery, Supabase availability, hosted RLS or a deployed account service.']};
await Promise.all([writeFile(path.join(root,'artifacts/auth-ui-results.json'),JSON.stringify(report,null,2)),writeFile(path.join(root,'test-results/email-auth-ui-results.json'),JSON.stringify(report,null,2))]);console.log(`${report.passed} passed, ${report.failed} failed.`);process.exitCode=report.failed?1:0;
