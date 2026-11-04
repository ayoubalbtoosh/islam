import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const bank=JSON.parse(fs.readFileSync(new URL('../data/questions.json',import.meta.url))).questions;
const core=fs.readFileSync(new URL('../src/core.js',import.meta.url),'utf8');
const controller=fs.readFileSync(new URL('../src/controller.js',import.meta.url),'utf8').replace(/(?:initialize|startApplication)\(\);\s*$/,'');
function context(){
 const rows=new Map(),elements=new Map();let now=1000000;
 const ctx=vm.createContext({console,structuredClone,Math,Date:class extends Date {static now(){return now;}},setTimeout,clearTimeout,setInterval(){},globalThis:null,crypto:{randomUUID:()=>String(Math.random())}});
 ctx.globalThis=ctx;ctx.bank=structuredClone(bank);ctx.rows=rows;ctx.elements=elements;ctx.clock=value=>{now=value;};
 vm.runInContext(`
 const S={page:'home',valid:bank.filter(q=>q.review.source_checked),byId:new Map(bank.map(q=>[q.id,q])),settings:{timers:{},sounds:false},profile:{xp:0,coins:0,name:'طالب'},results:[],mistakes:{},session:null,selected:null,players:['أ','ب'],scope:'all',level:'easy',lessonId:'u01_l01',roundTimer:'none',unitId:'u01',busy:false};
 const TIME_OPTIONS=[6,10,15,20,30,40,60];
 const document={getElementById:id=>elements.get(id)||null,addEventListener(){},querySelectorAll(){return[];}};
 const lifecycleHandlers={};const window={addEventListener(name,fn){lifecycleHandlers[name]=fn;},scrollTo(){}};
 const navigator={};const location={reload(){globalThis.reloaded=true;if(typeof globalThis.onReload==='function')globalThis.onReload();}};
 const db={clear:async()=>rows.clear(),get:async(k,d)=>structuredClone(rows.get(k)??d),put:async(k,v)=>rows.set(k,structuredClone(v)),remove:async k=>rows.delete(k),replaceAll:async v=>{rows.clear();for(const [k,x]of Object.entries(v))rows.set(k,structuredClone(x));},batch:async(v,del=[])=>{for(const [k,x]of Object.entries(v))rows.set(k,structuredClone(x));for(const k of del)rows.delete(k);}};
 const app={innerHTML:''};const render=()=>{globalThis.renderCalls=(globalThis.renderCalls||0)+1;},notify=()=>{},playSound=()=>{},saveState=async()=>{},levelFromXp=x=>Math.floor(Math.sqrt(x/180))+1,e=String,nf=String,fmt=String;
 function go(p){S.page=p;S.modal=null;S.selected=null;}function setup(){}function unit(){}function lesson(){}
 function responseFor(s){return S.selected??s.draft??(s.mode==='exam'?s.answers[s.current]?.response??null:null);}
 `,ctx);
 vm.runInContext(core+'\n'+fs.readFileSync(new URL('../src/storage.js',import.meta.url),'utf8').slice(fs.readFileSync(new URL('../src/storage.js',import.meta.url),'utf8').indexOf('function validateBackup'))+'\n'+controller,ctx);
 return {ctx,run:s=>vm.runInContext(s,ctx),advance:n=>{now+=n;}};
}
test('all original records: schema accepts approved bank; native wrong shapes fail safely',()=>{
 const {run}=context();assert.equal(run('bank.filter(validQuestion).length'),2340);
 assert.equal(run(`isAnswered(bank.find(q=>q.type==='multiple_choice'),'foreign')`),false);
 assert.equal(run(`isAnswered(bank.find(q=>q.type==='ordering'), ['a','a'])`),false);
 assert.equal(run(`validQuestion({...bank[0],payload:{options:[null,null]}})`),false);
});
test('each native question answer survives presentation shuffle',()=>{
 const {run}=context();assert.equal(run(`bank.every(q=>{q=presentQuestion(q,seededRandom(q.id));const a=q.answer;const r=q.type==='true_false'?a.value:q.type==='matching'?Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id])):q.type==='ordering'?a.ordered_ids:q.type==='multi_select'?a.option_ids:a.option_id;return checkAnswer(q,r);})`),true);
});
test('six repeated attempts use a whole bag without duplicate and avoid previous round',()=>{
 const {run}=context();assert.equal(run(`(()=>{const pool=bank.filter(q=>q.lesson_id==='u01_l01'&&q.difficulty==='easy');let state=null,previous=[];for(let n=0;n<6;n++){const r=drawBag(pool,state,10,seededRandom('round'+n));const ids=r.questions.map(q=>q.id);if(new Set(ids).size!==10||ids.some(x=>previous.includes(x)))return false;previous=ids;state=r.state;}return true;})()`),true);
});
test('score timeout is unattempted and no wrong-answer points',()=>{
 const {run}=context();assert.equal(run(`scoreAnswer(bank[0],false,0,6,20)`),0);
 const stats=run(`sessionStats({questions:[{},{}],answers:[{response:null,timedOut:true,correct:false,elapsed:6,points:0},{response:'a',correct:true,elapsed:2,points:10}]})`);
 assert.equal(stats.unanswered,1);assert.equal(stats.wrong,0);assert.equal(stats.accuracy,50);
});
test('exam respects scope/easy and never substitutes hard',async()=>{
 const {run}=context();assert.equal(run(`questionPool('exam',null,'easy','u02').every(q=>q.unit_id==='u02'&&q.difficulty==='easy')`),true);
 await run(`createSession('exam',null,'easy','u02',20,S.players,'none')`);
 assert.equal(run('S.session.questions.length'),20);assert.equal(run('timerLimit(S.session)'),2700);assert.equal(run('S.session.deadline-S.session.startedAt'),2700000);
});
test('duel creates 20 questions for 10 each with equal pair difficulty/topic and no duplicate',async()=>{
 const {run}=context();await run(`createSession('duel','u01_l01','easy','all',10,['سارة','عمر'],'20')`);
 assert.equal(run('S.session.questions.length'),20);assert.equal(run('S.session.phase'),'ready');
 assert.equal(run(`S.session.questions.every((q,i,a)=>i%2===0||(q.difficulty===a[i-1].difficulty&&q.topic===a[i-1].topic))`),true);
 assert.equal(run('new Set(S.session.questions.map(q=>q.id)).size'),20);assert.equal(run('timeRemaining(S.session)'),20);
});
test('duel handoff waits without decrement and alternates exactly',async()=>{
 const {run,advance}=context();await run(`createSession('duel','u01_l01','easy','all',2,['أ','ب'],'20')`);
 advance(60000);assert.equal(run('timeRemaining(S.session)'),20);
 run(`onAction({dataset:{action:'start-duel-turn'}})`);await new Promise(r=>setTimeout(r,0));
 assert.equal(run('S.session.phase'),'question');
 await run(`autoAnswer(S.session.questions[0].type==='true_false'?S.session.questions[0].answer.value:S.session.questions[0].answer.option_id)`);
 // Use a complete native answer for the random first question.
 if(run('S.session.current')===0)await run(`(()=>{const q=S.session.questions[0],a=q.answer;return autoAnswer(q.type==='matching'?Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id])):q.type==='ordering'?a.ordered_ids:q.type==='multi_select'?a.option_ids:a.option_id);})()`);
 assert.equal(run('S.session.current'),1);assert.equal(run('S.session.phase'),'ready');advance(60000);assert.equal(run('timeRemaining(S.session)'),20);
});
test('expired answer cannot score; single submission auto-advances once',async()=>{
 const {run,advance}=context();await run(`createSession('training','u01_l01','easy','all',3,S.players,'6')`);
 advance(6001);await run(`autoAnswer('any')`);assert.equal(run('S.session.current'),1);assert.equal(run('S.session.answers[0].timedOut'),true);assert.equal(run('S.session.answers[0].points'),0);
});
test('last exam answer retained, revision allowed, explicit finish is idempotent',async()=>{
 const {run}=context();await run(`createSession('exam',null,'easy','u01',1,S.players,'none')`);
 await run(`(()=>{const q=S.session.questions[0],a=q.answer;return autoAnswer(q.type==='true_false'?a.value:q.type==='matching'?Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id])):q.type==='ordering'?a.ordered_ids:q.type==='multi_select'?a.option_ids:a.option_id);})()`);
 assert.equal(run('S.session.current'),0);assert.equal(run('S.results.length'),0);
 await run('Promise.all([submitExam(),submitExam()])');assert.equal(run('S.results.length'),1);assert.equal(run('S.session'),null);assert.equal(run('S.results[0].correct'),1);
 await run('finishSession()');assert.equal(run('S.results.length'),1);
});
test('exam expires during modal and away from game, not after 45 min per question',async()=>{
 const {run,advance}=context();await run(`createSession('exam',null,'medium','u03',20,S.players,'none')`);
 run(`S.modal='confirm';S.page='home'`);advance(2700001);await run('clockTick()');assert.equal(run('S.results.length'),1);assert.equal(run('S.results[0].unanswered'),20);
});
test('ordinary paused round preserves remaining time; partial draft saved',async()=>{
 const {run,advance}=context();await run(`createSession('training','u01_l01','easy','all',5,S.players,'20')`);
 advance(3000);run(`S.selected=['one'];pauseSession()`);await new Promise(r=>setTimeout(r,0));advance(100000);run('resumeSessionClock()');
 assert.equal(run('timeRemaining(S.session)'),17);assert.equal(run('S.session.draft[0]'),'one');
});
test('endless extension exhausts finite pool without repeat',async()=>{
 const {run}=context();await run(`createSession('survival','u01_l01','easy','all',10,S.players,'none')`);
 await run(`extendEndless(S.session);`);await run(`extendEndless(S.session);`);assert.equal(run('new Set(S.session.questions.map(q=>q.id)).size'),30);assert.equal(await run('extendEndless(S.session)'),false);
});
test('two concurrent clicks record one answer and transition once',async()=>{
 const {run}=context();await run(`createSession('training','u01_l01','easy','all',10,S.players,'none')`);
 await run(`(()=>{const q=S.session.questions[0],a=q.answer,r=q.type==='true_false'?a.value:q.type==='matching'?Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id])):q.type==='ordering'?a.ordered_ids:q.type==='multi_select'?a.option_ids:a.option_id;return Promise.all([autoAnswer(r),autoAnswer(r)]);})()`);
 assert.equal(run('S.session.current'),1);assert.equal(run('S.session.answers.filter(Boolean).length'),1);
});
test('duel streak looks only at the current competitor history',()=>{
 const {run}=context();assert.equal(run(`playerStreak({mode:'duel',answers:[{correct:true},{correct:false},{correct:true},{correct:false}]},4)`),3);
 assert.equal(run(`playerStreak({mode:'duel',answers:[{correct:true},{correct:false},{correct:true},{correct:false}]},5)`),1);
});
test('failed atomic result write preserves active round and rolls back XP',async()=>{
 const {run}=context();await run(`createSession('training','u01_l01','easy','all',1,S.players,'none')`);
 run(`S.session.answers[0]={response:'a',correct:true,points:10,elapsed:1};db.batch=async()=>{throw Error('quota');}`);
 await assert.rejects(run('finishSession()'),/quota/);assert.equal(run('S.results.length'),0);assert.equal(run('S.profile.xp'),0);assert.equal(run('S.session.phase'),'locked');
});
test('duel replay prioritizes different question set when pool is sufficient',async()=>{
 const {run}=context();await run(`createSession('duel','u01_l01','easy','all',5,S.players,'none')`);
 const first=run('S.session.questions.map(q=>q.id)');run('S.session=null');await run(`createSession('duel','u01_l01','easy','all',5,S.players,'none')`);
 assert.equal(run(`S.session.questions.some(q=>${JSON.stringify(first)}.includes(q.id))`),false);
});
test('new challenge refuses to replace an active saved round',async()=>{
 const {run}=context();await run(`createSession('training','u01_l01','easy','all',10,S.players,'none')`);const id=run('S.session.id');
 await run(`createSession('duel','u02_l01','hard','all',2,S.players,'20')`);assert.equal(run('S.session.id'),id);assert.equal(run('S.session.mode'),'training');
});
test('valid backup import waits for confirmation and cancellation preserves data',async()=>{
 const {run}=context();run(`rows.set('profile',{name:'قديم',xp:10})`);
 await run(`importData({size:100,text:async()=>JSON.stringify({app:'tahadi-islamic',version:1,records:{profile:{name:'جديد',xp:20}}})})`);
 assert.equal(run(`rows.get('profile').name`),'قديم');assert.equal(run('S.pendingImport.profile.name'),'جديد');
 await run(`onAction({dataset:{action:'close-modal'}})`);assert.equal(run('S.pendingImport'),null);assert.equal(run(`rows.get('profile').name`),'قديم');
});
test('confirmed import replaces in one operation then reloads without stale active writes',async()=>{
 const {run}=context();await run(`importData({size:100,text:async()=>JSON.stringify({app:'tahadi-islamic',version:1,records:{profile:{name:'جديد',xp:20}}})})`);
 await run(`onAction({dataset:{action:'confirm-import'}})`);assert.equal(run(`rows.get('profile').name`),'جديد');assert.equal(run('globalThis.reloaded'),true);assert.equal(run('S.session'),null);
});

test('mistake review honors selected unit and difficulty',()=>{
 const {run}=context();run(`S.mistakes={u01_l01_q001:{count:1},u02_l01_q001:{count:1},u02_l01_q031:{count:1}}`);
 assert.equal(run(`questionPool('mistakes',null,'easy','u02').length`),1);
 assert.equal(run(`questionPool('mistakes',null,'easy','u02')[0].unit_id`),'u02');
 assert.equal(run(`questionPool('mistakes',null,'easy','u02')[0].difficulty`),'easy');
});

test('reset drains queued active saves and pagehide cannot recreate cleared progress',async()=>{
 const {run}=context();await run(`createSession('training','u01_l01','easy','all',10,S.players,'none')`);
 run(`S.selected=['partial'];captureDraft();saveSession();globalThis.onReload=()=>captureDraft();`);
 await run(`onAction({dataset:{action:'reset-all'}})`);await run('sessionWrite');
 assert.equal(run('rows.size'),0);assert.equal(run('S.session'),null);assert.equal(run('S.selected'),null);assert.equal(run('activeBagCache.size'),0);assert.equal(run('globalThis.reloaded'),true);
 await run('saveSession()');await run('captureDraft()');assert.equal(run('rows.size'),0);
});
test('failed reset releases guards and preserves active round and cache',async()=>{
 const {run}=context();await run(`createSession('training','u01_l01','easy','all',10,S.players,'none')`);const id=run('S.session.id');
 run(`db.clear=async()=>{throw Error('clear denied');};`);
 await assert.rejects(run('resetData()'),/clear denied/);assert.equal(run('S.busy'),false);assert.equal(run('S.importing'),false);assert.equal(run('S.session.id'),id);assert.equal(run('activeBagCache.size>0'),true);assert.equal(run('rows.has("active")'),true);
});

test('single-writer boot refuses another tab without initializing or writing',async()=>{
 const {run}=context();run(`navigator.locks={request:async(name,options,callback)=>callback(null)};globalThis.boots=0;startApplication(async()=>{globalThis.boots++;});`);
 await run('writerLockTask');assert.equal(run('S.writerBlocked'),true);assert.equal(run('globalThis.boots'),0);assert.match(run('app.innerHTML'),/المنصة مفتوحة في تبويب آخر/);
 await run('saveSession()');assert.equal(run('rows.size'),0);
});
test('single-writer boot holds exclusive lock through app lifetime and releases on pagehide',async()=>{
 const {run}=context();run(`navigator.locks={request:async(name,options,callback)=>{globalThis.lockName=name;globalThis.lockOptions=options;await callback({name});globalThis.released=true;}};globalThis.boots=0;startApplication(async()=>{globalThis.boots++;});`);
 await new Promise(r=>setTimeout(r,0));assert.equal(run('globalThis.boots'),1);assert.equal(run('globalThis.released'),undefined);assert.equal(run('lockOptions.ifAvailable'),true);
 run(`lifecycleHandlers.pagehide()`);await run('writerLockTask');assert.equal(run('globalThis.released'),true);assert.equal(run('S.writerSuspended'),true);
 run(`lifecycleHandlers.pageshow({persisted:true})`);assert.equal(run('globalThis.reloaded'),true);
});
test('answer storage failure renders recoverable lock; next retries save before advancing',async()=>{
 const {run}=context();await run(`createSession('training','u01_l01','easy','all',2,S.players,'none')`);
 const before=run('globalThis.renderCalls||0');run(`globalThis.realPut=db.put;db.put=async()=>{throw Error('quota');};`);
 await assert.rejects(run(`(()=>{const q=S.session.questions[0],a=q.answer;return submitAnswer(q.type==='true_false'?a.value:q.type==='matching'?Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id])):q.type==='ordering'?a.ordered_ids:q.type==='multi_select'?a.option_ids:a.option_id);})()`),/quota/);
 assert.equal(run('S.session.phase'),'locked');assert.equal(run('S.session.current'),0);assert.ok(run('globalThis.renderCalls')>before);
 await assert.rejects(run('nextQuestion()'),/quota/);assert.equal(run('S.session.current'),0);
 run('db.put=globalThis.realPut');await run('nextQuestion()');assert.equal(run('S.session.current'),1);assert.equal(run('S.session.phase'),'question');
});
