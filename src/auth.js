/** Official Supabase SDK handles passwords and OAuth; this application never stores them. */
const Auth=(()=>{
 const copy=value=>JSON.parse(JSON.stringify(value));
 const state={mode:'signed-out',configured:false,user:null,isAdmin:false,cloudStatus:'local',error:''};
 let client=null,initialising=null,unsubscribe=null,syncTimer=null,syncPromise=null,pending=null;
 let revision=0,ackHash=null,preparedUser=null,scopeToken=null,loggingOut=false,authStorageKey=null;
 const knownBank=()=>new Map(EMBEDDED_QUESTIONS.questions.filter(validQuestion).map(q=>[q.id,q]));
 const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
 const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable(value)))))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const clean=records=>{const next=copy(records||{});delete next['cloud-sync'];return next;};
 const checked=records=>validateBackup({app:'tahadi-islamic',version:1,records:clean(records)},knownBank());
 const current=()=>copy(state);
 const emit=()=>{if(typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent('platform-auth-change',{detail:current()}));};
 const fail=message=>{throw new Error(message);};
 const requireAccount=()=>{if(state.mode!=='account'||!client||!state.user)fail('سجّل الدخول بحسابك أولًا.');};
 const requireAdmin=()=>{requireAccount();if(!state.isAdmin)fail('هذه الصفحة مخصصة لإدارة المنصة.');};
 const scopeAlive=(id,token)=>state.mode==='account'&&state.user?.id===id&&db.scopeToken()===token;
 function publicConfig(value){
  if(!value||!value.url&&!value.publishableKey)return null;
  if(typeof value.url!=='string'||typeof value.publishableKey!=='string')fail('إعداد خدمة الحسابات غير صالح.');
  let url;try{url=new URL(value.url);}catch{fail('إعداد خدمة الحسابات غير صالح.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))fail('إعداد خدمة الحسابات غير صالح.');
  const key=value.publishableKey;
  if(/^sb_secret_/i.test(key)||/\s/.test(key))fail('لا يجوز وضع مفتاح خادم سري في الموقع.');
  if(!key.startsWith('sb_publishable_')){
   try{const body=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(body.role!=='anon')fail('مفتاح غير عام.');}
   catch{fail('استخدم مفتاح Supabase العام فقط، دون أي مفتاح إدارة.');}
  }
  if(key.length<24)fail('إعداد خدمة الحسابات غير صالح.');
  return {url:url.origin,publishableKey:key};
 }
 async function verifySession(session){
  if(!session?.user?.id){state.mode='signed-out';state.user=null;state.isAdmin=false;return;}
  const {data,error}=await client.rpc('record_login');
  if(error)fail('تعذر التحقق من صلاحية الحساب. حاول مجددًا، أو تواصل مع الإدارة.');
  if(!data?.allowed){await client.auth.signOut({scope:'local'});state.mode='signed-out';state.user=null;state.isAdmin=false;fail('تعذر فتح الحساب. تأكد من توثيق البريد وطريقة الدخول، أو تواصل مع الإدارة إذا كان الحساب معطّلًا.');}
  if(data.user_id!==session.user.id||typeof data.email!=='string')fail('تعذر التحقق من هوية الحساب.');
  state.mode='account';state.user={id:data.user_id,email:data.email,name:data.display_name||data.email};state.isAdmin=data.is_admin===true;state.error='';
 }
 function suspendIdentity(){
  clearTimeout(syncTimer);unsubscribe?.();unsubscribe=null;pending=null;preparedUser=null;scopeToken=null;
  state.mode='signed-out';state.user=null;state.isAdmin=false;state.cloudStatus='local';state.error='تغير حساب تسجيل الدخول. تُعاد تهيئة بيانات الحساب لحماية تقدمك.';
  if(typeof S!=='undefined'){S.writerSuspended=true;S.busy=true;}
  // No SDK calls inside its auth callback: avoid its session-lock reentrancy.
  void db.useGuest().catch(()=>{});emit();setTimeout(()=>location.reload(),0);
 }
 async function checkSession(id){
  const {data,error}=await client.auth.getSession();
  if(error||data.session?.user?.id!==id){suspendIdentity();fail('تغير حساب تسجيل الدخول. أعد فتح الصفحة.');}
 }
 async function init(){
  if(initialising)return initialising;
  initialising=(async()=>{
   let config;try{config=publicConfig(typeof AUTH_CONFIG==='undefined'?null:AUTH_CONFIG);}catch(error){state.error=error.message;emit();return current();}
   if(!config){state.configured=false;emit();return current();}
   if(typeof SupabaseSDK==='undefined'||typeof SupabaseSDK.createClient!=='function'){state.error='تعذر تحميل خدمة تسجيل الدخول.';emit();return current();}
   state.configured=true;
   authStorageKey='tahadi-auth-'+new URL(config.url).hostname;
   client=SupabaseSDK.createClient(config.url,config.publishableKey,{auth:{storageKey:authStorageKey,flowType:'pkce',autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}});
   try{const result=await client.auth.getSession();if(result.error)fail('تعذر استعادة جلسة الحساب.');await verifySession(result.data.session);}
   catch(error){state.mode='signed-out';state.user=null;state.isAdmin=false;state.error=error.message;}
   client.auth.onAuthStateChange((event,session)=>{
    if(loggingOut)return;
    const activeId=preparedUser||state.user?.id;
    if(activeId&&((event==='SIGNED_OUT')||session?.user?.id&&session.user.id!==activeId||event==='USER_UPDATED'))suspendIdentity();
   });
   emit();return current();
  })();return initialising;
 }
 async function readRemote(){
  const id=state.user.id;await checkSession(id);
  const {data,error}=await client.from('user_progress').select('user_id,records,updated_at,revision').eq('user_id',state.user.id).maybeSingle();
  if(error)throw error;await checkSession(id);
  if(data&&(data.user_id!==state.user.id||!Number.isSafeInteger(data.revision)||data.revision<1))fail('تعذر قراءة نسخة التقدم.');
  if(data)data.records=checked(data.records);return data;
 }
 async function persistAck(snapshot,server,id,token){
  const snapshotHash=await hash(snapshot);
  if(!scopeAlive(id,token))return;
  revision=server.revision;ackHash=snapshotHash;
  await db.put('cloud-sync',{revision,snapshotHash,lastSyncedAt:server.updated_at||new Date().toISOString()},{silent:true,scopeToken:token});
 }
 async function prepareStorage(){
  unsubscribe?.();unsubscribe=null;clearTimeout(syncTimer);pending=null;
  if(state.mode!=='account'){
   await db.useGuest();preparedUser=null;scopeToken=db.scopeToken();state.cloudStatus='local';emit();return;
  }
  const id=state.user.id;await db.useAccount(id);preparedUser=id;scopeToken=db.scopeToken();
  const token=scopeToken,rows=await db.all(),local=checked(rows),meta=rows['cloud-sync'];
  revision=meta?.revision||0;ackHash=meta?.snapshotHash||null;state.cloudStatus='loading';emit();
  const localHash=await hash(local),hasLocal=Object.keys(local).length>0;
  try{
   const remote=await readRemote();
   if(!scopeAlive(id,token))return;
   const dirty=hasLocal&&localHash!==ackHash;
   if(remote&&dirty&&revision!==remote.revision){state.cloudStatus='conflict';state.error='توجد نسختان مختلفتان للتقدم. اختر النسخة التي تريد الاحتفاظ بها من الإعدادات.';}
   else if(remote&&!dirty){
    const remoteHash=await hash(remote.records);revision=remote.revision;ackHash=remoteHash;
    await db.replaceAll({...remote.records,'cloud-sync':{revision,snapshotHash:remoteHash,lastSyncedAt:remote.updated_at}},{silent:true,scopeToken:token});
    state.cloudStatus='synced';
   }else if(!remote&&revision>0&&hasLocal){state.cloudStatus='conflict';state.error='تعذر مطابقة النسخة المحفوظة على هذا الجهاز مع نسخة الحساب.';}
   else {if(remote)revision=remote.revision;state.cloudStatus=hasLocal?'pending':'synced';if(hasLocal)pending=local;}
  }catch{state.cloudStatus='offline';state.error='تعذرت المزامنة الآن. تقدم هذا الحساب على هذا الجهاز محفوظ إن كان تخزين المتصفح متاحًا.';}
  unsubscribe=db.subscribe(event=>{
   if(event.userId!==state.user?.id||event.scopeToken!==scopeToken)return;
   pending=clean(event.records);
   if(state.cloudStatus==='conflict')return;
   state.cloudStatus='pending';emit();clearTimeout(syncTimer);
   syncTimer=setTimeout(()=>{syncNow().catch(()=>{});},600);
  });
  emit();if(pending&&state.cloudStatus!=='conflict')syncNow().catch(()=>{});
 }
 async function saveSnapshot(snapshot,id,token){
  snapshot=checked(snapshot);const snapshotHash=await hash(snapshot);
  if(!scopeAlive(id,token))return;
  if(snapshotHash===ackHash){state.cloudStatus='synced';state.error='';emit();return;}
  await checkSession(id);
  const {data,error}=await client.rpc('save_user_progress',{p_records:snapshot,p_expected_revision:revision,p_user_id:id});
  if(error){
   if(error.code==='40001'){state.cloudStatus='conflict';state.error='يوجد تقدم أحدث من جهاز آخر. اختر النسخة التي تريدها في الإعدادات.';}
   else {state.cloudStatus='error';state.error='لم تُؤكد المزامنة. احتفظ بنسخة احتياطية من تقدم الحساب وحاول مجددًا.';}
   emit();fail(state.error);
  }
  if(!data||data.user_id!==id||!Number.isSafeInteger(data.revision)||data.revision<=revision)fail('تعذر تأكيد حفظ التقدم على الحساب.');
  await persistAck(snapshot,data,id,token);
  if(scopeAlive(id,token)){state.cloudStatus=pending?'pending':'synced';state.error='';emit();}
 }
 async function syncNow(){
  requireAccount();if(state.cloudStatus==='conflict')fail(state.error||'اختر نسخة التقدم أولًا.');
  clearTimeout(syncTimer);
  if(syncPromise){await syncPromise;if(pending)return syncNow();return;}
  const id=state.user.id,token=scopeToken;
  syncPromise=(async()=>{
   const snapshot=pending||clean(await db.all());pending=null;state.cloudStatus='syncing';emit();
   try{await saveSnapshot(snapshot,id,token);}catch(error){if(scopeAlive(id,token)&&!pending)pending=snapshot;throw error;}
  })();
  try{await syncPromise;}finally{syncPromise=null;}
  if(pending&&state.cloudStatus!=='conflict')return syncNow();
 }
 async function flush(){if(state.mode!=='account')return;await db.flush();await syncNow();}
 async function resolveConflict(choice){
  requireAccount();if(!['cloud','local'].includes(choice))fail('اختيار غير صالح.');
  clearTimeout(syncTimer);if(syncPromise)await syncPromise.catch(()=>{});
  const remote=await readRemote(),id=state.user.id,token=scopeToken;
  if(choice==='cloud'){
   const records=remote?.records||{},snapshotHash=await hash(records);revision=remote?.revision||0;ackHash=snapshotHash;
   unsubscribe?.();unsubscribe=null;pending=null;
   const lifecycle=typeof prepareAuthStorageReplacement==='function'?await prepareAuthStorageReplacement():null;
   try{await db.replaceAll({...records,'cloud-sync':{revision,snapshotHash,lastSyncedAt:remote?.updated_at||new Date().toISOString()}},{silent:true,scopeToken:token});lifecycle?.commit();location.reload();}catch(error){lifecycle?.rollback();throw error;}
  }else{
   revision=remote?.revision||0;ackHash=null;state.cloudStatus='pending';pending=clean(await db.all());await syncNow();location.reload();
  }
 }
 async function signInEmail(email,password){
  await init();if(!client)fail('تسجيل الحسابات غير مفعّل بعد. يمكنك المتابعة كضيف مؤقتًا.');
  if(typeof email!=='string'||!email.trim()||typeof password!=='string'||!password)fail('أدخل إيميل الحساب وكلمة مرور المنصة.');
  state.error='';const result=await client.auth.signInWithPassword({email:email.trim(),password});
  // Never assign password to app state, progress, logs, analytics or an admin record.
  if(result.error)fail('تعذر تسجيل الدخول. تحقق من بيانات حساب المنصة أو تواصل مع الإدارة.');
  try{await verifySession(result.data.session);}catch(error){state.error=error.message;emit();throw error;}
  emit();location.reload();
 }
 async function signInGoogle(){
  await init();if(!client)fail('تسجيل Google غير مفعّل بعد. يمكنك المتابعة كضيف مؤقتًا.');
  if(!['https:','http:'].includes(location.protocol))fail('افتح الموقع من رابطه المنشور لتسجيل الدخول بحساب Google.');
  const redirect=new URL(location.href);redirect.search='';redirect.hash='';
  const result=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:redirect.href,queryParams:{prompt:'select_account'}}});
  if(result.error)fail('تعذر بدء تسجيل Google. حاول مجددًا أو تواصل مع الإدارة.');
 }
 async function enterGuest(){
  if(state.mode==='account')fail('سجّل الخروج من حسابك قبل المتابعة كضيف.');
  clearTimeout(syncTimer);unsubscribe?.();unsubscribe=null;await db.useGuest();preparedUser=null;scopeToken=db.scopeToken();state.mode='guest';state.user=null;state.isAdmin=false;state.cloudStatus='local';state.error='';emit();
 }
 async function bounded(operation){let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),5000);})]);}finally{clearTimeout(timer);}}
 async function signOut(){
  // Failing cloud sync must never trap an authenticated user on a shared device.
  if(state.mode==='account')await bounded(flush()).catch(()=>{});
  loggingOut=true;clearTimeout(syncTimer);unsubscribe?.();unsubscribe=null;
  let logoutError=false;
  if(client){try{const result=await bounded(client.auth.signOut({scope:'local'}));logoutError=!!result.error;}catch{logoutError=true;}}
  let removed=true;
  if(authStorageKey)try{for(const suffix of ['', '-code-verifier','-user'])localStorage.removeItem(authStorageKey+suffix);}catch{removed=false;}
  if(logoutError&&!removed){loggingOut=false;fail('تعذر مسح جلسة هذا المتصفح. أغلق الصفحة وحاول تسجيل الخروج بعد عودة الاتصال.');}
  state.mode='signed-out';state.user=null;state.isAdmin=false;pending=null;preparedUser=null;await db.useGuest();emit();location.reload();
 }
 async function resetProgress(){
  requireAccount();clearTimeout(syncTimer);if(syncPromise)await syncPromise.catch(()=>{});
  if(state.cloudStatus==='conflict')fail('احسم تعارض نسخ التقدم قبل حذف بيانات الحساب.');
  const id=state.user.id,token=scopeToken;
  await checkSession(id);
  const {data,error}=await client.rpc('save_user_progress',{p_records:{},p_expected_revision:revision,p_user_id:id});
  if(error||!data||data.user_id!==id||!Number.isSafeInteger(data.revision))fail('لم يُؤكد حذف التقدم من الحساب. بقيت النسخة المحلية دون تغيير.');
  pending=null;const snapshotHash=await hash({});revision=data.revision;ackHash=snapshotHash;
  await db.replaceAll({'cloud-sync':{revision,snapshotHash,lastSyncedAt:data.updated_at}},{silent:true,scopeToken:token});state.cloudStatus='synced';state.error='';emit();
 }
 async function adminRoster(){requireAdmin();await checkSession(state.user.id);const {data,error}=await client.rpc('platform_admin_roster');if(error)fail('تعذر تحميل لوحة الإدارة أو لم تعد لديك صلاحيتها.');return data;}
 async function adminAllowAccount(email,name){requireAdmin();await checkSession(state.user.id);const {data,error}=await client.rpc('admin_allow_account',{p_email:email,p_display_name:name});if(error)fail('تعذر إضافة الحساب إلى القائمة المسموحة.');return data;}
 async function adminDisableAccount(email,disabled){requireAdmin();await checkSession(state.user.id);const {data,error}=await client.rpc('admin_disable_account',{p_email:email,p_disabled:!!disabled});if(error)fail('تعذر تغيير حالة الحساب. لا يمكن تعطيل آخر مدير.');return data;}
 return {init,current,prepareStorage,signInEmail,signInGoogle,enterGuest,signOut,syncNow,flush,resolveConflict,resetProgress,adminRoster,adminAllowAccount,adminDisableAccount,publicConfig};
})();
