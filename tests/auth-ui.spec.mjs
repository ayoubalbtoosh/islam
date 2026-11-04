import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
await mkdir(path.join(root,'artifacts'),{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
const results=[],errors=[];let context,page;
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ADMIN='33333333-3333-4333-8333-333333333333',OUT='44444444-4444-4444-8444-444444444444';
const clone=x=>JSON.parse(JSON.stringify(x));
function server(){
 const state={offline:false};
 const accounts=new Map([
  ['a@example.test',{email:'a@example.test',display_name:'طالب ألف',is_admin:false,enabled:true,user_id:A,last_login_at:null,login_count:0}],
  ['b@example.test',{email:'b@example.test',display_name:'<img src=x onerror=alert(1)>',is_admin:false,enabled:true,user_id:B,last_login_at:null,login_count:0}],
  ['admin@example.test',{email:'admin@example.test',display_name:'مدير الاختبار',is_admin:true,enabled:true,user_id:ADMIN,last_login_at:null,login_count:0}]
 ]),cloud=new Map(),events=[],writes=[];
 const denied=()=>({data:null,error:{message:'server denied operation'}});
 async function call(payload){
  if(state.offline&&payload.name==='save_user_progress')return{data:null,error:{message:'mock offline cloud'}};
  const account=accounts.get(payload.user?.email),allowed=!!account&&account.enabled&&account.user_id===payload.user?.id;
  if(payload.name==='record_login'){
   events.unshift({id:events.length+1,user_id:payload.user?.id,email:payload.user?.email,display_name:account?.display_name||'',at:new Date().toISOString(),provider:'email',allowed});
   if(allowed){account.login_count++;account.last_login_at=new Date().toISOString();}
   return {data:{allowed,user_id:payload.user?.id,email:payload.user?.email,display_name:account?.display_name,is_admin:!!account?.is_admin},error:null};
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
  if(payload.name==='admin_allow_account'){
   const email=payload.args.p_email.toLowerCase();accounts.set(email,{email,display_name:payload.args.p_display_name,is_admin:false,enabled:true,user_id:null,last_login_at:null,login_count:0});return{data:{email},error:null};
  }
  if(payload.name==='admin_disable_account'){
   const row=accounts.get(payload.args.p_email);if(!row||row.is_admin)return denied();row.enabled=!payload.args.p_disabled;return{data:{email:row.email,enabled:row.enabled},error:null};
  }
  return denied();
 }
 return{accounts,cloud,events,writes,call,state};
}
async function newContext({mock=false,backend=server(),viewport={width:1366,height:768}}={}){
 const ctx=await browser.newContext({viewport});
 if(mock){
  await ctx.exposeBinding('__testBackend',(_,payload)=>backend.call(payload));
  await ctx.addInitScript(({ids})=>{
   const key='test-only-auth-session';const users={'a@example.test':ids.A,'b@example.test':ids.B,'admin@example.test':ids.ADMIN,'outside@example.test':ids.OUT};
   let session;try{session=JSON.parse(localStorage.getItem(key)||'null');}catch{session=null;}
   const callbacks=[];window.__testSwitchUser=(id,email)=>{session={user:{id,email}};localStorage.setItem(key,JSON.stringify(session));callbacks.forEach(cb=>cb('SIGNED_IN',session));};const answer=(data,error=null)=>Promise.resolve({data,error});
   window.__testSupabaseSDK={createClient(){return{
    auth:{getSession:()=>answer({session}),onAuthStateChange:cb=>{callbacks.push(cb);return{data:{subscription:{unsubscribe(){}}}};},
     signInWithPassword:async({email,password})=>{const id=users[email.toLowerCase()];if(!id||password!=='test-platform-password')return answer({session:null},{message:'mock rejected credentials'});session={user:{id,email:email.toLowerCase()}};localStorage.setItem(key,JSON.stringify(session));callbacks.forEach(cb=>cb('SIGNED_IN',session));return answer({session});},
     signInWithOAuth:async options=>{window.__testGoogleRequest=options;return answer({provider:'google',url:'https://accounts.google.com/o/oauth2/v2/auth'});},
     signOut:async()=>{session=null;localStorage.removeItem(key);callbacks.forEach(cb=>cb('SIGNED_OUT',null));return{error:null};}
    },
    rpc:(name,args={})=>window.__testBackend({name,args,user:session?.user||null}),
    from:()=>({select(){return this;},eq(_,id){this.id=id;return this;},maybeSingle(){return window.__testBackend({name:'read_progress',args:{user_id:this.id},user:session?.user||null});}})
   };}};
  },{ids:{A,B,ADMIN,OUT}});
  await ctx.route(base+'/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;if(pathname!=='/'&&pathname!=='/index.html')return route.continue();
   let html=await readFile(path.join(root,'dist/index.html'),'utf8');
   html=html.replace('const AUTH_CONFIG={"url":"","publishableKey":""};','const AUTH_CONFIG={"url":"https://mock-project.supabase.test","publishableKey":"sb_publishable_test_only_browser_1234567890"};');
   assert.ok(html.includes('const Auth=(()=>{'),'Auth bridge marker missing from production build');
   html=html.replace('const Auth=(()=>{','SupabaseSDK=window.__testSupabaseSDK;\nconst Auth=(()=>{');
   await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
  });
 }
 return{ctx,backend};
}
async function fresh(options={}){await context?.close();const next=await newContext(options);context=next.ctx;page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(base);await page.waitForFunction(()=>typeof S!=='undefined'&&S.ready&&document.querySelector('#main-content'));return next.backend;}
async function test(name,fn){const at=Date.now();try{await fn();results.push({name,status:'passed',milliseconds:Date.now()-at});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:error.stack,milliseconds:Date.now()-at});console.error('FAIL '+name+': '+error.message);}}
async function login(email){await page.locator('#auth-email').fill(email);await page.locator('#auth-password').fill('test-platform-password');await page.locator('#auth-email-form button[type=submit]').click();await page.waitForFunction(()=>Auth.current().mode==='account'&&S.ready&&db.status().userId===Auth.current().user.id);}
async function logout(){await page.evaluate(()=>go('settings'));await page.locator('.account-card [data-action=auth-signout]').click();await page.locator('[data-action=auth-confirm-signout]').click();await page.waitForFunction(()=>Auth.current().mode==='signed-out'&&S.ready&&document.querySelector('#auth-email-form'));}
async function oneRound(){await page.evaluate(async()=>{await createSession('training','u01_l01','easy','all',2,['a','b'],'none');while(S.session){const q=S.session.questions[S.session.current],a=q.answer;const r=q.type==='true_false'?a.value:['multiple_choice','fill_blank'].includes(q.type)?a.option_id:q.type==='multi_select'?a.option_ids:q.type==='ordering'?a.ordered_ids:Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id]));await autoAnswer(r);}await Auth.syncNow();});}

await test('real unconfigured service shows honest login gate without nickname bypass',async()=>{
 await fresh();assert.equal(await page.locator('.auth-screen').count(),1);assert.ok((await page.locator('.auth-panel').textContent()).includes('تسجيل الحسابات بانتظار التفعيل'));
 assert.equal(await page.locator('[data-action=auth-google]').isDisabled(),true);assert.equal(await page.locator('#auth-email-form button[type=submit]').isDisabled(),true);assert.equal(await page.locator('[data-action=save-name]').count(),0);
 assert.equal(await page.locator('#admin-allow-form').count(),0);assert.equal(await page.locator('[data-page=admin]').count(),0);
});
await test('real guest progress is temporary, isolated, and cleared by reload',async()=>{
 await fresh();await page.locator('[data-action=guest-name]').click();await page.waitForFunction(()=>Auth.current().mode==='guest'&&S.profile.name==='ضيف'&&!S.authBusy);
 assert.ok((await page.locator('.identity-guest').textContent()).includes('ضيف — تقدمك مؤقت ويُمسح عند إغلاق/تحديث الصفحة'));assert.equal(await page.evaluate(()=>db.status().persistent),false);
 await page.evaluate(async()=>{await createSession('training','u01_l01','easy','all',1,['a','b'],'none');const q=S.session.questions[0],a=q.answer;await autoAnswer(q.type==='true_false'?a.value:['multiple_choice','fill_blank'].includes(q.type)?a.option_id:q.type==='multi_select'?a.option_ids:q.type==='ordering'?a.ordered_ids:Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id])));});
 assert.equal(await page.evaluate(()=>S.results.length),1);await page.evaluate(()=>go('settings'));assert.equal(await page.locator('[data-action=export]').count(),0);assert.equal(await page.locator('#import-file').count(),0);
 assert.equal(await page.locator('[data-page=admin]').count(),0);await page.reload();await page.waitForFunction(()=>S.ready&&Auth.current().mode==='signed-out');assert.equal(await page.evaluate(()=>S.results.length),0);assert.equal(await page.evaluate(()=>S.session),null);assert.equal(await page.evaluate(()=>S.profile.xp),0);
});
await test('auth gate and guest banner fit phone tablet desktop and preserve source attribution',async()=>{
 for(const [width,height] of [[360,800],[390,844],[768,1024],[1366,768],[1920,1080]]){
  await fresh({viewport:{width,height}});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:path.join(root,`artifacts/auth-gate-${width}.png`),fullPage:true});await page.locator('[data-action=guest-name]').click();await page.waitForFunction(()=>Auth.current().mode==='guest'&&!S.authBusy);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.ok((await page.locator('.dashboard-kicker').textContent()).includes('توجيهي'));assert.ok(!(await page.locator('.dashboard-kicker').textContent()).includes('الحادي عشر'));
  await page.screenshot({path:path.join(root,`artifacts/auth-guest-${width}.png`),fullPage:true});await page.evaluate(()=>go('about'));assert.ok((await page.locator('#main-content').textContent()).includes('الحادي عشر، الفصل الثاني'));await page.evaluate(()=>{S.settings.theme='light';render();});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 }
});
await test('mocked provider uses official Google OAuth API without accepting a Google password',async()=>{
 await fresh({mock:true});await page.locator('[data-action=auth-google]').click();await page.waitForFunction(()=>!!window.__testGoogleRequest);
 const request=await page.evaluate(()=>window.__testGoogleRequest);assert.equal(request.provider,'google');assert.equal(request.options.queryParams.prompt,'select_account');assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.ok((await page.locator('.auth-panel').textContent()).includes('لا تُدخل كلمة مرور Google هنا'));
});
await test('mocked rejected credentials stay signed out and clear password without logging it',async()=>{
 await fresh({mock:true});await page.locator('#auth-email').fill('a@example.test');await page.locator('#auth-password').fill('wrong-test-password');await page.locator('#auth-email-form button[type=submit]').click();await page.waitForFunction(()=>!S.authBusy&&!!S.authMessage);
 assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.equal(await page.locator('#auth-password').inputValue(),'');assert.ok(!(await page.locator('.auth-panel').textContent()).includes('mock rejected credentials'));assert.ok(!(await page.evaluate(()=>JSON.stringify(S))).includes('wrong-test-password'));
});
await test('mocked allowlist denies an authenticated but unapproved email',async()=>{
 await fresh({mock:true});await page.locator('#auth-email').fill('outside@example.test');await page.locator('#auth-password').fill('test-platform-password');await page.locator('#auth-email-form button[type=submit]').click();await page.waitForFunction(()=>!S.authBusy&&!!S.authMessage);
 assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');assert.equal(await page.locator('[data-page=admin]').count(),0);assert.equal(await page.evaluate(()=>db.status().guest),true);
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
await test('mocked admin roster is role-gated escaped and supports allow/disable without passwords',async()=>{
 const backend=await fresh({mock:true});await login('admin@example.test');await page.locator('.sidebar [data-page=admin]').click();await page.waitForFunction(()=>S.adminLoaded&&!S.adminLoading);
 assert.equal(await page.locator('img[src=x]').count(),0);assert.ok((await page.locator('.admin-roster').textContent()).includes('<img src=x onerror=alert(1)>'));assert.equal(await page.locator('input[type=password]').count(),0);assert.equal(await page.locator('#admin-student-name').getAttribute('maxlength'),'80');
 await page.locator('#admin-student-name').fill('طالب جديد');await page.locator('#admin-student-email').fill('new@example.test');await page.locator('#admin-allow-form button[type=submit]').click();await page.waitForFunction(()=>!S.adminLoading&&S.adminData.accounts.some(a=>a.email==='new@example.test'));assert.equal(backend.accounts.get('new@example.test').user_id,null);
 await page.locator('[data-action=admin-toggle][data-email="b@example.test"]').click();await page.locator('[data-action=admin-confirm-toggle]').click();await page.waitForFunction(()=>!S.adminLoading&&S.adminData.accounts.some(a=>a.email==='b@example.test'&&a.enabled===false));assert.equal(backend.accounts.get('b@example.test').enabled,false);
 await page.setViewportSize({width:360,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);const scrollRegion=page.locator('.admin-roster .admin-table-wrap');await scrollRegion.focus();assert.ok(await scrollRegion.getAttribute('aria-label'));for(let i=0;i<14;i++)await page.keyboard.press('ArrowLeft');await page.waitForTimeout(120);assert.ok(Math.abs(await scrollRegion.evaluate(el=>el.scrollLeft))>0);await page.screenshot({path:path.join(root,'artifacts/auth-admin-phone.png'),fullPage:true});
 await logout();await page.locator('#auth-email').fill('b@example.test');await page.locator('#auth-password').fill('test-platform-password');await page.locator('#auth-email-form button[type=submit]').click();await page.waitForFunction(()=>!S.authBusy&&!!S.authMessage);assert.equal(await page.evaluate(()=>Auth.current().mode),'signed-out');
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
 await page.reload();await page.waitForFunction(()=>S.ready&&Auth.current().cloudStatus==='conflict');assert.ok(await page.evaluate(()=>!!S.session));await page.setViewportSize({width:360,height:800});await page.evaluate(()=>go('settings'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:path.join(root,'artifacts/auth-conflict-phone.png'),fullPage:true});
 const before=await page.evaluate(()=>S.profile.name);await page.locator('[data-action=auth-conflict][data-choice=cloud]').click();assert.ok(await page.locator('[data-action=auth-confirm-conflict]').count());await page.locator('[data-action=close-modal]').last().click();assert.equal(await page.evaluate(()=>S.profile.name),before);
 await page.locator('[data-action=auth-conflict][data-choice=cloud]').click();await page.locator('[data-action=auth-confirm-conflict]').click();await page.waitForFunction(()=>S.ready&&S.profile.name==='نسخة سحابية مستقلة'&&Auth.current().cloudStatus==='synced');assert.equal(await page.evaluate(()=>S.session),null);await page.reload();await page.waitForFunction(()=>S.ready&&Auth.current().mode==='account');assert.equal(await page.evaluate(()=>S.profile.name),'نسخة سحابية مستقلة');assert.equal(await page.evaluate(()=>S.session),null);
});
await test('no unexpected browser errors in auth UI checks',async()=>assert.deepEqual(errors,[]));
await context?.close();await browser.close();
const report={generatedAt:new Date().toISOString(),passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,results,errors,limitations:['Guest/unconfigured checks use the actual production bridge and browser memory storage.','Configured account, admin, Google API contract and cloud checks replace SDK transport in a routed HTML response with a deterministic test double. No production test switch exists.','These checks do not prove live Google OAuth, Supabase delivery, hosted RLS or a deployed account service.']};
await writeFile(path.join(root,'artifacts/auth-ui-results.json'),JSON.stringify(report,null,2));console.log(`${report.passed} passed, ${report.failed} failed.`);process.exitCode=report.failed?1:0;
