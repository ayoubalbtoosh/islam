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
async function step(name,fn){const started=Date.now();try{await fn();results.push({name,status:'passed',milliseconds:Date.now()-started});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:error.stack,milliseconds:Date.now()-started});console.error('FAIL '+name+': '+error.message);}}
const user=id=>backend.users.find(u=>u.id===id);const snapshot=async id=>{const r=await backend.call({name:'duel_state',args:{p_room_id:roomID},user:user(id)});assert.equal(r.error,null);return r.data;};
const click=async(page,a,v)=>page.locator(`[data-edu="${a}"]${v===undefined?'':`[data-value="${v}"]`}`).first().click();
async function solve(page,q){if(q.type==='matching'){for(const p of q.answer.pairs){await click(page,'left',p.left_id);await click(page,'right',p.right_id);}await click(page,'submit');}else if(q.type==='ordering'){for(const id of q.answer.ordered_ids)await click(page,'order',id);await click(page,'submit');}else await click(page,'answer',q.type==='true_false'?String(q.answer.value):q.answer.option_id);}
try{
 host=await newClient({width:390,height:844});guest=await newClient({width:1280,height:900});await login(host,'host@example.test');await login(guest,'guest@example.test');
 for(let game=0;game<13;game++)await step(`Game ${game+1}: two clients complete the actual activity with server-scored results`,async()=>{
  await host.evaluate(()=>go('educational'));assert.equal(await host.locator('.edu-game-icon svg').count(),13);assert.equal(await host.locator('.edu-number').count(),0);
  await host.selectOption('#edu-unit','u01');await host.selectOption('#edu-lesson','u01_l01');await host.selectOption('#edu-duration','custom');await host.locator('#edu-custom-duration').fill('137');await click(host,'online',game);await host.waitForSelector('[data-testid="online-room-code"]');invite=(await host.locator('[data-testid="online-room-code"]').textContent()).trim();
  const recent=await backend.call({name:'duel_recent',user:user(ids.host)});roomID=recent.data.find(r=>r.status==='waiting').id;
  await guest.evaluate(()=>go('online'));await guest.waitForTimeout(300);if(await guest.locator('[data-action="online-new"]').count())await guest.locator('[data-action="online-new"]').click();await guest.waitForSelector('#online-code');await guest.locator('#online-code').fill(invite);await guest.locator('#online-join-form button[type=submit]').click();await guest.waitForSelector('.edu-play');await host.waitForSelector('.edu-play');
  const initial=await snapshot(ids.host);assert.equal(initial.activity.seconds,137);assert.equal(Date.parse(initial.deadline)-Date.parse(initial.started_at),137000);
  const questions=(await backend.serialize(()=>backend.db.query('select questions from school_private.duel_rooms where id=$1',[roomID]))).rows[0].questions;
  // Reconnection must preserve this room's configured deadline and exact activity content.
  if(game===1){await host.reload();await host.waitForFunction(()=>S.ready&&Auth.current().mode==='account');await host.evaluate(()=>go('online'));await host.waitForSelector('.edu-play');assert.equal((await snapshot(ids.host)).deadline,initial.deadline);}
  for(const [page,id] of [[host,ids.host],[guest,ids.guest]]){
   for(let pos=0;pos<questions.length;pos++){
    const q=questions[pos];if(game===3){await click(page,'spin');assert.equal(await page.locator('.edu-wheel').count(),1);await page.waitForTimeout(400);assert.equal(await page.locator('.edu-wheel').count(),1);await page.waitForTimeout(900);}if(game===5)await click(page,'board',pos);if(game===6&&pos===0){for(let i=0;i<Math.min(3,questions.length);i++)await click(page,'clue',i);await click(page,'open');}else if(game===6){await click(page,'open');}
    if(game===7){const target=q.term.normalize('NFC').replace(/[\u064B-\u065F\u0670\u0640\s]/g,'');for(const ch of target){const matches=page.locator('[data-edu=letter]').filter({hasText:new RegExp('^'+ch+'$')});await matches.first().click();}await click(page,'spell');}
    else if(game===9){const word=q.term.normalize('NFC').replace(/[\u064B-\u065F\u0670\u0640\s]/g,'');await click(page,'cell',`${pos},0`);await click(page,'cell',`${pos},${word.length-1}`);}
    else if(game===12){await page.waitForTimeout(2700);for(const id of q.sequence)await click(page,'recall',id);await solve(page,q);}
    else{await solve(page,q);if(game===11){for(const i of [0,2,3])await click(page,'rotate',i);await click(page,'connect');}}
    await page.waitForFunction(()=>!document.querySelector('.edu-online-shell[disabled]'));
    const state=await snapshot(id),receipt=state.me.receipts.find(x=>x.id===q.id);assert.ok(receipt,`receipt ${game}/${pos}`);assert.equal(receipt.correct,true,`correct ${game}/${pos}`);
    if(pos+1<questions.length&&game!==9)await click(page,'next');
   }
  }
  if(await host.locator('[data-action="online-refresh"]').count())await host.locator('[data-action="online-refresh"]').click();await host.waitForSelector('.online-result');await guest.waitForSelector('.online-result');const a=await snapshot(ids.host),b=await snapshot(ids.guest);assert.equal(a.status,'completed');assert.deepEqual(a.result,b.result);assert.equal(a.result.winner_id,null);assert.ok(a.result.scores.every(x=>x.score>0));for(const page of [host,guest])assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'screen overflow');
 });
 assert.ok(results.every(x=>x.status==='passed'));assert.deepEqual(browserErrors,[]);assert.deepEqual(externalRequests,[]);await host.screenshot({path:'artifacts/educational-online-result.png',fullPage:true});await writeFile(new URL('test-results/educational-online-ui.json',root),JSON.stringify({results,browserErrors,externalRequests,sqlBackend:true,authTransport:'simulated',liveSupabase:false,testedBuildSha256},null,2));
}finally{for(const c of contexts)await c.close();await browser.close();await backend.db.close();}
