import { markdownDestinationRange } from './markdown-destination.js'
import { physicalWorkspaceLinkSource, sameWorkspaceReference, type PhysicalWorkspaceReference } from './workspace-paths.js'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { math } from 'micromark-extension-math'
import { mathFromMarkdown } from 'mdast-util-math'

/** Use the existing parser, not a Markdown regex: code, math and escaped syntax
 * remain literal. Image nodes become explicit links in the display copy only,
 * so merely reading a conversation never requests remote/tracking images.
 */
export function markdownImagesAsLinks(text: string, imageLabel = 'Image'): string {
  if (!text.includes('![') && !/file:/iu.test(text) && !text.includes('task-references/')) return text
  const tree = fromMarkdown(text, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] })
  const edits: Array<{ offset: number; length: number; value: string }> = []
  type Node = { type: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } }; alt?: string | null; url?: string; identifier?: string; title?: string | null }
  const definitions = new Map<string, Node>()
  const collect = (node: Node) => {
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    for (const child of node.children ?? []) collect(child)
  }
  collect(tree)
  const visit = (node: Node) => {
    const offset = node.position?.start.offset, end = node.position?.end.offset
    const target = node.type === 'image' ? node : node.identifier ? definitions.get(node.identifier) : undefined
    const url = target?.url
    if ((node.type === 'image' || node.type === 'imageReference') && offset !== undefined && end !== undefined && url !== undefined) {
      // Rebuild from the flattened alt text, not by deleting the leading '!':
      // nested images in an image's alt would otherwise become active images.
      const label = (node.alt || imageLabel).replace(/[&\\`*_[\]{}()#+.!<>|~-]/gu, '\\$&')
      const destination = displayFileDestination(url) ?? url.replace(/[<>|\s\\]/gu, character => encodeURIComponent(character)).replace(/&/gu, '&amp;')
      edits.push({ offset, length: end - offset, value: '[' + label + '](<' + destination + '>' + (target?.title ? ' "' + target.title.replace(/[&\\"]/gu, '\\$&') + '"' : '') + ')' })
    } else if ((node.type === 'link' || node.type === 'definition') && node.url && offset !== undefined && end !== undefined) {
      const destination = displayFileDestination(node.url)
      if (destination !== undefined) {
        const range = markdownDestinationRange(text, node)
        if (range) edits.push({ offset: range.start, length: range.end - range.start, value: destination })
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  let display = text
  for (const edit of edits.sort((a, b) => b.offset - a.offset)) display = display.slice(0, edit.offset) + edit.value + display.slice(edit.offset + edit.length)
  return display
}

function displayFileDestination(value: string): string | undefined {
  // taskReference is an application path with an encoded final segment, not
  // a URL already prepared for the Markdown delegate. Add only the transport
  // layer here; the official renderer removes it once before the service
  // parses the original reference. This also repairs already-stored links,
  // without rewriting archives or decoding literal percent sequences twice.
  const hash = value.indexOf('#')
  const destination = hash < 0 ? value : value.slice(0, hash)
  const fragment = hash < 0 ? '' : value.slice(hash)
  if (!destination.includes('?') && /^task-references\/[^/]+\/[^/]+$/u.test(destination)
    && (!fragment || /^#L[1-9]\d*(?:-L[1-9]\d*)?$/u.test(fragment)))
    return destination.split('/').map(part => encodeURIComponent(part)).join('/') + fragment

  if (!/^file:\/\//iu.test(value)) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:' || (url.host && url.host !== 'localhost') || url.search || url.hash || /%2f|%5c/iu.test(url.pathname)) return undefined
    let path = decodeURIComponent(url.pathname)
    if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1).replace(/\//gu, '\\')
    if (!physicalMarkdownPath(path)) return undefined
    return path.replace(/[%&<>|\s\\#?]/gu, character => encodeURIComponent(character))
  } catch { return undefined }
}

/** The native Markdown delegate already decodes URI escapes exactly once.
 * Logical DSS paths and source-verified physical results use their existing RPCs.
 * Do not map repositoryDirectory, localDirectory or workspace in the browser.
 */
export function logicalMarkdownPath(path: string): string | undefined {
  if (!path || /[\\\u0000-\u001f\u007f]/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) return undefined
  return path
}

export function physicalMarkdownPath(path: string): boolean {
  return !/[\u0000-\u001f\u007f]/u.test(path) && /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(path)
}
/** Bind each source-bearing Markdown link independently through the Host's
 * existing fileMentions API. The display copy uses human-readable file mentions;
 * stored Markdown keeps its real physical href and standard title. No task index is read.
 */
export function markdownPhysicalLinks(text: string): { text: string; links: Map<string, { reference: PhysicalWorkspaceReference; label: string }> } {
  const links = new Map<string, { reference: PhysicalWorkspaceReference; label: string }>()
  if (!text.includes('DSS source:')) return { text, links }
  const tree = fromMarkdown(text, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] })
  type Node = { type: string; children?: Node[]; value?: string; alt?: string | null; url?: string; title?: string | null; identifier?: string;
    position?: { start: { offset?: number }; end: { offset?: number } } }
  const definitions = new Map<string, Node>(), literalCode = new Set<string>()
  const collect = (node: Node) => {
    if (node.type === 'inlineCode' && node.value) literalCode.add(node.value.replace(/\r?\n|\r/gu, ' '))
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    for (const child of node.children ?? []) collect(child)
  }
  collect(tree)
  const label = (node: Node): string => node.value ?? node.alt ?? (node.children ?? []).map(label).join('')
  const edits: Array<{ offset: number; end: number; mention: string; table: boolean }> = []
  // The official renderer recognizes a complete HTTP(S) inline-code value
  // before consulting fileMentions. Prefix such labels with their real address.
  const isHttpLabel = (value: string): boolean => {
    if (value.trim() !== value) return false
    try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
  }
  const visit = (node: Node, table = false) => {
    const target = node.type === 'link' ? node : node.type === 'linkReference' && node.identifier ? definitions.get(node.identifier) : undefined
    const offset = node.position?.start.offset, end = node.position?.end.offset
    if (target?.url && offset !== undefined && end !== undefined) {
      // Match the native delegate's single URI decode and line-fragment rule.
      const hash = target.url.indexOf('#'), destination = hash < 0 ? target.url : target.url.slice(0, hash)
      if (!destination.includes('?') && (hash < 0 || /^#L[1-9]\d*(?:-L[1-9]\d*)?$/u.test(target.url.slice(hash)))) {
        let path: string | undefined
        try { path = decodeURIComponent(destination) } catch { /* malformed URLs remain non-opening text */ }
        const reference = path === undefined ? undefined : physicalWorkspaceLinkSource(path, target.title)
        if (reference) {
          const originalLabel = (label(node) || reference.path).replace(/\r?\n|\r/gu, ' ')
          const baseMention = isHttpLabel(originalLabel) ? reference.path + ' · ' + originalLabel : originalLabel
          let mention = baseMention
          const conflict = (value: string) => literalCode.has(value) || links.has(value) && !sameWorkspaceReference(links.get(value)!.reference, reference)
          if (conflict(mention)) {
            const sourceLabel = baseMention + ' · ' + reference.owner + ' · ' + reference.instanceUUID + ' · ' + reference.path
            mention = sourceLabel
            for (let ordinal = 2; conflict(mention); ordinal++) mention = sourceLabel + ' · ' + ordinal
          }
          links.set(mention, { reference, label: originalLabel })
          edits.push({ offset, end, mention, table })
          return
        }
      }
    }
    for (const child of node.children ?? []) visit(child, table || node.type === 'table')
  }
  visit(tree)
  let display = text
  for (const edit of edits.sort((a, b) => b.offset - a.offset)) {
    const ticks = '`'.repeat(Math.max(0, ...[...edit.mention.matchAll(/`+/gu)].map(match => match[0].length)) + 1)
    // GFM splits table cells before parsing inline code. Escape cell pipes in
    // the display Markdown; the parser restores the exact mention value.
    const value = edit.table ? edit.mention.replace(/\|/gu, '\\|') : edit.mention
    display = display.slice(0, edit.offset) + ticks + ' ' + value + ' ' + ticks + display.slice(edit.end)
  }
  return { text: display, links }
}

export function isMarkdownDocument(path?: string): boolean {
  return !!path && /\.(?:md|markdown)$/iu.test(path)
}
