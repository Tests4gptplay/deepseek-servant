import { build } from 'esbuild'
const result = await build({ entryPoints: ['tests/illustrations.test.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node24' })
await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
