import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveNativeRecoveryInput } from '../src/framework/native-recovery-input.js'
import type { AssistantInputEvidence } from '../src/contracts/assistant.js'

const previous = { id: 'A', taskId: 'A' }
const delivery = { request: { id: 'B', taskId: 'B' }, messageId: 'native-B', text: 'original B', confirmed: false }
for (const state of ['queued', 'consumed', 'claimed', 'discarded'] as const) {
  test(`native ${state} evidence preserves B responsibility and original body rather than old A`, () => {
    const input: AssistantInputEvidence = { state, text: 'original B', source: 'deepseek-servant', ...(state === 'claimed' ? { active: false } : {}) }
    const resolved = resolveNativeRecoveryInput(delivery, previous, new Map([['native-B', input]]))!
    assert.equal(resolved.request.taskId, 'B')
    assert.equal(resolved.messageId, 'native-B')
    assert.equal(resolved.text, 'original B')
    assert.equal(resolved.state, state)
    assert.equal(resolved.active, false)
  })
}
test('unadmitted delivery remains B pending responsibility, not proof that B ran', () => {
  const resolved = resolveNativeRecoveryInput(delivery, previous, new Map())!
  assert.equal(resolved.request.taskId, 'B'); assert.equal(resolved.state, 'unadmitted')
  assert.equal(resolved.text, 'original B')
})
test('active claim stays distinct from model consumption and missing saved text uses actual original', () => {
  const resolved = resolveNativeRecoveryInput({ ...delivery, text: undefined }, undefined,
    new Map([['native-B', { state: 'claimed', active: true, text: 'native original', source: 'deepseek-servant' }]]))!
  assert.equal(resolved.state, 'claimed'); assert.equal(resolved.active, true); assert.equal(resolved.text, 'native original')
})
test('conflicting text for one native identity is not reconstructed or silently accepted', () => {
  assert.throws(() => resolveNativeRecoveryInput(delivery, previous,
    new Map([['native-B', { state: 'queued', text: 'different', source: 'deepseek-servant' }]])), /differs/)
})
test('legacy last request without a native identity remains unknown rather than assumed unadmitted', () => {
  const resolved = resolveNativeRecoveryInput(undefined, previous, new Map())!
  assert.equal(resolved.state, 'unknown'); assert.equal(resolved.messageId, undefined)
  assert.equal(resolveNativeRecoveryInput(undefined, undefined, new Map()), undefined)
})

import { nativeRecoveryWakeId } from '../src/framework/native-recovery-input.js'
test('one pending recovery explanation keeps its identity across repeated recovery attempts', () => {
  const first = nativeRecoveryWakeId('session', 4, 'B')
  for (const state of ['queued', 'claimed', 'discarded', 'unadmitted', 'unknown'] as const) {
    assert.equal(nativeRecoveryWakeId('session', 5, 'B', { id: first, state }), first)
  }
})
test('one newly interrupted turn has one stable recovery identity and distinct real turns may each recover', () => {
  const first = nativeRecoveryWakeId('session', 4, 'B')
  const second = nativeRecoveryWakeId('session', 5, first, { id: first, state: 'consumed' })
  assert.notEqual(second, first)
  assert.equal(nativeRecoveryWakeId('session', 5, first, { id: first, state: 'consumed' }), second)
  assert.notEqual(nativeRecoveryWakeId('session', 6, second, { id: second, state: 'consumed' }), second)
})
test('confirmed delivery absent from available input history is unknown, never automatically unsent', () => {
  assert.equal(resolveNativeRecoveryInput({ ...delivery, confirmed: true }, previous, new Map())!.state, 'unknown')
})
