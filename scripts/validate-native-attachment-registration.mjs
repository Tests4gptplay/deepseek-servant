import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
const source = await fs.readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
const actualRegistration = source.split('\n').find(line => line.includes("ctx.slots.inject('main',"))
assert.ok(actualRegistration)
assert.equal(actualRegistration.includes("'conversation.input.attachments'"), false)
assert.equal(actualRegistration.includes("'deepseek-servant.interaction'"), true)
const Empty = () => null
const create = () => {
  const core = new SlotCore()
  core.register({name:'root', children:{main:{kind:'keyed', scope:'root'},'conversation.composer.bar':{kind:'single',scope:'session-maybe'}}}, Empty)
  return core
}
const native = core => core.register({name:'conversation.composer.bar', children:{'conversation.input.attachments':{kind:'single',scope:'session-maybe'}}},Empty)
const candidate = core => new Function('ctx','MainPage','PANEL_ID','NS',actualRegistration)({slots:{register:core.register.bind(core),inject:(_name,fn)=>fn()}},Empty,'deepseek-servant','deepseek-servant')
const previous=create();native(previous)
assert.throws(()=>previous.register({name:'main',key:'deepseek-servant',children:{'conversation.input.attachments':{kind:'single',scope:'session-maybe'}}},Empty),/already declared/)
for(const order of ['native-first','candidate-first']) {
 const core=create()
 if(order==='native-first'){native(core);candidate(core)}else{candidate(core);native(core)}
 assert.deepEqual(core.specDynamic('conversation.input.attachments'),{kind:'single',scope:'session-maybe'})
 assert.equal(core.entriesOfSlot('main').length,1)
 assert.equal(core.entriesOfSlot('conversation.composer.bar').length,1)
  assert.deepEqual(core.specDynamic('deepseek-servant.interaction'),{kind:'single',scope:'session'})
}
console.log(JSON.stringify({status:'passed',sdk:'0.2.2-rc.3',actualRegistration:actualRegistration.trim(),checks:['Previous duplicate child declaration reproduces failure in actual SlotCore','Candidate actual registration succeeds native-first','Candidate actual registration succeeds candidate-first','Official child declaration and both entries retained'],limits:'Actual SlotCore registry, dummy render components only. This is not a browser or full plugin boot test.'},null,2))
