import { frameworkErrorText } from './client-error.js'
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FrameworkClientApi } from './client-contracts.js'
import type { ManualTaskCleanupPreview, ManualFileCleanupPreview, ManualConversationCleanupPreview } from './manual-cleanup.js'
import css from '../client/page.module.css'

type Action = 'tasks' | 'conversation' | 'planning' | 'debug'
/** Separate explicit Local confirmations; no scheduled retention. */
export function ManualCleanupPanel({ api, storageScope, tr, changed }: {
  api: FrameworkClientApi; storageScope: string; tr: (cn: string, en: string) => string; changed(): Promise<void>
}) {
  const [pending, setPending] = useState<{ action: Action; commandId: string; preview?: ManualTaskCleanupPreview; filePreview?: ManualFileCleanupPreview; conversationPreview?: ManualConversationCleanupPreview; submitted?: boolean }>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [debug, setDebug] = useState<ManualFileCleanupPreview>()
  const [debugRecord, setDebugRecord] = useState<{ path: string; text: string }>()
  const [usage, setUsage] = useState<Awaited<ReturnType<FrameworkClientApi['maintenanceView']>>>()
  const inspect = async () => { setBusy(true); setError(''); try { setUsage(await api.maintenanceView({ mode: 'local', storageScope })) } catch (error) { setError(frameworkErrorText(error)) } finally { setBusy(false) } }
  useEffect(() => { void inspect() }, [api, storageScope])
  const open = async (target: 'records' | 'native-logs' | 'debug') => { setError(''); try { await api.openMaintenancePath({ mode: 'local', storageScope, target }) } catch (error) { setError(frameworkErrorText(error)) } }
  const inspectDebug = async () => {
    setBusy(true); setError(''); setDebugRecord(undefined)
    try {
      const preview = await api.cleanupPreview({ mode: 'local', storageScope, action: 'debug' })
      if (!('kind' in preview) || preview.kind !== 'debug') throw new Error('Invalid debug preview.')
      setDebug(preview)
    } catch (error) { setError(frameworkErrorText(error)) } finally { setBusy(false) }
  }
  const readDebug = async (path: string) => {
    setBusy(true); setError(''); setDebugRecord(undefined)
    try {
      const record = await api.readFile({ mode: 'local', storageScope, path })
      if (record.text === undefined) throw new Error('Debug record is not readable text.')
      setDebugRecord({ path, text: record.text })
    } catch (error) { setError(frameworkErrorText(error)) } finally { setBusy(false) }
  }
  const labels: Record<Action, string> = {
    tasks: tr('清理已结束任务记录', 'Clear ended task records'),
    conversation: tr('清理前台聊天记录', 'Clear Foreground conversation'),
    planning: tr('清空工作清单与缓存', 'Clear working List and Cache'),
    debug: tr('清理调试记录', 'Clear debug records'),
  }
  const prepare = async (action: Action) => {
    setBusy(true); setError(''); setResult('')
    try {
      const preview = await api.cleanupPreview({ mode: 'local', storageScope, action })
      const commandId = crypto.randomUUID()
      if (action === 'tasks') {
        if ('kind' in preview) throw new Error('Cleanup preview belongs to another action.')
        setPending({ action, commandId, preview })
      } else if (action === 'conversation') {
        if (!('kind' in preview) || preview.kind !== 'conversation') throw new Error('Cleanup preview belongs to another action.')
        setPending({ action, commandId, conversationPreview: preview })
      } else if ('kind' in preview && (preview.kind === 'planning' || preview.kind === 'debug') && preview.kind === action) {
        setPending({ action, commandId, filePreview: preview })
      } else throw new Error('Cleanup preview belongs to another action.')
    } catch (error) { setError(frameworkErrorText(error)) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!pending) return
    setPending({ ...pending, submitted: true })
    setBusy(true); setError('')
    try {
      const base = { mode: 'local' as const, storageScope, commandId: pending.commandId }
      const result = await api.cleanupRecords(pending.action === 'tasks'
        ? { ...base, action: 'tasks', preview: pending.preview!, confirmation: 'clear-ended-task-records' }
        : pending.action === 'conversation' ? { ...base, action: 'conversation', preview: pending.conversationPreview!, confirmation: 'clear-foreground-conversation' }
        : pending.action === 'debug' ? { ...base, action: 'debug', preview: pending.filePreview!, confirmation: 'clear-debug-records' }
        : { ...base, action: 'planning', preview: pending.filePreview, confirmation: 'clear-work-planning-notes' })
      setPending(undefined); setDebug(undefined); setDebugRecord(undefined); setUsage(undefined)
      await inspect()
      setResult(tr('已完成本次清理；保留的成果或后续变更文件：', 'Cleanup finished; retained artifacts or files changed afterward: ') + result.preservedPaths.length
        + (result.missingEntries?.length ? tr(' 以下聊天条目已缺失，原正文位置无法确定，未删除未知正文：', ' These conversation entries were already missing; their original body locations are unknown, so unknown bodies were not deleted: ') + result.missingEntries.join(', ') : ''))
      // Cleanup owns the confirmed write; its independent display refresh
      // must not keep unrelated Local actions busy after that write succeeds.
      void changed().catch(error => setError(frameworkErrorText(error)))
    } catch (error) { setError(frameworkErrorText(error)) }
    finally { setBusy(false) }
  }
  const bytes = (value: number) => {
    if (value < 1024) return value.toLocaleString() + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']; let amount = value / 1024, unit = 0
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
    return amount.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + units[unit]
  }
  const groups = [
    { title: tr('保存记录', 'Saved records'), total: usage?.usage.permanentBytes, rows: [
      [tr('聊天记录', 'Conversation'), usage?.usage.permanent.chatBytes], [tr('助理记录', 'Assistant records'), usage?.usage.permanent.assistantBytes],
      [tr('技能与知识', 'Skills and knowledge'), usage?.usage.permanent.knowledgeBytes], [tr('原始记录', 'Original records'), usage?.usage.permanent.originBytes],
      [tr('成果档案', 'Archives'), usage?.usage.permanent.archiveBytes], [tr('工作清单与缓存', 'Working notes'), usage?.usage.permanent.planningBytes],
      [tr('调试记录', 'Debug records'), usage ? usage.usage.permanent.debugBytes ?? 0 : undefined],
    ] },
    { title: tr('运行资料', 'Task data'), total: usage?.usage.temporaryBytes, rows: [
      [tr('任务资料', 'Task files'), usage?.usage.temporary.taskBytes], [tr('规划记忆', 'Planner memory'), usage?.usage.temporary.plannerMemoryBytes],
      [tr('规划笔记', 'Planner notes'), usage?.usage.temporary.plannerNoteBytes], [tr('执行回复', 'Worker replies'), usage?.usage.temporary.workerReplyBytes],
      [tr('执行记录', 'Execution records'), usage?.usage.temporary.executionBytes], [tr('恢复资料', 'Recovery data'), usage?.usage.temporary.recoveryBytes],
    ] },
  ]
  return <section className={css.retention} aria-label={tr('记录管理', 'Record management')}>
    <div className={css.retentionHeading}><h2>{tr('记录管理', 'Record management')}</h2><span className={css.retentionGrandTotal}>{tr('总计', 'Total')} <strong>{usage ? bytes(usage.usage.totalBytes) : '—'}</strong></span></div>
    <div className={css.retentionColumns}>{groups.map(group => <dl className={css.retentionGroup} key={group.title}>
      {group.rows.map(([label, size]) => <div className={css.retentionRow} key={String(label)}><dt>{label}</dt><dd title={typeof size === 'number' ? size.toLocaleString() + ' B' : undefined}>{typeof size === 'number' ? bytes(size) : '—'}</dd></div>)}
      <div className={`${css.retentionRow} ${css.retentionSubtotal}`}><dt>{group.title}</dt><dd>{group.total === undefined ? '—' : bytes(group.total)}</dd></div>
    </dl>)}</div>
    <div className={css.actions}>
      <Button type="button" variant="primary" disabled={busy} onClick={() => void inspect()}>{tr('刷新容量', 'Refresh usage')}</Button>
      <Button type="button" variant="outline" onClick={() => void open('records')}>{tr('打开记录文件夹', 'Open records folder')}</Button>
      <Button type="button" variant="outline" onClick={() => void open('native-logs')}>{tr('打开会话日志', 'Open session logs')}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void inspectDebug()}>{tr('查看调试记录', 'View debug records')}</Button>
      {usage?.debugDirectory && <Button type="button" variant="outline" onClick={() => void open('debug')}>{tr('打开调试文件夹', 'Open debug folder')}</Button>}
    </div>
    {debug && <div><p>{tr('调试记录', 'Debug records')}: {debug.files.length} · {debug.bytes} bytes</p>
      {debug.files.map(file => <Button key={file.path} disabled={busy} onClick={() => void readDebug(file.path)}>{file.path} · {file.bytes} bytes</Button>)}
      {debugRecord && <div><h4>{debugRecord.path}</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{debugRecord.text}</pre></div>}
    </div>}
    {usage && <details className={css.retentionManage}><summary>{tr('存储位置', 'Storage locations')}</summary>
      <dl className={css.storagePaths}>
        <div><dt>{tr('当前记录目录', 'Current records folder')}</dt><dd><code>{usage.localDirectory}</code></dd></div>
        {usage.recordsDirectory && <div><dt>{tr('DSS 记录根目录', 'DSS records root')}</dt><dd><code>{usage.recordsDirectory}</code></dd></div>}
        {usage.nativeDirectory && <div><dt>{tr('DSH 会话日志', 'DSH session logs')}</dt><dd><code>{usage.nativeDirectory}</code></dd></div>}
      </dl>
      <p className={css.muted}>{tr('以上为记录内容大小，不包含宿主会话日志。', 'Sizes show record content, excluding Host session logs.')}</p>
    </details>}
    {!pending && <div className={css.actions}>{(Object.keys(labels) as Action[]).map(action => <Button type="button" variant="outline" key={action} disabled={busy} onClick={() => void prepare(action)}>{labels[action]}</Button>)}</div>}
    {pending && <div role="group" aria-label={tr('确认清理', 'Confirm cleanup')}>
      <h4>{labels[pending.action]}</h4>
      <p>{pending.action === 'tasks' ? tr('只删除本次预览的已结束任务历史；成果、技能和知识保留。', 'Only the ended task history in this preview is removed; artifacts, skills and knowledge remain.')
        : pending.action === 'conversation' ? tr('只清理本次选择的前台聊天；若原前台执行仍在运行，会先停止并收取其尾部输出。之后的新聊天、后台任务及工作清单、缓存保留。', 'Clears only this selected Foreground conversation. If its original execution is still running, it is stopped and its final output is collected. Later messages, background tasks, List and Cache remain.')
        : pending.action === 'debug' ? tr('只删除本次预览的调试记录；之后新增或改写的记录保留，其他长期记录和任务不受影响。', 'Only the debug records in this preview are removed. Later additions or changes and other long-term records and tasks remain.')
        : tr('只清空本次预览的工作清单与缓存正文；之后写入的新内容、聊天和任务档案保留。', 'Only the reviewed List and Cache bodies are cleared. Later writes, conversation and task archives remain.')}</p>
      {pending.conversationPreview && <p>{pending.conversationPreview.messageIds.length} {tr('条已选聊天记录', 'selected conversation messages')}</p>}
      {pending.preview && <p>{pending.preview.tasks.length} {tr('个任务', 'tasks')} · {pending.preview.fileCount} {tr('个文件', 'files')} · {pending.preview.bytes} bytes</p>}
      {pending.filePreview && <div><p>{pending.filePreview.files.length} {tr('个文件', 'files')} · {pending.filePreview.bytes} bytes</p>{pending.filePreview.files.map(file => <p key={file.path}>{file.path}</p>)}</div>}
      <Button type="button" variant="primary" disabled={busy} onClick={() => void confirm()}>{tr('确认清理', 'Confirm cleanup')}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setPending(undefined); setError('') }}>{pending.submitted ? tr('关闭（不撤销已发送请求）', 'Close (does not cancel the submitted request)') : tr('取消', 'Cancel')}</Button>
      {pending.submitted && <p>{tr('请求已发送。结果未确认时，请用同一操作重试；关闭面板不会撤销已接纳的清理。', 'The request was sent. Retry this same operation if its outcome is unknown; closing the panel does not revoke an accepted cleanup.')}</p>}
    </div>}
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
  </section>
}
