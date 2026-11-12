/** Rules stay independent of rendering. Deadlines use wall time, including hidden tabs. */
function timerLimit(s){
 const difficulty=DIFFICULTIES.includes(s.difficulty)?s.difficulty:s.questions[s.current]?.difficulty||'medium';
 if(s.mode==='speed'||s.mode==='exam')return resolveTimer(s.mode,difficulty,S.settings.timers);
 if(s.timerSeconds==='none')return null;
 if(s.timerSeconds!==undefined&&s.timerSeconds!==null&&s.timerSeconds!=='default'&&TIME_OPTIONS.includes(Number(s.timerSeconds)))return Number(s.timerSeconds);
 return resolveTimer(s.mode,difficulty,S.settings.timers);
}
function timeRemaining(s){
 const limit=timerLimit(s);if(limit===null)return Infinity;
 if(s.mode==='exam')return Math.max(0,((s.deadline??s.startedAt+2700000)-Date.now())/1000);
 if(s.phase==='ready')return limit;
 if(!['question'].includes(s.phase))return Math.max(0,limit-(s.answers[s.current]?.elapsed||0));
 return Math.max(0,((s.questionDeadline??s.questionStartedAt+limit*1000)-(s.pausedAt||Date.now()))/1000);
}
let sessionWrite=Promise.resolve();
const storageScope=()=>typeof db.scopeToken==='function'?db.scopeToken():undefined;
const scopeOptions=token=>token===undefined?undefined:{scopeToken:token};
const scopeIsCurrent=token=>token===undefined||storageScope()===token;
const accountTransferAllowed=()=>typeof Auth==='undefined'||Auth.current()?.mode==='account';
function saveSession(){
 if(S.importing||S.writerBlocked||S.writerSuspended)return Promise.resolve();
 const value=S.session?clone(S.session):null,token=storageScope();
 sessionWrite=sessionWrite.catch(()=>{}).then(()=>{if(!scopeIsCurrent(token))return;return value?db.put('active',value,scopeOptions(token)):db.remove('active',scopeOptions(token));});
 return sessionWrite;
}
function captureDraft(){if(S.importing||S.writerBlocked||S.writerSuspended)return Promise.resolve();if(S.session&&S.session.phase==='question'){S.session.draft=clone(S.selected??S.session.draft??null);return saveSession();}return Promise.resolve();}
function pauseSession(){const s=S.session;if(!s)return;if(s.mode!=='exam'&&s.phase==='question'&&!s.pausedAt)s.pausedAt=Date.now();captureDraft().catch(console.warn);}
function resumeSessionClock(){const s=S.session;if(!s)return;if(s.mode!=='exam'&&s.pausedAt){const pause=Date.now()-s.pausedAt;s.questionStartedAt+=pause;if(s.questionDeadline)s.questionDeadline+=pause;s.pausedAt=null;}S.selected=s.draft??(s.mode==='exam'?s.answers[s.current]?.response??null:null);saveSession().catch(console.warn);}
function beginQuestion(s){const now=Date.now();s.questionStartedAt=now;s.elapsedBefore=0;s.pausedAt=null;s.draft=null;const limit=timerLimit(s);s.questionDeadline=limit===null?null:now+limit*1000;}
function questionPool(mode,lessonId,level,scope){
 let p=S.valid;
 if(mode==='mistakes')p=Object.keys(S.mistakes).filter(id=>(S.mistakes[id]?.mastery||0)<100).map(id=>S.byId.get(id)).filter(Boolean);
 else if(['training','speed','survival','hearts','duel'].includes(mode))p=p.filter(q=>q.lesson_id===lessonId);
 if(!['training','speed','survival','hearts','duel'].includes(mode)&&scope&&scope!=='all')p=p.filter(q=>q.unit_id===scope);
 p=p.filter(q=>level==='mixed'||q.difficulty===level);
 if(mode==='speed')p=p.filter(q=>['multiple_choice','fill_blank','true_false'].includes(q.type)&&q.prompt.length<=180&&(q.payload.options||[]).every(o=>o.text.length<=90));
 return p;
}
const activeBagCache=new Map();
async function rotating(pool,key,size){
 const token=storageScope();
 const value=activeBagCache.has(key)?activeBagCache.get(key):await db.get(`bag:${key}`,null);
 if(S.writerSuspended||S.writerBlocked||!scopeIsCurrent(token))return [];
 const res=drawBag(pool,value,size);activeBagCache.set(key,res.state);await db.put(`bag:${key}`,res.state,scopeOptions(token));return res.questions;
}
async function createSession(mode='training',lessonId=S.lessonId,level=S.level,scope=S.scope,count=10,players=S.players,timerChoice=S.roundTimer){
 if(S.busy||S.writerSuspended||S.writerBlocked)return;
 if(S.session){notify('توجد جولة محفوظة. استأنفها أو أنهها أولًا قبل بدء جولة جديدة.');return;}
 S.busy=true;const token=storageScope();
 try{
  const pool=questionPool(mode,lessonId,level,scope),requestedCount=Math.min(100,Math.max(1,Math.floor(Number(count)||10)));
  const day=localDay(),week=localWeek(),key=`${['training','speed','survival','hearts','duel'].includes(mode)?lessonId:scope}:${level}:${mode==='speed'?'short':'all'}`;
  let chosen;
  if(mode==='duel'){
   const old=activeBagCache.has(key)?activeBagCache.get(key):await db.get('bag:'+key,null);
   if(!scopeIsCurrent(token))return;
   const candidates=drawBag(pool,old,pool.length).questions;chosen=balanceDuel(candidates,requestedCount);
   const picked=new Set(chosen.map(q=>q.id));const state={remaining:candidates.filter(q=>!picked.has(q.id)).map(q=>q.id),lastSession:[...picked],updated:new Date().toISOString()};
   activeBagCache.set(key,state);await db.put('bag:'+key,state,scopeOptions(token));
  }else chosen=await rotating(pool,key,mode==='daily'?10:mode==='weekly'?20:requestedCount);
  if(S.writerSuspended||S.writerBlocked||!scopeIsCurrent(token))return;
  if(!chosen.length){notify('لا توجد أسئلة كافية مناسبة لهذا الإعداد. اختر درسًا أو مستوى آخر.');return;}
  if(chosen.length<(mode==='duel'?requestedCount*2:requestedCount)&&!['daily','weekly'].includes(mode))notify(`المتاح ${chosen.length} سؤالًا؛ عُدّلت الجولة إلى العدد المتاح دون تكرار.`);
  const now=Date.now();
  S.session={id:globalThis.crypto?.randomUUID?.()||`session-${now}-${Math.random().toString(36).slice(2,10)}`,mode,lessonId:['training','speed','survival','hearts','duel'].includes(mode)?lessonId:null,lessonIds:[...new Set(chosen.map(q=>q.lesson_id))],difficulty:level,scope,questions:chosen,answers:chosen.map(()=>null),current:0,phase:mode==='duel'?'ready':'question',startedAt:now,questionStartedAt:mode==='duel'?null:now,timerSeconds:timerChoice,hearts:3,players:players.map(n=>String(n).trim().slice(0,32)),requestedCount,feedback:mode==='training'&&!!document.getElementById('form-feedback')?.checked,draft:null,finished:false,day:mode==='daily'?day:null,week:mode==='weekly'?week:null};
  if(mode==='exam')S.session.deadline=now+2700000;
  if(mode!=='duel')beginQuestion(S.session);
  S.selected=null;S.finished=null;await saveSession();playSound('start');go('game');
 }catch(error){console.error(error);notify('حدث خطأ أثناء بدء التحدي: '+error.message);}finally{S.busy=false;}
}
async function startForm(){
 if(S.busy||S.starting)return;
 if(S.session){notify('توجد جولة محفوظة. استأنفها أو أنهها أولًا قبل بدء جولة جديدة.');return;}
 S.starting=true;
 try{
  const unitId=document.getElementById('form-unit')?.value||S.unitId,lessonId=document.getElementById('form-lesson')?.value||S.lessonId;
  const scope=document.getElementById('form-scope')?.value||(S.mode==='boss'?unitId:S.scope),count=Number(document.getElementById('form-count')?.value||(S.mode==='exam'?40:10));
  const players=S.mode==='duel'?[document.getElementById('player-one')?.value.trim()||'اللاعب الأول',document.getElementById('player-two')?.value.trim()||'اللاعب الثاني']:S.players;
  const timerChoice=document.getElementById('form-timer')?.value||S.roundTimer;
  S.unitId=unitId;S.lessonId=lessonId;S.scope=scope;S.players=players;S.roundTimer=timerChoice;S.settings.roundTimer=timerChoice;
  await saveState();await createSession(S.mode,lessonId,S.level,scope,count,players,timerChoice);
 }finally{S.starting=false;}
}
function updateMistake(q,correct){const old=S.mistakes[q.id];if(!correct)S.mistakes[q.id]={count:(old?.count||0)+1,corrected:old?.corrected||0,lastAt:new Date().toISOString(),lessonId:q.lesson_id,level:q.difficulty,mastery:Math.max(0,(old?.mastery||0)-15)};else if(old)S.mistakes[q.id]={...old,corrected:(old.corrected||0)+1,mastery:Math.min(100,(old.mastery||0)+20)};}
async function rememberMistake(q,correct){updateMistake(q,correct);await db.put('mistakes',S.mistakes);}
function pickedResponse(){const q=S.session.questions[S.session.current];return responseFor(S.session)??(q.type==='multi_select'?[]:null);}
function playerStreak(s,index){const step=s.mode==='duel'?2:1;let count=0;for(let i=index-step;i>=0;i-=step){if(!s.answers[i]?.correct)break;count++;}return count+1;}
async function submitAnswer(response=null,timeout=false){
 const s=S.session;if(!s||s.phase!=='question'||S.busy||s.mode==='exam')return false;
 const index=s.current,q=s.questions[index],expired=timeRemaining(s)<=0;
 timeout=timeout||expired;if(timeout)playSound('timeout');const r=timeout?null:(response===null?pickedResponse():response);
 if(!timeout&&!isAnswered(q,r)){notify('اختر إجابتك كاملة قبل التثبيت.');return false;}
 S.busy=true;s.phase='locked';
 try{
  const limit=timerLimit(s),elapsed=Math.max(0,(Date.now()-s.questionStartedAt)/1000),correct=!timeout&&checkAnswer(q,r),points=scoreAnswer(q,correct,elapsed,limit,playerStreak(s,index));
  s.answers[index]={response:r,correct,elapsed:limit===null?elapsed:Math.min(limit,elapsed),points,timedOut:timeout,timestamp:new Date().toISOString()};
  s.draft=null;S.selected=null;
  if(s.mode==='hearts'&&!correct)s.hearts--;
  if(s.feedback&&!timeout)s.phase='feedback';
  await saveSession();render();return true;
 }catch(error){render();throw error;}finally{S.busy=false;}
}
async function autoAnswer(response=null,timeout=false){
 const s=S.session;if(!s||s.phase!=='question'||S.busy||(!timeout&&S.modal))return;
 if(s.mode==='exam'){
  if(timeRemaining(s)<=0)return submitExam(true);
  const q=s.questions[s.current];if(!isAnswered(q,response))return notify('أكمل اختيار إجابتك أولًا.');
  S.busy=true;
  try{
   S.selected=response;s.draft=response;storeExamDraft(s);
   if(s.current<s.questions.length-1){s.current++;beginQuestion(s);S.selected=s.answers[s.current]?.response??null;s.draft=S.selected;}
   else {S.selected=s.answers[s.current].response;s.draft=S.selected;notify('حُفظت الإجابة الأخيرة. يمكنك المراجعة ثم الضغط على تسليم الامتحان.');}
   await saveSession();render();window.scrollTo({top:0,behavior:'instant'});
  }finally{S.busy=false;}
  return;
 }
 const ok=await submitAnswer(response,timeout);
 if(ok&&S.session===s&&['locked','feedback'].includes(s.phase)){
  if(s.phase==='feedback')setTimeout(()=>{if(S.session===s&&s.phase==='feedback')nextQuestion();},1800);
  else await nextQuestion();
 }
}
function storeExamDraft(s){
 const q=s.questions[s.current],r=S.selected??s.draft??s.answers[s.current]?.response??null;
 if(isAnswered(q,r)){const old=s.answers[s.current];s.answers[s.current]={response:clone(r),correct:false,elapsed:(old?.elapsed||0)+Math.max(0,(Date.now()-s.questionStartedAt)/1000),points:0,timestamp:new Date().toISOString()};}
 s.questionStartedAt=Date.now();s.draft=r;return r;
}
async function saveExamCurrent(){const s=S.session;if(!s||s.mode!=='exam')return;if(timeRemaining(s)<=0)return submitExam(true);storeExamDraft(s);await saveSession();}
async function examJump(i){
 const s=S.session;if(!s||s.mode!=='exam'||S.busy||!Number.isInteger(i)||i<0||i>=s.questions.length)return;
 if(timeRemaining(s)<=0)return submitExam(true);
 S.busy=true;try{storeExamDraft(s);s.current=i;beginQuestion(s);S.selected=s.answers[i]?.response??null;s.draft=S.selected;await saveSession();render();window.scrollTo({top:0,behavior:'instant'});}finally{S.busy=false;}
}
async function examSkip(){const s=S.session;if(!s||s.mode!=='exam'||S.busy)return;if(s.current<s.questions.length-1)return examJump(s.current+1);notify('أنت في السؤال الأخير. راجع إجاباتك ثم اضغط تسليم الامتحان.');}
async function extendEndless(s){
 const seen=new Set(s.questions.map(q=>q.id)),pool=questionPool(s.mode,s.lessonId,s.difficulty,s.scope).filter(q=>!seen.has(q.id));
 if(!pool.length)return false;
 const next=await rotating(pool,`endless:${s.id}`,10);s.questions.push(...next);s.answers.push(...next.map(()=>null));return !!next.length;
}
async function nextQuestion(){
 const s=S.session;if(!s||S.busy||S.writerSuspended||S.writerBlocked||!['locked','feedback'].includes(s.phase))return;
 S.busy=true;
 try{
  // Persist the locked answer before allowing a retry to advance past it.
  await saveSession();s.phase='advancing';
  const a=s.answers[s.current];
  if((s.mode==='survival'&&!a?.correct)||(s.mode==='hearts'&&s.hearts<=0)){await finishSession();return;}
  if(s.current>=s.questions.length-1){if(['survival','hearts'].includes(s.mode)&&await extendEndless(s)){}else{await finishSession();return;}}
  s.current++;s.phase=s.mode==='duel'?'ready':'question';S.selected=null;s.draft=null;s.questionStartedAt=null;s.questionDeadline=null;
  if(s.phase==='question')beginQuestion(s);
  await saveSession();render();window.scrollTo({top:0,behavior:'instant'});
 }catch(error){if(s.phase==='advancing')s.phase='locked';render();throw error;}finally{S.busy=false;}
}
async function submitExam(expired=false){
 const s=S.session;if(!s||s.mode!=='exam'||S.busy||s.finishing)return;
 S.busy=true;s.finishing=true;
 try{
  // Saved answers remain valid; pending input at/after the deadline cannot replace them.
  if(!expired&&timeRemaining(s)>0)storeExamDraft(s);
  for(let i=0;i<s.questions.length;i++){const a=s.answers[i];if(!a)continue;const q=s.questions[i];a.correct=checkAnswer(q,a.response);a.points=scoreAnswer(q,a.correct,0,null,0);}
  S.modal=null;await finishSession();
 }finally{S.busy=false;s.finishing=false;}
}
let finishingPromise=null;
async function finishSession(){
 if(finishingPromise)return finishingPromise;
 if(S.writerSuspended||S.writerBlocked)return;
 const s=S.session;if(!s)return;
 const previousBusy=S.busy,token=storageScope();S.busy=true;
 finishingPromise=(async()=>{
  const existing=S.results.find(r=>r.id===s.id);
  if(existing){S.finished=existing;S.session=null;await db.remove('active');go('result');return;}
  const t=sessionStats(s);if(s.mode==='exam')t.duration=Math.min(2700,Math.max(0,(Date.now()-s.startedAt)/1000));
  const items=s.questions.map((q,i)=>({id:q.id,lesson_id:q.lesson_id,difficulty:q.difficulty,correct:!!s.answers[i]?.correct,response:s.answers[i]?.response??null,points:s.answers[i]?.points||0,elapsed:s.answers[i]?.elapsed||0,timedOut:!!s.answers[i]?.timedOut,player:s.mode==='duel'?i%2:null}));
  const duelStats=[0,1].map(p=>sessionStats({questions:s.questions.filter((_,i)=>i%2===p),answers:s.answers.filter((_,i)=>i%2===p)})),duelScores=duelStats.map(p=>p.totalScore),winner=duelScores[0]===duelScores[1]?null:duelScores[0]>duelScores[1]?0:1;
  const periodKey=s.mode==='daily'?s.day:s.mode==='weekly'?s.week:null,previouslyRewarded=periodKey&&S.results.some(r=>r.mode===s.mode&&r.periodKey===periodKey);
  // Shared-device duel scores belong to named competitors, not the signed-in student's XP.
  const reward={xp:previouslyRewarded||s.mode==='duel'?0:t.totalScore,coins:previouslyRewarded||s.mode==='duel'?0:Math.floor(t.totalScore/5)};
  const result={id:s.id,mode:s.mode,lessonId:s.lessonId,lessonIds:s.lessonIds,difficulty:s.difficulty,scope:s.scope,players:s.players,timerSeconds:s.timerSeconds,requestedCount:s.requestedCount,countPerPlayer:s.mode==='duel'?s.questions.length/2:null,periodKey,...t,items,at:new Date().toISOString(),duelScores,duelStats,winner:s.mode==='duel'?winner:null,reward};
  const oldProfile=clone(S.profile),oldMistakes=clone(S.mistakes),oldLength=S.results.length;
  if(s.mode!=='duel')for(let i=0;i<s.questions.length;i++)if(s.answers[i])updateMistake(s.questions[i],!!s.answers[i].correct);
  S.results.push(result);S.profile.xp+=reward.xp;S.profile.coins+=reward.coins;S.profile.level=levelFromXp(S.profile.xp);
  await sessionWrite.catch(()=>{});
  try{await db.batch({results:clone(S.results),profile:clone(S.profile),mistakes:clone(S.mistakes)},['active'],scopeOptions(token));}
  catch(error){S.results.length=oldLength;S.profile=oldProfile;S.mistakes=oldMistakes;s.phase='locked';notify('تعذر حفظ النتيجة. احتُفظ بالجولة، حاول الإنهاء مجددًا أو صدّر التقدم.');render();throw error;}
  S.finished=result;S.session=null;S.selected=null;
  if(typeof persistAchievements==='function')await persistAchievements().catch(()=>notify('حُفظت النتيجة، وتعذر حفظ تاريخ الإنجاز الآن.'));
  playSound(s.mode==='duel'?(winner===null?'tie':'win'):'finish');go('result');
 })();
 try{return await finishingPromise;}finally{finishingPromise=null;S.busy=previousBusy;}
}
async function quitGame(){if(!S.session)return go('challenges');S.modal=`<h2>إدارة الجولة الحالية</h2><p>يمكنك حفظ الجولة لإكمالها لاحقًا، أو إنهاؤها واحتساب الأسئلة المتبقية غير مجابة.${S.session.mode==='exam'?' يستمر موعد الامتحان الإجمالي عند الخروج.':''}</p><div class="modal-actions"><button class="btn btn-outline" data-action="close-modal">متابعة اللعب</button><button class="btn btn-primary" data-action="leave-game">الخروج مع الحفظ</button><button class="btn btn-danger" data-action="${S.session.mode==='exam'?'confirm-submit-exam':'confirm-finish-round'}">إنهاء الجولة الآن</button></div>`;render();}
/** Suspend old in-memory progress before an authentication bridge replaces its storage. */
async function prepareAuthStorageReplacement(){
 const previousImporting=S.importing,previousBusy=S.busy,pendingFinish=finishingPromise;
 S.importing=true;S.busy=true;
 const restoreFlags=()=>{
  S.importing=previousImporting;
  // A finish that completed while draining owns the old busy state and session lifecycle.
  S.busy=pendingFinish?false:previousBusy;
 };
 try{
  if(pendingFinish)await pendingFinish.catch(()=>{});
  S.importing=true;S.busy=true;
  await sessionWrite.catch(()=>{});
  if(typeof db.flush==='function')await db.flush();
  S.importing=true;S.busy=true;
 }catch(error){restoreFlags();throw error;}
 let settled=false;
 return {
  commit(){
   if(settled)return;settled=true;
   S.session=null;S.selected=null;S.pendingImport=null;S.pendingImportScope=undefined;
   S.importing=true;S.busy=true;
  },
  rollback(){if(settled)return;settled=true;restoreFlags();}
 };
}
async function exportData(){
 if(!accountTransferAllowed()){notify('تصدير التقدم متاح للحسابات المسجلة فقط. وضع الضيف مؤقت ولا يحفظ التقدم.');return;}
 try{
  const token=storageScope(),records=await db.all();if(!scopeIsCurrent(token))return;
  delete records['cloud-sync'];
  const payload={app:'tahadi-islamic',version:1,exportedAt:new Date().toISOString(),records};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`tahadi-progress-${localDay()}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);notify('تم إنشاء ملف نسخة التقدم.');
 }catch(error){notify('تعذر تصدير البيانات: '+error.message);}
}
async function importData(file){
 if(!accountTransferAllowed()){notify('استيراد التقدم متاح للحسابات المسجلة فقط. سجّل الدخول أولًا.');return;}
 try{
  if(file.size>20_000_000)throw Error('الملف كبير جدًا');
  const token=storageScope(),data=JSON.parse(await file.text());if(!scopeIsCurrent(token))return;
  const records=validateBackup(data,S.byId);delete records['cloud-sync'];
  S.pendingImport=records;S.pendingImportScope=token;
  S.modal=`<h2>تأكيد استيراد نسخة التقدم</h2><p>تحتوي النسخة على ${nf(records.results?.length||0)} نتيجة${records.active?' وجولة جارية':''}. سيستبدل الاستيراد تقدم هذا المتصفح بالكامل، بما فيه الجولة الحالية. صدّر نسخة من تقدمك أولًا إذا احتجت إليها.</p><div class="modal-actions"><button class="btn btn-outline" data-action="close-modal">إلغاء دون تغيير</button><button class="btn btn-danger" data-action="confirm-import">استبدال التقدم بالنسخة</button></div>`;render();
 }catch(error){S.pendingImport=null;notify('فشل الاستيراد: '+error.message);}
}
async function confirmImport(){
 if(!accountTransferAllowed()){S.pendingImport=null;notify('سجّل الدخول بحساب قبل استيراد التقدم.');return;}
 if(!S.pendingImport||S.busy)return;
 const token=S.pendingImportScope??storageScope();
 if(!scopeIsCurrent(token)){S.pendingImport=null;notify('تغير الحساب. اختر النسخة مجددًا داخل الحساب المطلوب.');return;}
 S.busy=true;S.importing=true;
 try{
  await sessionWrite.catch(()=>{});
  const metadata=await db.get('cloud-sync',null);
  const records={...S.pendingImport};delete records['cloud-sync'];if(metadata)records['cloud-sync']=metadata;
  await db.replaceAll(records,scopeOptions(token));S.pendingImport=null;S.pendingImportScope=undefined;S.modal=null;S.session=null;location.reload();
 }
 catch(error){S.importing=false;S.busy=false;throw error;}
}
async function resetData(){
 if(S.busy||S.importing)return;
 S.busy=true;S.importing=true;
 try{
  // Existing queued snapshots finish before the clear. Import/reset guards stop new snapshots,
  // including pagehide's final capture, from restoring the discarded active round.
  const token=storageScope();await sessionWrite.catch(()=>{});
  if(typeof Auth!=='undefined'&&Auth.current()?.mode==='account')await Auth.resetProgress();
  else await db.clear(scopeOptions(token));
  S.session=null;S.selected=null;S.pendingImport=null;activeBagCache.clear();
  location.reload();
 }catch(error){S.busy=false;S.importing=false;throw error;}
}
function showReset(){S.modal=`<h2>تأكيد حذف جميع بيانات التقدم</h2><p>هذا الإجراء لا يمكن التراجع عنه إلا إذا كانت لديك نسخة احتياطية. هل تريد المتابعة؟</p><div class="modal-actions"><button class="btn btn-outline" data-action="close-modal">إلغاء</button><button class="btn btn-danger" data-action="reset-all">نعم، احذف بياناتي</button></div>`;render();}
async function saveSettings(){S.profile.name=document.getElementById('setting-name')?.value.trim().slice(0,32)||'طالب';S.settings.theme=document.getElementById('setting-theme')?.value||'dark';const color=document.getElementById('setting-background')?.value;S.settings.backgroundColor=document.getElementById('setting-custom-background')?.checked&&/^#[0-9a-f]{6}$/i.test(color||'')?color:'';S.settings.sounds=!!document.getElementById('setting-sounds')?.checked;for(const d of DIFFICULTIES)S.settings.timers[d]=document.getElementById(`timer-${d}`)?.value||'default';await saveState();render();notify('تم حفظ الإعدادات.');}
async function replay(){const r=S.finished||S.results.at(-1);if(!r)return go('challenges');if(r.mode==='exam')return setup('exam');if(r.mode==='mistakes')return setup('mistakes');if(r.mode==='daily'||r.mode==='weekly')return setup(r.mode);await createSession(r.mode,r.lessonId||S.lessonId,r.difficulty,r.scope||'all',r.requestedCount||10,r.players||S.players,r.timerSeconds??S.roundTimer);}
async function onAction(btn){const action=btn.dataset.action;if(action==='writer-retry'){location.reload();return;}if(S.writerBlocked||S.writerSuspended)return;if(action.startsWith('online-')){await Online.action(btn);return;}switch(action){
 case 'navigate':go(btn.dataset.page);break;
 case 'begin-session':{const el=btn;el.disabled=true;el.setAttribute('aria-busy','true');return startForm().finally(()=>{if(el.isConnected){el.disabled=false;el.removeAttribute('aria-busy');}});break;}
 case 'unit':unit(btn.dataset.unit);break;
 case 'lesson':lesson(btn.dataset.lesson);break;
 case 'setup':if(btn.dataset.level)S.level=btn.dataset.level;setup(btn.dataset.mode,btn.dataset.lesson);break;
 case 'menu':S.menuOpen=!S.menuOpen;render();break;
 case 'select-level':S.level=btn.dataset.level;document.querySelectorAll('.segmented [data-action="select-level"]').forEach(el=>{el.classList.toggle('selected',el.dataset.level===S.level);el.setAttribute('aria-pressed',String(el.dataset.level===S.level));});break;
 case 'level':S.level=btn.dataset.level;document.querySelectorAll('[data-action="level"]').forEach(el=>el.classList.toggle('on',el.dataset.level===S.level));break;
 case 'start':S.level=btn.dataset.level||S.level;await createSession(btn.dataset.mode||'training',btn.dataset.lesson||S.lessonId,S.level,S.scope);break;
 case 'choose':await autoAnswer(btn.dataset.bool!==undefined?btn.dataset.bool==='true':btn.dataset.option);break;
 case 'toggle-option':{let arr=Array.isArray(responseFor(S.session))?[...responseFor(S.session)]:[];if(arr.includes(btn.dataset.option))arr=arr.filter(x=>x!==btn.dataset.option);else arr.push(btn.dataset.option);S.selected=arr;captureDraft().catch(console.warn);render();break;}
 case 'order-add':{const arr=[...(Array.isArray(responseFor(S.session))?responseFor(S.session):[]),btn.dataset.option];if(isAnswered(S.session.questions[S.session.current],arr))await autoAnswer(arr);else {S.selected=arr;captureDraft().catch(console.warn);render();}break;}
 case 'order-remove':S.selected=(Array.isArray(responseFor(S.session))?responseFor(S.session):[]).filter(x=>x!==btn.dataset.option);captureDraft().catch(console.warn);render();break;
 case 'submit-answer':await autoAnswer(responseFor(S.session));break;
 case 'start-duel-turn':if(S.session?.mode==='duel'&&S.session.phase==='ready'){S.session.phase='question';beginQuestion(S.session);await saveSession();playSound('turn');render();}break;
 case 'next':await nextQuestion();break;
 case 'exam-jump':await examJump(Number(btn.dataset.index));break;
 case 'save-exam-answer':await autoAnswer(responseFor(S.session));break;
 case 'exam-skip':await examSkip();break;
 case 'confirm-submit-exam':S.modal=`<h2>تسليم الامتحان</h2><p>أجبت عن ${nf(S.session.answers.filter(Boolean).length)} من أصل ${nf(S.session.questions.length)} سؤالًا. هل تريد إنهاء الامتحان الآن؟</p><div class="modal-actions"><button class="btn btn-outline" data-action="close-modal">متابعة الحل</button><button class="btn btn-gold" data-action="submit-exam">تسليم الامتحان</button></div>`;render();break;
 case 'submit-exam':S.modal=null;await submitExam();break;
 case 'quit-game':await quitGame();break;
 case 'leave-game':go('challenges');break;
 case 'resume-game':go('game');break;
 case 'replay-result':await replay();break;
 case 'save-settings':await saveSettings();break;
 case 'default-background':{const checkbox=document.getElementById('setting-custom-background');if(checkbox)checkbox.checked=false;applyAppearance({...S.settings,backgroundColor:'',theme:document.getElementById('setting-theme')?.value||S.settings.theme});break;}
 case 'export':await exportData();break;
 case 'confirm-reset':showReset();break;
 case 'reset-all':await resetData();break;
 case 'confirm-finish-round':if(S.session){S.modal=`<h2>إنهاء الجولة وتسجيل النتيجة؟</h2><p>ستُحتسب الأسئلة المتبقية غير مجابة ولن يمكن استئناف هذه الجولة بعد إنهائها.</p><div class="modal-actions"><button class="btn btn-outline" data-action="close-modal">متابعة الجولة</button><button class="btn btn-danger" data-action="finish-round">إنهاء وتسجيل النتيجة</button></div>`;render();}break;
 case 'finish-round':S.modal=null;await finishSession();break;
 case 'confirm-import':await confirmImport();break;
 case 'close-modal':S.pendingImport=null;S.modal=null;render();break;
 }}
document.addEventListener('click',event=>{const b=event.target.closest('[data-action]');if(!b||b.disabled)return;if(b.classList.contains('modal-backdrop')&&event.target.closest('.modal'))return;event.preventDefault();onAction(b).catch(error=>{console.warn(error.message);notify('تعذر تنفيذ الإجراء: '+error.message);});});

document.addEventListener('input',event=>{
 if(['setting-background','setting-custom-background','setting-theme'].includes(event.target?.id)){
  const checkbox=document.getElementById('setting-custom-background');
  if(event.target.id==='setting-background'&&checkbox)checkbox.checked=true;
  applyAppearance({...S.settings,theme:document.getElementById('setting-theme')?.value||S.settings.theme,backgroundColor:checkbox?.checked?document.getElementById('setting-background')?.value:''});return;
 }
 if(event.target?.id!=='lesson-search')return;
 const query=event.target.value.trim().toLocaleLowerCase('ar').normalize('NFKC');
 let visible=0;for(const card of document.querySelectorAll('#lesson-directory .direct-lesson-card')){
  const text=card.querySelector('.direct-lesson-name')?.textContent.toLocaleLowerCase('ar').normalize('NFKC')||'';
  card.hidden=!text.includes(query);if(!card.hidden)visible++;
 }
 const empty=document.getElementById('no-lessons');if(empty)empty.hidden=visible>0;
});
document.addEventListener('submit',event=>{if(event.target?.id!=='setup-form')return;event.preventDefault();startForm().catch(error=>notify('تعذر بدء الجولة: '+error.message));});
document.addEventListener('change',async event=>{try{const t=event.target;
 if(t.id==='form-unit'){S.unitId=t.value;S.lessonId=unitFor(S.unitId)?.lessons?.[0]?.id||S.lessonId;const lessonSelect=document.getElementById('form-lesson');if(lessonSelect)lessonSelect.innerHTML=(unitFor(S.unitId)?.lessons||[]).map(l=>`<option value="${l.id}">${e(l.name)}</option>`).join('');}
 if(t.id==='form-lesson')S.lessonId=t.value;
 if(t.id==='form-scope')S.scope=t.value;
 if(t.id==='form-timer')S.roundTimer=t.value;
 if(t.dataset.match!==undefined){const current=responseFor(S.session);const next={...(current&&typeof current==='object'&&!Array.isArray(current)?current:{}),[t.dataset.match]:t.value};if(isAnswered(S.session.questions[S.session.current],next))await autoAnswer(next);else {S.selected=next;captureDraft().catch(console.warn);}}
 if(t.id==='import-file'&&t.files?.[0])await importData(t.files[0]);
}catch(error){console.warn(error.message);notify('تعذر حفظ الاختيار: '+error.message);}});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.modal){S.pendingImport=null;S.modal=null;render();}if(S.page==='game'&&!S.modal&&S.session?.phase==='question'&&e.key==='Enter'&&e.target.tagName!=='BUTTON'&&e.target.tagName!=='SELECT'){e.preventDefault();if(S.session.questions[S.session.current].type==='multi_select')autoAnswer(responseFor(S.session)).catch(error=>notify('تعذر اعتماد الإجابة: '+error.message));}});
let tickBusy=false;
let lastCountdownKey='';
async function clockTick(){
 const s=S.session;if(!s||s.finished||tickBusy||S.importing||S.writerSuspended||S.writerBlocked)return;
 // A saved ordinary round is paused off-screen; an exam always has one total deadline.
 if(s.mode!=='exam'&&(S.page!=='game'||s.pausedAt||s.phase!=='question'))return;
 const remaining=timeRemaining(s);
 if(S.page==='game'&&remaining>0&&remaining<=3&&s.phase==='question'){const key=s.id+':'+s.current+':'+Math.ceil(remaining);if(key!==lastCountdownKey){lastCountdownKey=key;playSound('tick');}}
 const timer=document.getElementById('timer-text');
 if(timer){timer.textContent=remaining===Infinity?'∞':fmt(remaining);timer.closest('.timer-box')?.classList.toggle('urgent',remaining<=5);}
 if(remaining<=0&&!S.busy){tickBusy=true;try{if(s.mode==='exam')await submitExam(true);else await autoAnswer(null,true);}finally{tickBusy=false;}}
}
setInterval(()=>clockTick().catch(console.error),200);
window.addEventListener('visibilitychange',()=>clockTick().catch(console.error));
window.addEventListener('pagehide',()=>{
 if(typeof Online!=='undefined')Online.stop();
 const pending=finishingPromise||captureDraft();S.writerSuspended=true;
 pending.catch(console.warn).finally(async()=>{
  await sessionWrite.catch(()=>{});
  if(!S.writerBlocked&&typeof db.all==='function')await db.all().catch(()=>{});
  releaseWriterLock?.();
 });
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
async function initialize(){
 try{
  const [units,data]=[EMBEDDED_LESSONS,EMBEDDED_QUESTIONS];
  S.units=units;S.questions=data.questions||[];S.valid=S.questions.filter(q=>validQuestion(q)&&q.review?.source_checked===true&&q.review?.excluded!==true);S.byId=new Map(S.questions.filter(validQuestion).map(q=>[q.id,q]));
  const saved=await Promise.all([db.get('profile',null),db.get('settings',null),db.get('results',[]),db.get('mistakes',{}),db.get('active',null),db.get('achievements',{})]);
  const safeSaved=(key,value,fallback)=>{if(value===null||value===undefined)return fallback;try{return typeof validateBackup==='function'?validateBackup({app:'tahadi-islamic',version:1,records:{[key]:value}},S.byId)[key]:value;}catch(error){notify(`تعذر قراءة ${key} المحفوظ. بقيت البيانات الأصلية دون حذف ويمكن تصديرها للمراجعة.`);console.warn(error.message);return fallback;}};
  const profile=safeSaved('profile',saved[0],null),settings=safeSaved('settings',saved[1],null);
  if(profile)S.profile={...S.profile,...profile};
  const identity=typeof Auth==='undefined'?null:Auth.current();
  if(identity?.mode==='account'&&!String(profile?.name||'').trim())S.profile.name=String(identity.user?.name||identity.user?.email||'طالب').trim().slice(0,32);
  if(settings)S.settings={...S.settings,...settings,timers:{...S.settings.timers,...settings.timers}};
  S.achievements=safeSaved('achievements',saved[5],{});
  S.roundTimer=S.settings.roundTimer||'default';
  S.profile.level=levelFromXp(S.profile.xp);S.results=safeSaved('results',saved[2],[]);S.mistakes=safeSaved('mistakes',saved[3],{});
  const active=safeSaved('active',saved[4],null);
  if(active?.questions?.length&&!S.results.some(r=>r.id===active.id)){S.session=active;}
  if(S.session){S.session.finishing=false;S.page='game';S.selected=S.session.draft??(S.session.mode==='exam'?S.session.answers[S.session.current]?.response??null:null);resumeSessionClock();}
  S.ready=true;render();
  if(typeof Online!=='undefined'&&new URL(location.href).searchParams.has('room')&&identity?.mode==='account')go('online');
  if(S.session&&['locked','feedback','advancing'].includes(S.session.phase)){S.session.phase='locked';await nextQuestion();}
  await clockTick();
 }catch(error){console.error(error);app.innerHTML=`<div class="fatal"><h1>تعذر تحميل الموقع</h1><p>${e(error.message)}</p><p>يرجى إعادة فتح الملف في متصفح حديث.</p></div>`;}
}
/** A single writer prevents cached progress in two tabs from overwriting newer results. */
let releaseWriterLock=null;
let writerLockTask=null;
let applicationBooting=false;
let applicationStarted=false;
function showWriterBlocked(){
 S.writerBlocked=true;
 app.innerHTML='<main class="fatal" role="status"><h1>المنصة مفتوحة في تبويب آخر</h1><p>لحماية تقدمك، أكمل العمل في التبويب الأول أو أغلقه، ثم أعد المحاولة هنا.</p><button class="btn btn-primary" data-action="writer-retry">إعادة المحاولة</button></main>';
}
async function bootstrapApplication(boot){
 try{
  if(typeof Auth!=='undefined'){await Auth.init();await Auth.prepareStorage();}
  await boot();return true;
 }catch(error){
  console.warn('Application initialization failed:',error.message);
  app.innerHTML=`<main class="fatal" role="alert"><h1>تعذر بدء المنصة</h1><p>${e(error.message)}</p><p>أعد المحاولة للتحقق من تسجيل الدخول والتخزين.</p><button class="btn btn-primary" data-action="writer-retry">إعادة المحاولة</button></main>`;
  return false;
 }
}
function startApplication(boot=initialize){
 if(applicationBooting||applicationStarted)return;
 applicationBooting=true;
 const unguarded=async()=>{
  applicationBooting=false;applicationStarted=true;
  S.singleWriterWarning='متصفحك لا يتيح حماية تعدد التبويبات هنا. استخدم تبويبًا واحدًا فقط لحماية تقدمك.';
  await bootstrapApplication(boot);notify(S.singleWriterWarning);
 };
 if(!navigator.locks||typeof navigator.locks.request!=='function'){void unguarded().catch(console.error);return;}
 writerLockTask=navigator.locks.request('islamic-challenge-writer-v1',{mode:'exclusive',ifAvailable:true},async lock=>{
  applicationBooting=false;
  if(!lock){showWriterBlocked();return;}
  if(S.writerSuspended)return;
  S.writerBlocked=false;applicationStarted=true;
  const held=new Promise(resolve=>{releaseWriterLock=resolve;});
  try{await bootstrapApplication(boot);await held;}finally{releaseWriterLock=null;}
 }).catch(error=>{
  // Some local-file/private contexts expose the API but reject its use.
  console.warn('Single-writer lock unavailable:',error.message);
  if(!applicationStarted&&!S.writerSuspended)void unguarded().catch(console.error);
 });
}
startApplication();
