import { build } from 'esbuild'
for (const name of ['model-route', 'model-picker']) {
  await build({ entryPoints: ['tests/' + name + (name === 'model-picker' ? '.ui.ts' : '.test.ts')], bundle: true, outfile: '.validation/' + name + '.test.mjs',
    platform: 'node', format: 'esm', target: 'node24', loader: { '.css': 'empty' },
    plugins: name === 'model-picker' ? [{ name: 'model-selector-initial-state', setup(build) {
      build.onResolve({ filter: /^(react(?:\/jsx-runtime)?|@deepseek-ai\/dsh-client-ui-primitives)$/ }, args => ({ path: args.path, namespace: 'test-controls' }))
      build.onLoad({ filter: /.*/, namespace: 'test-controls' }, args => ({
        contents: args.path === 'react'
          ? 'export const useState = initial => [initial, () => {}];'
          : args.path === 'react/jsx-runtime'
            ? 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;'
            : 'export const Button = "button"; export const IconChevronDownOutlineRegular = "chevron"; export const Menu = "menu";',
        loader: 'js',
      }))
    } }] : [],
  })
}
await import('../.validation/model-route.test.mjs')
await import('../.validation/model-picker.test.mjs')
