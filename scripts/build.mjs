import { build } from 'esbuild'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

await mkdir('lib', { recursive: true })
const roles = ['foreground', 'planner', 'worker']
const roleTexts = Object.fromEntries(await Promise.all(roles.map(async name => [name, await readFile(`src/roles/${name}.md`, 'utf8')])))
const coopRoleTexts = Object.fromEntries(await Promise.all(roles.map(async name => [name, await readFile(`src/experimental/private-git/prompts/${name}.md`, 'utf8')])))
// Page artwork stays independent of the plugin-list icon.
const pageIcon = `data:image/png;base64,${(await readFile('assets/page-icon.png')).toString('base64')}`
const welcomeCharacter = `data:image/png;base64,${(await readFile('assets/welcome-character.png')).toString('base64')}`
const taskEmptyCharacter = `data:image/png;base64,${(await readFile('assets/task-empty-character.png')).toString('base64')}`
const statusIcon = `data:image/png;base64,${(await readFile('assets/statusbar-icon.png')).toString('base64')}`
await build({
  entryPoints: ['src/host.ts'], outfile: 'lib/host.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node22', sourcemap: false,
  packages: 'external', define: { __SERVANT_ROLE_TEXTS__: JSON.stringify(roleTexts), __COOP_ROLE_TEXTS__: JSON.stringify(coopRoleTexts) },
})
const clientOptions = {
  entryPoints: ['src/client.tsx'], outfile: 'lib/client.js', bundle: true,
  // DSH's browser loader resolves shared modules through its factory require.
  // A plain ESM bundle cannot register with the native module graph.
  format: 'cjs', platform: 'browser', target: 'es2022', sourcemap: false,
  external: ['@deepseek-ai/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@deepseek-ai/dsh-agent-preset-registry/display': fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry/display')) },
  define: {
    __SERVANT_STATUS_ICON_DATA_URI__: JSON.stringify(statusIcon),
    __SERVANT_ICON_DATA_URI__: JSON.stringify(pageIcon),
    __SERVANT_WELCOME_CHARACTER_DATA_URI__: JSON.stringify(welcomeCharacter),
    __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__: JSON.stringify(taskEmptyCharacter),
  },
  banner: { js: 'window.__ModuleLoader__.load({ id: "deepseek-servant", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
}
const preview = await build({ ...clientOptions, write: false })
const css = preview.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
await build({ ...clientOptions, define: { ...clientOptions.define, __SERVANT_CLIENT_CSS__: JSON.stringify(css) } })
