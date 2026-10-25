import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelPicker } from '../src/client/model-picker.js'
import type { ServantModels } from '../src/client/models.js'

const front = { provider: 'front', model: 'foreground-model', reasoningEffort: 'max' }
const models = { current: { provider: 'host', model: 'ordinary-chat', reasoningEffort: 'low' },
  groups: [
    { id: 'front', name: 'Front', models: [{ id: 'foreground-model', name: 'Foreground model', reasoning: { defaultEffort: 'max', efforts: [{ id: 'max', name: 'Max' }] } }] },
    { id: 'host', name: 'Host', models: [{ id: 'ordinary-chat', name: 'Ordinary chat' }] },
  ], failures: [], status: 'ready', error: null } as unknown as ServantModels
function view(props: Parameters<typeof ModelPicker>[0]) {
  const element = ModelPicker(props)
  const anchor = element.props.anchor
  return JSON.stringify({ caption: anchor.props.children[0].props.children, items: element.props.items })
}
const base = { models, onChange: () => {}, onRefresh: async () => {}, label: 'Model', t: (key: string) => key } as const
test('composer presents the foreground model without Auto and keeps the reasoning selector', () => {
  const html = view({ ...base, composer: true, value: front })
  assert.match(html, /Foreground model · Max/)
  assert.match(html, /model.effort/)
  assert.doesNotMatch(html, /Auto|Ordinary chat/)
})
test('background Auto keeps the foreground caption and opens the complete model list directly', () => {
  const element = ModelPicker({ ...base, value: {}, followModel: front })
  const caption = element.props.anchor.props.children[0].props.children
  assert.equal(caption, 'Auto · Foreground model · Max')
  const ids = element.props.items.map((item: { id: string }) => item.id)
  assert.ok(ids.includes('auto'))
  assert.ok(ids.includes(JSON.stringify(['front', 'foreground-model'])))
  assert.ok(ids.includes(JSON.stringify(['host', 'ordinary-chat'])))
  assert.ok(!ids.includes('model') && !ids.includes('back'))
})
test('an uninitialized foreground displays its initial concrete choice without Auto', () => {
  const html = view({ ...base, composer: true, value: {} })
  assert.match(html, /Ordinary chat/)
  assert.doesNotMatch(html, /Auto/)
})
