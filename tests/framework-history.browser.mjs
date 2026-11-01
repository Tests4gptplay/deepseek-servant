// Run: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/framework-history.browser.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
await mkdir('.validation/history-browser', { recursive: true })
await build({ entryPoints: ['tests/fixtures/framework-history-browser.tsx'], outfile: '.validation/history-browser/app.js', bundle: true, jsx: 'automatic', platform: 'browser', format: 'esm', loader: { '.ttf':'dataurl', '.woff':'dataurl', '.woff2':'dataurl' },
  define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])),
  plugins: process.env.HISTORY_RED ? [{ name: 'baseline', setup(b) { b.onResolve({filter: /(?:client-page|client-contracts)\.js$/}, args => ({ path: resolve('.validation/history-baseline/src/framework', args.path.split('/').at(-1).replace(/\.js$/, args.path.includes('client-page') ? '.tsx' : '.ts')) })) } }] : [],
})
const html = '<!doctype html><link rel="stylesheet" href="/app.css"><style>html,body,#root{height:100%;margin:0}#root>section{height:100%;box-sizing:border-box}button{min-height:24px} [role=log]{height:300px;flex:1;min-height:120px}</style><div id="root"></div><script type="module" src="/app.js"></script>'
const server = createServer(async (req,res) => { if(req.url==='/'){res.end(html);return} const name=req.url==='/app.css'?'app.css':'app.js';res.setHeader('content-type',name.endsWith('css')?'text/css':'text/javascript');res.end(await readFile('.validation/history-browser/'+name)) })
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message))
try {
  await page.goto('http://127.0.0.1:'+server.address().port);const log=page.getByRole('log');await page.waitForFunction(()=>document.querySelectorAll('[role=log] article').length===50,undefined,{timeout:5000})
  const state=()=>log.evaluate(e=>({top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,ids:[...e.querySelectorAll('article[data-message-id]')].map(x=>x.dataset.messageId)}))
  const count=async n=>page.waitForFunction(n=>document.querySelectorAll('[role=log] article').length===n,n,{timeout:5000})
  const anchorBefore=await log.evaluate(e=>{e.scrollTop=0;const row=e.querySelector('article');const anchor={id:row.dataset.messageId,offset:row.getBoundingClientRect().top-e.getBoundingClientRect().top};e.dispatchEvent(new WheelEvent('wheel',{deltaY:-50,bubbles:true}));return anchor});await count(100)
  const anchorAfter=await log.evaluate((e,id)=>[...e.querySelectorAll('article')].find(row=>row.dataset.messageId===id).getBoundingClientRect().top-e.getBoundingClientRect().top,anchorBefore.id);assert.ok(Math.abs(anchorAfter-anchorBefore.offset)<2,'same original row stays at the same pixel offset')
  let s=await state();assert.equal(new Set(s.ids).size,100);assert.ok(s.top>0,'prepend anchors existing rows')
  for(const n of [150,200,240]){await log.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new WheelEvent('wheel',{deltaY:-50,bubbles:true}))});await count(n)}
  s=await state();assert.deepEqual(s.ids,Array.from({length:240},(_,i)=>'qa-'+String(i).padStart(4,'0')))
  await log.evaluate(e=>{e.scrollTop=e.scrollHeight/2});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const mid=(await state()).top;await page.evaluate(()=>window.qa.append());await count(241);assert.ok(Math.abs((await state()).top-mid)<2,'middle reader is not pulled down')
  await log.evaluate(e=>{e.scrollTop=0});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.evaluate(()=>window.qa.append());await count(242);assert.equal((await state()).top,0)
  await log.evaluate(e=>{e.scrollTop=e.scrollHeight});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.evaluate(()=>window.qa.append());await count(243);s=await state();assert.ok(s.height-s.top-s.client<2,'bottom follower remains at bottom')
  await page.getByLabel('Saved date (UTC)',{exact:true}).fill('2026-10-30');await page.getByRole('button',{name:'Browse date',exact:true}).click();await count(50)
  await page.getByRole('button',{name:'Newer messages',exact:true}).click();await count(30)
  await log.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new WheelEvent('wheel',{deltaY:-50,bubbles:true}))});await count(80);assert.deepEqual((await state()).ids,Array.from({length:80},(_,i)=>'qa-'+String(i+80).padStart(4,'0')))
  await page.getByRole('button',{name:'Jump to latest',exact:true}).click();await count(50);await page.evaluate(()=>window.qa.hold());await log.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new WheelEvent('wheel',{deltaY:-50,bubbles:true}));e.dispatchEvent(new WheelEvent('wheel',{deltaY:-50,bubbles:true}))});
  await page.waitForFunction(()=>document.querySelector('[role=log]').getAttribute('aria-busy')==='true');const calls=await page.evaluate(()=>window.qa.calls.length)
  await page.getByLabel('Saved date (UTC)',{exact:true}).fill('2026-10-29');await page.getByRole('button',{name:'Browse date',exact:true}).click();await count(50);await page.evaluate(()=>window.qa.release());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.ok((await state()).ids.every(id=>id<'qa-0080'));assert.equal(await page.evaluate(()=>window.qa.calls.length),calls+1)
  await page.getByRole('button',{name:'Jump to latest',exact:true}).click();await count(50);await page.evaluate(()=>window.qa.hold());await log.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new WheelEvent('wheel',{deltaY:-50,bubbles:true}))});await page.waitForFunction(()=>document.querySelector('[role=log]').getAttribute('aria-busy')==='true');await page.getByText('DSS-cah',{exact:true}).click();await page.evaluate(()=>window.qa.release());await count(0)
  await page.getByText('Local',{exact:true}).click();await count(50);await page.evaluate(()=>window.qa.hold());await log.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new WheelEvent('wheel',{deltaY:-50,bubbles:true}))});await page.waitForFunction(()=>document.querySelector('[role=log]').getAttribute('aria-busy')==='true');await page.evaluate(()=>window.qa.directory());await count(0);await page.evaluate(()=>window.qa.release());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal((await state()).ids.length,0)
  assert.deepEqual(errors,[]);console.log('PASS: actual React page in Chromium: 240 originals, date pagination, deduplication, middle/top anchoring, bottom following, date/mode/directory late-response isolation')
} catch(error) { console.error(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error } finally {await browser.close();await new Promise(r=>server.close(r))}
