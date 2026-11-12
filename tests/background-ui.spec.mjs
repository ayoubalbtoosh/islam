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
async function openHeader(){
 if(!await page.locator('#header-colors').count())await page.locator('[data-action="colors-toggle"]').click();
 await page.waitForSelector('#header-colors');
}
async function headerColor(key,value){
 const id=key==='sidebarColor'?'header-sidebar-color':'header-background';
 await openHeader();
 await page.locator('#'+id).evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);
 await page.waitForFunction(async ({key,value,id})=>(await db.get('settings',{}))[key]===value&&document.getElementById(id)?.value===value,{key,value,id});
 await page.evaluate(()=>db.flush());
}
const cssRGB=hex=>'rgb('+hex.slice(1).match(/../g).map(x=>parseInt(x,16)).join(', ')+')';
async function sidebar(){return page.evaluate(()=>({bg:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,fg:getComputedStyle(document.querySelector('.sidebar .nav-item')).color}));}
function contrast(a,b){
 const l=value=>{const [r,g,b]=value.match(/[0-9.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
 const x=l(a),y=l(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
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
 await test('Header color picker sits beside theme and account controls and keeps page and menu colors independent',async()=>{
  await openHeader();
  assert.equal(await page.evaluate(()=>{
   const saved={page:S.page,session:S.session,answer:autoAnswer};let submissions=0;
   try{S.page='game';S.session={phase:'question',questions:[{type:'multi_select'}],current:0};autoAnswer=async()=>{submissions++;};
    document.getElementById('header-background').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return submissions;
   }finally{S.page=saved.page;S.session=saved.session;autoAnswer=saved.answer;}
  }),0,'Enter in the color panel must not submit a game answer');
  await page.setViewportSize({width:1366,height:900});
  for(const next of ['home','units','challenges']){
   await page.evaluate(next=>go(next),next);
   assert.equal(await page.locator('.topbar [data-action="colors-toggle"]').count(),1);
   assert.equal(await page.locator('.topbar [data-action="toggle-theme"]').count(),1);
   assert.equal(await page.locator('.topbar .avatar').count(),1);
  }
  await headerColor('backgroundColor','#315288');await headerColor('sidebarColor','#faf1a7');
  assert.equal((await bg()).custom,'#315288');assert.equal((await sidebar()).bg,cssRGB('#faf1a7'));
  assert.ok(contrast((await sidebar()).bg,(await sidebar()).fg)>=4.5,'Sidebar text must contrast with its own chosen background');
  await page.reload();await ready();await openHeader();
  assert.equal((await bg()).custom,'#315288');assert.equal((await sidebar()).bg,cssRGB('#faf1a7'));
  assert.equal(await page.locator('#header-background').inputValue(),'#315288');
  assert.equal(await page.locator('#header-sidebar-color').inputValue(),'#faf1a7');
  const saved=await page.evaluate(()=>db.get('settings',{}));assert.equal(saved.backgroundColor,'#315288');assert.equal(saved.sidebarColor,'#faf1a7');
 });
 await test('Resetting either header color preserves the other color and existing player preferences',async()=>{
  await page.locator('[data-action="colors-reset"][data-target="backgroundColor"]').click();
  await page.waitForFunction(async ()=>(await db.get('settings',{})).backgroundColor==='');
  assert.equal((await bg()).custom,'');assert.equal((await sidebar()).bg,cssRGB('#faf1a7'));
  await headerColor('backgroundColor','#0a5566');
  await page.locator('[data-action="colors-reset"][data-target="sidebarColor"]').click();
  await page.waitForFunction(async ()=>(await db.get('settings',{})).sidebarColor==='');
  assert.equal((await bg()).custom,'#0a5566');assert.notEqual((await sidebar()).bg,cssRGB('#faf1a7'));
  await page.reload();await ready();
  assert.equal((await bg()).custom,'#0a5566');
  const saved=await page.evaluate(()=>db.get('settings',{}));assert.equal(saved.sidebarColor,'');assert.equal(saved.sounds,true);
  assert.equal(await page.evaluate(()=>S.profile.name),'اختبار لون محفوظ');
 });
 await test('Header picker and colored mobile menu fit narrow screens and Escape restores button focus',async()=>{
  for(const width of [360,390]){
   await page.setViewportSize({width,height:844});await page.evaluate(()=>go('home'));await openHeader();
   const panel=await page.locator('#header-colors').boundingBox();assert.ok(panel.x>=0&&panel.x+panel.width<=width+1,'Picker must fit viewport');
   if(width===390)await page.screenshot({path:new URL('artifacts/header-colors-mobile.png',root).pathname});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.keyboard.press('Escape');await page.waitForSelector('#header-colors',{state:'hidden'});
   assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'colors-toggle');
  }
  await openHeader();await headerColor('sidebarColor','#ffffff');
  await page.locator('[data-action="colors-close"]').click();await page.waitForSelector('#header-colors',{state:'hidden'});
  await page.locator('[data-action="menu"]').first().click();await page.waitForSelector('.layout.sidebar-open');
  assert.equal((await sidebar()).bg,cssRGB('#ffffff'));assert.ok(contrast((await sidebar()).bg,(await sidebar()).fg)>=4.5);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await mkdir(new URL('artifacts/',root),{recursive:true});await page.screenshot({path:new URL('artifacts/header-sidebar-mobile.png',root).pathname});
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
