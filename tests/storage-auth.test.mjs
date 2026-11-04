import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/storage.js',import.meta.url),'utf8');
const USER_A='11111111-1111-4111-8111-111111111111';
const USER_B='22222222-2222-4222-8222-222222222222';
const LEGACY='islamic-challenge-offline-v1';
const accountKey=id=>`islamic-challenge-account-${id}-offline-v1`;
const plain=value=>JSON.parse(JSON.stringify(value));
function runtime({saved={},protocol='file:',idbOpen=null}={}){
 const storage=new Map(Object.entries(saved).map(([key,value])=>[key,JSON.stringify(value)]));const calls=[];
 const ctx=vm.createContext({setTimeout,clearTimeout,console,location:{protocol},localStorage:{
  getItem:key=>{calls.push(['get',key]);return storage.get(key)??null;},
  setItem:(key,value)=>{calls.push(['set',key]);storage.set(key,value);},
  removeItem:key=>{calls.push(['remove',key]);storage.delete(key);}
 },...(idbOpen?{indexedDB:{open:name=>{calls.push(['idb-open',name]);return idbOpen(name);}}}:{})});
 vm.runInContext(source+'\nglobalThis.api=db;',ctx);return {db:ctx.api,validateBackup:ctx.validateBackup,storage,calls};
}
test('explicit guest never reads or writes any persistent storage, including settings and bags',async()=>{
 const {db,storage,calls}=runtime({protocol:'https:',saved:{[LEGACY]:{profile:{xp:900}},[accountKey(USER_A)]:{profile:{xp:400}}},idbOpen:()=>{throw Error('guest must not reach IndexedDB');}});
 const before=plain([...storage]);await db.useGuest();
 assert.equal(db.status().guest,true);assert.equal(db.status().scope,'guest');assert.equal(db.status().persistent,false);
 assert.deepEqual(plain(await db.all()),{});
 await db.batch({profile:{xp:10},settings:{theme:'light'},active:{id:'guest'},'bag:test':{remaining:[],lastSession:[]},results:[{id:'guest-result'}]});
 await db.remove('active');await db.replaceAll({achievements:{first:new Date().toISOString()}});await db.clear();await db.flush();
 assert.deepEqual(calls,[]);assert.deepEqual(plain([...storage]),before);
});
test('each guest selection starts fresh and guest progress never migrates into an account',async()=>{
 const {db}=runtime();await db.useGuest();await db.put('profile',{name:'Guest',xp:700});
 await db.useGuest();assert.equal(await db.get('profile'),null);
 await db.put('profile',{name:'Another guest',xp:800});await db.useAccount(USER_A);
 assert.equal(await db.get('profile'),null);assert.equal(db.status().userId,USER_A);
});
test('accounts use separate namespaces and legacy records stay untouched',async()=>{
 const {db,storage,calls}=runtime({saved:{[LEGACY]:{profile:{name:'Legacy',xp:900}},[accountKey(USER_A)]:{profile:{name:'A',xp:30}}}});
 const legacy=storage.get(LEGACY);await db.useAccount(USER_A);
 assert.equal((await db.get('profile')).name,'A');await db.put('profile',{name:'A',xp:50});
 await db.useAccount(USER_B);assert.equal(await db.get('profile'),null);await db.put('profile',{name:'B',xp:10});
 await db.useAccount(USER_A);assert.equal((await db.get('profile')).xp,50);
 assert.equal(JSON.parse(storage.get(accountKey(USER_B))).profile.xp,10);assert.equal(storage.get(LEGACY),legacy);
 assert.ok(calls.every(([,key])=>key!==LEGACY));assert.equal(db.status().scope,'account:'+USER_A);
});
test('account UUID validation rejects unsafe selectors before touching storage',async()=>{
 const {db,calls}=runtime();await db.useGuest();
 for(const id of ['',null,7,'../legacy','a'.repeat(36),USER_A+'/evil','x'+USER_A])await assert.rejects(db.useAccount(id),{name:'TypeError'});
 assert.deepEqual(calls,[]);assert.equal(db.status().guest,true);
 await db.useAccount(USER_A.toUpperCase());assert.equal(db.status().userId,USER_A);
});
test('account IndexedDB names are isolated; guest does not attempt even a backend probe',async()=>{
 const {db,calls}=runtime({protocol:'https:',idbOpen:()=>{throw Error('force supported local fallback');}});
 await db.useGuest();assert.deepEqual(calls,[]);await db.useAccount(USER_A);await db.useAccount(USER_B);
 assert.deepEqual(calls.filter(([kind])=>kind==='idb-open').map(([,name])=>name),[`islamic-challenge-account-${USER_A}`,`islamic-challenge-account-${USER_B}`]);
});
test('switch cancels queued old writes and explicit old tokens cannot leak across accounts',async()=>{
 const {db,storage}=runtime();await db.useAccount(USER_A);await db.put('profile',{xp:1});const oldToken=db.scopeToken();
 const pending=db.put('profile',{xp:999});const switching=db.useAccount(USER_B);
 await assert.rejects(pending,{name:'StaleStorageScopeError'});await switching;
 await assert.rejects(db.put('profile',{xp:888},{scopeToken:oldToken}),{name:'StaleStorageScopeError'});
 await assert.rejects(db.all({scopeToken:oldToken}),{name:'StaleStorageScopeError'});
 await db.put('profile',{xp:2});await db.flush();assert.equal((await db.get('profile')).xp,2);
 assert.equal(JSON.parse(storage.get(accountKey(USER_A))).profile.xp,1);
});
test('subscribers receive account snapshots only; hydration is silent and unsubscribe works',async()=>{
 const {db}=runtime();const events=[];const unsubscribe=db.subscribe(event=>events.push(event));
 await db.useGuest();await db.put('profile',{xp:500});assert.equal(events.length,0);
 await db.useAccount(USER_A);assert.equal(events.length,0);
 await db.replaceAll({profile:{xp:20}},{silent:true});assert.equal(events.length,0);
 await db.put('profile',{xp:30});await db.put('settings',{theme:'light'});
 assert.equal(events.length,2);assert.equal(events[0].userId,USER_A);assert.equal(events[0].scope,'account:'+USER_A);
 assert.deepEqual(plain(events[0].records),{profile:{xp:30}});assert.equal(events[0].scopeToken,db.scopeToken());
 assert.equal(events[1].records.settings.theme,'light');unsubscribe();await db.put('profile',{xp:40});assert.equal(events.length,2);
});
test('legacy default behavior is retained until an explicit identity selection',async()=>{
 const {db}=runtime({saved:{[LEGACY]:{profile:{xp:70}}}});assert.equal((await db.get('profile')).xp,70);
 assert.equal(db.status().scope,'legacy');await db.useGuest();assert.equal(await db.get('profile'),null);
});
test('cloud metadata accepts only nonnegative integer revision and a SHA-256 hash',()=>{
 const {validateBackup}=runtime();const envelope=metadata=>({app:'tahadi-islamic',version:1,records:{'cloud-sync':metadata}});
 const valid={revision:3,snapshotHash:'a'.repeat(64),lastSyncedAt:new Date().toISOString()};
 assert.deepEqual(plain(validateBackup(envelope(valid))['cloud-sync']),valid);
 for(const metadata of [{...valid,revision:-1},{...valid,revision:1.5},{...valid,revision:'3'},{...valid,snapshotHash:'not-a-hash'},{...valid,lastSyncedAt:'yesterday'}])assert.throws(()=>validateBackup(envelope(metadata)));
});
test('silent metadata writes never schedule another cloud save and metadata remains account-isolated',async()=>{
 const {db}=runtime();const events=[];db.subscribe(event=>events.push(event));await db.useAccount(USER_A);
 const meta={revision:1,snapshotHash:'b'.repeat(64)};await db.put('cloud-sync',meta,{silent:true});
 await db.batch({'cloud-sync':{...meta,revision:2}},[],{silent:true});assert.equal(events.length,0);
 await db.put('profile',{xp:10});assert.equal(events.length,1);assert.equal(events[0].records['cloud-sync'].revision,2);
 await db.useAccount(USER_B);assert.equal(await db.get('cloud-sync'),null);await db.useAccount(USER_A);assert.equal((await db.get('cloud-sync')).revision,2);
});
test('switch waits for an in-flight IndexedDB transaction and closes only the old account connection',async()=>{
 const backends=new Map(),closed=[];let releaseWrite,writeStarted;
 const started=new Promise(resolve=>{writeStarted=resolve;});let holdWrites=false;
 const factory=name=>{
  const request={};setTimeout(()=>{
   if(!backends.has(name))backends.set(name,{});
   request.result={close:()=>closed.push(name),transaction:(_store,kind)=>{
    let staged=plain(backends.get(name)),aborted=false;const tx={error:null,abort:()=>{aborted=true;tx.onabort?.();},objectStore:()=>({
     getAllKeys:()=>({result:Object.keys(staged)}),getAll:()=>({result:Object.values(staged)}),
     clear:()=>{staged={};},put:(value,key)=>{staged[key]=plain(value);},delete:key=>{delete staged[key];}
    })};
    const finish=()=>{if(aborted)return;if(kind==='readwrite')backends.set(name,staged);tx.oncomplete?.();};
    if(kind==='readwrite'&&holdWrites){releaseWrite=()=>setTimeout(finish,0);writeStarted();}else setTimeout(finish,0);
    return tx;
   }};request.onsuccess?.();
  },0);return request;
 };
 const {db}=runtime({protocol:'https:',idbOpen:factory});const events=[];db.subscribe(change=>events.push(change));
 await db.useAccount(USER_A);assert.equal(db.status().mode,'indexeddb');holdWrites=true;
 const writing=db.put('profile',{xp:9});await started;const switching=db.useAccount(USER_B);
 assert.deepEqual(closed,[]);holdWrites=false;releaseWrite();await writing;await switching;
 assert.equal(backends.get(`islamic-challenge-account-${USER_A}`).profile.xp,9);
 assert.deepEqual(plain(await db.all()),{});assert.deepEqual(closed,[`islamic-challenge-account-${USER_A}`]);
 assert.equal(events.length,0,'a completed old-scope write cannot schedule a new-scope cloud save');
});
