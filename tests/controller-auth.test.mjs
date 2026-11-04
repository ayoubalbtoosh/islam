import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/controller.js',import.meta.url),'utf8').replace(/startApplication\(\);\s*$/,'');
const core=fs.readFileSync(new URL('../src/core.js',import.meta.url),'utf8');
function fixture({mode='account',auth=true,profile=null}={}){
 const trace=[],rows=new Map();if(profile)rows.set('profile',profile);
 const ctx=vm.createContext({console:{warn(){},error(){}},structuredClone,setTimeout:fn=>{fn();return 1;},clearTimeout(){},setInterval(){},trace,rows,mode});
 vm.runInContext(`
 const S={profile:{name:'',xp:0,coins:0},settings:{timers:{}},results:[],mistakes:{},session:null,selected:null,page:'home',busy:false,valid:[],byId:new Map(),players:['أ','ب']};
 const EMBEDDED_LESSONS=[],EMBEDDED_QUESTIONS={questions:[]},TIME_OPTIONS=[6,10,15,20,30,40,60];
 const app={innerHTML:''},navigator={},window={addEventListener(){},scrollTo(){}},document={addEventListener(){},getElementById(){return null;},querySelectorAll(){return[];},createElement(){trace.push('create-link');return {click(){trace.push('download');},remove(){}};},body:{append(){}}};
 const location={reload(){trace.push('reload');}};
 const notify=message=>trace.push('notice:'+message),render=()=>trace.push('render'),saveState=async()=>{},playSound=()=>{},go=page=>{S.page=page;},levelFromXp=()=>1,e=String,nf=String,fmt=String;
 let scope=1;
 const db={scopeToken:()=>scope,get:async(key,fallback)=>{trace.push('read:'+key);return structuredClone(rows.get(key)??fallback);},all:async()=>{trace.push('read:all');return Object.fromEntries(rows);},put:async(key,value,options)=>{if(options?.scopeToken!==undefined&&options.scopeToken!==scope)throw Error('stale scope');trace.push('put:'+key);rows.set(key,structuredClone(value));},remove:async(key,options)=>{if(options?.scopeToken!==undefined&&options.scopeToken!==scope)throw Error('stale scope');rows.delete(key);},clear:async()=>{trace.push('local-clear');rows.clear();},replaceAll:async(records,options)=>{if(options?.scopeToken!==undefined&&options.scopeToken!==scope)throw Error('stale scope');trace.push('replace');rows.clear();for(const [key,value]of Object.entries(records))rows.set(key,structuredClone(value));},batch:async()=>{}};
 function validateBackup(data){return structuredClone(data.records);}
 `,ctx);
 if(auth)vm.runInContext(`
 const identity={mode,configured:true,user:mode==='account'?{id:'test-account',email:'learner@example.test',name:'اسم الحساب'}:null};
 const Auth={current:()=>identity,init:async()=>{trace.push('auth-init');},prepareStorage:async()=>{trace.push('prepare:'+identity.mode);},resetProgress:async()=>{trace.push('account-reset');rows.clear();}};
 `,ctx);
 vm.runInContext(core+'\n'+source,ctx);
 return {run:code=>vm.runInContext(code,ctx),trace,rows};
}
test('authenticated bootstrap initializes auth and storage before any profile reads',async()=>{
 const {run,trace}=fixture();await run('bootstrapApplication(initialize)');
 assert.deepEqual(trace.slice(0,3),['auth-init','prepare:account','read:profile']);assert.equal(run('S.ready'),true);assert.equal(run('S.profile.name'),'اسم الحساب');
});
test('account name keeps explicit stored name and uses email when account name is blank',async()=>{
 const stored=fixture({profile:{name:'اسمي الدراسي',xp:30,coins:0}});await stored.run('bootstrapApplication(initialize)');assert.equal(stored.run('S.profile.name'),'اسمي الدراسي');
 const blank=fixture({profile:{name:'',xp:0,coins:0}});blank.run(`identity.user.name=''`);await blank.run('bootstrapApplication(initialize)');assert.equal(blank.run('S.profile.name'),'learner@example.test');
});
test('guest and signed-out bootstrap leave user name empty and do not fabricate an account',async()=>{
 for(const mode of ['guest','signed-out']){const {run,trace}=fixture({mode});await run('bootstrapApplication(initialize)');assert.equal(run('S.profile.name'),'');assert.ok(trace.includes('prepare:'+mode));}
});
test('Web Lock rejects second tab before auth init or storage preparation',async()=>{
 const {run,trace}=fixture();run(`navigator.locks={request:async(name,options,callback)=>callback(null)};startApplication(initialize);`);await run('writerLockTask');
 assert.equal(run('S.writerBlocked'),true);assert.equal(trace.length,0);assert.match(run('app.innerHTML'),/تبويب آخر/);
});
test('Web Lock boot still initializes auth in order and holds the writer lock',async()=>{
 const {run,trace}=fixture();run(`navigator.locks={request:async(name,options,callback)=>{await callback({name});trace.push('released');}};startApplication(initialize);`);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(trace.slice(0,3),['auth-init','prepare:account','read:profile']);assert.equal(trace.includes('released'),false);run('releaseWriterLock()');await run('writerLockTask');assert.equal(trace.at(-1),'released');
});
test('auth storage preparation failure renders retry and performs no profile reads',async()=>{
 const {run,trace}=fixture();run(`Auth.prepareStorage=async()=>{trace.push('prepare-failed');throw Error('storage unavailable');}`);
 assert.equal(await run('bootstrapApplication(initialize)'),false);assert.equal(trace.some(x=>x.startsWith('read:')),false);assert.match(run('app.innerHTML'),/تعذر بدء المنصة/);assert.match(run('app.innerHTML'),/writer-retry/);
});
test('guest and signed-out cannot export, parse an import, or confirm a pending import',async()=>{
 for(const mode of ['guest','signed-out']){const {run,trace}=fixture({mode});await run('exportData()');await run(`importData({size:10,text:async()=>{trace.push('file-read');return '{}';}})`);run(`S.pendingImport={profile:{name:'محظور',xp:0}}`);await run('confirmImport()');assert.equal(trace.some(x=>['read:all','file-read','replace','download'].includes(x)),false);assert.equal(run('S.pendingImport'),null);}
});
test('account reset delegates cloud and local clearing to Auth then reloads',async()=>{
 const {run,trace}=fixture();run(`S.session={id:'active-round',phase:'question'};S.selected='a';activeBagCache.set('test',{});`);await run('resetData()');assert.deepEqual(trace,['account-reset','reload']);assert.equal(run('S.session'),null);assert.equal(run('activeBagCache.size'),0);
});
test('account cloud reset failure preserves current round and releases reset guards',async()=>{
 const {run,trace}=fixture();run(`S.session={id:'active-round',phase:'question'};Auth.resetProgress=async()=>{throw Error('remote reset failed');};`);
 await assert.rejects(run('resetData()'),/remote reset failed/);assert.equal(run('S.session.id'),'active-round');assert.equal(run('S.importing'),false);assert.equal(run('S.busy'),false);assert.equal(trace.includes('local-clear'),false);assert.equal(trace.includes('reload'),false);
});
test('guest reset clears only in-memory scope without calling account reset',async()=>{
 const {run,trace}=fixture({mode:'guest'});await run('resetData()');assert.deepEqual(trace,['local-clear','reload']);
});
test('queued session snapshot cannot write to a newly switched account scope',async()=>{
 const {run,trace,rows}=fixture();run(`S.session={id:'old-account-round'};saveSession();scope++;`);await run('sessionWrite');assert.equal(rows.has('active'),false);assert.equal(trace.some(x=>x==='put:active'),false);
});
test('import discards foreign cloud revision and preserves current account metadata',async()=>{
 const {run,rows}=fixture();rows.set('cloud-sync',{revision:7,snapshotHash:'current'});
 await run(`importData({size:100,text:async()=>JSON.stringify({app:'tahadi-islamic',version:1,records:{profile:{name:'من نسخة',xp:0},'cloud-sync':{revision:999,snapshotHash:'foreign'}}})})`);
 assert.equal(run(`S.pendingImport['cloud-sync']`),undefined);await run('confirmImport()');assert.equal(rows.get('cloud-sync').revision,7);assert.equal(rows.get('profile').name,'من نسخة');
});
test('pending import from a previous account cannot replace the next account data',async()=>{
 const {run,trace}=fixture();await run(`importData({size:50,text:async()=>JSON.stringify({app:'tahadi-islamic',version:1,records:{profile:{name:'سابق',xp:0}}})})`);run('scope++');await run('confirmImport()');assert.equal(trace.includes('replace'),false);assert.equal(run('S.pendingImport'),null);
});
test('legacy controller without Auth keeps direct bootstrap behavior',async()=>{
 const {run,trace}=fixture({auth:false});await run('bootstrapApplication(initialize)');assert.equal(trace[0],'read:profile');assert.equal(run('S.ready'),true);
});
test('account backup export excludes internal cloud revision metadata',async()=>{
 const {run,rows,trace}=fixture();rows.set('profile',{name:'دارس',xp:10});rows.set('cloud-sync',{revision:4,snapshotHash:'internal'});
 run(`globalThis.Blob=class {constructor(parts){globalThis.exportedText=parts.join('');}};globalThis.URL={createObjectURL(){return 'blob:test';},revokeObjectURL(){}};`);
 await run('exportData()');const payload=JSON.parse(run('globalThis.exportedText'));assert.equal(payload.records['cloud-sync'],undefined);assert.equal(payload.records.profile.name,'دارس');assert.equal(trace.includes('download'),true);
});

test('auth replacement blocks draft capture before draining queued saves and preserves chosen cloud round',async()=>{
 const {run,trace,rows}=fixture();
 run(`S.session={id:'discard-local',phase:'question'};S.selected='local-choice';S.pendingImport={};db.put=async(key,value)=>{trace.push('write-start');await new Promise(resolve=>{globalThis.releaseWrite=resolve;});rows.set(key,structuredClone(value));trace.push('write-done');};db.flush=async()=>trace.push('flush');saveSession();globalThis.replacement=prepareAuthStorageReplacement();`);
 assert.equal(run('S.importing'),true);assert.equal(run('S.busy'),true);
 await run('captureDraft()');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(trace,['write-start']);
 run('globalThis.releaseWrite()');const handle=await run('globalThis.replacement');assert.deepEqual(trace,['write-start','write-done','flush']);
 await run(`db.replaceAll({active:{id:'chosen-cloud'}})`);handle.commit();await run('captureDraft()');
 assert.equal(run('S.session'),null);assert.equal(run('S.selected'),null);assert.equal(run('S.pendingImport'),null);assert.equal(run('S.importing'),true);assert.equal(run('S.busy'),true);assert.equal(rows.get('active').id,'chosen-cloud');
});
test('auth replacement rollback retains current round and restores flags without replacing state',async()=>{
 const {run}=fixture();run(`S.session={id:'keep-local',phase:'question'};S.selected='keep';S.importing=false;S.busy=false;`);
 const handle=await run('prepareAuthStorageReplacement()');handle.rollback();assert.equal(run('S.session.id'),'keep-local');assert.equal(run('S.selected'),'keep');assert.equal(run('S.importing'),false);assert.equal(run('S.busy'),false);
});
test('auth replacement waits in-flight finish and rollback does not resurrect completed round',async()=>{
 const {run,trace}=fixture();run(`S.session={id:'finishing-local'};S.busy=true;finishingPromise=new Promise(resolve=>{globalThis.finishNow=()=>{S.session=null;S.busy=false;resolve();};});globalThis.replacement=prepareAuthStorageReplacement();`);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(run('S.importing'),true);run('globalThis.finishNow()');const handle=await run('globalThis.replacement');handle.rollback();
 assert.equal(run('S.session'),null);assert.equal(run('S.busy'),false);assert.equal(trace.includes('replace'),false);
});
test('auth replacement drain failure releases guards and preserves local round',async()=>{
 const {run}=fixture();run(`S.session={id:'keep-after-drain-error'};S.importing=false;S.busy=false;db.flush=async()=>{throw Error('flush denied');};`);
 await assert.rejects(run('prepareAuthStorageReplacement()'),/flush denied/);assert.equal(run('S.session.id'),'keep-after-drain-error');assert.equal(run('S.importing'),false);assert.equal(run('S.busy'),false);
});

test('auth replacement rollback releases completed failed-finish busy state without deleting retained round',async()=>{
 const {run}=fixture();run(`S.session={id:'retry-failed-finish'};S.busy=true;finishingPromise=Promise.reject(Error('finish save failed'));`);
 const handle=await run('prepareAuthStorageReplacement()');handle.rollback();assert.equal(run('S.session.id'),'retry-failed-finish');assert.equal(run('S.busy'),false);
});
