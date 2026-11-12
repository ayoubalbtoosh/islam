import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/storage.js',import.meta.url),'utf8');
const bank=JSON.parse(fs.readFileSync(new URL('../data/questions.json',import.meta.url),'utf8')).questions;
const byId=new Map(bank.map(q=>[q.id,q]));
function runtime({saved,deny=false,writeFail=false}={}){
 const storage=new Map(saved?[['islamic-challenge-offline-v1',JSON.stringify(saved)]]:[]);
 const ctx=vm.createContext({setTimeout,clearTimeout,console,location:{protocol:'file:'},localStorage:{
  getItem:key=>{if(deny)throw Error('denied');return storage.get(key)??null;},
  setItem:(key,value)=>{if(deny||writeFail&&key==='islamic-challenge-offline-v1')throw Error('quota');storage.set(key,value);},
  removeItem:key=>storage.delete(key)
 }});
 vm.runInContext(source+'\nglobalThis.api={db,validateBackup};',ctx);
 return {...ctx.api,storage};
}
const plain=value=>JSON.parse(JSON.stringify(value));
const backup=records=>({app:'tahadi-islamic',version:1,records});
test('legacy localStorage records survive initialization and writes are isolated snapshots',async()=>{
 const {db}=runtime({saved:{profile:{name:'طالب',xp:100},results:[]}});
 assert.equal((await db.get('profile')).xp,100);
 const data={name:'طالبة',xp:200};const write=db.put('profile',data);data.xp=999;await write;
 const read=await db.get('profile');read.xp=888;assert.equal((await db.get('profile')).xp,200);
 assert.equal(db.status().mode,'localStorage');
});
test('queued batch persists related result/profile changes and deletes active together',async()=>{
 const {db,storage}=runtime();
 await db.put('active',{id:'session'});
 await Promise.all([db.batch({results:[{id:'session'}],profile:{xp:10}},['active']),db.put('settings',{theme:'light'})]);
 assert.deepEqual(plain(await db.all()),{results:[{id:'session'}],profile:{xp:10},settings:{theme:'light'}});
 assert.equal(JSON.parse(storage.get('islamic-challenge-offline-v1')).active,undefined);
});
test('denied storage stays usable in memory and explicitly reports non-persistence',async()=>{
 const {db}=runtime({deny:true});await db.put('profile',{xp:10});assert.equal((await db.get('profile')).xp,10);
 assert.equal(db.status().persistent,false);assert.match(db.status().warning,/مؤقت/);
});
test('quota failure retains this tab progress and announces fallback instead of claiming persistence',async()=>{
 const {db}=runtime({writeFail:true});await db.put('results',[1]);assert.deepEqual(plain(await db.get('results')),[1]);
 assert.equal(db.status().mode,'memory');assert.match(db.status().warning,/امتلأ/);
});
test('backup validates before replacement; malformed/prototype/unknown keys are rejected',async()=>{
 const {db,validateBackup}=runtime({saved:{profile:{name:'طالب',xp:10}}});
 for(const records of [{profile:{name:'طالب',xp:-1}},{results:{}},{evil:{}},JSON.parse('{"__proto__":{}}'),{settings:{theme:'hacked'}},{settings:{backgroundColor:'red; background: url(test)'}},{settings:{backgroundColor:'#fff'}},{settings:{backgroundColor:42}},{settings:{sidebarColor:'red; background: url(test)'}},{settings:{sidebarColor:42}},{active:{questions:[]}}]){
  assert.throws(()=>validateBackup(backup(records),byId));
 }
 assert.equal((await db.get('profile')).xp,10);
});
test('valid legacy backup roundtrips without clearing separate data on a failed validation',async()=>{
 const {db,validateBackup}=runtime();const rows={profile:{name:'طالب',xp:40,coins:8,level:1},results:[],mistakes:{},settings:{theme:'dark',sounds:false,timers:{easy:'none'}}};
 await db.replaceAll(validateBackup(backup(rows),byId));assert.deepEqual(plain(await db.all()),rows);
});
test('active backups reject foreign questions and replace question text/answers with bundled content',()=>{
 const {validateBackup}=runtime();const question=JSON.parse(JSON.stringify(bank[0]));question.prompt='tampered';
 const active={id:'session-1',mode:'training',phase:'question',questions:[question],answers:[null],current:0,startedAt:100,questionStartedAt:100,players:['أ','ب'],draft:null};
 const restored=validateBackup(backup({active}),byId);assert.equal(restored.active.questions[0].prompt,bank[0].prompt);
 active.questions[0].id='u01_l01_q999';assert.throws(()=>validateBackup(backup({active}),byId));
});
test('duplicate results and malformed response IDs are rejected',()=>{
 const {validateBackup}=runtime();const result={id:'s1',mode:'training',at:'2026-11-04T10:00:00Z',items:[]};
 assert.throws(()=>validateBackup(backup({results:[result,result]}),byId));
 const q=bank.find(q=>q.type==='multiple_choice');result.items=[{id:q.id,correct:true,points:10,response:'invalid'}];
 assert.throws(()=>validateBackup(backup({results:[result]}),byId));
});
test('duel imports require both players, finite separate scores and an explicit valid winner',()=>{
 const {validateBackup}=runtime();const duel={id:'duel1',mode:'duel',at:new Date().toISOString(),items:[],players:['أ','ب'],duelScores:[10,0],winner:0};
 assert.equal(validateBackup(backup({results:[duel]}),byId).results[0].winner,0);
 for(const patch of [{players:undefined},{players:['أ']},{duelScores:undefined},{duelScores:[10,-1]},{duelScores:['10',0]},{duelScores:[10]},{winner:undefined},{winner:2}])assert.throws(()=>validateBackup(backup({results:[{...duel,...patch}]}),byId));
});
test('result import rejects invalid rewards, duplicate question items and invalid optional scopes',()=>{
 const {validateBackup}=runtime();const q=bank[0];const item={id:q.id,correct:false,points:0,response:null};
 const result={id:'s2',mode:'training',at:new Date().toISOString(),items:[item]};
 for(const patch of [{reward:{xp:-1,coins:0}},{reward:{xp:1,coins:'2'}},{items:[item,item]},{difficulty:'expert'},{scope:'u99'},{lessonId:'u01_l99'},{lessonIds:[{}]}])assert.throws(()=>validateBackup(backup({results:[{...result,...patch}]}),byId));
 const legacy=validateBackup(backup({results:[result]}),byId);assert.equal(legacy.results.length,1);
});
test('achievement imports require a map of valid dated entries',()=>{
 const {validateBackup}=runtime();const valid={first:new Date().toISOString()};
 assert.deepEqual(plain(validateBackup(backup({achievements:valid}),byId).achievements),valid);
 for(const achievements of [[],{first:{}},{first:'yesterday'},{first:42}])assert.throws(()=>validateBackup(backup({achievements}),byId));
});
test('active session imports accept real current epoch values and validate optional runtime settings',()=>{
 const {validateBackup}=runtime();const now=Date.now();
 const active={id:'s-current',mode:'training',phase:'question',questions:[bank[0]],answers:[null],current:0,startedAt:now,questionStartedAt:now,players:['أ','ب'],draft:null,difficulty:'mixed',scope:'all',timerSeconds:'none',hearts:3,pausedAt:now,questionDeadline:now+60000,deadline:now+2700000};
 assert.equal(validateBackup(backup({active}),byId).active.startedAt,now);
 for(const patch of [{difficulty:'expert'},{scope:'u99'},{timerSeconds:'banana'},{timerSeconds:-5},{hearts:4},{hearts:-1},{hearts:1.5},{pausedAt:'now'},{pausedAt:-1},{lessonId:'u01_l99'}])assert.throws(()=>validateBackup(backup({active:{...active,...patch}}),byId));
});
test('visited lesson metadata roundtrips but cannot inject invalid last lesson or timestamps',()=>{
 const {validateBackup}=runtime(),at=new Date().toISOString(),profile={name:'طالب',xp:0,lastLessonId:'u01_l01',visitedLessons:{u01_l01:at}};
 assert.deepEqual(plain(validateBackup(backup({profile}),byId).profile),profile);
 for(const patch of [{lastLessonId:'u01_l99'},{lastLessonId:{}},{visitedLessons:[]},{visitedLessons:{u01_l01:'bad'}},{visitedLessons:{u99_l01:at}}])assert.throws(()=>validateBackup(backup({profile:{...profile,...patch}}),byId));
});
