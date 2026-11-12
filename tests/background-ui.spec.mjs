/** Custom background UI with real IndexedDB persistence and a synthetic account transport. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url),base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
const html=await readFile(new URL('dist/index.html',root),'utf8'),fixture=await readFile(new URL('tests/fixtures/authorized-account.js',root),'utf8');
const testedBuildSha256=createHash('sha256').update(html).digest('hex');
assert.equal((html.match(/startApplication\(\);/g)||[]).length,1);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1366,height:900}}),results=[],errors=[],externalRequests=[];
await context.route('**/*',async route=>{
 if(new URL(route.request().url()).origin!==new URL(base).origin){externalRequests.push(route.request().url());return route.abort();}
 if(route.request().resourceType()==='document')return route.fulfill({contentType:'text/html; charset=utf-8',body:html.replace('startApplication();',fixture+'\nstartApplication();')});
 return route.continue();
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
async function ready(){await page.waitForFunction(()=>S.ready&&Auth.current().mode==='account');}
async function settings(){await page.evaluate(()=>go('settings'));await page.waitForSelector('#setting-background');}
async function color(value){await page.locator('#setting-background').evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},value);}
async function save(){await page.locator('[data-action="save-settings"]').first().click();await page.waitForFunction(()=>document.querySelector('.toast')?.textContent.includes('تم حفظ الإعدادات'));await page.evaluate(()=>db.flush());}
async function bg(){return page.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,fg:getComputedStyle(document.body).color,custom:document.documentElement.style.getPropertyValue('--bg'),theme:document.documentElement.dataset.theme}));}
async function test(name,fn){const started=Date.now();try{await fn();results.push({name,status:'passed',milliseconds:Date.now()-started});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:error.stack});console.error('FAIL '+name+': '+error.message);}}
try{
 await page.goto(base);await ready();
 await test('Custom background previews immediately and persists with player settings after reload',async()=>{
  await settings();await page.locator('#setting-name').fill('اختبار لون محفوظ');await page.locator('#setting-sounds').check();
  await color('#7432a8');assert.equal((await bg()).custom,'#7432a8');assert.equal(await page.locator('#setting-custom-background').isChecked(),true);
  await save();assert.equal(await page.evaluate(()=>S.settings.backgroundColor),'#7432a8');
  await page.reload();await ready();await settings();
  assert.equal((await bg()).custom,'#7432a8');assert.equal(await page.locator('#setting-background').inputValue(),'#7432a8');
  assert.equal(await page.locator('#setting-name').inputValue(),'اختبار لون محفوظ');assert.equal(await page.locator('#setting-sounds').isChecked(),true);
  const saved=await page.evaluate(()=>db.get('settings',{}));assert.equal(saved.backgroundColor,'#7432a8');assert.equal(saved.sounds,true);
 });
 await test('Saved color remains on other pages and white or black backgrounds adapt text contrast',async()=>{
  for(const next of ['home','units','challenges']){await page.evaluate(next=>go(next),next);assert.equal((await bg()).custom,'#7432a8');}
  await settings();await color('#ffffff');assert.deepEqual(await bg(),{bg:'rgb(255, 255, 255)',fg:'rgb(0, 0, 0)',custom:'#ffffff',theme:'light'});
  await color('#000000');assert.deepEqual(await bg(),{bg:'rgb(0, 0, 0)',fg:'rgb(255, 255, 255)',custom:'#000000',theme:'dark'});
  await color('#1fd8bc');await save();
 });
 await test('Reset preview and save restore default theme without losing name or sound preference',async()=>{
  await page.locator('#setting-theme').selectOption('light');await page.locator('[data-action="default-background"]').click();
  assert.equal(await page.locator('#setting-custom-background').isChecked(),false);assert.equal((await bg()).custom,'');assert.equal((await bg()).theme,'light');
  await save();await page.reload();await ready();await settings();
  assert.equal(await page.evaluate(()=>S.settings.backgroundColor),'');assert.equal((await bg()).custom,'');assert.equal((await bg()).theme,'light');
  assert.equal(await page.locator('#setting-name').inputValue(),'اختبار لون محفوظ');assert.equal(await page.locator('#setting-sounds').isChecked(),true);
 });
 await test('Theme toggle exits custom color and custom controls fit a mobile viewport',async()=>{
  await color('#1a247f');await save();
  await page.locator('[data-action="toggle-theme"]').click();await page.waitForFunction(()=>S.settings.backgroundColor===''&&document.documentElement.style.getPropertyValue('--bg')==='');
  assert.equal((await bg()).custom,'');assert.equal((await bg()).theme,'light');
  await page.setViewportSize({width:390,height:844});await settings();await color('#4e3190');await save();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await mkdir(new URL('artifacts/',root),{recursive:true});await page.screenshot({path:new URL('artifacts/background-mobile.png',root).pathname,fullPage:true});
 });
 await test('No browser errors or external network calls and frozen build stays unchanged',async()=>{
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  assert.equal(createHash('sha256').update(await readFile(new URL('dist/index.html',root))).digest('hex'),testedBuildSha256);
 });
}finally{
 await context.close();await browser.close();
 const report={generatedAt:new Date().toISOString(),testedBuildSha256,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,results,errors,externalRequests,limitations:['Account identity and cloud transport are synthetic fixtures; persistence is real browser IndexedDB.','No hosted Supabase authentication, actual cross-device cloud sync or physical device was used.']};
 await mkdir(new URL('test-results/',root),{recursive:true});await writeFile(new URL('test-results/background-ui-results.json',root),JSON.stringify(report,null,2)+'\n');
 console.log(`${report.passed} passed, ${report.failed} failed.`);process.exitCode=report.failed?1:0;
}
