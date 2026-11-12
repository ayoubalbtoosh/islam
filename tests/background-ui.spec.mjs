/** Curated theme swatches with real IndexedDB persistence and synthetic account transport. */
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
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
const selector=(key,color)=>`.color-swatch[data-action="color-preset"][data-target="${key}"][data-color="${color}"]`;
const cssRGB=hex=>'rgb('+hex.slice(1).match(/../g).map(value=>parseInt(value,16)).join(', ')+')';
async function ready(){await page.waitForFunction(()=>S.ready&&Auth.current().mode==='account');}
async function openHeader(){
 if(!await page.locator('#header-colors').count())await page.locator('.topbar [data-action="colors-toggle"]').click();
 await page.waitForSelector('#header-colors');
}
async function target(key){
 await openHeader();await page.locator(`[data-action="colors-target"][data-target="${key}"]`).click();
 await page.waitForSelector(`.color-swatches[data-target="${key}"]`);
}
async function choose(key,color){
 await target(key);await page.locator(selector(key,color)).click();
 await page.waitForFunction(async ({key,color})=>S.settings[key]===color&&(await db.get('settings',{}))[key]===color&&document.querySelector(`.color-swatch[data-target="${key}"][data-color="${color}"]`)?.getAttribute('aria-pressed')==='true',{key,color});
 await page.evaluate(()=>db.flush());
}
async function reset(key){
 await target(key);await page.locator(`[data-action="colors-reset"][data-target="${key}"]`).click();
 await page.waitForFunction(async key=>S.settings[key]===''&&(await db.get('settings',{}))[key]==='',key);
}
async function sidebar(){return page.evaluate(()=>({bg:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,fg:getComputedStyle(document.querySelector('.sidebar .nav-item')).color}));}
async function canvas(){return page.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,fg:getComputedStyle(document.body).color,custom:document.documentElement.style.getPropertyValue('--bg'),theme:document.documentElement.dataset.theme}));}
function contrast(a,b){
 const luminance=value=>{const [r,g,b]=value.match(/[0-9.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
 const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
async function test(name,run){const started=Date.now();try{await run();results.push({name,status:'passed',milliseconds:Date.now()-started});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:error.stack});console.error('FAIL '+name+': '+error.message);}}
try{
 await page.goto(base);await ready();
 await mkdir(new URL('artifacts/',root),{recursive:true});
 await test('Header offers a large unnamed preset palette instead of free color inputs on every page',async()=>{
  for(const next of ['home','units','challenges','settings']){
   await page.evaluate(next=>go(next),next);
   assert.equal(await page.locator('.topbar [data-action="colors-toggle"]').count(),1);
   assert.equal(await page.locator('.topbar [data-action="toggle-theme"]').count(),1);
   assert.equal(await page.locator('.topbar .avatar').count(),1);
   assert.equal(await page.locator('input[type="color"]').count(),0,'No arbitrary native color picker remains');
  }
  await target('backgroundColor');
  const swatches=await page.locator('.color-swatches .color-swatch').evaluateAll(elements=>elements.map(element=>({color:element.dataset.color,text:element.textContent.trim(),label:element.getAttribute('aria-label')})));
  assert.equal(swatches.length,72);assert.equal(new Set(swatches.map(s=>s.color)).size,72);
  for(const value of ['#000000','#ffffff','#ff0000','#00ff00','#0000ff','#ffff00','#00ffff','#ff00ff'])assert.ok(swatches.some(s=>s.color===value),'Missing primary or neutral preset '+value);
  assert.ok(swatches.every(s=>/^#[0-9a-f]{6}$/.test(s.color)&&s.text===''&&s.label),'Tiles need anonymous visuals and accessible labels');
  const text=await page.locator('#header-colors').innerText();assert.equal(/#[0-9a-f]{6}/i.test(text),false);
  assert.equal(/كئيب|ألوان أساسية|ألوان صافية/.test(text),false,'Do not name color families');
 });
 await test('Preset choices save automatically and independently for page and menu after reload',async()=>{
  await choose('backgroundColor','#0000ff');await choose('sidebarColor','#ffffff');
  assert.equal((await canvas()).bg,cssRGB('#0000ff'));assert.equal((await sidebar()).bg,cssRGB('#ffffff'));
  await page.reload();await ready();await target('backgroundColor');
  assert.equal(await page.locator(selector('backgroundColor','#0000ff')).getAttribute('aria-pressed'),'true');
  await target('sidebarColor');assert.equal(await page.locator(selector('sidebarColor','#ffffff')).getAttribute('aria-pressed'),'true');
  assert.equal((await canvas()).bg,cssRGB('#0000ff'));assert.equal((await sidebar()).bg,cssRGB('#ffffff'));
  const saved=await page.evaluate(()=>db.get('settings',{}));assert.equal(saved.backgroundColor,'#0000ff');assert.equal(saved.sidebarColor,'#ffffff');
 });
 await test('White and black preset backgrounds keep main and menu text independently readable',async()=>{
  for(const color of ['#ffffff','#000000']){
   await choose('backgroundColor',color);let state=await canvas();assert.equal(state.bg,cssRGB(color));assert.ok(contrast(state.bg,state.fg)>=4.5);
   await choose('sidebarColor',color);state=await sidebar();assert.equal(state.bg,cssRGB(color));assert.ok(contrast(state.bg,state.fg)>=4.5);
  }
  await choose('backgroundColor','#0000ff');await choose('sidebarColor','#ffffff');
 });
 await test('Saving ordinary player settings preserves both preset choices and needs no free color input',async()=>{
  await page.evaluate(()=>go('settings'));await page.locator('#setting-name').fill('اختبار ألوان محفوظة');await page.locator('#setting-sounds').check();
  assert.equal(await page.locator('input[type="color"]').count(),0);
  await page.locator('[data-action="save-settings"]').first().click();
  await page.waitForFunction(async ()=>S.profile.name==='اختبار ألوان محفوظة'&&(await db.get('profile',{})).name==='اختبار ألوان محفوظة');
  const saved=await page.evaluate(()=>db.get('settings',{}));assert.equal(saved.backgroundColor,'#0000ff');assert.equal(saved.sidebarColor,'#ffffff');assert.equal(saved.sounds,true);
  await page.reload();await ready();assert.equal(await page.evaluate(()=>S.profile.name),'اختبار ألوان محفوظة');
  assert.equal((await canvas()).bg,cssRGB('#0000ff'));assert.equal((await sidebar()).bg,cssRGB('#ffffff'));
 });
 await test('Each default reset leaves the other saved color and account preferences unchanged',async()=>{
  await reset('backgroundColor');assert.equal((await canvas()).custom,'');assert.equal((await sidebar()).bg,cssRGB('#ffffff'));
  await choose('backgroundColor','#ff0000');await reset('sidebarColor');assert.equal((await canvas()).custom,'#ff0000');
  assert.notEqual((await sidebar()).bg,cssRGB('#ffffff'));
  await page.reload();await ready();const saved=await page.evaluate(()=>db.get('settings',{}));
  assert.equal(saved.backgroundColor,'#ff0000');assert.equal(saved.sidebarColor,'');assert.equal(saved.sounds,true);
  assert.equal(await page.evaluate(()=>S.profile.name),'اختبار ألوان محفوظة');
 });
 await test('Keyboard navigation selects presets without submitting game answers and Escape restores focus',async()=>{
  await target('backgroundColor');
  const swatches=page.locator('.color-swatches .color-swatch');await swatches.first().focus();
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement?.dataset.color),await swatches.last().getAttribute('data-color'));
  await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement?.dataset.color),await swatches.first().getAttribute('data-color'));
  await page.keyboard.press('ArrowRight');let selected=await page.evaluate(()=>document.activeElement?.dataset.color);assert.ok(selected&&selected!==await swatches.first().getAttribute('data-color'));
  await page.keyboard.press('Space');await page.waitForFunction(async color=>(await db.get('settings',{})).backgroundColor===color,selected);
  assert.equal(await page.evaluate(()=>{
   const saved={page:S.page,session:S.session,answer:autoAnswer};let submitted=0;
   try{S.page='game';S.session={phase:'question',questions:[{type:'multi_select'}],current:0};autoAnswer=async()=>{submitted++;};
    document.querySelector('.color-swatches .color-swatch').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return submitted;
   }finally{S.page=saved.page;S.session=saved.session;autoAnswer=saved.answer;}
  }),0);
  await page.keyboard.press('Escape');await page.waitForSelector('#header-colors',{state:'hidden'});assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'colors-toggle');
 });
 await test('Preset panel and independently colored mobile menu fit 360 and 390 pixel screens',async()=>{
  for(const width of [360,390]){
   await page.setViewportSize({width,height:844});await page.evaluate(()=>go('home'));await target('backgroundColor');
   const panel=await page.locator('#header-colors').boundingBox();assert.ok(panel.x>=0&&panel.x+panel.width<=width+1);assert.ok(panel.height<=844-100);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   if(width===390)await page.screenshot({path:new URL('artifacts/preset-colors-mobile.png',root).pathname});
   await page.keyboard.press('Escape');await page.waitForSelector('#header-colors',{state:'hidden'});
  }
  await choose('backgroundColor','#0000ff');await choose('sidebarColor','#ffffff');
  await page.locator('[data-action="colors-close"]').click();await page.waitForSelector('#header-colors',{state:'hidden'});
  await page.locator('[data-action="menu"]').first().click();await page.waitForSelector('.layout.sidebar-open');
  const menu=await sidebar();assert.equal(menu.bg,cssRGB('#ffffff'));assert.ok(contrast(menu.bg,menu.fg)>=4.5);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.mobile-bottom')).backgroundColor),cssRGB('#ffffff'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:new URL('artifacts/preset-sidebar-mobile.png',root).pathname});
 });
 await test('Matching inline book favicon decodes and the frozen build has no browser errors or external requests',async()=>{
  const icon=await page.evaluate(async()=>{
   const link=document.querySelector('link[rel="icon"][type="image/svg+xml"]');if(!link)return null;
   const img=new Image();img.src=link.href;await img.decode();
   return {href:link.href,width:img.naturalWidth,height:img.naturalHeight,svg:decodeURIComponent(link.href.split(',').slice(1).join(','))};
  });
  assert.ok(icon&&icon.href.startsWith('data:image/svg+xml,'));assert.ok(icon.width>=16&&icon.height>=16);assert.ok(/<svg/.test(icon.svg));assert.ok(/path|rect/.test(icon.svg));
  assert.ok(/082c23|0da979/i.test(icon.svg),'Icon must match green branding');
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  assert.equal(createHash('sha256').update(await readFile(new URL('dist/index.html',root))).digest('hex'),testedBuildSha256);
 });
}finally{
 await context.close();await browser.close();
 const report={generatedAt:new Date().toISOString(),testedBuildSha256,passed:results.filter(result=>result.status==='passed').length,failed:results.filter(result=>result.status==='failed').length,results,errors,externalRequests,limitations:['Account identity and cloud transport are synthetic fixtures; persistence is real browser IndexedDB.','No hosted Supabase authentication, actual cross-device cloud sync or physical device was used.','Favicon link and SVG decoding were tested; browser chrome screenshot rendering itself is outside page automation.']};
 await mkdir(new URL('test-results/',root),{recursive:true});await writeFile(new URL('test-results/background-ui-results.json',root),JSON.stringify(report,null,2)+'\n');
 console.log(`${report.passed} passed, ${report.failed} failed.`);process.exitCode=report.failed?1:0;
}
