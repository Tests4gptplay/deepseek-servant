import { build } from 'esbuild'
import { mkdir, readFile } from 'node:fs/promises'

await mkdir('lib', { recursive: true })
const roles = ['foreground', 'planner', 'worker', 'helper']
const roleTexts = Object.fromEntries(await Promise.all(roles.map(async name => [name, await readFile(`src/roles/${name}.md`, 'utf8')])))
const lightStatusIcon = `data:image/png;base64,${(await readFile('assets/statusbar-icon-black.png')).toString('base64')}`
const darkStatusIcon = `data:image/png;base64,${(await readFile('assets/statusbar-icon.png')).toString('base64')}`
await build({
  entryPoints: ['src/host.ts'], outfile: 'lib/host.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node22', sourcemap: false,
  packages: 'external', define: { __SERVANT_ROLE_TEXTS__: JSON.stringify(roleTexts) },
})
const clientOptions = {
  entryPoints: ['src/client.tsx'], outfile: 'lib/client.js', bundle: true,
  // DSH's browser loader resolves shared modules through its factory require.
  // A plain ESM bundle cannot register with the native module graph.
  format: 'cjs', platform: 'browser', target: 'es2022', sourcemap: false,
  external: ['@deepseek-ai/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
  define: {
    __SERVANT_STATUS_ICON_LIGHT_DATA_URI__: JSON.stringify(lightStatusIcon),
    __SERVANT_STATUS_ICON_DARK_DATA_URI__: JSON.stringify(darkStatusIcon),
  },
  banner: { js: 'window.__ModuleLoader__.load({ id: "deepseek-servant", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
}
const preview = await build({ ...clientOptions, write: false })
const css = preview.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
await build({ ...clientOptions, define: { ...clientOptions.define, __SERVANT_CLIENT_CSS__: JSON.stringify(css) } })
