import fs from 'node:fs/promises';import vm from 'node:vm';
const ctx=vm.createContext({});vm.runInContext(await fs.readFile('src/educational-core.js','utf8')+';globalThis.C=EducationalContent',ctx);const C=ctx.C;
const bank=JSON.parse(await fs.readFile('data/questions.json','utf8')).questions,units=JSON.parse(await fs.readFile('data/lessons.json','utf8'));const rows=[];
for(const u of units)for(const l of u.lessons)for(let game=0;game<13;game++){
 let p=C.eligible(C.pool(bank,u.id,l.id),game);const seen=new Set();p=p.filter(x=>{const q=x.q||x;if(seen.has(q.id))return false;seen.add(q.id);return true;});
 const groups=['easy','medium','hard'].map(d=>p.filter(x=>(x.q||x).difficulty===d));p=[];for(let i=0;groups.some(a=>a[i]);i++)for(const a of groups)if(a[i])p.push(a[i]);
 for(const item of p.slice(0,game===0?15:game===5?12:8)){const q=item.q||item;const data=Object.fromEntries(['id','unit_id','lesson_id','difficulty','type','prompt','topic','payload','answer','explanation','source'].map(k=>[k,q[k]]));if(item.term)data.term=item.term;rows.push({game,id:q.id,unit_id:q.unit_id,lesson_id:q.lesson_id,data});}
}
const file='supabase/migrations/005_educational_online.sql';let sql=await fs.readFile(file,'utf8');const seed=`-- BEGIN EDUCATIONAL SEED\n-- Canonical content adapters, no credentials or user records. Regenerate with node scripts/seed-educational-online.mjs.\ninsert into school_private.educational_questions(game,id,unit_id,lesson_id,data)\nselect (x->>'game')::int,x->>'id',x->>'unit_id',x->>'lesson_id',x->'data' from jsonb_array_elements($edu_seed$${JSON.stringify(rows)}$edu_seed$::jsonb) x\non conflict(game,id) do update set data=excluded.data,unit_id=excluded.unit_id,lesson_id=excluded.lesson_id;\n-- END EDUCATIONAL SEED`;
sql=sql.replace(/-- BEGIN EDUCATIONAL SEED[\s\S]*?-- END EDUCATIONAL SEED/,()=>seed);await fs.writeFile(file,sql);console.log(`${rows.length} canonical activity records seeded across 26 lessons and 13 games.`);
