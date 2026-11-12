/** Refresh only the marked seed section of migration004 from the canonical bank. */
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const bank=JSON.parse(await readFile(new URL('data/questions.json',root),'utf8')).questions;
const eligible=bank.filter(q=>q.type==='multiple_choice'&&q.review?.source_checked&&!q.review?.excluded&&q.payload?.options?.length===4&&q.payload.options.some(o=>o.id===q.answer?.option_id));
const selected=[];
for(const lesson of [...new Set(eligible.map(q=>q.lesson_id))].sort()){
  for(const difficulty of ['easy','medium','hard'])selected.push(...eligible.filter(q=>q.lesson_id===lesson&&q.difficulty===difficulty).slice(0,difficulty==='easy'?2:1));
}
if(selected.length<20)throw Error('Canonical duel question bank is unexpectedly incomplete');
const questions=selected.map(q=>({id:q.id,prompt:q.prompt,options:q.payload.options,correct_answer:q.answer.option_id,explanation:q.explanation}));
const payload=JSON.stringify(questions);
if(payload.includes('$duel_seed$'))throw Error('Seed delimiter collision');
const seed=`-- ${questions.length} source-checked MCQs across ${new Set(selected.map(q=>q.lesson_id)).size} lessons; no credentials or user data.\ninsert into school_private.duel_questions(id,question)\nselect value ->> 'id', value from jsonb_array_elements($duel_seed$${payload}$duel_seed$::jsonb)\non conflict (id) do update set question = excluded.question;`;
const target=new URL('supabase/migrations/004_online_duels.sql',root);
const text=await readFile(target,'utf8');
const next=text.replace(/(-- BEGIN GENERATED QUESTION SEED \(scripts\/seed-duels\.mjs\)\n)[\s\S]*?(-- END GENERATED QUESTION SEED)/,`$1${seed}\n$2`);
if(next===text&&!text.includes(payload))throw Error('Seed markers missing');
await writeFile(target,next);
console.log(`Seeded ${questions.length} canonical MCQs covering ${new Set(selected.map(q=>q.lesson_id)).size} lessons`);
