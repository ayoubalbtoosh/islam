/** Legacy storage remains untouched; authentication explicitly selects an isolated account or a fresh guest. */
const db=(()=>{
 const STORE='records';
 let name='islamic-challenge-v1', fallbackKey='islamic-challenge-offline-v1';
 const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
 let connection=null, initialising=null, queue=Promise.resolve(), rows={}, mode='memory', warning='';
 let scope='legacy', userId=null, generation=0;
 const listeners=new Set();
 const status=()=>({mode,persistent:mode!=='memory'&&scope!=='guest',warning,guest:scope==='guest',scope,userId});
 const scopeToken=()=>generation;
 function stale(){const error=Error('تغير الحساب أثناء العملية؛ لم تُطبق البيانات على الحساب الجديد.');error.name='StaleStorageScopeError';return error;}
 function announce(message){warning=message;if(typeof globalThis.dispatchEvent==='function'&&typeof globalThis.CustomEvent==='function')globalThis.dispatchEvent(new CustomEvent('storage-status',{detail:status()}));}
 function transact(kind,run){return new Promise((resolve,reject)=>{
  const tx=connection.transaction(STORE,kind);let result,done=false;
  const timer=setTimeout(()=>{if(done)return;try{tx.abort();}catch{};reject(Error('انتهت مهلة حفظ البيانات؛ لم يتم تأكيد الحفظ.'));},5000);
  tx.oncomplete=()=>{done=true;clearTimeout(timer);resolve(typeof result==='function'?result():result);};
  tx.onerror=tx.onabort=()=>{done=true;clearTimeout(timer);reject(tx.error||Error('تعذر إكمال معاملة التخزين.'));};
  try{result=run(tx.objectStore(STORE));}catch(error){try{tx.abort();}catch{};clearTimeout(timer);reject(error);}
 });}
 async function init(){
  if(initialising)return initialising;
  initialising=(async()=>{
   if(scope==='guest'){
    mode='memory';warning='وضع الضيف: التقدم مؤقت ولا يُحفظ على الجهاز أو في الحساب. سجّل الدخول لحفظ تقدمك.';return;
   }
   if(globalThis.location?.protocol!=='file:'&&'indexedDB' in globalThis){
    try{
     connection=await new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,1);let abandoned=false;
      const timer=setTimeout(()=>{abandoned=true;reject(Error('تأخر فتح قاعدة البيانات.'));},5000);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
      request.onsuccess=()=>{clearTimeout(timer);if(abandoned){request.result.close();return;}resolve(request.result);};
      request.onerror=()=>{clearTimeout(timer);reject(request.error);};
      request.onblocked=()=>{abandoned=true;clearTimeout(timer);reject(Error('قاعدة البيانات محجوبة في تبويب آخر.'));};
     });
     rows=await transact('readonly',store=>{const keys=store.getAllKeys(),values=store.getAll();return ()=>Object.fromEntries(keys.result.map((key,i)=>[key,values.result[i]]));});
     mode='indexeddb';const opened=connection;
     opened.onversionchange=()=>{opened.close();if(connection!==opened)return;connection=null;mode='memory';announce('تغير إصدار قاعدة البيانات. أعد فتح الصفحة قبل متابعة الحفظ؛ بيانات الجلسة الحالية مؤقتة.');};return;
    }catch{connection?.close();connection=null;}
   }
   try{
    const saved=globalThis.localStorage?.getItem(fallbackKey);
    if(saved){const parsed=JSON.parse(saved);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw Error('invalid local data');rows=parsed;}
    if(!globalThis.localStorage)throw Error('unavailable');
    // Probe only this account's namespace; never touch legacy or another account's records.
    const probe=fallbackKey+':probe';localStorage.setItem(probe,'1');localStorage.removeItem(probe);
    mode='localStorage';announce('الحفظ في تخزين المتصفح المحلي؛ احتفظ بنسخة احتياطية، خصوصًا عند فتح ملف HTML.');
   }catch{mode='memory';announce('التخزين الدائم غير متاح أو بياناته غير قابلة للقراءة. التقدم في هذا التبويب مؤقت؛ صدّر نسخة قبل إغلاقه.');}
  })();return initialising;
 }
 function schedule(operation,options={}){
  const token=options.scopeToken??generation;
  const next=queue.then(async()=>{if(token!==generation)throw stale();await init();if(token!==generation)throw stale();return operation(token);});
  queue=next.catch(()=>{});return next;
 }
 function changed(options,token){
  if(scope==='guest'||scope==='legacy'||options.silent||token!==generation||!listeners.size)return;
  const event={scope,userId,records:copy(rows),scopeToken:token};
  for(const listener of listeners)try{Promise.resolve(listener(event)).catch(()=>{});}catch{}
 }
 async function commit(next,puts,deletes,replace,options,token){
  if(mode==='indexeddb'){
   try{await transact('readwrite',store=>{if(replace)store.clear();for(const key of deletes)store.delete(key);for(const [key,value]of Object.entries(puts))store.put(value,key);});}
   catch(error){announce('تعذر تأكيد الحفظ في قاعدة البيانات. البيانات السابقة محفوظة؛ حاول مجددًا أو صدّر التقدم.');throw error;}
  }else if(mode==='localStorage'){
   try{localStorage.setItem(fallbackKey,JSON.stringify(next));}
   catch{mode='memory';announce('امتلأ التخزين أو تعذر الوصول إليه. التقدم الجديد مؤقت في هذا التبويب؛ صدّر نسخة احتياطية.');}
  }
  rows=next;changed(options,token);
 }
 function batch(puts={},deletes=[],options={}){
  const captured=copy(puts),removed=[...deletes],settings={...options};
  return schedule(async token=>{const next={...rows,...captured};for(const key of removed)delete next[key];await commit(next,captured,removed,false,settings,token);},settings);
 }
 function get(key,fallback=null,options={}){return schedule(()=>copy(rows[key]??fallback),options);}
 function all(options={}){return schedule(()=>copy(rows),options);}
 function put(key,value,options={}){return batch({[key]:value},[],options);}
 function remove(key,options={}){return batch({},[key],options);}
 function replaceAll(values,options={}){const captured=copy(values),settings={...options};return schedule(token=>commit(captured,captured,[],true,settings,token),settings);}
 function clear(options={}){return replaceAll({},options);}
 function switchTo(nextScope,nextUserId){
  // Invalidate queued old writes immediately. An already-running transaction is allowed to
  // finish in its old database; the switch waits for it before closing that connection.
  const token=++generation;
  const next=queue.then(async()=>{
   if(token!==generation)throw stale();connection?.close();connection=null;initialising=null;rows={};mode='memory';warning='';
   scope=nextScope;userId=nextUserId;
   name=nextUserId?`islamic-challenge-account-${nextUserId}`:'islamic-challenge-v1';
   fallbackKey=nextUserId?`islamic-challenge-account-${nextUserId}-offline-v1`:'islamic-challenge-offline-v1';
   await init();if(token!==generation)throw stale();return status();
  });queue=next.catch(()=>{});return next;
 }
 function useGuest(){return switchTo('guest',null);}
 function useAccount(id){
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return Promise.reject(TypeError('معرّف الحساب غير صالح.'));
  const normalized=id.toLowerCase();return switchTo('account:'+normalized,normalized);
 }
 function subscribe(listener){if(typeof listener!=='function')throw TypeError('Storage subscriber must be a function');listeners.add(listener);return()=>listeners.delete(listener);}
 function flush(){return queue;}
 return {get,put,remove,all,replaceAll,clear,batch,status,scopeToken,useGuest,useAccount,subscribe,flush};
})();

/** Validate the entire backup before opening a write transaction. No executable markup is trusted. */
function validateBackup(data,byId){
 const fail=message=>{throw Error('ملف النسخة الاحتياطية غير صالح: '+message);};
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const finite=(n,max=1e12)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=max;
 const integer=(n,max=1e9)=>finite(n,max)&&Number.isInteger(n);
 const text=(s,max=1000)=>typeof s==='string'&&s.length<=max;
 const id=s=>typeof s==='string'&&/^u0[1-4]_l\d{2}_q\d{3}$/.test(s);
 const epoch=n=>finite(n,8.64e15);
 const date=s=>text(s,80)&&Number.isFinite(Date.parse(s));
 const unitId=s=>typeof s==='string'&&/^u0[1-4]$/.test(s);
 const lessonId=s=>typeof s==='string'&&/^u0[1-4]_l\d{2}$/.test(s)&&(!byId||[...byId.values()].some(q=>q.lesson_id===s));
 const difficulties=['easy','medium','hard','mixed'];
 const scope=s=>s==='all'||unitId(s);
 const players=a=>Array.isArray(a)&&a.length===2&&a.every(x=>text(x,64));
 const safe=(value,depth=0)=>{
  if(depth>35)fail('تداخل مفرط');
  if(typeof value==='number'&&!Number.isFinite(value))fail('عدد غير صالح');
  if(typeof value==='string'&&value.length>30000)fail('نص طويل جدًا');
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))fail('حقل غير آمن');safe(item,depth+1);}
 };
 if(!object(data)||data.app!=='tahadi-islamic'||data.version!==1||!object(data.records))fail('صيغة غير مدعومة');
 if(JSON.stringify(data).length>20_000_000)fail('حجم كبير جدًا');safe(data);
 const records=JSON.parse(JSON.stringify(data.records));
 for(const key of Object.keys(records))if(!['profile','settings','results','mistakes','active','achievements','cloud-sync'].includes(key)&&!/^bag:[a-zA-Z0-9:_-]{1,160}$/.test(key))fail('سجل غير معروف');
 if(records['cloud-sync']!==undefined){
  const meta=records['cloud-sync'];
  if(!object(meta)||!integer(meta.revision,Number.MAX_SAFE_INTEGER)||typeof meta.snapshotHash!=='string'||!/^[0-9a-f]{64}$/i.test(meta.snapshotHash)||meta.lastSyncedAt!==undefined&&!date(meta.lastSyncedAt))fail('بيانات المزامنة المحلية');
 }
 if(records.profile!==undefined){
  const p=records.profile;if(!object(p)||!text(p.name,64)||!finite(p.xp)||p.coins!==undefined&&!finite(p.coins)||p.level!==undefined&&!integer(p.level))fail('بيانات المستخدم');
  if(p.lastLessonId!==undefined&&!lessonId(p.lastLessonId))fail('آخر درس');
  if(p.visitedLessons!==undefined&&(!object(p.visitedLessons)||Object.keys(p.visitedLessons).length>26||Object.entries(p.visitedLessons).some(([id,at])=>!lessonId(id)||!date(at))))fail('زيارات الدروس');
 }
 const timers=['default','none','6','10','15','20','30','40','45','60','90','120'];
 if(records.settings!==undefined){
  for(const key of ['backgroundColor','sidebarColor']){const color=records.settings?.[key];
   if(color!==undefined&&color!==''&&(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color)))fail('لون الخلفية');
  }
  const s=records.settings;if(!object(s)||s.theme!==undefined&&!['dark','light'].includes(s.theme)||s.sounds!==undefined&&typeof s.sounds!=='boolean'||s.roundTimer!==undefined&&!timers.includes(String(s.roundTimer))||s.feedback!==undefined&&typeof s.feedback!=='boolean')fail('الإعدادات');
  if(s.timers!==undefined&&(!object(s.timers)||Object.entries(s.timers).some(([k,v])=>!['easy','medium','hard'].includes(k)||!timers.includes(String(v)))))fail('إعدادات المؤقت');
 }
 const known=qid=>id(qid)&&(!byId||byId.has(qid));
 const modes=['training','speed','survival','hearts','duel','random','boss','daily','weekly','mistakes','exam'];
 const validateResponse=(q,r)=>{
  if(r===null||r===undefined)return;
  const p=q.payload;
  if(['multiple_choice','fill_blank'].includes(q.type)){if(!p.options.some(x=>x.id===r))fail('خيار إجابة غير معروف');}
  else if(q.type==='true_false'){if(typeof r!=='boolean')fail('إجابة صح أو خطأ');}
  else if(['ordering','multi_select'].includes(q.type)){
   const pool=q.type==='ordering'?p.items:p.options;
   if(!Array.isArray(r)||r.length>pool.length||new Set(r).size!==r.length||r.some(x=>!pool.some(y=>y.id===x)))fail('عناصر إجابة غير صالحة');
  }else if(q.type==='matching'){
   if(!object(r)||Object.entries(r).some(([left,right])=>!p.left.some(x=>x.id===left)||right!==''&&!p.right.some(x=>x.id===right)))fail('إجابة توصيل غير صالحة');
  }
 };
 if(records.results!==undefined){
  if(!Array.isArray(records.results)||records.results.length>20000)fail('سجل النتائج');const seen=new Set();
  for(const r of records.results){
   if(!object(r)||!text(r.id,160)||!r.id||seen.has(r.id)||!modes.includes(r.mode)||!date(r.at)||!Array.isArray(r.items)||r.items.length>2340)fail('نتيجة غير صالحة أو مكررة');seen.add(r.id);
   for(const field of ['answered','correct','wrong','accuracy','duration','totalScore','bestStreak','average'])if(r[field]!==undefined&&!finite(r[field],field==='accuracy'?100:1e12))fail('قيم النتيجة');
   if(r.players!==undefined&&!players(r.players))fail('أسماء المتنافسين');
   if(r.mode==='duel'&&(!players(r.players)||!Array.isArray(r.duelScores)||r.duelScores.length!==2||r.duelScores.some(n=>!finite(n))||![null,0,1].includes(r.winner)))fail('نتيجة المواجهة');
   if(r.reward!==undefined&&(!object(r.reward)||!finite(r.reward.xp)||!finite(r.reward.coins)))fail('مكافأة النتيجة');
   if(r.difficulty!==undefined&&!difficulties.includes(r.difficulty)||r.scope!==undefined&&!scope(r.scope)||r.lessonId!==undefined&&r.lessonId!==null&&!lessonId(r.lessonId)||r.lessonIds!==undefined&&(!Array.isArray(r.lessonIds)||r.lessonIds.length>26||r.lessonIds.some(x=>!lessonId(x))))fail('نطاق النتيجة');
   const itemIds=new Set();
   for(const item of r.items){if(!object(item)||!known(item.id)||itemIds.has(item.id)||typeof item.correct!=='boolean'||item.points!==undefined&&!finite(item.points)||item.elapsed!==undefined&&!finite(item.elapsed))fail('تفاصيل النتيجة');itemIds.add(item.id);const q=byId?.get(item.id);if(q)validateResponse(q,item.response);}
  }
 }
 if(records.mistakes!==undefined){if(!object(records.mistakes)||Object.keys(records.mistakes).length>2340)fail('سجل الأخطاء');for(const [qid,m]of Object.entries(records.mistakes)){if(!known(qid)||!object(m)||!integer(m.count)||m.corrected!==undefined&&!integer(m.corrected)||m.mastery!==undefined&&!finite(m.mastery,100))fail('تفاصيل الأخطاء');}}
 if(records.achievements!==undefined){
  const a=records.achievements;if(!object(a))fail('الإنجازات');
  if(Object.keys(a).length>200)fail('عدد الإنجازات');
  for(const [key,value]of Object.entries(a))if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||!date(value))fail('تاريخ الإنجاز');
 }
 for(const [key,b]of Object.entries(records))if(key.startsWith('bag:')){
  if(!object(b)||!Array.isArray(b.remaining)||!Array.isArray(b.lastSession)||b.remaining.length>2340||b.lastSession.length>2340||[...b.remaining,...b.lastSession].some(qid=>!known(qid)))fail('سجل دوران الأسئلة');
 }
 if(records.active!==undefined&&records.active!==null){
  const s=records.active;
  if(!object(s)||!text(s.id,160)||!s.id||!modes.includes(s.mode)||!['ready','question','locked','feedback'].includes(s.phase)||!Array.isArray(s.questions)||!s.questions.length||s.questions.length>2340||!Array.isArray(s.answers)||s.answers.length!==s.questions.length||!integer(s.current,s.questions.length-1)||!epoch(s.startedAt)||s.questionStartedAt!==null&&s.questionStartedAt!==undefined&&!epoch(s.questionStartedAt))fail('الجلسة الجارية');
  if(!players(s.players))fail('أسماء الجلسة');
  if(s.difficulty!==undefined&&!difficulties.includes(s.difficulty)||s.scope!==undefined&&!scope(s.scope)||s.lessonId!==undefined&&s.lessonId!==null&&!lessonId(s.lessonId)||s.lessonIds!==undefined&&(!Array.isArray(s.lessonIds)||s.lessonIds.length>26||s.lessonIds.some(x=>!lessonId(x))))fail('نطاق الجلسة');
  if(s.timerSeconds!==null&&s.timerSeconds!==undefined&&!timers.includes(String(s.timerSeconds)))fail('مؤقت الجلسة');
  if(s.hearts!==undefined&&!integer(s.hearts,3)||s.elapsedBefore!==undefined&&!finite(s.elapsedBefore))fail('حالة الجلسة');
  for(const field of ['deadline','questionDeadline','pausedAt'])if(s[field]!==null&&s[field]!==undefined&&!epoch(s[field]))fail('توقيت الجلسة');
  const seen=new Set();s.questions=s.questions.map((q,i)=>{
   if(!object(q)||!known(q.id)||seen.has(q.id))fail('أسئلة الجلسة');seen.add(q.id);
   // The bundled bank is authoritative; a backup cannot change a question or its correct answer.
   const canonical=byId?.get(q.id)||q;
   if(typeof validQuestion==='function'&&!validQuestion(canonical))fail('بنية السؤال');
   const a=s.answers[i];if(a!==null&&(!object(a)||typeof a.correct!=='boolean'||!finite(a.points)||!finite(a.elapsed)))fail('إجابات الجلسة');
   if(a)validateResponse(canonical,a.response);
   return JSON.parse(JSON.stringify(canonical));
  });
  if(s.draft!==undefined)validateResponse(s.questions[s.current],s.draft);
  s.finishing=false;s.finished=false;
 }
 return records;
}
