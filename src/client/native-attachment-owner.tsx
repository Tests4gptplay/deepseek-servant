import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FileCard } from '@deepseek-ai/dsh-client-ui-attachment/src/FileCard.tsx'
import { AttachmentRail } from '@deepseek-ai/dsh-client-ui-attachment/src/AttachmentRail.tsx'
import type { ComposerAttachmentsOwnerProps, DraftAttachmentId, DraftFileUploads } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComposerAttachment } from '../framework/client-attachments.js'
import css from './page.module.css'

/** The official public slot owner. Its image preview arm needs no receipt. */
export type NativeImageAttachmentsOwner = ComposerAttachmentsOwnerProps
export type NativeImageAttachments = (owner: NativeImageAttachmentsOwner) => ReactNode
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** DSS owns selection/storage. Official DSH components own the visuals. */
export function NativeAttachmentOwner({ rows, renderImages, canAcceptDrop, onAddFiles, onRemove, onRetry, zh }: {
  rows: readonly ComposerAttachment[]
  renderImages?: NativeImageAttachments
  canAcceptDrop: boolean
  onAddFiles: NativeImageAttachmentsOwner['onAddFiles']
  onRemove: (id: string) => void
  onRetry: (id: string) => void
  zh: boolean
}) {
  const urls = useRef(new Map<File, string>())
  const [previews, setPreviews] = useState(new Map<File, string>())
  useEffect(() => {
    const files = new Set(renderImages ? rows.flatMap(row => row.file && imageTypes.has(row.file.type) ? [row.file] : []) : [])
    for (const [file, url] of urls.current) if (!files.has(file)) { URL.revokeObjectURL(url); urls.current.delete(file) }
    for (const file of files) if (!urls.current.has(file)) urls.current.set(file, URL.createObjectURL(file))
    setPreviews(new Map(urls.current))
  }, [rows, !!renderImages])
  useEffect(() => () => { for (const url of urls.current.values()) URL.revokeObjectURL(url); urls.current.clear() }, [])
  const imageRows = rows.filter(row => row.file && imageTypes.has(row.file.type))
  const fileRows = rows.filter(row => !row.file || !imageTypes.has(row.file.type))
  const uploads: Record<string, DraftFileUploads[string]> = {}
  for (const row of imageRows) {
    if (row.state === 'uploading' || row.state === 'queued') uploads[row.id] = { status: 'uploading', loaded: 0 }
    else if (row.state === 'error') uploads[row.id] = { status: 'error', message: row.error ?? '' }
  }
  const error = (row: ComposerAttachment) => row.error || (row.issue === 'git-size'
    ? zh ? 'Git 每个文件不得超过 100 MiB。' : 'Git files cannot exceed 100 MiB.'
    : row.issue === 'unavailable' ? zh ? '当前接入端不支持附件上传。' : 'This connection does not support attachment uploads.' : '')
  return <div className={css.nativeAttachments}>
    {renderImages?.({ attachments: imageRows.flatMap(row => {
      const previewUrl = row.file && previews.get(row.file)
      return previewUrl && row.file ? [{ kind: 'image' as const, id: row.id as DraftAttachmentId, file: row.file, previewUrl }] : []
    }), canAcceptDrop, onAddFiles, onRemoveAttachment: onRemove, uploads, onRetryFile: onRetry, uploadFailureText: value => value })}
    {!!fileRows.length && <div className={css.nativeAttachmentFiles}><AttachmentRail items={fileRows} labels={{ group: zh ? '待发送附件' : 'Pending attachments', scrollLeft: zh ? '向左滚动' : 'Scroll left', scrollRight: zh ? '向右滚动' : 'Scroll right' }} renderItem={row =>
      <FileCard name={row.name} bytes={row.bytes ?? row.file?.size ?? 0}
        state={row.state === 'uploading' || row.state === 'queued' ? 'uploading' : row.state === 'error' ? 'error' : 'ready'}
        labels={{ label: row.name, remove: zh ? `移除 ${row.name}` : `Remove ${row.name}`, uploading: row.originalPath ? zh ? '正在引用原文件' : 'Selecting original' : zh ? '正在上传' : 'Uploading', failed: error(row) || (zh ? '上传失败' : 'Upload failed'), retry: zh ? `重试 ${row.name}` : `Retry ${row.name}` }}
        onRemove={() => onRemove(row.id)} onRetry={() => onRetry(row.id)} />
    } /></div>}
    {imageRows.filter(row => row.state === 'error' && error(row)).map(row => <p key={row.id} role="alert">{error(row)}</p>)}
  </div>
}
