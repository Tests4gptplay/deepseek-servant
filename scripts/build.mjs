import { build } from 'esbuild'
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

await mkdir('lib', { recursive: true })
// Page artwork stays independent of the plugin-list icon.
const pageIcon = `data:image/png;base64,${(await readFile('assets/page-icon.png')).toString('base64')}`
const welcomeCharacter = `data:image/png;base64,${(await readFile('assets/welcome-character.png')).toString('base64')}`
const taskEmptyCharacter = `data:image/png;base64,${(await readFile('assets/task-empty-character.png')).toString('base64')}`
const statusIcon = `data:image/webp;base64,${(await readFile('assets/statusbar-mask.webp')).toString('base64')}`
await build({
  entryPoints: ['src/host.ts'], outfile: 'lib/host.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node22', sourcemap: false,
  packages: 'external',
})
const clientOptions = {
  entryPoints: ['src/client.tsx'], outfile: 'lib/client.js', bundle: true,
  // DSH's browser loader resolves shared modules through its factory require.
  // A plain ESM bundle cannot register with the native module graph.
  format: 'cjs', platform: 'browser', target: 'es2022', sourcemap: false, jsx: 'automatic',
  external: ['@deepseek-ai/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: {
    clsx: fileURLToPath(import.meta.resolve('clsx')),
    '@deepseek-ai/dsh-client-ui-directory-picker-browse/src/client/DirectoryBrowser.tsx': fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-ui-directory-picker-browse/src/client/DirectoryBrowser.tsx')),
    '@deepseek-ai/dsh-agent-preset-registry/display': fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry/display')),
    '@deepseek-ai/dsh-util-file-drag': fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-file-drag')),
    // Public source exports are bundled once; React and shared DSH services stay external.
    ...Object.fromEntries(['FileCard', 'AttachmentRail', 'client/ComposerAttachments'].map(name => {
      const spec = `@deepseek-ai/dsh-client-ui-attachment/src/${name}.tsx`
      return [spec, fileURLToPath(import.meta.resolve(spec))]
    })),
  },
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

// Keep the independent cleaner entry and reviewed runtime bytes in the same package.
await mkdir('lib/native-cleaner', { recursive: true })
for (const name of ["workspace-account", "plugin", "coordinator", "jsonl-adapter", "cache-domain", "retirement-store", "kernel-lock", "windows-semaphore", "pinned-directory", "entry", "exact-file", "win32-file-signatures", "windows-native-api", "windows-storage-backend"]) await copyFile(`src/native-cleaner/${name}.mjs`, `lib/native-cleaner/${name}.mjs`)

// The resident helper is package-owned code, launched only by authorized Git use.
await copyFile('src/experimental/private-git/dulwich-helper.py', 'lib/dulwich-helper.py')
// Hash the actual shipped helper and dependency inputs after this build.
const gitRuntimeFiles = ['lib/dulwich-helper.py', 'python/requirements.txt', 'python/bundled_runtime.py', 'python/vendor/manifest.json', 'python/licenses/Dulwich-COPYING', 'python/licenses/urllib3-LICENSE.txt']
const hashes = await Promise.all(gitRuntimeFiles.map(async path => `${createHash('sha256').update(await readFile(path)).digest('hex')}  ${path}`))
await writeFile('python/SHA256SUMS', hashes.join('\n') + '\n')
