import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { evidence } from './test-support/dsh-sdk-runtime.mjs'
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { frameworkStorageUsage } = await import('../src/framework/maintenance.ts')
const { workerTransferPath } = await import('../src/framework/worker-business.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-usage-categories-'))
const files = new PhysicalLocalFiles(root)
const transactions = { run() { throw new Error('Unexpected generic transaction in physical conversation fixture') } }
try {
  const conversation = new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: 'usage-fixture' })
  await conversation.send('usage-input', { id: 'usage-message', participantId: 'user', username: 'user', createdAt: '2026-11-12T00:00:00.000Z', role: 'user', recipient: 'ai', text: 'Actual conversation input.' })
  const transfer = workerTransferPath('usage-fixture', 'execution-1')
  const transferContent = JSON.stringify({version:1, record:{identity:{role:'Worker',executionId:'execution-1'}}, successorId:'worker-2'})
  await files.replace(transfer, transferContent)
  const original = await fs.readFile(path.join(root, ...transfer.split('/')), 'utf8')
  const contextPath = path.join(root,'conversation-context','local','usage-fixture','index.json')
  const contextBytes = (await fs.stat(contextPath)).size
  const transferBytes = Buffer.byteLength(transferContent)
  const all = await frameworkStorageUsage(files)
  await files.delete(transfer)
  const withoutTransfer = await frameworkStorageUsage(files)
  await files.delete('conversation-context/local/usage-fixture/index.json')
  const withoutContext = await frameworkStorageUsage(files)
  console.log(JSON.stringify({ observedTransferRecoveryDelta: all.temporary.recoveryBytes - withoutTransfer.temporary.recoveryBytes, expectedTransferBytes: transferBytes, observedContextChatDelta: withoutTransfer.permanent.chatBytes - withoutContext.permanent.chatBytes, expectedContextBytes: contextBytes }))
  assert.equal(all.totalBytes - withoutTransfer.totalBytes, transferBytes)
  assert.equal(all.temporary.recoveryBytes - withoutTransfer.temporary.recoveryBytes, transferBytes)
  assert.equal(all.temporaryBytes - withoutTransfer.temporaryBytes, transferBytes)
  assert.equal(all.permanentBytes, withoutTransfer.permanentBytes)
  assert.equal(withoutTransfer.totalBytes - withoutContext.totalBytes, contextBytes)
  assert.equal(withoutTransfer.permanent.chatBytes - withoutContext.permanent.chatBytes, contextBytes)
  assert.equal(withoutTransfer.permanentBytes - withoutContext.permanentBytes, contextBytes)
  assert.equal(withoutTransfer.temporaryBytes, withoutContext.temporaryBytes)
  assert.equal(original, transferContent)
  console.log(JSON.stringify({status:'passed',contextBytes,transferBytes,scope:'Actual PhysicalLocalFiles and FrameworkConversation.send; worker-transfer path from production function with representative contents; no actual Worker session or full GUI.',evidence:evidence()},null,2))
} finally { await files.close(); await fs.rm(root,{recursive:true,force:true}) }
