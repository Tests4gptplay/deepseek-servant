// These tests require the actual pinned Host packages. There is no fake SDK,
// package download, global-module search or silent dependency fallback.
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const requested = process.env.DSS_SDK_HOST_ROOT
if (!requested || !isAbsolute(requested)) {
  throw new Error('Set DSS_SDK_HOST_ROOT to the absolute DSH Host directory containing node_modules. These checks require the actual SDK; no mock fallback is provided.')
}
export const sdkHostRoot = realpathSync(requested)
const sdkModules = join(sdkHostRoot, 'node_modules')
if (!statSync(sdkModules).isDirectory()) throw new Error('DSS_SDK_HOST_ROOT must contain a node_modules directory.')
const sdkParent = pathToFileURL(join(sdkHostRoot, '__dss_sdk_test_entry__.mjs')).href
export const sourceRoot = new URL('../../src/', import.meta.url)
const scriptRoot = new URL('../', import.meta.url)
export const loaded = new Map()
const packages = new Map(), packageFiles = new Map()
export const hash = value => createHash('sha256').update(value).digest('hex')
const inside = (root, target) => { const rel = relative(root, target); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) }
function recordPackage(specifier, url) {
  if (!url.startsWith('file:')) return // Node builtin modules have no package.
  const file = fileURLToPath(url)
  if (!inside(sdkModules, file)) throw new Error('SDK dependency resolved outside DSS_SDK_HOST_ROOT/node_modules: ' + specifier)
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
  for (let directory = dirname(file); inside(sdkModules, directory); directory = dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (!existsSync(manifest)) continue
    const value = JSON.parse(readFileSync(manifest, 'utf8'))
    if (value.name !== name) continue
    const versions = packages.get(name) ?? new Set(); versions.add(value.version); packages.set(name, versions)
    packageFiles.set(relative(sdkHostRoot, manifest).split(sep).join('/'), { name, version: value.version, sha256: hash(readFileSync(manifest)) })
    return
  }
  throw new Error('Cannot identify the actual SDK package manifest for ' + specifier)
}

export const hooks = registerHooks({
  resolve(specifier, context, next) {
    const bare = !specifier.startsWith('.') && !isAbsolute(specifier) && !specifier.includes(':')
    if (bare) {
      // Source/test imports use only the explicitly selected Host dependency
      // tree. Dependencies inside that tree keep their native package routing.
      const fromTest = context.parentURL?.startsWith(sourceRoot.href) || context.parentURL?.startsWith(scriptRoot.href)
      const result = next(specifier, fromTest ? { ...context, parentURL: sdkParent } : context)
      recordPackage(specifier, result.url)
      return result
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})

export function evidence() {
  return {
    runtime: process.version, platform: process.platform, sdkHostRoot,
    actualPackages: Object.fromEntries([...packages].sort().map(([name, versions]) => [name, versions.size === 1 ? [...versions][0] : [...versions].sort()])),
    actualPackageManifests: Object.fromEntries([...packageFiles].sort()),
    sourceHashes: Object.fromEntries([...loaded].sort()),
  }
}
