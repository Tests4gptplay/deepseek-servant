import { useMemo } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PhysicalWorkspaceReference } from './workspace-paths.js'
import { markdownImagesAsLinks, markdownPhysicalLinks } from './markdown-display.js'
import css from '../client/page.module.css'

const labels = {
  zh: { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '脚注' },
  en: { code: { copyLabel: 'Copy code', copiedLabel: 'Copied' }, footnotes: 'Footnotes' },
}

/** Display only. The original message and readFile response stay untouched. */
export function FrameworkMarkdown({ text, zh, openFile }: { text: string; zh: boolean; openFile: (path: string, reference?: PhysicalWorkspaceReference) => void }) {
  const display = useMemo(() => markdownPhysicalLinks(markdownImagesAsLinks(text, zh ? '图片' : 'Image')), [text, zh])
  const fileMentions = useMemo(() => ({ resolve(token: string) {
    const link = display.links.get(token)
    return link ? { label: link.label, title: link.reference.path + ' · ' + link.reference.owner + ' · ' + link.reference.instanceUUID,
      open: () => openFile(link.reference.path, link.reference) } : undefined
  } }), [display, openFile])
  // Older Hosts may not expose these capabilities. Keep complete source text
  // rather than requiring a new Host version or hiding unsupported link targets.
  const Markdown = primitives.MarkdownText, Delegate = primitives.MarkdownDelegateProvider
  if (!Markdown || !Delegate) return <div className={css.messageText}>{text}</div>
  return <div className={css.markdownContent} data-dss-markdown>
    <Delegate openFile={path => openFile(path)}><Markdown text={display.text} fileMentions={fileMentions} labels={labels[zh ? 'zh' : 'en']} /></Delegate>
  </div>
}
