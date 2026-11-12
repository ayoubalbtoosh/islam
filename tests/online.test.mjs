import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/online.js',import.meta.url),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const room=(overrides={})=>({id:'room-a',code:'ABCDEF1234',status:'active',host_id:'alice',guest_id:'bob',server_now:new Date().toISOString(),deadline:new Date(Date.now()+90000).toISOString(),question_count:5,players:[{id:'alice',name:'ألف',answered:0,score:null},{id:'bob',name:'باء',answered:0,score:null}],me:{id:'alice',answered:0,score:null},question:{id:'q1',prompt:'السؤال الأصلي',options:[{id:'a',text:'الإجابة الأولى'},{id:'b',text:'الإجابة الثانية'}]},...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
function runtime({mode='account',isAdmin=false,snapshot=room()}={}){
 const timers=new Map(),listeners=new Map(),windowListeners=new Map(),calls=[],identity={mode,isAdmin,user:mode==='account'?{id:'alice'}:null};
 let timerId=0,active=0,maxActive=0,html='',ctx;
 const transport={handler:async name=>name==='duel_recent'?[snapshot]:snapshot};
 const document={visibilityState:'visible',addEventListener(name,callback){listeners.set(name,callback);},querySelector(){return null;},getElementById(){return null;}};
 ctx=vm.createContext({URL,Date,Set,Array,Math,Number,JSON,Error,String,Promise,console,document,location:{href:'https://example.test/islam/?room=ABCDEF1234'},navigator:{clipboard:{writeText:async()=>{}}},
  S:{page:'online'},authState:()=>identity,
  e:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),nf:value=>String(value||0),ico:()=>'',heroTitle:(title,subtitle)=>`<h1>${title}</h1><p>${subtitle}</p>`,formatAccountDate:String,
  setTimeout(callback,delay){timers.set(++timerId,{callback,delay});return timerId;},clearTimeout(id){timers.delete(id);},
  window:{addEventListener(name,callback){windowListeners.set(name,callback);}},render(){html=ctx.api.view();},
  Auth:{async duelRpc(name,args){calls.push({name,args:copy(args)});active++;maxActive=Math.max(maxActive,active);try{return await transport.handler(name,args);}finally{active--;}}}
 });
 vm.runInContext(source+'\nglobalThis.api=Online;',ctx);
 return{api:ctx.api,ctx,identity,document,timers,listeners,windowListeners,calls,transport,get html(){return html;},get maxActive(){return maxActive;},async poll(){const [id,timer]=timers.entries().next().value||[];assert.ok(timer,'A refresh must be scheduled');timers.delete(id);await timer.callback();},action(action,other={}){return ctx.api.action({dataset:{action,...other}});}};
}
test('guest can see account requirement without reading rooms or scheduling polling',async()=>{
 const r=runtime({mode:'guest'});await r.api.open();assert.match(r.api.view(),/سجّل الدخول للمواجهة/);assert.equal(r.calls.length,0);assert.equal(r.timers.size,0);assert.equal(r.api.adminView(),'');
});
test('polling pauses while hidden, resumes on visibility, and stops for a terminal result',async()=>{
 const r=runtime();await r.api.open();assert.deepEqual(r.calls.map(call=>call.name),['duel_recent','duel_state']);assert.equal(r.timers.size,1);
 r.document.visibilityState='hidden';r.listeners.get('visibilitychange')();assert.equal(r.timers.size,0);
 r.document.visibilityState='visible';r.listeners.get('visibilitychange')();await settle();assert.equal(r.calls.at(-1).name,'duel_state');assert.equal(r.timers.size,1);
 r.transport.handler=async()=>room({status:'completed',question:null,result:{winner_id:null,reason:'answered'},players:[{id:'alice',name:'ألف',answered:5,score:3},{id:'bob',name:'باء',answered:5,score:3}]});
 await r.poll();assert.equal(r.timers.size,0);assert.match(r.html,/تعادل بين اللاعبين/);assert.match(r.html,/حُفظت النتيجة/);
});
test('an answer waits for an in-flight poll and never overlaps RPCs',async()=>{
 const r=runtime();await r.api.open();const gate=deferred();r.transport.handler=async name=>name==='duel_state'?gate.promise:room({question:{id:'q2',prompt:'السؤال التالي',options:[]},me:{id:'alice',answered:1}});
 const poll=r.poll();await settle();const answer=r.action('online-answer',{questionId:'q1',option:'a'});await settle();
 assert.equal(r.calls.filter(call=>call.name==='duel_answer').length,0);gate.resolve(room());await Promise.all([poll,answer]);
 assert.equal(r.maxActive,1);assert.equal(r.calls.at(-1).name,'duel_answer');assert.deepEqual(r.calls.at(-1).args,{p_room_id:'room-a',p_question_id:'q1',p_answer:'a'});assert.match(r.html,/السؤال التالي/);
});
test('a stopped or changed identity cannot apply a late room response',async()=>{
 for(const stop of [true,false]){
  const r=runtime(),gate=deferred();r.transport.handler=async()=>gate.promise;
  const opening=r.api.open();await settle();if(stop)r.api.stop();else r.identity.user={id:'bob'};
  gate.resolve([room({question:{id:'private',prompt:'PRIVATE_OLD_ACCOUNT',options:[]}})]);await opening;
  assert.doesNotMatch(r.api.view(),/PRIVATE_OLD_ACCOUNT/);assert.equal(r.calls.length,1);assert.equal(r.timers.size,0);
 }
});
test('failed polling backs off, prevents blind answer resubmission, then recovers',async()=>{
 const r=runtime();await r.api.open();r.transport.handler=async()=>{throw Error('network unavailable');};
 await r.poll();assert.match(r.html,/network unavailable/);assert.match(r.html,/data-action="online-answer"[^>]* disabled/);assert.equal([...r.timers.values()][0].delay,6000);
 await r.poll();assert.equal([...r.timers.values()][0].delay,12000);
 r.transport.handler=async()=>room();await r.poll();assert.doesNotMatch(r.html,/network unavailable/);assert.equal([...r.timers.values()][0].delay,3000);
});
test('private question output is escaped and polling does not replace unchanged question controls',async()=>{
 const unsafe=room({question:{id:'q1',prompt:'<img src=x onerror=alert(1)>',options:[{id:'a',text:'<script>evil</script>'}]}}),r=runtime({snapshot:unsafe});await r.api.open();
 assert.match(r.html,/&lt;img/);assert.doesNotMatch(r.html,/<img/);assert.match(r.html,/&lt;script&gt;/);
 const before=r.html;r.transport.handler=async()=>({...unsafe,server_now:new Date(Date.now()+3000).toISOString()});await r.poll();assert.equal(r.html,before,'Unchanged question is retained, preserving focus and keyboard input');
});
