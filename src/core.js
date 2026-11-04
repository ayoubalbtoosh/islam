const DIFFICULTIES = ['easy', 'medium', 'hard'];
const DIFF_NAMES = {easy:'سهل', medium:'متوسط', hard:'صعب'};
const TYPES = ['multiple_choice','fill_blank','true_false','multi_select','matching','ordering'];
const DEFAULT_TIMERS = {easy:20,medium:30,hard:40};
const BASE_SCORE = {easy:10,medium:20,hard:30};
/** Timers are part of gameplay rules, not dependent on UI rendering. */
function resolveTimer(mode,difficulty,overrides={}){
 if(mode==='exam')return 2700;
 if(mode==='speed')return 6;
 const preference=overrides[difficulty];
 if(preference==='none')return null;
 if(preference===undefined||preference==='default')return DEFAULT_TIMERS[difficulty];
 const value=Number(preference);
 return [6,10,15,20,30,40,45,60,90,120].includes(value)?value:DEFAULT_TIMERS[difficulty];
}
const idPattern = /^u0[1-4]_l\d\d_q\d{3}$/;
const clone = x=>JSON.parse(JSON.stringify(x));
function shuffle(items, rng=Math.random) {
  const result=[...items];
  for(let i=result.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[result[i],result[j]]=[result[j],result[i]];}
  return result;
}
function seededRandom(text){
  let s=2166136261;
  for(const c of String(text)){s^=c.charCodeAt(0);s=Math.imul(s,16777619);}
  return ()=>{s+=0x6D2B79F5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
function validQuestion(q){
 if(!q||typeof q.id!=='string'||!idPattern.test(q.id)||!DIFFICULTIES.includes(q.difficulty)||!TYPES.includes(q.type)||typeof q.prompt!=='string'||!q.prompt.trim()||typeof q.explanation!=='string'||!q.explanation.trim())return false;
 if(q.lesson_id!==q.id.slice(0,7)||q.unit_id!==q.id.slice(0,3))return false;
 if(!Array.isArray(q.source?.printed_pages)||!q.source.printed_pages.length||!q.source.printed_pages.every(n=>Number.isInteger(n)&&n>0))return false;
 const p=q.payload||{},a=q.answer||{};
 const unique=xs=>Array.isArray(xs)&&xs.length>=2&&xs.every(x=>x&&typeof x.id==='string'&&x.id&&typeof x.text==='string'&&x.text.trim())&&new Set(xs.map(x=>x.id)).size===xs.length&&new Set(xs.map(x=>x.text.trim())).size===xs.length;
 switch(q.type){
  case 'multiple_choice':return unique(p.options)&&p.options.length===4&&p.options.some(x=>x.id===a.option_id);
  case 'fill_blank':return unique(p.options)&&p.options.some(x=>x.id===a.option_id);
  case 'true_false':return typeof a.value==='boolean';
  case 'multi_select':return unique(p.options)&&Array.isArray(a.option_ids)&&a.option_ids.length>0&&new Set(a.option_ids).size===a.option_ids.length&&a.option_ids.every(id=>p.options.some(x=>x.id===id));
  case 'matching':return unique(p.left)&&unique(p.right)&&p.left.length===p.right.length&&Array.isArray(a.pairs)&&a.pairs.length===p.left.length&&new Set(a.pairs.map(x=>x?.left_id)).size===a.pairs.length&&new Set(a.pairs.map(x=>x?.right_id)).size===a.pairs.length&&a.pairs.every(x=>x&&p.left.some(l=>l.id===x.left_id)&&p.right.some(r=>r.id===x.right_id));
  case 'ordering':return unique(p.items)&&Array.isArray(a.ordered_ids)&&a.ordered_ids.length===p.items.length&&a.ordered_ids.every(id=>p.items.some(x=>x.id===id))&&new Set(a.ordered_ids).size===p.items.length;
  default:return false;
 }
}
function presentQuestion(q,rng=Math.random){
  const copy=clone(q), p=copy.payload;
  for(const key of ['options','left','right','items'])if(Array.isArray(p?.[key]))p[key]=shuffle(p[key],rng);
  return copy;
}
function isAnswered(q,response){
 if(response===null||response===undefined)return false;
 const p=q.payload;
 if(q.type==='true_false')return typeof response==='boolean';
 if(q.type==='matching')return typeof response==='object'&&!Array.isArray(response)&&Object.keys(response).length===p.left.length&&p.left.every(x=>p.right.some(r=>r.id===response[x.id]))&&new Set(Object.values(response)).size===p.left.length;
 if(q.type==='ordering')return Array.isArray(response)&&response.length===p.items.length&&new Set(response).size===response.length&&response.every(id=>p.items.some(x=>x.id===id));
 if(q.type==='multi_select')return Array.isArray(response)&&response.length>0&&new Set(response).size===response.length&&response.every(id=>p.options.some(x=>x.id===id));
 return typeof response==='string'&&p.options.some(x=>x.id===response);
}
function checkAnswer(q,r){
  const a=q.answer;
  if(!isAnswered(q,r))return false;
  switch(q.type){
    case 'multiple_choice':case 'fill_blank':return String(r)===String(a.option_id);
    case 'true_false':return r===a.value;
    case 'multi_select':return Array.isArray(r)&&r.length===a.option_ids.length&&a.option_ids.every(x=>r.includes(x));
    case 'matching':return a.pairs.every(p=>r?.[p.left_id]===p.right_id)&&Object.keys(r||{}).length===a.pairs.length;
    case 'ordering':return Array.isArray(r)&&r.length===a.ordered_ids.length&&r.every((v,i)=>v===a.ordered_ids[i]);
    default:return false;
  }
}
function describeAnswer(q){
 const p=q.payload||{}, a=q.answer||{};
 const label=id=>[...(p.options||[]),...(p.right||[]),...(p.items||[])].find(x=>x.id===id)?.text||id;
 switch(q.type){
   case 'true_false':return a.value?'صح':'خطأ';
   case 'multiple_choice':case 'fill_blank':return label(a.option_id);
   case 'multi_select':return a.option_ids.map(label).join('، ');
   case 'matching':return a.pairs.map(x=>`${p.left.find(y=>y.id===x.left_id)?.text} ← ${label(x.right_id)}`).join(' | ');
   case 'ordering':return a.ordered_ids.map(label).join(' ← ');
 }
 return '';
}
/** Human-readable student's own answer, shown only on the final result page. */
function describeResponse(q,r){
 if(r===null||r===undefined)return 'لم تتم الإجابة عن هذا السؤال';
 const p=q.payload||{}, byId=(list,id)=>list?.find(x=>String(x.id)===String(id))?.text||'إجابة غير معروفة';
 switch(q.type){
  case 'multiple_choice':case 'fill_blank':return byId(p.options,r);
  case 'true_false':return r===true?'صح':r===false?'خطأ':'لم تتم الإجابة';
  case 'multi_select':return Array.isArray(r)&&r.length?r.map(id=>byId(p.options,id)).join('، '):'لم تتم الإجابة';
  case 'matching':return (p.left||[]).map(l=>`${l.text} ← ${r?.[l.id]?byId(p.right,r[l.id]):'لم تُطابَق'}`).join(' | ');
  case 'ordering':return Array.isArray(r)&&r.length?r.map(id=>byId(p.items,id)).join(' ← '):'لم تتم الإجابة';
  default:return 'إجابة غير متاحة';
 }
}
/** Group interleaving prevents a session from being made entirely of the same lesson topic. */
function topicShuffle(questions,rng=Math.random){
 // Interleave lessons first (a boss/exam spans all lessons), then topics within each lesson.
 const lessons=new Map();
 for(const q of shuffle(questions,rng)){
   if(!lessons.has(q.lesson_id))lessons.set(q.lesson_id,new Map());
   const topics=lessons.get(q.lesson_id),key=q.topic||q.lesson_id;
   if(!topics.has(key))topics.set(key,[]);
   topics.get(key).push(q);
 }
 const lessonQueue=new Map();
 for(const [id,topics] of lessons){
   const cards=[];
   while([...topics.values()].some(x=>x.length))for(const bin of shuffle([...topics.values()].filter(x=>x.length),rng))cards.push(bin.pop());
   lessonQueue.set(id,cards);
 }
 const result=[];
 while([...lessonQueue.values()].some(x=>x.length)){
   for(const cards of shuffle([...lessonQueue.values()].filter(x=>x.length),rng))result.push(cards.pop());
 }
 return result;
}
/** Persistent shuffle bag: first 30 questions from a 30-question pool have no repeats. */
function drawBag(pool,oldState,size=10,rng=Math.random){
 const map=new Map(pool.filter(validQuestion).map(q=>[q.id,q]));
 const ids=new Set(map.keys());
 const old=oldState&&typeof oldState==='object'?oldState:{};
 let remaining=(Array.isArray(old.remaining)?old.remaining:[]).filter((x,i,a)=>ids.has(x)&&a.indexOf(x)===i);
 let lastSession=Array.isArray(old.lastSession)?old.lastSession:[];
 const picked=[],chosen=new Set();
 const target=Math.min(Math.max(0,size),map.size);
 while(picked.length<target){
   if(remaining.length===0){
     const eligible=[...map.values()].filter(q=>!chosen.has(q.id));
     const fresh=topicShuffle(eligible.filter(q=>!lastSession.includes(q.id)),rng).map(q=>q.id);
     const recent=topicShuffle(eligible.filter(q=>lastSession.includes(q.id)),rng).map(q=>q.id);
     remaining=[...fresh,...recent];
   }
   if(!remaining.length)break;
   const id=remaining.shift();if(chosen.has(id)||!map.has(id))continue;
   picked.push(presentQuestion(map.get(id),rng));chosen.add(id);
 }
 return {questions:picked, state:{remaining,lastSession:picked.map(q=>q.id),updated:new Date().toISOString()}};
}
function selectFixed(questions,count,seed){
 const rng=seededRandom(seed), unique=new Map(questions.filter(validQuestion).map(q=>[q.id,q]));
 return topicShuffle([...unique.values()],rng).slice(0,count).map(q=>presentQuestion(q,rng));
}
function scoreAnswer(q,correct,seconds,limit,streak){
 if(!correct)return 0;
 const speed=limit&&limit>0?Math.min(10,Math.max(0,Math.round(10*(1-seconds/limit)))):0;
 const streakBonus=streak>0&&streak%10===0?10:streak>0&&streak%5===0?5:0;
 return BASE_SCORE[q.difficulty]+speed+streakBonus;
}
function sessionStats(session){
 const a=session.answers||[],total=session.questions?.length??a.length;
 const answered=a.filter(x=>x&&x.response!==null&&x.response!==undefined&&!x.timedOut).length;
 const correct=a.filter(x=>x?.correct&&!x.timedOut).length;
 const duration=a.reduce((sum,x)=>sum+(Number.isFinite(x?.elapsed)?x.elapsed:0),0);
 let streak=0,best=0;
 for(const x of a){if(x?.correct){streak++;best=Math.max(streak,best);}else streak=0;}
 return {answered,correct,wrong:answered-correct,unanswered:total-answered,accuracy:total?Math.round(correct/total*100):0,duration,average:a.filter(Boolean).length?duration/a.filter(Boolean).length:0,bestStreak:best,totalScore:a.reduce((sum,x)=>sum+(x?.points||0),0)};
}
/** Each adjacent pair has equal difficulty and topic wherever available. */
function balanceDuel(questions,countPerPlayer,rng=Math.random){
 const groups=new Map(),leftovers=[];
 for(const q of questions){const k=[q.lesson_id,q.difficulty,q.topic||''].join(':');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(q);}
 const rank=new Map(questions.map((q,i)=>[q.id,i]));
 const pairs=[];
 for(const list of groups.values()){while(list.length>=2)pairs.push([list.shift(),list.shift()]);if(list.length)leftovers.push(list[0]);}
 const rest=new Map();for(const q of leftovers){const k=q.lesson_id+':'+q.difficulty;if(!rest.has(k))rest.set(k,[]);rest.get(k).push(q);}
 for(const list of rest.values())while(list.length>=2)pairs.push([list.shift(),list.shift()]);
 return pairs.sort((a,b)=>Math.max(...a.map(q=>rank.get(q.id)))-Math.max(...b.map(q=>rank.get(q.id)))).slice(0,countPerPlayer).flatMap(pair=>shuffle(pair,rng));
}
function localDay(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function localWeek(d=new Date()){const date=new Date(d.getFullYear(),d.getMonth(),d.getDate()),dow=(date.getDay()+6)%7;date.setDate(date.getDate()-dow);return localDay(date);}
function lessonProgress(results,lessonId){
 const arr=results.filter(r=>r.mode!=='duel').map(r=>{const items=(r.items||[]).filter(x=>(x.lesson_id||x.id?.slice(0,7))===lessonId);if(items.length){const answered=items.filter(x=>x.response!==null&&x.response!==undefined);return {at:r.at,items,accuracy:Math.round(100*items.filter(x=>x.correct).length/items.length),answered:answered.length};}if(r.lessonId===lessonId)return {...r,items:[]};return null;}).filter(Boolean);
 const last=arr.at(-1),unique=new Set(arr.flatMap(r=>r.items.filter(x=>x.response!==null&&x.response!==undefined).map(x=>x.id))).size;
 const best=Math.max(0,...arr.map(r=>r.accuracy||0)),accuracy=Math.round(arr.slice(-5).reduce((s,x)=>s+(x.accuracy||0),0)/(Math.min(arr.length,5)||1));
 const mastery=unique>=10?accuracy:Math.min(49,accuracy);
 return {played:arr.length,best,mastery,practiced:unique,stars:mastery>=90?3:mastery>=70?2:mastery>=50?1:0,lastDate:last?.at||null};
}
