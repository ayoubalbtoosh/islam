/** Online rooms use authenticated RPCs only; individual study progress stays separate. */
const Online=(()=>{
 const terminal=new Set(['completed','cancelled','expired']);
 const state={owner:null,room:null,recent:[],loading:false,busy:false,error:'',notice:'',code:'',admin:null,adminLoading:false,adminError:'',adminOffset:0};
 let timer=null,inFlight=null,generation=0,failures=0,receivedAt=0;
 const stale=()=>Object.assign(new Error('stale_online_request'),{stale:true});
 const identity=()=>authState().mode==='account'?authState().user?.id:null;
 const visible=()=>S.page==='online'&&document.visibilityState!=='hidden'&&!!identity();
 const paint=()=>{if(S.page==='online'||S.page==='admin')render();};
 const rows=data=>Array.isArray(data)?data:Array.isArray(data?.rooms)?data.rooms:Array.isArray(data?.results)?data.results:[];
 const active=room=>room&&!terminal.has(room.status);
 const label=status=>({waiting:'بانتظار صديقك',active:'المواجهة جارية',completed:'مكتملة',cancelled:'ملغاة',expired:'انتهت صلاحية الغرفة'}[status]||'غير متاح');
 const date=value=>value?e(formatAccountDate(value)):'—';
 const players=room=>{
  if(Array.isArray(room?.players))return room.players;
  const scores=Array.isArray(room?.result?.scores)?room.result.scores:[];
  return ['host','guest'].filter(role=>room?.[role+'_id']).map(role=>({id:room[role+'_id'],name:room[role+'_name'],email:room[role+'_email'],score:scores.find(row=>row.id===room[role+'_id'])?.score}));
 };
 function adopt(room){state.room=room;receivedAt=Date.now();}
 async function rpc(name,args={}){
  const token=generation,user=identity();if(!user)throw new Error('سجّل الدخول بحسابك للمشاركة في مواجهة أونلاين.');
  if(inFlight)await inFlight.catch(()=>{});
  if(token!==generation||identity()!==user)throw stale();
  const operation=Auth.duelRpc(name,args);inFlight=operation;
  try{const data=await operation;if(token!==generation||identity()!==user)throw stale();return data;}
  finally{if(inFlight===operation)inFlight=null;}
 }
 function schedule(delay=3000){
  clearTimeout(timer);timer=null;if(!visible()||!active(state.room))return;
  timer=setTimeout(()=>refresh(false),delay);
 }
 async function refresh(manual=true){
  if(!visible()||!state.room?.id||inFlight||state.busy){schedule();return;}
  const previous=JSON.stringify({...state.room,server_now:undefined});
  try{
   const room=await rpc('duel_state',{p_room_id:state.room.id});adopt(room);failures=0;
   const hadError=!!state.error;state.error='';
   if(manual||hadError||previous!==JSON.stringify({...room,server_now:undefined}))paint();
   else{const countdown=document.querySelector('[data-testid=online-time]');if(countdown)countdown.textContent=nf(Math.max(0,Math.ceil((Date.parse(room.deadline)-Date.parse(room.server_now))/1000)));}
  }catch(error){if(error.stale)return;failures++;state.error='تعذّر تحديث المواجهة. ستُعاد المحاولة تلقائيًا؛ لا تُعد إرسال إجابتك قبل التحديث. '+error.message;paint();}
  finally{schedule(Math.min(30000,3000*2**Math.min(failures,3)));}
 }
 function stop(){clearTimeout(timer);timer=null;generation++;state.loading=false;state.busy=false;}
 async function open(){
  stop();const token=generation,owner=identity();
  if(state.owner!==owner){state.owner=owner;state.room=null;state.recent=[];state.admin=null;state.adminOffset=0;state.error='';state.notice='';}
  const invitation=new URL(location.href).searchParams.get('room');if(invitation&&!state.code)state.code=invitation.trim().toUpperCase().slice(0,12);
  if(!owner){paint();return;}
  state.loading=true;state.error='';paint();
  try{
   const recent=rows(await rpc('duel_recent'));state.recent=recent;
   const current=recent.find(active);if(current)adopt(await rpc('duel_state',{p_room_id:current.id}));
   else if(active(state.room))adopt(null);
  }catch(error){if(error.stale)return;state.error=error.message;}
  finally{if(token===generation){state.loading=false;if(visible()){paint();schedule();}}}
 }
 async function command(name,args){
  if(state.busy||state.loading)return;const token=generation;state.busy=true;state.error='';state.notice='';clearTimeout(timer);paint();
  try{adopt(await rpc(name,args));failures=0;}
  catch(error){if(error.stale)return;state.error=error.message;}
  finally{if(token===generation){state.busy=false;paint();schedule();}}
 }
 function outcome(room){
  if(!room?.result)return label(room?.status);
  if(room.status==='expired')return 'انتهت صلاحية الغرفة';
  if(room.status==='cancelled')return 'أُلغيت الغرفة';
  const winner=players(room).find(p=>p.id===room.result.winner_id);
  return winner?'الفائز: '+winner.name:'تعادل بين اللاعبين';
 }
 function scores(room){return players(room).map(p=>`<div class="online-player"><strong>${e(p.name||'لاعب')}${p.id===identity()?' <small>(أنت)</small>':''}</strong><span>${nf(p.answered)} / ${nf(room.question_count||5)} إجابات</span>${room.status==='completed'?`<b>${nf(p.score)} صحيحة</b>`:''}</div>`).join('');}
 function lobby(){return `<section class="surface panel online-lobby"><div><h2>${ico('users')} واجه صديقك من جهازه</h2><p>أنشئ غرفة وأرسل رمزها أو رابط دعوتها لصديقك، أو أدخل رمز الغرفة الذي وصلك.</p><p class="muted">خمسة أسئلة مشتركة و٩٠ ثانية تبدأ عند انضمام اللاعب الثاني. تُحسب الإجابات على الخادم، وتظهر النتيجة بعد انتهاء المواجهة. إغلاق الصفحة لا يوقف الوقت؛ يمكنك العودة إلى غرفتك من الحساب نفسه.</p><button class="btn btn-gold" data-action="online-create" ${state.busy||state.loading?'disabled':''}>${ico('users')} إنشاء غرفة</button></div><form id="online-join-form" class="online-join"><label for="online-code">رمز دعوة صديقك</label><input id="online-code" name="code" dir="ltr" maxlength="12" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required value="${e(state.code)}" placeholder="رمز الغرفة" ${state.busy||state.loading?'disabled':''}><button class="btn btn-primary" type="submit" ${state.busy||state.loading?'disabled':''}>انضمام إلى الغرفة</button></form></section>`;}
 function roomView(room){
  const waiting=room.status==='waiting',running=room.status==='active',done=terminal.has(room.status),question=room.question;
  const deadline=Date.parse(running?room.deadline:room.expires_at),now=Date.parse(room.server_now)+(Date.now()-receivedAt),seconds=Math.max(0,Math.ceil((deadline-now)/1000));
  return `<section class="surface panel online-room" aria-busy="${state.busy}"><div class="online-room-heading"><div><span class="eyebrow">غرفة المواجهة</span><h2>${e(done?outcome(room):label(room.status))}</h2></div><span class="tag">${e(label(room.status))}</span></div>${waiting?`<div class="online-invite"><p>أرسل رمز الدعوة لصديقك ليبدأ التحدي</p><strong class="online-invite-code" dir="ltr" data-testid="online-room-code">${e(room.code)}</strong><div class="online-actions"><button class="btn btn-outline" data-action="online-copy-code">نسخ الرمز</button><button class="btn btn-outline" data-action="online-copy-link">نسخ رابط الدعوة</button></div><p class="muted">تنتهي صلاحية الدعوة بعد عشر دقائق. على صديقك تسجيل الدخول بحسابه قبل الانضمام.</p></div>`:''}<div class="online-players">${scores(room)}</div>${running?`<div class="online-round-meta"><span>${ico('clock')} المتبقي تقريبًا <b data-testid="online-time">${Number.isFinite(seconds)?nf(seconds):'—'}</b> ثانية</span><span>الفوز بعدد الإجابات الصحيحة؛ النتيجة المتساوية تعادل.</span></div>${question?`<div class="online-question" data-question-id="${e(question.id)}"><span class="eyebrow">السؤال ${nf((room.me?.answered||0)+1)} من ${nf(room.question_count||5)}</span><h3>${e(question.prompt)}</h3><div class="choices">${(Array.isArray(question.options)?question.options:[]).map((option,index)=>`<button class="choice" data-action="online-answer" data-question-id="${e(question.id)}" data-option="${e(option.id)}" ${state.busy||state.error?'disabled':''}><span class="choice-letter">${String.fromCharCode(65+index)}</span><span>${e(option.text)}</span></button>`).join('')}</div><p class="muted">الضغط على الاختيار يرسل إجابتك النهائية. لا يمكن تغيير الإجابة بعد حفظها.</p></div>`:`<div class="online-wait" role="status">${ico('check',30)}<h3>حُفظت إجاباتك</h3><p>بانتظار إكمال اللاعب الآخر أو انتهاء وقت المواجهة. ستظهر النتيجة هنا تلقائيًا.</p></div>`}`:''}${done?`<div class="online-result" role="status"><h3>${e(outcome(room))}</h3><p>${room.status==='completed'?'حُفظت النتيجة على حسابك وفي سجل المدير.':room.status==='cancelled'?'أُلغيت الغرفة قبل بدء اللعب.':'انتهت صلاحية الغرفة دون مواجهة.'}</p>${room.result?.reason==='forfeit'?'<p>انتهت المواجهة بانسحاب لاعب.</p>':''}<button class="btn btn-gold" data-action="online-new">مواجهة جديدة</button></div>`:`<div class="online-actions"><button class="btn btn-outline" data-action="online-refresh" ${state.busy?'disabled':''}>${ico('refresh')} تحديث الاتصال</button><button class="btn btn-outline" data-action="online-confirm-leave" ${state.busy?'disabled':''}>${waiting?'إلغاء الغرفة':'الانسحاب من المواجهة'}</button></div>`}</section>`;
 }
 function history(){return `<section class="surface panel online-history"><div class="section-header compact"><h2>${ico('clock')} مواجهاتك الأخيرة</h2><button class="text-link" data-action="online-history-refresh" ${state.loading||state.busy?'disabled':''}>تحديث السجل</button></div>${state.recent.length?state.recent.map(room=>`<div class="history-row"><span>${e(players(room).map(p=>p.name).join(' × ')||'غرفة انتظار')}<small>${date(room.finished_at||room.created_at)}</small></span><span>${e(outcome(room))}</span><button class="text-link" data-action="online-room" data-room-id="${e(room.id)}" ${state.busy?'disabled':''}>${active(room)?'استئناف':'عرض'}</button></div>`).join(''):'<p class="muted">لا توجد مواجهات محفوظة معروضة بعد.</p>'}</section>`;}
 function view(){
  const header=heroTitle('مواجهة أونلاين','غرفة خاصة، رمز دعوة، وصديق يلعب من جهازه.');
  if(authState().mode!=='account')return `${header}<section class="surface panel"><h2>${ico('lock')} سجّل الدخول للمواجهة</h2><p>المواجهات الأونلاين تحتاج حسابين مسجلين لحفظ النتيجة وربطها بكل لاعب. تجربة الضيف تبقى مؤقتة.</p><button class="btn btn-primary" data-action="auth-signout">العودة لتسجيل الدخول</button></section>`;
  return `${header}<div class="online-content">${state.error?`<div class="auth-message is-error" role="alert">${e(state.error)} <button class="text-link" data-action="online-retry">إعادة المحاولة</button></div>`:''}${state.notice?`<p class="auth-message is-notice" role="status">${e(state.notice)}</p>`:''}${state.loading?'<p class="muted" role="status">جارٍ تحميل الغرف…</p>':''}${state.room?roomView(state.room):lobby()}${history()}</div>`;
 }
 async function loadAdmin(offset=0){
  if(!authState().isAdmin||state.adminLoading)return;state.adminLoading=true;state.adminError='';paint();
  try{const data=await rpc('platform_admin_duels',{p_limit:20,p_offset:Math.max(0,offset)});state.admin=data;state.adminOffset=Math.max(0,offset);}
  catch(error){if(!error.stale)state.adminError=error.message;}
  finally{state.adminLoading=false;paint();}
 }
 function adminView(){
  if(!authState().isAdmin)return '';
  const records=rows(state.admin),total=Number(state.admin?.total),hasMore=Number.isFinite(total)?state.adminOffset+records.length<total:records.length===20;
  return `<section class="surface panel online-admin"><div class="section-header compact"><h2>${ico('users')} نتائج المواجهات الأونلاين</h2><button class="btn btn-outline" data-action="online-admin-refresh" ${state.adminLoading?'disabled':''}>${state.adminLoading?'جارٍ التحميل…':'تحميل النتائج'}</button></div><p class="muted">نتائج محسوبة ومحفوظة على الخادم. تظهر أسماء اللاعبين والبريد للمدير فقط.</p>${state.adminError?`<p class="auth-message is-error" role="alert">${e(state.adminError)}</p>`:''}${state.admin?(records.length?`<div class="admin-table-wrap" role="region" tabindex="0" aria-label="نتائج المواجهات الأونلاين"><table class="admin-table"><thead><tr><th scope="col">اللاعبان</th><th scope="col">النتيجة</th><th scope="col">الحالة</th><th scope="col">التاريخ</th></tr></thead><tbody>${records.map(room=>`<tr><td class="admin-student">${players(room).map(p=>`<strong>${e(p.name||'لاعب')}</strong>${p.email?`<span dir="ltr">${e(p.email)}</span>`:''}`).join('')}</td><td>${room.status==='completed'?players(room).map(p=>nf(p.score)).join(' : '):'—'}<small class="online-admin-outcome">${e(outcome(room))}</small></td><td>${e(label(room.status))}</td><td>${date(room.finished_at||room.created_at)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">لا توجد نتائج مواجهات محفوظة في هذه الصفحة.</p>'):'<p class="muted">اضغط «تحميل النتائج» لعرض سجل المواجهات.</p>'}${state.admin?`<div class="online-actions"><button class="btn btn-outline" data-action="online-admin-prev" ${state.adminOffset===0||state.adminLoading?'disabled':''}>السابق</button><span>الصفحة ${nf(Math.floor(state.adminOffset/20)+1)}</span><button class="btn btn-outline" data-action="online-admin-next" ${!hasMore||state.adminLoading?'disabled':''}>التالي</button></div>`:''}</section>`;
 }
 async function copy(value,message){try{await navigator.clipboard.writeText(value);state.notice=message;}catch{state.notice='تعذّر النسخ التلقائي. انسخ رمز الغرفة الظاهر يدويًا: '+(state.room?.code||'');}paint();}
 async function action(button){
  switch(button.dataset.action){
   case 'online-create':return command('duel_create',{});
   case 'online-answer':if(state.room?.status==='active'&&state.room.question?.id===button.dataset.questionId)return command('duel_answer',{p_room_id:state.room.id,p_question_id:button.dataset.questionId,p_answer:button.dataset.option});return;
   case 'online-refresh':return refresh();
   case 'online-history-refresh':case 'online-retry':return open();
   case 'online-new':if(state.busy)return;adopt(null);state.error='';state.notice='';return open();
   case 'online-room':return command('duel_state',{p_room_id:button.dataset.roomId});
   case 'online-copy-code':return copy(state.room?.code||'','نُسخ رمز الدعوة.');
   case 'online-copy-link':{const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('room',state.room?.code||'');return copy(url.href,'نُسخ رابط الدعوة.');}
   case 'online-confirm-leave':if(!state.room||state.busy)return;S.modal=`<h2>${state.room.status==='waiting'?'إلغاء الغرفة؟':'الانسحاب من المواجهة؟'}</h2><p>${state.room.status==='waiting'?'لن يستطيع صديقك الانضمام بهذا الرمز بعد الإلغاء.':'سيُسجل انسحابك وتُحفظ النتيجة للاعب الآخر.'}</p><div class="modal-actions"><button class="btn btn-outline" data-action="close-modal">متابعة</button><button class="btn btn-danger" data-action="online-leave">تأكيد ${state.room.status==='waiting'?'الإلغاء':'الانسحاب'}</button></div>`;render();return;
   case 'online-leave':S.modal=null;return state.room&&command('duel_leave',{p_room_id:state.room.id});
   case 'online-admin-refresh':return loadAdmin(0);
   case 'online-admin-prev':return loadAdmin(state.adminOffset-20);
   case 'online-admin-next':return loadAdmin(state.adminOffset+20);
  }
 }
 document.addEventListener('input',event=>{if(event.target?.id==='online-code')state.code=event.target.value.toUpperCase().trim();});
 document.addEventListener('submit',event=>{
  if(event.target?.id!=='online-join-form')return;event.preventDefault();
  const input=document.getElementById('online-code'),code=String(input?.value||state.code).trim().toUpperCase();state.code=code;
  if(!/^[A-F0-9]{10}$/.test(code)){state.error='أدخل رمز الدعوة كاملًا كما أرسله صديقك.';paint();return;}
  void command('duel_join',{p_code:code});
 });
 document.addEventListener('visibilitychange',()=>{if(!visible()){clearTimeout(timer);timer=null;}else if(active(state.room))void refresh();});
 window.addEventListener('online',()=>{if(visible()&&active(state.room))void refresh();});
 window.addEventListener('pagehide',stop);
 return {view,open,action,stop,adminView,loadAdmin};
})();
