import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const host = process.env.DSS_SDK_HOST_ROOT, sourceRoot = new URL('../', import.meta.url).pathname
assert.ok(host, 'explicit SDK Host root')
const requireHost = createRequire(host + '/package.json')
const { JSDOM } = requireHost('jsdom'), esbuild = requireHost('esbuild')
const React = requireHost('react')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Event = dom.window.Event
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = requireHost('react-dom/client')
const { Simulate } = requireHost('react-dom/test-utils')

const page = fs.readFileSync(sourceRoot + '/src/framework/client-page.tsx', 'utf8')
assert.ok(page.includes("{tab === 'conversation' && <div className={css.conversation}>"))
assert.ok(page.includes("props.nativeQuestions?.(view?.executions ?? [], zh)"))
let sdk
window.__ModuleLoader__ = { load({ factory }) {
  sdk = factory(name => name === '@deepseek-ai/dsh-client-store' || name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : requireHost(name))
} }
const sdkSource = fs.readFileSync(host + '/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js', 'utf8')
  .replace('exports.apply = apply;', 'exports.__audit = { PendingQuestion, createWaterfallRequest }; exports.apply = apply;')
new Function('window', sdkSource)(window)
const { PendingQuestion, createWaterfallRequest } = sdk.__audit

async function loadComponent(entry) {
  const built = await esbuild.build({ entryPoints: [entry],
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, packages: 'external',
    plugins: [{ name: 'markdown-shim', setup(build) {
      build.onResolve({ filter: /client-markdown/ }, args => ({ path: args.path, namespace: 'markdown-shim' }))
      build.onLoad({ filter: /.*/, namespace: 'markdown-shim' }, () => ({ contents: 'exports.FrameworkMarkdown = () => null', loader: 'js' }))
    } }] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireHost, module, module.exports)
  return module.exports.NativeQuestionRegion
}
const candidate = await loadComponent(sourceRoot + '/src/client/native-questions.tsx')
async function run(Component) {
  const card = new PendingQuestion('session-a', [{ id: 'q', header: 'Decision', question: 'Choose', options: [{ label: 'A' }] }], 'call-a')
  const waterfall = createWaterfallRequest(Date.now() + 60_000, undefined, channel => card.detachWaterfall(channel))
  card.attachWaterfall(waterfall.channel)
  const statuses = new Map([['session-a', { pendingInteraction: card }]])
  const uiSession = { sessionStatus: { getSnapshot: () => statuses, subscribe: () => () => {} } }
  const services = { uiSession, generation: 0 }
  const client = { getSnapshot: () => services, subscribe: () => () => {} }
  const execution = { sessionId: 'session-a', executionId: 'execution-a', workId: 'work-a', role: 'Worker', state: 'running' }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function App() {
    const [tab, setTab] = React.useState('conversation')
    return React.createElement(React.Fragment, null,
      React.createElement('button', { id: 'tab', onClick: () => setTab(value => value === 'conversation' ? 'tasks' : 'conversation') }, tab),
      tab === 'conversation' && React.createElement(Component, { client, executions: [execution], zh: false }))
  }
  try {
    await React.act(async () => root.render(React.createElement(App)))
    const option = container.querySelector('input[type=radio]')
    assert.ok(option)
    await React.act(async () => Simulate.change(option, { target: { checked: true } }))
    assert.equal(container.querySelector('input[type=radio]').checked, true)
    assert.equal(card.getSnapshot().waitState, 'editing')
    assert.equal(card.getSnapshot().channel, 'waterfall')
    await React.act(async () => container.querySelector('#tab').click())
    assert.equal(container.querySelector('#tab').textContent, 'tasks')
    assert.equal(container.querySelector('input[type=radio]'), null)
    await React.act(async () => container.querySelector('#tab').click())
    assert.equal(container.querySelector('#tab').textContent, 'conversation')
    const retainedChoice = container.querySelector('input[type=radio]')?.checked ?? false
    const activeCard = card.getSnapshot().channel === 'waterfall' && !card.getSnapshot().closed
    if (retainedChoice) {
      const submit = [...container.querySelectorAll('button')].find(button => button.textContent === 'Submit answers')
      assert.ok(submit)
      await React.act(async () => submit.click())
      assert.deepEqual((await waterfall.result).answers, [{ id: 'q', selected: ['A'] }])
    } else await React.act(async () => waterfall.channel.resolve({ answers: [{ id: 'q', selected: ['A'] }] }))
    return { retainedChoice, activeCard }
  } finally {
    await React.act(async () => root.unmount())
    container.remove()
  }
}
const fixed = await run(candidate)
assert.deepEqual(fixed, { retainedChoice: true, activeCard: true })
// A new native card, even with an equal displayed question or call key, is
// not the old answer draft. The existing card survives only while it is live.
async function identityAndModeChecks(Component) {
  const question = [{ id:'q', header:'Decision', question:'Choose', options:[{label:'A'}] }]
  const makeCard=(sessionId,callId)=>{const card=new PendingQuestion(sessionId,question,callId)
    const waterfall=createWaterfallRequest(undefined,undefined,channel=>card.detachWaterfall(channel));card.attachWaterfall(waterfall.channel)
    return{card,waterfall}}
  const local=makeCard('session-local','same-call'), git=makeCard('session-git','same-call')
  const rows=new Map([['session-local',{pendingInteraction:local.card}],['session-git',{pendingInteraction:git.card}]])
  const uiSession={sessionStatus:{getSnapshot:()=>rows,subscribe:()=>()=>{}}},services={uiSession,generation:0},client={getSnapshot:()=>services,subscribe:()=>()=>{}}
  const execution=sessionId=>({sessionId,executionId:'execution-'+sessionId,workId:'work-'+sessionId,role:'Worker',state:'running'})
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
  function App(){const [tab,setTab]=React.useState('conversation'),[mode,setMode]=React.useState('local')
    return React.createElement(React.Fragment,null,
      React.createElement('button',{id:'tab',onClick:()=>setTab(value=>value==='conversation'?'tasks':'conversation')},tab),
      React.createElement('button',{id:'mode',onClick:()=>setMode(value=>value==='local'?'git':'local')},mode),
      tab==='conversation'&&React.createElement(Component,{client,executions:[execution('session-'+mode)],zh:false}))}
  const option=()=>container.querySelector('input[type=radio]')
  const tab=async()=>React.act(async()=>container.querySelector('#tab').click())
  const mode=async()=>React.act(async()=>container.querySelector('#mode').click())
  try{
    await React.act(async()=>root.render(React.createElement(App)))
    await React.act(async()=>Simulate.change(option(),{target:{checked:true}}))
    assert.equal(option().checked,true)
    await tab();await mode();await tab()
    assert.equal(container.querySelector('#mode').textContent,'git')
    assert.equal(option().checked,false,'another mode/session cannot see Local draft')
    await tab();await mode();await tab()
    assert.equal(option().checked,true,'returning to same Local card restores its own draft')
    await tab()
    const replacement=makeCard('session-local','same-call')
    local.card.close()
    rows.set('session-local',{pendingInteraction:replacement.card})
    await tab()
    assert.equal(option().checked,false,'closed old card cannot transfer draft to new card with same key')
    await React.act(async()=>Simulate.change(option(),{target:{checked:true}}))
    const submit=[...container.querySelectorAll('button')].find(node=>node.textContent==='Submit answers')
    await React.act(async()=>submit.click())
    assert.deepEqual((await replacement.waterfall.result).answers,[{id:'q',selected:['A']}])
    assert.equal(container.querySelector('input[type=radio]'),null,'answered waterfall no longer has an answer form')
    git.waterfall.channel.resolve({answers:[{id:'q',selected:['A']}]})
    local.waterfall.channel.resolve({answers:[{id:'q',selected:['A']}]})
    return{sameCardRetained:true,otherModeBlank:true,closedReplacementBlank:true,originalAnswerSubmitted:true}
  }finally{await React.act(async()=>root.unmount());container.remove()}
}
const boundaries=await identityAndModeChecks(candidate)
console.log(JSON.stringify({ status: 'passed', candidate: fixed, boundaries,
  limits: 'Actual shipped rc.5 PendingQuestion and waterfall plus production NativeQuestionRegion in React jsdom. A wrapper performs the same ordinary Conversation→Tasks conditional unmount from current client-page.tsx; not full FrameworkPage or DSH Host.' }, null, 2))
