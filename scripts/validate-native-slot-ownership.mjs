import assert from 'node:assert/strict'
import {SlotCore} from '@deepseek-ai/dsh-client-ui-slots'
const core=new SlotCore();const Empty=()=>null;const checks=[]
core.register({name:'root',children:{main:{kind:'single',scope:'root'}}},Empty)
core.registerFactory({name:'conversation.content',scope:'session-maybe',children:{'conversation.composer':{kind:'chain',scope:'session'}}},Empty)
core.register({name:'main',children:{'deepseek-servant.interaction':{kind:'single',scope:'session'}}},Empty)
assert.throws(()=>core.register({name:'deepseek-servant.interaction',children:{'conversation.composer':{kind:'chain',scope:'session'}}},Empty),/already declared/);checks.push('actual official SlotCore rejects old duplicate composer declaration')
const dispose=core.register({name:'deepseek-servant.interaction'},Empty);checks.push('actual official SlotCore accepts isolated session seat without claiming native child')
assert.ok(core.factory('conversation.content'));checks.push('official existing factory remains available')
dispose();assert.ok(core.factory('conversation.content'));checks.push('DSS seat disposal does not remove native factory')
console.log(JSON.stringify({status:'passed',checks,limits:'Official installed rc3 SlotCore registration contract; not browser rendering or native user answer.'},null,2))
