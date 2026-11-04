import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173';
const artifacts = path.join(root, 'artifacts');
// The game/persistence suite runs under a clearly synthetic authorized account.
// Production guest behavior is intentionally ephemeral and covered separately.
const accountFixture = await readFile(path.join(root,'tests/fixtures/authorized-account.js'),'utf8');
function authorizedHtml(html){
  assert.equal((html.match(/startApplication\(\);/g)||[]).length,1,'Expected one application bootstrap marker for test-only injection');
  return html.replace('startApplication();',accountFixture+'\nstartApplication();');
}
async function installAuthorizedFixture(target){
  await target.route('**/*',async route=>{
    const request=route.request();
    if(request.resourceType()!=='document'||!request.url().startsWith(url)){await route.continue();return;}
    const response=await route.fetch();
    await route.fulfill({response,body:authorizedHtml(await response.text())});
  });
}

await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
const consoleErrors = [];
let context;
let page;
async function fresh(viewport = { width: 1366, height: 768 }) {
  if (context) await context.close();
  context = await browser.newContext({ viewport });
  await installAuthorizedFixture(context);
  page = await context.newPage();
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(url);
  await page.waitForFunction(() => typeof S !== 'undefined' && S.valid.length && document.querySelector('#main-content'));
  assert.equal(await page.evaluate(()=>globalThis.__authorizedAccountFixture?.synthetic===true&&Auth.current().mode==='account'),true,'Game suite requires its synthetic account fixture');
}
async function test(name, body) {
  if(process.env.TEST_FILTER&&!new RegExp(process.env.TEST_FILTER).test(name))return;
  const start = Date.now();
  try { await body(); results.push({ name, status: 'passed', milliseconds: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { if(error.skip){results.push({name,status:'skipped',reason:error.message,milliseconds:Date.now()-start});console.log(`SKIP ${name}: ${error.message}`);return;} results.push({ name, status: 'failed', error: error.stack, milliseconds: Date.now() - start }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function settle() { await page.waitForFunction(() => !S.busy); }
async function start(mode = 'training', count = 4, level = 'easy', scope = 'all', timer = 'none') {
  await page.evaluate(async ({ mode, count, level, scope, timer }) => {
    S.modal = null;
    await createSession(mode, 'u01_l01', level, scope, count, ['سارة', 'عمر'], timer);
  }, { mode, count, level, scope, timer });
  await settle();
}
async function actualAnswer(correct = true) {
  await page.evaluate(async correct => {
    if (!S.session) return;
    if (S.session.phase === 'ready') {
      const btn = document.querySelector('[data-action="start-duel-turn"]');
      btn?.click();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const q = S.session.questions[S.session.current];
    const a = q.answer;
    const r = !correct ? null : q.type === 'true_false' ? a.value : ['multiple_choice', 'fill_blank'].includes(q.type) ? a.option_id : q.type === 'multi_select' ? a.option_ids : q.type === 'ordering' ? a.ordered_ids : Object.fromEntries(a.pairs.map(p => [p.left_id, p.right_id]));
    await autoAnswer(r, !correct);
    if (S.session?.phase === 'feedback') await nextQuestion();
  }, correct);
  await settle();
}
async function complete(correct = true) {
  for (let i = 0; i < 160; i++) {
    if (!(await page.evaluate(() => !!S.session))) return;
    await actualAnswer(correct);
    const done = await page.evaluate(() => S.session?.mode === 'exam' && S.session.current === S.session.questions.length - 1 && S.session.answers.every(Boolean));
    if (done) { await page.evaluate(() => submitExam()); return; }
  }
  throw Error('Session did not finish after 160 answers');
}

await test('initial load, real data counts, creator separate from learner', async () => {
  await fresh();
  const data = await page.evaluate(() => ({ units: S.units.length, lessons: allLessons().length, bank: S.questions.length, active: S.valid.length, name: S.profile.name, credit: document.body.textContent.includes(STUDENT_CREDIT) }));
  assert.equal(data.units, 4); assert.equal(data.lessons, 26); assert.equal(data.bank, 2340); assert.ok(data.active > 0); assert.ok(data.credit); assert.notEqual(data.name, 'أيوب محمد البطوش');
});
await test('lesson visit is distinct from solved/completed/mastered and survives reload',async()=>{
  await fresh();await page.evaluate(async()=>{lesson('u02_l03');await db.get('profile');});
  assert.ok(await page.evaluate(()=>S.profile.visitedLessons?.u02_l03));assert.equal(await page.evaluate(()=>S.profile.lastLessonId),'u02_l03');
  assert.equal(await page.evaluate(()=>lessonMetrics('u02_l03').answered),0);assert.equal(await page.evaluate(()=>lessonMetrics('u02_l03').mastered),false);assert.equal(await page.evaluate(()=>completedCount()),0);assert.equal(await page.evaluate(()=>S.results.length),0);
  await page.reload();await page.waitForFunction(()=>S.valid.length&&document.querySelector('#main-content'));assert.ok(await page.evaluate(()=>S.profile.visitedLessons?.u02_l03));assert.equal(await page.evaluate(()=>completedCount()),0);
});
await test('78 actual lesson-level sessions, all requested timer choices and exam counts',async()=>{
  await fresh();const exercised=await page.evaluate(async()=>{
    let rounds=0;
    for(const lesson of allLessons())for(const difficulty of DIFFICULTIES){
      await createSession('training',lesson.id,difficulty,'all',2,['a','b'],'none');
      if(!S.session||S.session.questions.length!==2||!S.session.questions.every(q=>q.lesson_id===lesson.id&&q.difficulty===difficulty))throw Error('Invalid lesson-level pool '+lesson.id+' '+difficulty);
      while(S.session){const q=S.session.questions[S.session.current],a=q.answer;const response=q.type==='true_false'?a.value:['multiple_choice','fill_blank'].includes(q.type)?a.option_id:q.type==='multi_select'?a.option_ids:q.type==='ordering'?a.ordered_ids:Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id]));await autoAnswer(response);}
      if(S.finished.correct!==2)throw Error('Failed answers '+lesson.id+' '+difficulty);rounds++;
    }
    for(const seconds of [6,10,15,20,30,40,60])if(resolveTimer('training','easy',{easy:String(seconds)})!==seconds)throw Error('Timer '+seconds);
    if(resolveTimer('training','easy',{easy:'none'})!==null||resolveTimer('speed','hard',{hard:'60'})!==6||resolveTimer('exam','easy',{easy:'6'})!==2700)throw Error('Fixed timer rules');
    for(const count of [20,40,60,100]){await createSession('exam','u01_l01','mixed','all',count,['a','b'],'none');if(S.session.questions.length!==count)throw Error('Exam count '+count);await submitExam();}
    return rounds;
  });assert.equal(exercised,78);
});
await test('all four units, 26 lessons and three difficulty setup pages', async () => {
  await fresh();
  const ids = await page.evaluate(() => allLessons().map(l => l.id));
  for (const id of ids) {
    await page.evaluate(id => lesson(id), id);
    assert.ok(await page.locator('h1').textContent());
    for (const level of ['easy', 'medium', 'hard']) {
      await page.evaluate(({ id, level }) => { S.level = level; setup('training', id); }, { id, level });
      assert.equal(await page.locator('#setup-form').count(), 1);
    }
  }
  for (const id of ['u01', 'u02', 'u03', 'u04']) { await page.evaluate(id => unit(id), id); assert.ok(await page.locator('#main-content').textContent()); }
});
await test('actual setup buttons select level, lesson, count and timer', async () => {
  await fresh();
  await page.evaluate(() => { S.level = 'medium'; setup('training', 'u02_l02'); });
  await page.locator('#form-timer').selectOption('15');
  if (await page.locator('#form-count').count()) await page.locator('#form-count').selectOption('10');
  await page.locator('[data-action="begin-session"]').click();
  await page.waitForFunction(() => S.session && !S.busy);
  const data = await page.evaluate(() => ({ lesson: S.session.lessonId, level: S.session.difficulty, timer: timerLimit(S.session), unique: new Set(S.session.questions.map(q=>q.id)).size, count: S.session.questions.length }));
  assert.equal(data.lesson, 'u02_l02'); assert.equal(data.level, 'medium'); assert.equal(data.timer, 15); assert.equal(data.unique, data.count);
});
for (const type of ['multiple_choice', 'fill_blank', 'true_false', 'multi_select', 'matching', 'ordering']) {
  await test(`native answer interface: ${type}`, async () => {
    await fresh(); await start('training', 2);
    const expected = await page.evaluate(type => {
      const q = presentQuestion(S.valid.find(q => q.type === type));
      S.session.questions = [q, presentQuestion(S.valid.find(x => x.type === 'true_false' && x.id !== q.id))];
      S.session.answers = [null, null]; S.session.current = 0; S.session.phase = 'question'; S.session.questionStartedAt = Date.now(); S.selected = null; render();
      return q.answer;
    }, type);
    if (['multiple_choice','fill_blank'].includes(type)) await page.locator(`[data-action="choose"][data-option="${expected.option_id}"]`).click();
    if (type === 'true_false') await page.locator(`[data-action="choose"][data-bool="${expected.value}"]`).click();
    if (type === 'multi_select') {
      for (const id of expected.option_ids) await page.locator(`[data-action="toggle-option"][data-option="${id}"]`).click();
      await page.locator('[data-action="submit-answer"]').click();
    }
    if (type === 'matching') for (const pair of expected.pairs) await page.locator(`[data-match="${pair.left_id}"]`).selectOption(pair.right_id);
    if (type === 'ordering') for (const id of expected.ordered_ids) await page.locator(`[data-action="order-add"][data-option="${id}"]`).click();
    await page.waitForFunction(() => S.session?.current === 1 && !S.busy);
    assert.equal(await page.evaluate(()=>S.session.answers[0].correct), true);
  });
}
await test('training feedback is opt-in and compound partial answer survives reload',async()=>{
  await fresh();await page.evaluate(()=>{setup('training','u01_l01');});
  await page.locator('#form-feedback').check();await page.locator('#form-timer').selectOption('none');await page.locator('[data-action="begin-session"]').click();await page.waitForFunction(()=>S.session&&!S.busy);
  await page.evaluate(()=>{const q=presentQuestion(S.valid.find(q=>q.type==='multi_select'));S.session.questions[0]=q;S.session.draft=null;S.selected=null;render();});
  const id=await page.evaluate(()=>S.session.questions[0].answer.option_ids[0]);await page.locator(`[data-action="toggle-option"][data-option="${id}"]`).click();
  await page.reload();await page.waitForFunction(()=>S.session&&!S.busy);assert.deepEqual(await page.evaluate(()=>responseFor(S.session)),[id]);
  await page.evaluate(async()=>{const q=S.session.questions[S.session.current];await autoAnswer(q.answer.option_ids);});
  assert.equal(await page.evaluate(()=>S.session.phase),'feedback');
  assert.ok((await page.locator('.question-body').textContent()).includes('إجابة صحيحة'));
  await page.waitForFunction(()=>S.session.current===1&&!S.busy);
});
await test('all eleven modes start and finish; session counts are unique', async () => {
  await fresh();
  await page.evaluate(() => { const q = S.valid[0]; S.mistakes[q.id] = {count:1,corrected:0,mastery:0,lessonId:q.lesson_id,level:q.difficulty,lastAt:new Date().toISOString()}; });
  for (const mode of ['training', 'speed', 'survival', 'hearts', 'random', 'boss', 'daily', 'weekly', 'mistakes', 'duel', 'exam']) {
    await start(mode, mode === 'exam' ? 20 : 4, 'easy', mode === 'boss' ? 'u01' : 'all');
    const session = await page.evaluate(() => ({ mode:S.session?.mode, unique:new Set(S.session?.questions.map(q=>q.id)).size, total:S.session?.questions.length }));
    assert.equal(session.mode,mode); assert.equal(session.unique,session.total);
    await complete(!['survival','hearts'].includes(mode));
    assert.equal(await page.evaluate(()=>S.finished?.mode), mode);
  }
});
await test('six-second mode excludes long compound types; deadline timeout progresses once', async () => {
  await fresh(); await start('speed', 4);
  assert.equal(await page.evaluate(()=>timerLimit(S.session)),6);
  assert.ok(await page.evaluate(()=>S.session.questions.every(q=>['multiple_choice','fill_blank','true_false'].includes(q.type))));
  await page.evaluate(()=>{ S.session.questionStartedAt=Date.now()-6100; S.session.questionDeadline=Date.now()-100; });
  await page.waitForFunction(()=>S.session.current===1);
  assert.equal(await page.evaluate(()=>S.session.answers.filter(Boolean).length),1);
  assert.equal(await page.evaluate(()=>S.session.answers[0].response),null);
});
await test('late answer is rejected, repeated answer and finish are idempotent', async () => {
  await fresh(); await start('training',2,'easy','all','6');
  await page.evaluate(async ()=>{const s=S.session,q=s.questions[0];s.questionStartedAt=Date.now()-6100;s.questionDeadline=Date.now()-100;await Promise.all([autoAnswer(q.answer.option_id??q.answer.value),autoAnswer(q.answer.option_id??q.answer.value)]);});
  assert.equal(await page.evaluate(()=>S.session.answers.filter(Boolean).length),1);
  assert.equal(await page.evaluate(()=>S.session.answers[0].correct),false);
  await complete();
  const before=await page.evaluate(()=>({n:S.results.length,xp:S.profile.xp}));
  await page.evaluate(async ()=>{await Promise.all([finishSession(),finishSession()]);});
  assert.deepEqual(await page.evaluate(()=>({n:S.results.length,xp:S.profile.xp})),before);
});
await test('replay and persistent rotation avoid previous round with enough alternatives', async () => {
  await fresh(); await start('training',4,'easy');
  let previous=await page.evaluate(()=>S.session.questions.map(q=>q.id));
  for(let i=0;i<5;i++){
    await complete(); await page.evaluate(()=>replay()); await settle();
    const current=await page.evaluate(()=>S.session.questions.map(q=>q.id));
    assert.equal(new Set(current).size,current.length);
    assert.equal(current.filter(id=>previous.includes(id)).length,0);
    previous=current;
  }
  await page.reload();await page.waitForFunction(()=>S.session&&!S.busy);assert.deepEqual(await page.evaluate(()=>S.session.questions.map(q=>q.id)),previous);
});
await test('duel readiness, equal per-player questions, alternation, hidden answers, winner and replay', async () => {
  await fresh();await start('duel',4,'medium','all','10');
  assert.equal(await page.evaluate(()=>S.session.questions.length),8);
  assert.equal(await page.evaluate(()=>S.session.phase),'ready');
  const remaining=await page.evaluate(()=>timeRemaining(S.session));
  await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>timeRemaining(S.session)),remaining);
  for(let i=0;i<8;i++){
    assert.equal(await page.evaluate(()=>S.session.current%2),i%2);
    assert.equal(await page.evaluate(()=>S.session.phase),'ready');
    assert.equal(await page.locator('.source-explanation').count(),0);
    await actualAnswer(i%2===0);
  }
  const result=await page.evaluate(()=>S.finished);assert.equal(result.winner,0);assert.ok(result.duelScores[0]>result.duelScores[1]);assert.equal(result.players[0],'سارة');
  const ids=result.items.map(x=>x.id);await page.evaluate(()=>replay());await settle();
  assert.equal(await page.evaluate(()=>S.session.questions.length),8);assert.equal(await page.evaluate(()=>S.session.players[0]),'سارة');
  assert.equal((await page.evaluate(()=>S.session.questions.map(q=>q.id))).filter(id=>ids.includes(id)).length,0);
});
await test('duel tie derives from answers and survives reload at handoff', async () => {
  await fresh();await start('duel',2);await actualAnswer(false);
  await page.reload();await page.waitForFunction(()=>S.session&&!S.busy);assert.equal(await page.evaluate(()=>S.session.current),1);assert.equal(await page.evaluate(()=>S.session.phase),'ready');
  await complete(false);assert.equal(await page.evaluate(()=>S.finished.winner),null);
});
await test('exam difficulty and unit filters, total 45 minutes, last answer kept editable', async () => {
  await fresh();await start('exam',20,'medium','u02');
  assert.equal(await page.evaluate(()=>timerLimit(S.session)),2700);
  assert.ok(await page.evaluate(()=>S.session.questions.every(q=>q.unit_id==='u02'&&q.difficulty==='medium')));
  await actualAnswer();assert.equal(await page.evaluate(()=>S.session.current),1);
  const first=await page.evaluate(()=>S.session.answers[0].response);await page.locator('[data-action="exam-jump"][data-index="0"]').click();await settle();
  assert.deepEqual(await page.evaluate(()=>responseFor(S.session)),first);
  await page.evaluate(async()=>{await examJump(S.session.questions.length-1);});await actualAnswer();
  assert.ok(await page.evaluate(()=>!!S.session));assert.equal(await page.evaluate(()=>S.page),'game');
  await page.locator('[data-action="confirm-submit-exam"]').click();assert.equal(await page.locator('[role="dialog"]').count(),1);
  await page.locator('[data-action="submit-exam"]').click();await page.waitForFunction(()=>S.page==='result'&&!S.session);
  assert.ok(await page.locator('.source-explanation').count());
});
await test('exam timeout submits while confirmation modal is open, once only',async()=>{
  await fresh();await start('exam',20,'easy');await actualAnswer();
  await page.locator('[data-action="confirm-submit-exam"]').click();
  await page.evaluate(()=>{S.session.startedAt=Date.now()-2700100;if(S.session.examDeadline)S.session.examDeadline=Date.now()-100;if(S.session.deadline)S.session.deadline=Date.now()-100;});
  await page.waitForFunction(()=>S.page==='result'&&!S.session);
  assert.equal(await page.evaluate(()=>S.results.length),1);
});
await test('settings persist after fresh page, export JSON, malformed import rejected',async()=>{
  await fresh();await page.evaluate(()=>go('settings'));
  await page.locator('#setting-name').fill('<img src=x onerror=alert(1)>');await page.locator('#setting-theme').selectOption('light');await page.locator('[data-action="save-settings"]').first().click();
  await page.reload();await page.waitForFunction(()=>S.valid.length&&document.querySelector('#main-content'));await page.evaluate(()=>go('settings'));
  assert.equal(await page.locator('#setting-theme').inputValue(),'light');assert.equal(await page.locator('img[src="x"]').count(),0);
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-action="export"]').click();const download=await downloadPromise;assert.ok(download.suggestedFilename().endsWith('.json'));
  const before=await page.evaluate(()=>JSON.stringify(S.profile));
  await page.locator('#import-file').setInputFiles({name:'corrupt.json',mimeType:'application/json',buffer:Buffer.from('{"app":"tahadi-islamic","version":1,"records":{"profile":{"xp":"bad"}}}')});
  await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>JSON.stringify(S.profile)),before);assert.ok((await page.locator('.toast').allTextContents()).some(t=>t.includes('فشل')||t.includes('غير صالح')));
});
await test('IndexedDB actual backup export/import roundtrip restores profile and completed results',async()=>{
  await fresh();await start('training',2);await complete();
  await page.evaluate(()=>{S.profile.name='نسخة محفوظة';return saveState();});
  assert.equal(await page.evaluate(()=>db.status().mode),'indexeddb');
  await page.evaluate(()=>go('settings'));
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-action="export"]').click();
  const downloaded=await downloadPromise;const bytes=await readFile(await downloaded.path());const backup=JSON.parse(bytes.toString());
  assert.equal(backup.records.profile.name,'نسخة محفوظة');assert.equal(backup.records.results.length,1);
  await page.evaluate(()=>{S.profile.name='تغيير محلي';return saveState();});
  await page.locator('#import-file').setInputFiles({name:'progress.json',mimeType:'application/json',buffer:bytes});
  const confirmImport=page.locator('[data-action="confirm-import"]');
  try { await confirmImport.waitFor({timeout:700}); await confirmImport.click(); } catch(error) { if(!error.message.includes('Timeout'))throw error; }
  await page.waitForFunction(()=>S.profile.name==='نسخة محفوظة'&&S.results.length===1);
  assert.equal(await page.evaluate(()=>S.results[0].mode),'training');
});
await test('storage denied retains playable session and reports memory fallback',async()=>{
  if(context)await context.close();context=await browser.newContext();await installAuthorizedFixture(context);page=await context.newPage();
  page.on('pageerror',error=>consoleErrors.push(error.message));
  await page.addInitScript(()=>{Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Test storage denial','SecurityError');}});Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Test storage denial','SecurityError');}});});
  await page.goto(url);await page.waitForFunction(()=>typeof S!=='undefined'&&S.valid.length&&document.querySelector('#main-content'));
  const guest=page.locator('[data-action="guest-name"]');if(await guest.count())await guest.click();
  await start('training',2);await complete();assert.equal(await page.evaluate(()=>S.finished.mode),'training');
  assert.equal(await page.evaluate(()=>db.status().persistent),false);assert.equal(await page.evaluate(()=>db.status().mode),'memory');
});
await test('desktop and phone layouts, no horizontal overflow, all pages and light theme',async()=>{
  for(const [width,height] of [[360,800],[390,844],[768,1024],[1366,768],[1920,1080]]){
    await fresh({width,height});
    for(const name of ['home','units','challenges','stats','achievements','settings','about']){
      await page.evaluate(name=>go(name),name);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
      assert.equal(overflow,false,`${name} overflow at ${width}`);
    }
    await page.evaluate(()=>{S.settings.theme='dark';go('home');});
    await page.screenshot({path:path.join(artifacts,`home-dark-${width}.png`),fullPage:true});
    await page.evaluate(()=>{S.settings.theme='light';go('home');});
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
    await page.screenshot({path:path.join(artifacts,`home-${width}.png`),fullPage:true});
  }
});
await test('exam reload preserves deadline and saved answer, revised answer reaches final result',async()=>{
  await fresh();await start('exam',20,'easy','u03');await actualAnswer();
  const before=await page.evaluate(()=>({deadline:S.session.deadline,response:S.session.answers[0].response,current:S.session.current}));
  await page.reload();await page.waitForFunction(()=>S.session&&!S.busy);
  assert.equal(await page.evaluate(()=>S.session.deadline),before.deadline);assert.equal(await page.evaluate(()=>S.session.current),before.current);
  await page.locator('[data-action="exam-jump"][data-index="0"]').click();await settle();
  const changed=await page.evaluate(async()=>{const q=S.session.questions[0],a=q.answer;let r=q.type==='true_false'?!a.value:['multiple_choice','fill_blank'].includes(q.type)?q.payload.options.find(o=>o.id!==a.option_id).id:q.type==='multi_select'?[q.payload.options.find(o=>!a.option_ids.includes(o.id))?.id||a.option_ids[0]]:q.type==='ordering'?[...a.ordered_ids].reverse():Object.fromEntries(a.pairs.map((p,i,arr)=>[p.left_id,arr[(i+1)%arr.length].right_id]));await autoAnswer(r);return r;});
  await page.evaluate(()=>submitExam());assert.deepEqual(await page.evaluate(()=>S.finished.items[0].response),changed);assert.equal(await page.evaluate(()=>S.finished.items[0].correct),false);
});
await test('360px game/setup/results: matching ordering, exam navigation stay within viewport',async()=>{
  for(const type of ['matching','ordering']){
    await fresh({width:360,height:800});await page.evaluate(()=>setup('training','u01_l01'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.locator('#form-timer').selectOption('none');await page.locator('[data-action="begin-session"]').click();await page.waitForFunction(()=>S.session&&!S.busy);
    await page.evaluate(type=>{S.session.questions=[presentQuestion(S.valid.find(q=>q.type===type))];S.session.answers=[null];S.session.current=0;S.session.draft=null;S.selected=null;render();},type);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const a=await page.evaluate(()=>S.session.questions[0].answer);
    if(type==='matching')for(const pair of a.pairs)await page.locator(`[data-match="${pair.left_id}"]`).selectOption(pair.right_id);
    else for(const id of a.ordered_ids)await page.locator(`[data-action="order-add"][data-option="${id}"]`).click();
    await page.waitForFunction(()=>S.page==='result');assert.equal(await page.evaluate(()=>S.finished.correct),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  }
  await fresh({width:360,height:800});await start('exam',100,'mixed');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.locator('[data-action="exam-jump"][data-index="99"]').click();await settle();assert.equal(await page.evaluate(()=>S.session.current),99);
});
await test('mistake scope honors selected unit and difficulty buttons update pressed state',async()=>{
  await fresh();await page.evaluate(()=>{for(const unit of ['u01','u02']){const q=S.valid.find(q=>q.unit_id===unit&&q.difficulty==='easy');S.mistakes[q.id]={count:1,corrected:0,mastery:0,lessonId:q.lesson_id,level:q.difficulty,lastAt:new Date().toISOString()};}S.level='easy';setup('mistakes');});
  await page.locator('[data-action="select-level"][data-level="medium"]').click();assert.equal(await page.locator('[data-action="select-level"][data-level="medium"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-action="select-level"][data-level="easy"]').getAttribute('aria-pressed'),'false');
  await page.locator('[data-action="select-level"][data-level="easy"]').click();await page.locator('#form-scope').selectOption('u02');await page.locator('[data-action="begin-session"]').click();await page.waitForFunction(()=>S.session&&!S.busy);assert.ok(await page.evaluate(()=>S.session.questions.every(q=>q.unit_id==='u02')));
});
await test('injected active-save failure keeps answer locked and Next retry preserves it',async()=>{
  await fresh();await start('training',2);
  const correct=await page.evaluate(async()=>{const q=presentQuestion(S.valid.find(q=>q.type==='multiple_choice'));S.session.questions[0]=q;await saveSession();render();const original=db.put;let fail=true;db.put=async function(key,value){if(key==='active'&&fail){fail=false;throw Error('Injected browser save failure');}return original(key,value);};return q.answer.option_id;});
  await page.locator(`[data-action="choose"][data-option="${correct}"]`).click();await page.waitForFunction(()=>S.session?.phase==='locked'&&!S.busy);
  assert.equal(await page.evaluate(()=>S.session.answers[0].response),correct);await page.locator('[data-action="next"]').click();await page.waitForFunction(()=>S.session.current===1&&!S.busy);
  assert.equal(await page.evaluate(async()=>(await db.get('active')).answers[0].response),correct);
});
await test('second tab cannot overwrite progress and acquires writer lock after first closes',async()=>{
  await fresh();await start('training',2);const previous=await page.evaluate(()=>({id:S.session.id,name:S.profile.name}));
  const second=await context.newPage();second.on('pageerror',error=>consoleErrors.push(error.message));await second.goto(url);
  await second.locator('[data-action="writer-retry"]').waitFor();assert.ok((await second.locator('body').textContent()).includes('المنصة مفتوحة في تبويب آخر'));
  assert.equal(await second.evaluate(()=>S.writerBlocked),true);assert.equal(await second.locator('[data-action="begin-session"]').count(),0);
  await page.close();page=second;await page.locator('[data-action="writer-retry"]').click();await page.waitForFunction(()=>S.session&&!S.busy);
  assert.deepEqual(await page.evaluate(()=>({id:S.session.id,name:S.profile.name})),previous);
});
await test('closing Chromium process and reopening same profile preserves ongoing exam',async()=>{
  const directory=await mkdtemp('/tmp/islam-browser-profile-');const options={executablePath:process.env.CHROMIUM_PATH|| (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']};let persistent;
  try{
    persistent=await chromium.launchPersistentContext(directory,options);await installAuthorizedFixture(persistent);let tab=persistent.pages()[0]||await persistent.newPage();await tab.goto(url);await tab.waitForFunction(()=>typeof S!=='undefined'&&S.valid.length&&document.querySelector('#main-content'));
    const saved=await tab.evaluate(async()=>{S.profile.name='حفظ عبر الإغلاق';await saveState();S.modal=null;await createSession('exam','u01_l01','easy','all',20,['a','b'],'none');const q=S.session.questions[0],a=q.answer,r=q.type==='true_false'?a.value:['multiple_choice','fill_blank'].includes(q.type)?a.option_id:q.type==='multi_select'?a.option_ids:q.type==='ordering'?a.ordered_ids:Object.fromEntries(a.pairs.map(p=>[p.left_id,p.right_id]));await autoAnswer(r);return{id:S.session.id,deadline:S.session.deadline};});
    await persistent.close();persistent=null;
    persistent=await chromium.launchPersistentContext(directory,options);await installAuthorizedFixture(persistent);
    // Chromium can restore the prior application tab and also create about:blank. Reuse the restored owner.
    tab=persistent.pages().find(p=>p.url().startsWith(url))||persistent.pages()[0]||await persistent.newPage();
    // Re-navigate even a restored tab so its response receives the test-only account fixture.
    await tab.goto(url);
    try{await tab.waitForFunction(()=>typeof S!=='undefined'&&S.session&&!S.busy);}
    catch(error){const diagnostics=await Promise.all(persistent.pages().map(async p=>({url:p.url(),state:await p.evaluate(async()=>({body:document.body.innerText,blocked:typeof S!=='undefined'?S.writerBlocked:null,valid:typeof S!=='undefined'?S.valid.length:null,session:typeof S!=='undefined'?S.session:null,records:typeof db!=='undefined'?await db.all():null})).catch(e=>({error:e.message}))})));await writeFile(path.join(artifacts,'restart-failure-diagnostics.json'),JSON.stringify(diagnostics,null,2));throw error;}
    assert.deepEqual(await tab.evaluate(()=>({id:S.session.id,deadline:S.session.deadline})),saved);assert.equal(await tab.evaluate(()=>S.session.current),1);assert.equal(await tab.evaluate(()=>S.session.answers.filter(Boolean).length),1);assert.equal(await tab.evaluate(()=>S.profile.name),'حفظ عبر الإغلاق');
  }finally{await persistent?.close();await rm(directory,{recursive:true,force:true});}
});
await test('sound toggle initializes short Web Audio effects and mute persists',async()=>{
  await fresh();await page.locator('[data-action="toggle-sound"]').click();
  await page.waitForFunction(()=>S.settings.sounds&&typeof audioContext!=='undefined');
  assert.ok(await page.evaluate(()=>['running','suspended'].includes(audioContext.state)));
  await page.evaluate(()=>{for(const kind of ['tap','start','tick','timeout','point','achievement','turn','finish','win','tie'])playSound(kind);});
  assert.equal(await page.locator('audio').count(),0);
  await page.locator('[data-action="toggle-sound"]').click();await page.waitForFunction(()=>!S.settings.sounds);await page.reload();await page.waitForFunction(()=>S.valid.length&&document.querySelector('#main-content'));assert.equal(await page.evaluate(()=>S.settings.sounds),false);
});
await test('confirmed reset clears active session and does not resurrect it on reload',async()=>{
  await fresh();await start('training',2);await page.evaluate(()=>go('settings'));
  await page.locator('[data-action="confirm-reset"]').click();const resetNavigation=page.waitForNavigation({waitUntil:'load'});await page.locator('[data-action="reset-all"]').click();await resetNavigation;
  await page.waitForFunction(()=>typeof S!=='undefined'&&S.valid.length&&!S.session&&S.results.length===0&&S.profile.name===Auth.current().user.name);
  assert.equal(await page.evaluate(()=>S.results.length),0);assert.equal(await page.evaluate(()=>db.get('active',null)),null);assert.equal(await page.evaluate(()=>S.profile.name),await page.evaluate(()=>Auth.current().user.name));
  await page.reload();await page.waitForFunction(()=>typeof S!=='undefined'&&S.valid.length&&document.querySelector('#main-content'));
  assert.equal(await page.evaluate(()=>S.session),null);assert.equal(await page.evaluate(()=>S.results.length),0);
});
await test('fixed daily weekly counts and endless setup labels match actual rules',async()=>{
  await fresh();
  for(const [mode,count] of [['daily',10],['weekly',20]]){
    await page.evaluate(mode=>{S.level='easy';setup(mode);},mode);
    assert.equal(await page.locator('#form-count').count(),0);assert.ok((await page.locator('#setup-form').textContent()).includes('عدد ثابت'));
    await page.locator('#form-timer').selectOption('none');await page.locator('[data-action="begin-session"]').click();await page.waitForFunction(()=>S.session&&!S.busy);
    assert.equal(await page.evaluate(()=>S.session.questions.length),count);await complete();assert.equal(await page.evaluate(()=>S.finished.mode),mode);
  }
  for(const mode of ['survival','hearts']){await page.evaluate(mode=>setup(mode),mode);assert.ok((await page.locator('#setup-form').textContent()).includes('الدفعة الأولى'));assert.equal(await page.locator('#form-count').count(),1);}
});
await test('standalone file opens without network dependencies',async()=>{
  await fresh();
  try { await page.goto('file://'+path.join(root,'standalone.html')); }
  catch(error) { if(error.message.includes('ERR_BLOCKED_BY_ADMINISTRATOR')) throw Object.assign(Error('Managed Chromium policy blocks file:// navigation; local Windows file opening remains untested.'),{skip:true}); throw error; }
  await page.waitForFunction(()=>typeof S!=='undefined'&&S.valid.length&&document.querySelector('#main-content'));assert.ok(await page.locator('#main-content').textContent());
});
await test('standalone inline bundle renders in opaque origin without external requests',async()=>{
  await fresh();await page.goto('about:blank');let requests=0;page.on('request',()=>requests++);
  await page.setContent(authorizedHtml(await readFile(path.join(root,'standalone.html'),'utf8')));
  await page.waitForFunction(()=>typeof S!=='undefined'&&S.valid.length&&document.querySelector('#main-content'));
  assert.equal(requests,0);assert.ok(await page.locator('#main-content').textContent());
});
await test('no browser JavaScript or console errors',async()=>{assert.deepEqual(consoleErrors,[]);});

await context?.close();await browser.close();
const report={generatedAt:new Date().toISOString(),browser:'Chromium /usr/bin/chromium via Playwright',baseUrl:url,results,consoleErrors,passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,skipped:results.filter(x=>x.status==='skipped').length,notes:['All data were isolated in fresh test browser contexts.','The historical game and persistence regressions use tests/fixtures/authorized-account.js injected into test responses only. It simulates an authorized non-admin account and an in-memory cloud endpoint; it does not test live Google OAuth, email login, allowlist verification, RLS or real cloud synchronization. Production HTML and auth configuration are not altered.','Account progress reset returns to the authenticated account display name; guest no-persistence behavior is covered by the separate authentication UI suite.','Some lifecycle tests call actual application functions directly using real bank questions. Native type controls, setup, exam navigation and backup controls are also exercised through actual DOM actions.','Timer expiry is accelerated by moving recorded start timestamps backward; no claim of a 45-minute wall-clock wait.','No testing on physical phones, Safari or Firefox.']};
await writeFile(path.join(artifacts,process.env.TEST_REPORT_FILE||'browser-results.json'),JSON.stringify(report,null,2));
console.log(`${report.passed} passed, ${report.failed} failed.`);
process.exitCode=report.failed?1:0;
