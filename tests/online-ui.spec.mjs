/** Two isolated browser clients, real PostgreSQL game RPCs, simulated Email Auth transport. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {createDuelServer,ids} from './helpers/duel-server.mjs';
const root=new URL('../',import.meta.url),base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
const html=await readFile(new URL('dist/index.html',root),'utf8');
assert.ok(html.includes('const Online='),'Build the online release before running this test');
const testedBuildSha256=createHash('sha256').update(html).digest('hex');
const backend=await createDuelServer(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const contexts=[],results=[],browserErrors=[],externalRequests=[];
let host,guest,admin,roomID,invite,progressBefore;
async function newClient(viewport){
 const context=await browser.newContext({viewport});contexts.push(context);
 await context.exposeBinding('__sqlRPC',(_,payload)=>backend.call(payload));
 await context.exposeBinding('__fixtureEmailAuth',(_,payload)=>backend.auth(payload));
 await context.addInitScript(()=>{
  const key='online-test-only-session';let session;try{session=JSON.parse(localStorage.getItem(key)||'null');}catch{session=null;}
  const callbacks=[],result=data=>Promise.resolve({data,error:null});
  const persist=next=>{session=next;if(next)localStorage.setItem(key,JSON.stringify(next));else localStorage.removeItem(key);callbacks.forEach(cb=>cb(next?'SIGNED_IN':'SIGNED_OUT',next));};
  window.__fixtureSDK={createClient:()=>({
   auth:{getSession:()=>result({session}),onAuthStateChange:cb=>{callbacks.push(cb);return{data:{subscription:{unsubscribe(){}}}};},signInWithPassword:async data=>{const response=await window.__fixtureEmailAuth(data);if(response.data.session)persist(response.data.session);return response;},signOut:async()=>{persist(null);return{error:null};}},
   rpc:(name,args={})=>window.__sqlRPC({name,args,user:session?.user||null}),
   from:()=>({select(){return this;},eq(_,id){this.id=id;return this;},maybeSingle(){return window.__sqlRPC({name:'read_progress',args:{user_id:this.id},user:session?.user||null});}})
  })};
 });
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==new URL(base).origin){externalRequests.push(url.origin);return route.abort();}
  if(route.request().resourceType()!=='document')return route.continue();
  const configured=html.replace(/^const AUTH_CONFIG=[^\r\n]*;$/gm,'const AUTH_CONFIG={url:"https://local-postgres.supabase.test",publishableKey:"sb_publishable_browser_fixture_only_1234567890"};');
  assert.ok(configured.includes('const Auth=(()=>{'));
  return route.fulfill({status:200,contentType:'text/html;charset=utf-8',body:configured.replace('const Auth=(()=>{','SupabaseSDK=window.__fixtureSDK;\nconst Auth=(()=>{')});
 });
 const page=await context.newPage();page.on('pageerror',e=>browserErrors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>S.ready&&Auth.current().configured);
 return page;
}
async function login(page,email){
 await page.locator('#auth-email').fill(email);await page.locator('#auth-password').fill('local-test-password');
 await page.locator('#auth-email-form button[type=submit]').click();
 await page.waitForFunction(()=>S.ready&&Auth.current().mode==='account'&&db.status().userId===Auth.current().user.id);
}
async function online(page){await page.evaluate(()=>go('online'));await page.waitForSelector('[data-action="online-create"]');}
async function step(name,fn){const started=Date.now();try{await fn();results.push({name,status:'passed',milliseconds:Date.now()-started});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:error.stack,milliseconds:Date.now()-started});console.error('FAIL '+name+': '+error.message);}}
const hostUser=()=>backend.users.find(u=>u.id===ids.host);
const guestUser=()=>backend.users.find(u=>u.id===ids.guest);
const snapshot=async user=>{const response=await backend.call({name:'duel_state',args:{p_room_id:roomID},user});assert.equal(response.error,null);return response.data;};
try{
 await step('Email sign-in opens independent mobile and desktop accounts; stored progress remains separate',async()=>{
  host=await newClient({width:390,height:844});guest=await newClient({width:1366,height:900});
  await Promise.all([login(host,'host@example.test'),login(guest,'guest@example.test')]);
  await host.evaluate(async()=>{S.profile.coins=17;await saveState();await Auth.syncNow();});
  progressBefore=(await backend.serialize(()=>backend.db.query('select user_id,records,revision from public.user_progress order by user_id'))).rows;
  assert.equal(await host.evaluate(()=>S.profile.coins),17);assert.equal(await guest.evaluate(()=>S.profile.coins),0);
  assert.notEqual(await host.evaluate(()=>Auth.current().user.id),await guest.evaluate(()=>Auth.current().user.id));
  await Promise.all([online(host),online(guest)]);
  for(const p of [host,guest])assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 });
 await step('Host creates an invite code; another authenticated client joins the same server room',async()=>{
  await host.locator('[data-action="online-create"]').click();
  await host.waitForFunction(()=>!!document.querySelector('[data-action="online-copy-code"]'));
  const recent=await backend.call({name:'duel_recent',user:hostUser()});assert.equal(recent.error,null);
  const waiting=recent.data.find(r=>r.status==='waiting');assert.ok(waiting);roomID=waiting.id;invite=waiting.code;
  assert.match(invite,/^[A-F0-9]{10}$/);assert.ok((await host.locator('#main-content').textContent()).includes(invite));
  await guest.locator('#online-code').fill(invite.toLowerCase());await guest.locator('#online-join-form button[type="submit"]').click();
  await guest.waitForSelector('[data-action="online-answer"]');await host.waitForSelector('[data-action="online-answer"]');
  const [a,b]=await Promise.all([snapshot(hostUser()),snapshot(guestUser())]);
  assert.equal(a.id,b.id);assert.equal(a.question.id,b.question.id);assert.equal(a.status,'active');
  assert.equal(a.players.length,2);assert.ok(a.players.every(p=>p.score===null));assert.equal(a.result,null);
  assert.equal('correct_answer' in a.question,false);
 });
 await step('Reload reconnects the player to the active room without resetting deadline or progress',async()=>{
  const before=await snapshot(hostUser());await host.reload();await host.waitForFunction(()=>S.ready&&Auth.current().mode==='account');
  await host.evaluate(()=>go('online'));await host.waitForSelector('[data-action="online-answer"]');
  const after=await snapshot(hostUser());assert.equal(after.id,before.id);assert.equal(after.deadline,before.deadline);assert.equal(after.me.answered,0);
  assert.equal(await host.evaluate(()=>S.profile.coins),17);
 });
 await step('Five shared questions are scored by PostgreSQL and final result appears on both clients',async()=>{
  const {rows}=await backend.serialize(()=>backend.db.query('select questions from school_private.duel_rooms where id=$1',[roomID]));
  const questions=rows[0].questions;
  for(let i=0;i<5;i++){
   for(const [page,user,correct] of [[host,hostUser(),true],[guest,guestUser(),false]]){
    const state=await snapshot(user),q=questions[i];assert.equal(state.question.id,q.id);
    const choice=correct?q.correct_answer:q.options.find(o=>o.id!==q.correct_answer).id;
    await page.locator(`[data-action="online-answer"][data-option="${choice}"]`).click();
    await page.waitForFunction(id=>{const room=document.querySelector('.online-room'),q=document.querySelector('.online-question');return room?.getAttribute('aria-busy')==='false'&&(!q||q.dataset.questionId!==id);},q.id);
    let updated=await snapshot(user);assert.equal(updated.me.answered,i+1);
   }
  }
  await host.waitForSelector('.online-result');await guest.waitForSelector('.online-result');
  const [a,b]=await Promise.all([snapshot(hostUser()),snapshot(guestUser())]);
  assert.equal(a.status,'completed');assert.deepEqual(a.result,b.result);assert.equal(a.result.winner_id,ids.host);
  assert.deepEqual(a.result.scores.map(s=>s.score),[5,0]);
  for(const page of [host,guest]){await page.waitForFunction(()=>document.querySelector('#main-content')?.textContent.includes('لاعب الهاتف'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);}
  const saved=(await backend.serialize(()=>backend.db.query('select user_id,records,revision from public.user_progress order by user_id'))).rows;
  assert.deepEqual(saved,progressBefore,'Online results must not overwrite standalone study progress');
 });
 await step('Server denies unrelated student access and exposes saved result to the existing owner admin',async()=>{
  const outsider=backend.users.find(u=>u.id===ids.outsider);
  const denied=await backend.call({name:'duel_state',args:{p_room_id:roomID},user:outsider});assert.ok(denied.error);
  const deniedAdmin=await backend.call({name:'platform_admin_duels',args:{p_limit:20,p_offset:0},user:hostUser()});assert.ok(deniedAdmin.error);
  admin=await newClient({width:1366,height:900});await login(admin,'ayobalbtoosh41@gmail.com');
  await admin.evaluate(()=>go('admin'));await admin.waitForFunction(()=>S.adminLoaded&&!S.adminLoading);
  await admin.locator('[data-action="online-admin-refresh"]').click();
  await admin.waitForFunction(()=>document.querySelector('.online-admin .admin-table')?.textContent.includes('host@example.test'));
  const response=await backend.call({name:'platform_admin_duels',args:{p_limit:20,p_offset:0},user:backend.users.find(u=>u.id===ids.admin)});
  assert.equal(response.error,null);assert.equal(response.data.total,1);assert.equal(response.data.rooms[0].id,roomID);
  assert.equal(response.data.rooms[0].result.winner_id,ids.host);
  assert.equal(await admin.locator('input[type="password"]').count(),0);
 });
 await step('No unhandled browser errors or external requests; build unchanged during checks',async()=>{
  assert.deepEqual(browserErrors,[]);assert.deepEqual(externalRequests,[]);
  assert.equal(createHash('sha256').update(await readFile(new URL('dist/index.html',root))).digest('hex'),testedBuildSha256);
 });
}finally{
 await Promise.all(contexts.map(c=>c.close()));await browser.close();await backend.db.close();
 const report={generatedAt:new Date().toISOString(),testedBuildSha256,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,results,browserErrors,externalRequests,environment:{browser:'Chromium',clients:['isolated browser context 390x844','isolated browser context 1366x900'],database:'PGlite PostgreSQL executing migrations 001 + owner bootstrap +003 +004',auth:'Email session issuance and SDK transport fixtures'},limitations:['Two isolated browser clients simulate separate devices; no physical phone or second physical computer was used.','Hosted Supabase, actual Email Auth token issuance, SMTP delivery, live GitHub Pages and hosted migration application are not validated by this local test.']};
 await mkdir(new URL('test-results/',root),{recursive:true});await writeFile(new URL('test-results/online-ui-results.json',root),JSON.stringify(report,null,2));
 console.log(`${report.passed} passed, ${report.failed} failed.`);process.exitCode=report.failed?1:0;
}
