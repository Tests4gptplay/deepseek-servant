import test from 'node:test'
import assert from 'node:assert/strict'
import { frameworkMessageAuthor } from '../src/framework/client-presentation.js'
import { illustrationFor, showCornerIllustration } from '../src/client/illustrations.js'

test('Local human and assistant labels follow current settings without mutating stable identities', () => {
  const settings = { userName: 'Local human', name: 'Servant name' }
  const human = { role: 'user' as const, participantId: 'stable-local-id' }
  assert.equal(frameworkMessageAuthor('local', human, settings), 'Local human')
  assert.equal(frameworkMessageAuthor('local', { role: 'assistant', participantId: 'A' }, settings), 'Servant name')
  assert.equal(human.participantId, 'stable-local-id')
  assert.equal(frameworkMessageAuthor('local', human, { ...settings, userName: 'New display name' }), 'New display name')
})
test('Git participants and system records are not relabelled as the local user or assistant', () => {
  const settings = { userName: 'Local human', name: 'Servant name' }
  assert.equal(frameworkMessageAuthor('git', { role: 'user', participantId: 'invited-account' }, settings), 'invited-account')
  assert.equal(frameworkMessageAuthor('git', { role: 'assistant', participantId: 'principal-account' }, settings), 'principal-account')
  assert.equal(frameworkMessageAuthor('local', { role: 'system', participantId: 'Host' }, settings), 'Host')
})
test('empty presentation names fall back to the existing participant label', () => {
  assert.equal(frameworkMessageAuthor('local', { role: 'user', participantId: 'local-id' }, { name: '', userName: '  ' }), 'local-id')
})

test('the existing illustration selection applies the same swap to both empty and corner positions', () => {
  for (const swap of [false, true]) for (const hasContent of [false, true]) for (const visible of [false, true]) {
    const settings = { swapPageIllustrations: swap, showCornerCharacter: visible }
    assert.equal(illustrationFor('conversation', settings), swap ? 'task' : 'welcome')
    assert.equal(illustrationFor('tasks', settings), swap ? 'welcome' : 'task')
    assert.equal(showCornerIllustration(hasContent, settings), hasContent && visible)
  }
  assert.equal(showCornerIllustration(true, {}), true)
})
