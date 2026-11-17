/** Locate only the URL bytes of a parsed link/definition. Labels and titles can
 * contain the same URL or escaped delimiters and must not be rewritten. */
export function markdownDestinationRange(text: string, node: {
  type: string
  url?: unknown
  children?: Array<{ position?: { end: { offset?: number } } }>
  position?: { start: { offset?: number }; end: { offset?: number } }
}): { start: number; end: number } | undefined {
  if ((node.type !== 'link' && node.type !== 'definition') || typeof node.url !== 'string' || !node.url) return undefined
  const start = node.position?.start.offset, end = node.position?.end.offset
  if (start === undefined || end === undefined) return undefined
  const raw = text.slice(start, end)
  const labelEnd = (node.children?.at(-1)?.position?.end.offset ?? start) - start
  let marker = node.type === 'definition' ? raw.indexOf(']:') : raw.indexOf('](', labelEnd)
  while (node.type === 'definition' && marker >= 0) {
    let preceding = marker - 1
    while (raw[preceding] === '\\') preceding--
    if ((marker - preceding - 1) % 2 === 0) break
    marker = raw.indexOf(']:', marker + 2)
  }
  if (marker < 0) return undefined
  let offset = marker + 2
  while (/[ \t\r\n]/u.test(raw[offset] ?? '') && offset < raw.length) offset++
  const angle = raw[offset] === '<'
  if (angle) offset++
  const destinationStart = offset
  let depth = 0
  // MDAST already validated the link and decoded entities/escapes in url. Use
  // its raw destination token boundaries, never search decoded text in titles.
  for (; offset < raw.length; offset++) {
    const char = raw[offset]!
    if (char === '\\') {
      const next = raw.charCodeAt(offset + 1)
      if (next >= 33 && next <= 47 || next >= 58 && next <= 64 || next >= 91 && next <= 96 || next >= 123 && next <= 126) { offset++; continue }
    }
    if (angle) {
      if (char === '>') return { start: start + destinationStart, end: start + offset }
    } else {
      if (/[ \t\r\n]/u.test(char) || char === ')' && depth === 0) break
      if (char === '(') depth++
      else if (char === ')') depth--
    }
  }
  return angle || offset === destinationStart ? undefined : { start: start + destinationStart, end: start + offset }
}
