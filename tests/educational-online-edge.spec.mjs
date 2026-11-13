/** Two isolated browser clients, real PostgreSQL game RPCs, simulated Email Auth transport. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {createDuelServer,ids} from './helpers/duel-server.mjs';
const root=new URL('../',import.meta.url),base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
const html=await readFile(new URL('dist/index.html',root),'utf8');
assert.ok(html.includes('educational_duel_create'),'Build the online release before running this test');
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
async function step(name,fn){const started=Date.now();try{await fn();results.push({name,status:'passed',milliseconds:Date.now()-started});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:error.stack,milliseconds:Date.now()-started});console.error(error.stack);throw error;}}
const user=id=>backend.users.find(u=>u.id===id);const snapshot=async id=>{const r=await backend.call({name:'duel_state',args:{p_room_id:roomID},user:user(id)});assert.equal(r.error,null);return r.data;};
const click=async(page,a,v)=>page.locator(`[data-edu="${a}"]${v===undefined?'':`[data-value="${v}"]`}`).first().click();
async function solve(page,q){if(q.type==='matching'){for(const p of q.answer.pairs){await click(page,'left',p.left_id);await click(page,'right',p.right_id);}await click(page,'submit');}else if(q.type==='ordering'){for(const id of q.answer.ordered_ids)await click(page,'order',id);await click(page,'submit');}else await click(page,'answer',q.type==='true_false'?String(q.answer.value):q.answer.option_id);}
try{
 host=await newClient({width:360,height:800});guest=await newClient({width:1280,height:900});await login(host,'host@example.test');await login(guest,'guest@example.test');
 await step('Icons, all-game custom solo timers, replay preservation and invalid duration recovery',async()=>{
  await host.evaluate(()=>go('educational'));assert.equal(await host.locator('.edu-game-icon svg').count(),13);await host.selectOption('#edu-duration','custom');await host.locator('#edu-custom-duration').fill('1');await click(host,'start',7);await host.waitForTimeout(200);assert.equal(await host.locator('#edu-custom-duration').count(),1);await host.locator('#edu-custom-duration').fill('137');
  for(let game=0;game<13;game++){await host.selectOption('#edu-duration','custom');await host.locator('#edu-custom-duration').fill('137');await host.selectOption('#edu-unit','u01');await host.selectOption('#edu-lesson','u01_l01');assert.equal(await host.locator('#edu-duration').inputValue(),'custom');assert.equal(await host.locator('#edu-custom-duration').inputValue(),'137');await click(host,'start',game);await host.waitForSelector('.edu-play');await host.waitForFunction(()=>!!S.profile.educationalActive);const g=await host.evaluate(()=>S.profile.educationalActive);assert.equal(g.roundSeconds,137);assert.ok(Math.abs(g.end-Date.now()-137000)<3000);await click(host,'finish');if(game===0){await click(host,'replay');await host.waitForSelector('.edu-play');await host.waitForFunction(()=>!!S.profile.educationalActive);assert.equal((await host.evaluate(()=>S.profile.educationalActive)).roundSeconds,137);await click(host,'finish');}await click(host,'catalog');}
  await host.screenshot({path:'artifacts/educational-icons-mobile.png',fullPage:true});await host.selectOption('#edu-duration','custom');await host.locator('#edu-custom-duration').fill('35');await host.selectOption('#edu-timer','5');await click(host,'start',4);await host.waitForTimeout(500);assert.ok((await host.locator('#edu-clock').textContent()).includes('العبارة'));await click(host,'finish');await click(host,'catalog');await host.selectOption('#edu-timer','0');await host.selectOption('#edu-duration','0');await click(host,'start',10);assert.equal(await host.evaluate(()=>S.profile.educationalActive.end),undefined);await click(host,'finish');await click(host,'catalog');
 });
 async function joinGame(game,time){await host.evaluate(()=>go('educational'));await host.selectOption('#edu-unit','u01');await host.selectOption('#edu-lesson','u01_l01');await host.selectOption('#edu-duration','custom');await host.locator('#edu-custom-duration').fill(String(time));await click(host,'online',game);await host.waitForSelector('[data-testid=online-room-code]');assert.ok(!(await host.locator('.online-room').textContent()).includes('ليس رقم'));const code=(await host.locator('[data-testid=online-room-code]').textContent()).trim();const recent=await backend.call({name:'duel_recent',user:user(ids.host)});roomID=recent.data.find(r=>r.status==='waiting').id;await guest.evaluate(()=>go('online'));await guest.waitForTimeout(250);if(await guest.locator('[data-action=online-new]').count())await guest.locator('[data-action=online-new]').click();await guest.waitForSelector('#online-code');await guest.locator('#online-code').fill(code);await guest.locator('#online-join-form button[type=submit]').click();await host.waitForSelector('.edu-play');await guest.waitForSelector('.edu-play');return(await backend.serialize(()=>backend.db.query('select questions from school_private.duel_rooms where id=$1',[roomID]))).rows[0].questions;}
 async function finishBoth(){await click(host,'finish');await click(guest,'finish');await guest.waitForSelector('.online-result');if(await host.locator('[data-action=online-refresh]').count())await host.locator('[data-action=online-refresh]').click();await host.waitForSelector('.online-result');}
 await step('Escape wrong-answer retry survives polling and is accepted once by the server',async()=>{const questions=await joinGame(2,120),q=questions[0];await click(host,'answer',q.payload.options.find(x=>x.id!==q.answer.option_id).id);await host.waitForSelector('[data-edu=next]');assert.equal((await snapshot(ids.host)).me.answered,0);await click(host,'next');await host.waitForTimeout(3300);await solve(host,q);await host.waitForSelector('[data-edu=next]');const r=await snapshot(ids.host);assert.equal(r.me.answered,1);assert.equal(r.me.receipts.length,1);assert.equal(r.me.receipts[0].correct,true);await finishBoth();});
 await step('Wheel animation remains visible until it stops at its chosen question',async()=>{await joinGame(3,60);await click(host,'spin');assert.equal(await host.locator('.edu-wheel').count(),1);await host.waitForTimeout(400);assert.equal(await host.locator('.edu-wheel').count(),1);await host.waitForTimeout(1000);assert.equal(await host.locator('.edu-wheel').count(),0);await finishBoth();});
 await step('Offline rejection preserves a retryable question and resumed room deadline',async()=>{const [q]=await joinGame(0,60);backend.offline.add(ids.host);await solve(host,q);await host.waitForFunction(()=>document.querySelector('.online-content [role=alert]')?.textContent.includes('تعذر الاتصال'));assert.equal((await backend.serialize(()=>backend.db.query('select count(*)::int n from school_private.duel_answers where room_id=$1',[roomID]))).rows[0].n,0);backend.offline.delete(ids.host);await host.locator('[data-action=online-refresh]').click();await host.waitForFunction(()=>!document.querySelector('.edu-online-shell[disabled]'));await solve(host,q);await host.waitForSelector('[data-edu=next]');assert.equal((await snapshot(ids.host)).me.receipts.length,1);await finishBoth();});
 await step('Fifteen-second shared deadline expires in real time after player reload',async()=>{await joinGame(9,15);const before=await snapshot(ids.host);await host.reload();await host.waitForFunction(()=>S.ready&&Auth.current().mode==='account');await host.evaluate(()=>go('online'));await host.waitForSelector('.edu-play');assert.equal((await snapshot(ids.host)).deadline,before.deadline);await host.waitForSelector('.online-result',{timeout:20000});assert.equal((await snapshot(ids.host)).result.reason,'timeout');});
 assert.ok(results.every(x=>x.status==='passed'));assert.deepEqual(browserErrors,[]);await writeFile(new URL('test-results/educational-online-edge.json',root),JSON.stringify({results,browserErrors,liveSupabase:false},null,2));
}finally{for(const c of contexts)await c.close();await browser.close();await backend.db.close();}
