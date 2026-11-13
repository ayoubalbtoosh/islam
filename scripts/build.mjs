import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { build as bundle } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(root, name), 'utf8');
const lessons = JSON.parse(await read('data/lessons.json'));
const questions = JSON.parse(await read('data/questions.json'));
const savedAuthConfig = JSON.parse(await read('config/auth.public.json'));
const authConfig = {url:process.env.SUPABASE_URL||savedAuthConfig.url||'',publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY||savedAuthConfig.publishableKey||''};
if(Object.keys(savedAuthConfig).some(k=>!['url','publishableKey'].includes(k))) throw Error('Unexpected auth configuration; never embed server secrets');
if (Object.keys(authConfig).some(k=>!['url','publishableKey'].includes(k))) throw Error('Unexpected auth configuration; never embed server secrets');
if (/^sb_secret_/i.test(authConfig.publishableKey||'')) throw Error('Secret server key cannot be embedded');
if ((authConfig.publishableKey||'').split('.').length===3) { const role=JSON.parse(Buffer.from(authConfig.publishableKey.split('.')[1],'base64url').toString()).role; if(role!=='anon') throw Error('Only public anon key may be embedded'); }
const vendor=await bundle({stdin:{contents:"export {createClient} from '@supabase/supabase-js';",resolveDir:root},bundle:true,format:'iife',globalName:'SupabaseSDK',target:'es2022',platform:'browser',write:false,minify:true,legalComments:'eof'});
const sources = await Promise.all(['core', 'storage', 'auth', 'ui', 'online', 'educational-core', 'educational', 'controller'].map(name => read(`src/${name}.js`)));
// Canonical editorial metadata stays in data/questions.json. Embed only fields used by the offline runtime.
const runtimeQuestions = { ...questions, questions: questions.questions.map(q => ({
  id:q.id,unit_id:q.unit_id,lesson_id:q.lesson_id,difficulty:q.difficulty,type:q.type,topic:q.topic,
  prompt:q.prompt,payload:q.payload,answer:q.answer,explanation:q.explanation,
  source:{printed_pages:q.source?.printed_pages,pdf_pages:q.source?.pdf_pages},
  review:{source_checked:q.review?.source_checked,excluded:q.review?.excluded,verification_status:q.review?.verification_status}
})) };
const code = `${vendor.outputFiles[0].text}\nconst AUTH_CONFIG=${JSON.stringify(authConfig)};\nconst EMBEDDED_LESSONS=${JSON.stringify(lessons)};\nconst EMBEDDED_QUESTIONS=${JSON.stringify(runtimeQuestions)};\n${sources.join('\n')}`;
new vm.Script(code, { filename: 'app.bundle.js' });
const css = await read('src/styles.css');
// Inline the canonical brand icon so Pages and the standalone HTML need no asset request.
const favicon = 'data:image/svg+xml,' + encodeURIComponent(await read('assets/favicon.svg'));
const html = `<!doctype html>
<html lang="ar" dir="rtl" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#082c23">
<meta name="description" content="منصة تحدي التوجيهي في التربية الإسلامية، بتحديات فردية ومواجهات واختبارات. إنشاء الطالب أيوب محمد البطوش.">
<meta name="color-scheme" content="dark light">
<link rel="icon" type="image/svg+xml" sizes="any" href="${favicon}">
<title>تحدي التوجيهي | التربية الإسلامية</title>
<style>${css.replace(/<\/style/gi, '<\\/style')}</style>
</head>
<body>
<div id="app"><div class="fatal"><h1>تحدي التوجيهي</h1><p>جارٍ تحميل المنصة…</p></div></div>
<noscript>يرجى تفعيل JavaScript لتشغيل التحديات وتسجيل الدخول.</noscript>
<script>${code.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/index.html'), html);
await writeFile(path.join(root, 'standalone.html'), html);
await writeFile(path.join(root, 'index.html'), html);
await rm(path.join(root, 'dist/sw.js'), { force: true });
console.log(`Production + standalone built: ${lessons.length} units, ${lessons.flatMap(u=>u.lessons).length} lessons, ${questions.questions.length} bank records, ${Buffer.byteLength(html)} bytes.`);
