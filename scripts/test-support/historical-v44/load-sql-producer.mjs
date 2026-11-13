import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Only migration fixtures may execute these frozen historical producer bytes.
// Hash verification prevents current product changes from redefining old input.
const root = new URL('./', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('SOURCE.json', root), 'utf8'))
for (const [name, expected] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(readFileSync(new URL(name, root))).digest('hex'), expected, 'Frozen v44 input: ' + name)
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root.href) && specifier === './file-list-selection.js')
      return { url: new URL('file-list-selection.ts', root).href, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return next(url, context)
  },
})
let original
try { original = await import('./local-files-worker.ts') }
finally { hooks.deregister() }
export const localFilesWorkerSource = original.localFilesWorkerSource
export const historicalProducer = manifest
