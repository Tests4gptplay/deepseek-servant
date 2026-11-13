import { LocalUpgradeStatus, OriginalTaskReadStatus } from './client-upgrade-status.js'
import { taskCancellationNotice } from './client-contracts.js'
import { frameworkErrorText } from './client-error.js'
import { AttachmentDownloadCapabilityError, authenticatedAttachmentDownloadPath, attachmentByteLabel, attachmentKind, getConversationAttachmentDrafts, sameAttachmentReferences } from './client-attachments.js'
import type { ConversationAttachmentReference } from './conversation-attachment-reference.js'
import { FrameworkMarkdown } from './client-markdown.js'
import { isMarkdownDocument, logicalMarkdownPath, physicalMarkdownPath } from './markdown-display.js'
import { isPhysicalWorkspaceReference, type PhysicalWorkspaceReference } from './workspace-paths.js'
import { ConversationTurnNavigator } from '../client/conversation-turn-navigator.js'
import { conversationTurns } from '../client/conversation-turns.js'
import { HistoryDatePicker } from '../client/date-picker.js'
import { en, zh as chinese, type ServantLocaleKey } from '../client/locales.js'
import { RecordMovePanel } from './record-move-panel.js'
import { illustrationFor, showCornerIllustration } from '../client/illustrations.js'
import { frameworkMessageAuthor, frameworkReplyPreview, frameworkMemberStatus, frameworkStateLabel, frameworkControlLabel } from './client-presentation.js'
import { ManualCleanupPanel } from './manual-cleanup-panel.js'
import { KnowledgeRecordView } from './knowledge-records.js'
import type { SkillMergeIssue } from './skill-merge.js'
import { Fragment, useMemo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Input, Modal, Menu, SegmentedControl, StateDot, IconSettingsOutlineRegular, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { FrameworkClientController, getFrameworkClientController, frameworkScopeKey, type FrameworkClientExecution, type FrameworkClientApi, type FrameworkClientSettings, type FrameworkClientModel, type FrameworkClientView, type FrameworkClientRole, type FrameworkLegacyTask, type FrameworkClientProcessGroup } from './client-contracts.js'
import css from '../client/page.module.css'

declare const __SERVANT_ICON_DATA_URI__: string
declare const __SERVANT_WELCOME_CHARACTER_DATA_URI__: string
declare const __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__: string
export interface FrameworkPageProps {
  nativeQuestions?: (executions: readonly FrameworkClientExecution[], zh: boolean) => ReactNode
  api: FrameworkClientApi
  settingsOnly?: boolean
  transportConnected?: boolean
  language?: 'zh' | 'en'
  onOpenCredentials?: () => Promise<void>
  onPickDirectory?: () => Promise<string | null>
  onViewed?: (view: FrameworkClientView) => void
  onConversationVisible?: (visible: boolean) => void
  modelControl?: (value: FrameworkClientModel | undefined, onChange: (value: FrameworkClientModel | undefined) => void, label: string, options?: { composer?: boolean; disabled?: boolean; autoLabel?: string; autoHint?: string; followModel?: FrameworkClientModel }) => ReactNode
  presetControl?: (value: string | undefined, onChange: (value: string | undefined) => void) => ReactNode
}
const roles: FrameworkClientRole[] = ['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper']
const blankSettings: FrameworkClientSettings = { name: 'DeepSeek Servant', userName: '', localDirectory: '', ownerRepo: '', repositoryDirectory: '', collaborationId: '', workerSeats: 0, workspace: '' }

/** Uses the existing DSS surfaces and native controls; all data/actions are Host RPCs. */
export function FrameworkPage(props: FrameworkPageProps) {
  const controller = getFrameworkClientController(props.api), snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const view = snapshot.value, zh = props.language !== 'en', tr = (cn: string, en: string) => zh ? cn : en
  const [tab, setTab] = useState<'conversation' | 'tasks' | 'archives'>('conversation')
  const [settingsTab, setSettingsTab] = useState<'settings' | 'knowledge' | 'resources'>('settings')
  const [modeOpen, setModeOpen] = useState(false)
  const t = (key: string) => (zh ? chinese : en)[key as ServantLocaleKey] ?? key
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [changingMode, setChangingMode] = useState(false)
  const modeNavigation = useRef(0)
  const [error, setError] = useState('')
  const [exported, setExported] = useState('')
  const [selectedTask, setSelectedTask] = useState<string>()
  const [draft, setDraft] = useState('')
  const draftText = useRef('')
  const [recipient, setRecipient] = useState<'ai' | 'human'>('ai')
  const [modelOperations, setModelOperations] = useState<Record<string, { input: Parameters<FrameworkClientApi['foregroundModel']>[0]; pending: boolean }>>({})
  const [replyTo, setReplyTo] = useState<string>()
  const [document, setDocument] = useState<Omit<Awaited<ReturnType<FrameworkClientApi['readFile']>>, 'path'> & { path?: string; label?: string; reference?: PhysicalWorkspaceReference }>()
  const [documentLoading, setDocumentLoading] = useState(false)
  const documentRequest = useRef(0)
  const closeDocument = () => { documentRequest.current++; setDocument(undefined); setDocumentLoading(false) }
  const documentTitle = document?.label ?? document?.path ?? tr('读取资料', 'Reading document')
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyDate, setHistoryDate] = useState('')
  const scope = view ? frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope) : ''
  const modelOperation = modelOperations[scope], modelAttempt = modelOperation?.input, modelSaving = modelOperation?.pending ? modelAttempt?.commandId : undefined
  const draftsByScope = useRef(new Map<string, { text: string; replyTo?: string; recipient: 'ai' | 'human' }>())
  const hostPathDrafts = useRef(new Map<string, string>())
  const [hostPath, setHostPath] = useState('')
  const attachmentDrafts = getConversationAttachmentDrafts(props.api)
  useSyncExternalStore(attachmentDrafts.subscribe, attachmentDrafts.snapshot)
  const selectedAttachments = attachmentDrafts.selections(scope)
  const attachmentInput = useRef<HTMLInputElement>(null)
  const attachmentPickerScope = useRef<string>()
  const composerSending = controller.pendingDrafts().some(item => item.state === 'sending'
    && item.input.text === draft && item.input.recipient === recipient && item.input.replyTo === replyTo
    && sameAttachmentReferences(item.input.attachments, selectedAttachments.map(row => row.reference!).filter(Boolean)))
  const [attachmentDownload, setAttachmentDownload] = useState<{ reference: ConversationAttachmentReference; downloadUrl?: string; failed?: boolean; capability?: 'webcrypto' | 'client-memory' }>()
  const attachmentRequest = useRef<AbortController>()
  const closeAttachment = () => { attachmentRequest.current?.abort(); attachmentRequest.current = undefined; setAttachmentDownload(undefined) }
  useEffect(() => () => { attachmentRequest.current?.abort() }, [])
  useEffect(() => () => { if (attachmentDownload?.downloadUrl?.startsWith('blob:')) URL.revokeObjectURL(attachmentDownload.downloadUrl) }, [attachmentDownload?.downloadUrl])
  useEffect(() => { closeAttachment() }, [scope])
  const groupChat = view?.activeMode === 'git' && view.hasOtherInstanceRecords === true
  useEffect(() => {
    props.onConversationVisible?.(!props.settingsOnly && tab === 'conversation' && !settingsOpen && !changingMode && !!view)
    return () => props.onConversationVisible?.(false)
  }, [props.onConversationVisible, props.settingsOnly, tab, settingsOpen, changingMode, scope, !!view])
  const previousScope = useRef(scope)
  const previousScopeView = useRef(view)
  const onViewed = useRef(props.onViewed); onViewed.current = props.onViewed
  useEffect(() => controller.retainConnection(), [controller])
  useEffect(() => { if (view) onViewed.current?.(view) }, [view, view?.storageScope])
  useEffect(() => {
    const previous = previousScopeView.current
    previousScopeView.current = view
    if (previousScope.current === scope) return
    const resolvedHeader = previous && view && !previous.storageScope && !!view.storageScope
      && previous.activeMode === view.activeMode && previous.collaborationId === view.collaborationId && previous.revision === view.revision
    const saved = (resolvedHeader ? draftsByScope.current.get(previousScope.current) : undefined) ?? draftsByScope.current.get(scope) ?? (previousScope.current === '' ? draftsByScope.current.get('') : undefined)
    if (resolvedHeader && saved) { draftsByScope.current.set(scope, saved); draftsByScope.current.delete(previousScope.current) }
    if (resolvedHeader && hostPathDrafts.current.has(previousScope.current)) {
      hostPathDrafts.current.set(scope, hostPathDrafts.current.get(previousScope.current)!)
      hostPathDrafts.current.delete(previousScope.current)
    }
    draftText.current = saved?.text ?? ''
    setDraft(saved?.text ?? ''); setReplyTo(saved?.replyTo); setRecipient(saved?.recipient ?? 'ai'); setHostPath(hostPathDrafts.current.get(scope) ?? '')
    setExported(''); setDocument(undefined); documentRequest.current++; setDocumentLoading(false); setSelectedTask(undefined)
    previousScope.current = scope
  }, [scope, view?.revision])
  const remember = (text: string, reply = replyTo, target = recipient) => { draftText.current = text; setDraft(text); setReplyTo(reply); setRecipient(target); draftsByScope.current.set(scope, { text, replyTo: reply, recipient: target }) }
  const run = (operation: Promise<unknown>) => { setError(''); void operation.catch(reason => setError(frameworkErrorText(reason))) }
  // The controller owns read errors by generation. Do not copy an obsolete
  // read rejection into page-local errors after navigation withdrew that read.
  const refresh = (archives = false, originals = false) => { setError(''); void controller.refresh(archives, false, originals).catch(() => {}) }
  useEffect(() => {
    if (!groupChat && recipient === 'human') {
      setRecipient('ai'); draftsByScope.current.set(scope, { text: draftText.current, replyTo, recipient: 'ai' })
    }
  }, [groupChat, recipient, scope, replyTo])
  const localPickerAvailable = typeof (globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: { pathFor?: (file: File) => string } }).__DSH_HOST_PATHS__?.pathFor === 'function'
  const canSelectAttachments = view?.activeMode === 'local' ? !!props.api.selectLocalAttachment && localPickerAvailable : !!props.api.uploadAttachment
  const chooseAttachments = (files: readonly File[]) => {
    const current = controller.snapshot().value
    if (!view?.storageScope || !current || changingMode || !canSelectAttachments
      || frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) !== scope) return
    remember(draftText.current)
    attachmentDrafts.add(scope, { mode: view.activeMode, collaborationId: view.collaborationId, storageScope: view.storageScope }, files)
  }
  const addHostPath = () => {
    const current = controller.snapshot().value
    if (!view?.storageScope || !current || view.activeMode !== 'local' || changingMode || !props.api.selectLocalAttachment
      || frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) !== scope) return
    const nativePath = hostPathDrafts.current.get(scope) ?? ''
    try {
      attachmentDrafts.addHostPath(scope, { mode: 'local', collaborationId: view.collaborationId, storageScope: view.storageScope }, nativePath)
      hostPathDrafts.current.delete(scope); setHostPath(''); setError('')
    } catch (reason) { setError(frameworkErrorText(reason)) }
  }
  const send = () => {
    const current = controller.snapshot().value
    const selections = attachmentDrafts.selections(scope)
    if (!view || !current || changingMode
      || frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) !== scope
      || (!draftText.current.trim() && !selections.length) || selections.some(row => row.state !== 'ready' || !row.reference)) return
    const attachments = selections.map(row => row.reference!)
    const now = new Date()
    const target = groupChat ? recipient : 'ai' as const
    const retry = controller.pendingDrafts().find(item => item.input.text === draftText.current
      && item.input.recipient === target && item.input.replyTo === replyTo && sameAttachmentReferences(item.input.attachments, attachments))
    if (retry?.state === 'sending') return
    const input = retry ? retry.input : { mode: view.activeMode, collaborationId: view.collaborationId, storageScope: view.storageScope, id: crypto.randomUUID(), createdAt: now.toISOString(), timezoneOffsetMinutes: -now.getTimezoneOffset(), text: draftText.current, recipient: target, replyTo, device: 'dsh-web', ...(attachments.length ? { attachments } : {}) }
    setError('')
    const sentDraft = draftsByScope.current.get(scope) ?? { text: input.text, replyTo: input.replyTo, recipient: target }
    draftsByScope.current.set(scope, sentDraft)
    const sameComposer = () => {
      const latest = controller.snapshot().value
      return latest?.activeMode === view.activeMode && latest.collaborationId === view.collaborationId
        && (latest.storageScope === view.storageScope || (view.storageScope === undefined && latest.revision === view.revision))
    }
    // Keep both text and selected originals until the durable conversation ack.
    // A late ack can clear only its own saved draft, never another selection.
    void controller.send(input).then(() => {
      const saved = draftsByScope.current.get(scope)
      // Acknowledge the original selections, not a later upload of the same file.
      for (const row of selections) attachmentDrafts.remove(scope, row.id)
      if (saved === sentDraft && saved?.text === input.text && saved.replyTo === input.replyTo && saved.recipient === target) {
        draftsByScope.current.set(scope, { text: '', recipient: target })
        if (sameComposer() && draftText.current === input.text) {
          draftText.current = ''; setDraft(''); setReplyTo(undefined)
          const latest = controller.snapshot().value!
          draftsByScope.current.set(frameworkScopeKey(latest.activeMode, latest.collaborationId, latest.storageScope), { text: '', recipient: target })
        }
      }
    }, reason => { if (sameComposer()) setError(frameworkErrorText(reason)) })
  }
  const prepareAttachment = async (reference: ConversationAttachmentReference) => {
    if (!view?.storageScope || !props.api.attachment || reference.mode !== view.activeMode || reference.collaborationId !== view.collaborationId) return
    attachmentRequest.current?.abort()
    const request = new AbortController(); attachmentRequest.current = request
    setAttachmentDownload({ reference })
    try {
      const result = await props.api.attachment({ mode: view.activeMode, collaborationId: view.collaborationId, storageScope: view.storageScope, reference }, request.signal)
      if (request.signal.aborted || attachmentRequest.current !== request || !sameDocumentScope()) { if (result.downloadUrl.startsWith('blob:')) URL.revokeObjectURL(result.downloadUrl); return }
      if (result.bytes !== reference.bytes) { if (result.downloadUrl.startsWith('blob:')) URL.revokeObjectURL(result.downloadUrl); throw new Error('The authenticated attachment download is unavailable.') }
      const downloadUrl = result.downloadUrl.startsWith('blob:') ? result.downloadUrl : authenticatedAttachmentDownloadPath(result.downloadUrl)
      setAttachmentDownload({ reference, downloadUrl })
    } catch (reason) {
      if (!request.signal.aborted && attachmentRequest.current === request && sameDocumentScope()) { frameworkErrorText(reason); setAttachmentDownload({ reference, failed: true, capability: reason instanceof AttachmentDownloadCapabilityError ? reason.capability : undefined }) }
    }
  }
  const attachmentLabel = (mimeType: string) => attachmentKind(mimeType) === 'image' ? tr('图片', 'Image') : attachmentKind(mimeType) === 'video' ? tr('视频', 'Video') : tr('文件', 'File')
  const attachmentCards = (references: readonly ConversationAttachmentReference[] = []) => references.map((reference, index) => <div key={reference.path + ':' + reference.sha256 + ':' + index} data-conversation-attachment data-attachment-kind={attachmentKind(reference.mimeType)} className={css.artifact} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <span>{attachmentLabel(reference.mimeType)} · {reference.name} · {attachmentByteLabel(reference.bytes)}</span>
    {reference.mode === 'local' ? <><span>{reference.path}</span><Button size="sm" disabled={!props.api.openLocalAttachment || !view?.storageScope || view.activeMode !== 'local' || reference.collaborationId !== view.collaborationId} onClick={() => { if (view?.storageScope && props.api.openLocalAttachment) run(props.api.openLocalAttachment({ mode: 'local', collaborationId: view.collaborationId, storageScope: view.storageScope, reference })) }}>{tr('打开原文件', 'Open original')}</Button></>
      : <Button size="sm" title={!props.api.attachment ? tr('当前客户端连接不支持原始附件下载，未切换到其他连接。', 'This client connection does not support raw attachment downloads. No other connection was used.') : undefined} disabled={!props.api.attachment || !view?.storageScope || reference.mode !== view.activeMode || reference.collaborationId !== view.collaborationId} onClick={() => { void prepareAttachment(reference) }}>{tr('下载原文件', 'Download original')}</Button>}
  </div>)

  const saveForegroundModel = (input: Parameters<FrameworkClientApi['foregroundModel']>[0]) => {
    setModelOperations(current => ({ ...current, [scope]: { input, pending: true } })); setError('')
    const settle = (saved: boolean) => setModelOperations(current => {
      if (current[scope]?.input.commandId !== input.commandId) return current
      const next = { ...current }
      if (saved) delete next[scope]; else next[scope] = { input, pending: false }
      return next
    })
    void controller.foregroundModel(input).then(() => settle(true), reason => {
      settle(false)
      const current = controller.snapshot().value
      if (current?.activeMode === input.mode && current.storageScope === input.storageScope) setError(frameworkErrorText(reason))
    })
  }
  const unknownPhysicalSource = () => tr('此链接未携带原接入电脑和确切物理地址，不能猜测当前电脑。请使用包含来源信息的实际文件链接。', 'This link does not carry its original computer and exact physical address. Use a source-bearing physical link; the current computer cannot be assumed.');
  const physicalIssue = (reference: PhysicalWorkspaceReference) => {
    if (!isPhysicalWorkspaceReference(reference)) return unknownPhysicalSource();
    if (!view?.connection.instanceUUID) return tr("\u5F53\u524D\u63A5\u5165\u7535\u8111\u8EAB\u4EFD\u5C1A\u4E0D\u53EF\u786E\u8BA4\uFF0C\u4E0D\u80FD\u8BFB\u53D6\u6216\u6253\u5F00\u6B64\u7269\u7406\u6210\u679C\u3002", "This connection identity is unavailable, so the physical result cannot be read or opened.");
    if (reference.instanceUUID !== view.connection.instanceUUID)
      return tr("\u6B64\u6210\u679C\u4F4D\u4E8E " + reference.owner + " \u7684\u539F\u63A5\u5165\u7535\u8111\uFF0C\u8BF7\u5728\u539F\u7535\u8111\u6253\u5F00\uFF1B\u4E0D\u4F1A\u8BFB\u53D6\u5F53\u524D\u7535\u8111\u7684\u540C\u540D\u8DEF\u5F84\u3002", "This result is on " + reference.owner + "'s original connected computer. Open it there; a same-named path on this computer will not be read.");
    return undefined;
  };
  const open = async (path: string, reference?: PhysicalWorkspaceReference, originalTaskId?: string) => {
    if (!view) return;
    const issue = reference ? reference.path !== path ? unknownPhysicalSource() : physicalIssue(reference) : physicalMarkdownPath(path) ? unknownPhysicalSource() : undefined;
    if (issue) {
      setError(issue);
      return;
    }
    const request = ++documentRequest.current;
    setDocument(undefined);
    setDocumentLoading(true);
    try {
      const result = await props.api.readFile({ mode: view.activeMode, storageScope: view.storageScope, path: path, ...reference ? { reference } : {}, ...(originalTaskId ? { originalTaskId } : {}) });
      if (request === documentRequest.current && sameDocumentScope()) setDocument({ ...result, ...reference ? { reference } : {} });
    } catch (reason) {
      if (request === documentRequest.current && sameDocumentScope()) setError(frameworkErrorText(reason));
    } finally {
      if (request === documentRequest.current && sameDocumentScope()) setDocumentLoading(false);
    }
  };
  const openNative = async (reference: PhysicalWorkspaceReference) => {
    if (!view) return;
    const issue = physicalIssue(reference);
    if (issue) {
      setError(issue);
      return;
    }
    if (!props.api.openWorkspaceFile) {
      setError(tr("\u5F53\u524D\u63A5\u5165\u7AEF\u6CA1\u6709\u539F\u751F\u6587\u4EF6\u6253\u5F00\u80FD\u529B\uFF0C\u53EF\u4F7F\u7528\u9884\u89C8\u3002", "This connection cannot open native files. Preview is available."));
      return;
    }
    try {
      await props.api.openWorkspaceFile({ mode: view.activeMode, storageScope: view.storageScope, path: reference.path, reference });
    } catch (reason) {
      if (sameDocumentScope()) setError(frameworkErrorText(reason));
    }
  };
  const openMarkdownFile = (path: string, reference?: PhysicalWorkspaceReference) => {
    if (physicalMarkdownPath(path)) {
      if (!reference || reference.path !== path) {
        setError(unknownPhysicalSource());
        return;
      }
      setError("");
      void openNative(reference);
      return;
    }
    if (logicalMarkdownPath(path) === undefined) {
      setError(tr("\u6B64\u94FE\u63A5\u4E0D\u662F DSS \u8D44\u6599\u5E93\u5185\u7684\u903B\u8F91\u76F8\u5BF9\u8DEF\u5F84\u3002\u8BF7\u4F7F\u7528\u4EFB\u52A1\u6210\u679C\u6216\u5F52\u6863\u4E2D\u7684\u8D44\u6599\u94FE\u63A5\u3002", "This link is not a logical relative path inside DSS storage. Use a task result or archive material link."));
      return;
    }
    setError("");
    void open(path);
  };
  const sameDocumentScope = () => {
    const current = controller.snapshot().value;
    return current && frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) === scope && current.connection.instanceUUID === view?.connection.instanceUUID;
  };
  const workspaceResult = (result: PhysicalWorkspaceReference | string, index: number) => {
    if (typeof result === 'string') return <div className={css.artifact} key={'legacy:' + index + ':' + result}><code>{result}</code><p>{unknownPhysicalSource()}</p></div>
    const issue = physicalIssue(result)
    return <div key={JSON.stringify(result)} className={css.artifact} data-workspace-result title={result.owner + ' · ' + result.instanceUUID}>
      <code>{result.owner} · {result.path}</code>
      <div className={css.actions}>
        <Button size="sm" disabled={!!issue || !props.api.openWorkspaceFile} onClick={() => { setError(''); void openNative(result) }}>{tr('打开原文件', 'Open original file')}</Button>
        <Button size="sm" disabled={!!issue} onClick={() => { setError(''); void open(result.path, result) }}>{tr('预览', 'Preview')}</Button>
      </div>
      {issue ? <p>{issue}</p> : !props.api.openWorkspaceFile && <p>{tr('当前接入端没有原生文件打开能力，可使用预览。', 'This connection cannot open native files. Preview is available.')}</p>}
    </div>
  }
  const openLegacyRecords = async (task: FrameworkLegacyTask) => {
    if (!view) return
    const request = ++documentRequest.current; setDocument(undefined); setDocumentLoading(true)
    try {
      const result = await props.api.legacyRecords({ mode: view.activeMode, storageScope: view.storageScope, migrationId: task.migrationId, oldTaskId: task.oldTaskId })
      if (request === documentRequest.current && sameDocumentScope()) setDocument({ ...result, label: tr('完整原记录', 'Complete original records') + ' · ' + task.oldTaskId })
    } catch (reason) { if (request === documentRequest.current && sameDocumentScope()) setError(frameworkErrorText(reason)) }
    finally { if (request === documentRequest.current && sameDocumentScope()) setDocumentLoading(false) }
  }
  const exportLegacyRecords = async (task: FrameworkLegacyTask) => {
    if (!view || view.activeMode !== 'local') return
    try {
      const result = await props.api.exportRecords({ mode: 'local', storageScope: view.storageScope, migrationId: task.migrationId, oldTaskId: task.oldTaskId })
      if (sameDocumentScope()) setExported(result.path)
    } catch (reason) { if (sameDocumentScope()) setError(frameworkErrorText(reason)) }
  }
  const pending = controller.pendingDrafts().filter(item => item.input.mode === 'local')
  const visibleMessages = useMemo(() => view?.messages.filter((message) => message.role !== "system" || message.source === "deepseek-servant-status") ?? [], [view?.messages]);
  const liveProcessesVisible = props.transportConnected !== false && !changingMode && !snapshot.error && !!view?.foregroundProcessing;
  const processGroups = useMemo(() => {
    const live = liveProcessesVisible ? view?.foregroundProcessGroups ?? [] : [];
    const currentIds = new Set(live.map((group) => group.id));
    const liveIds = /* @__PURE__ */ new Set(), ids = new Set(visibleMessages.map((message) => message.id));
    const merged = new Map((view?.processGroups ?? []).filter((group) => group.closed && currentIds.has(group.id)).map((group) => [group.id, group]));
    for (const group of live) {
      const stored = merged.get(group.id);
      const preferred = stored?.closed && !group.closed ? stored : group;
      const fallback = preferred === group ? stored : group;
      const anchors = preferred.beforeMessageId || preferred.afterMessageId ? preferred : fallback;
      merged.set(group.id, {
        ...fallback,
        ...preferred,
        beforeMessageId: anchors?.beforeMessageId,
        afterMessageId: anchors?.afterMessageId
      });
      if (!(stored?.closed && !group.closed)) liveIds.add(group.id);
    }
    const before = new Map<string, FrameworkClientProcessGroup[]>(), after = new Map<string, FrameworkClientProcessGroup[]>(), tail: FrameworkClientProcessGroup[] = [];
    let count = 0;
    for (const group of [...merged.values()].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))) {
      const beforeId = group.beforeMessageId && ids.has(group.beforeMessageId) ? group.beforeMessageId : undefined;
      const afterId = group.afterMessageId && ids.has(group.afterMessageId) ? group.afterMessageId : undefined;
      const target = beforeId ? before : afterId ? after : undefined, id = beforeId ?? afterId;
      if (target && id) {
        const values = target.get(id) ?? [];
        values.push(group);
        target.set(id, values);
        count++;
      } else if (liveIds.has(group.id) && !view?.historyWindow) {
        tail.push(group);
        count++;
      }
    }
    return { before, after, tail, count };
  }, [visibleMessages, view?.processGroups, view?.foregroundProcessGroups, view?.historyWindow, liveProcessesVisible]);
  const turns = useMemo(() => conversationTurns(visibleMessages), [visibleMessages]);
  const [activeTurnId, setActiveTurnId] = useState<string>();
  const messagesById = new Map(visibleMessages.map((message) => [message.id, message]));
  const replyPreview = (id: string) => {
    const original = messagesById.get(id);
    return original ? frameworkReplyPreview(original.text) || original.attachments?.map(item => item.name).join(', ') || tr("\u7A7A\u6D88\u606F", "Empty message") : tr("\u539F\u6D88\u606F\u672A\u52A0\u8F7D", "Original message not loaded");
  };
  const messages = useRef<HTMLDivElement>(null), followBottom = useRef(true), previousTop = useRef(0)
  const historyOperation = useRef<object>(), renderedScope = useRef(scope); renderedScope.current = scope
  const prepend = useRef<{ id?: string; offset: number; top: number; first?: string; done: boolean }>()
  const anchor = () => {
    const element = messages.current!
    const top = element.getBoundingClientRect().top
    const row = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.getBoundingClientRect().bottom > top)
    return { id: row?.dataset.messageId, offset: row ? row.getBoundingClientRect().top - top : 0, top: element.scrollTop }
  }
  const history = (operation: () => Promise<void>, older = false) => {
    if (older && (historyOperation.current || !view?.pageBefore)) return
    const owner = historyOperation.current = {}, requestScope = scope
    if (older && messages.current) prepend.current = { ...anchor(), first: view?.messages[0]?.id, done: false }
    else { prepend.current = undefined; followBottom.current = true }
    setHistoryBusy(true); setError('')
    void operation().catch(reason => {
      if (historyOperation.current === owner && renderedScope.current === requestScope) setError(frameworkErrorText(reason))
    }).finally(() => {
      if (historyOperation.current !== owner || renderedScope.current !== requestScope) return
      historyOperation.current = undefined
      if (prepend.current) prepend.current.done = true
      setHistoryBusy(false)
    })
  }
  const loadOlder = () => { if (messages.current && view?.pageBefore) { followBottom.current = false; history(() => controller.older(50), true) } }
  const updateActiveTurn = () => {
    const element = messages.current;
    if (!element || !turns.length) {
      setActiveTurnId(undefined);
      return;
    }
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 1) {
      setActiveTurnId(turns.at(-1)?.anchorId);
      return;
    }
    const ids = new Set(turns.map((turn) => turn.anchorId)), top = element.getBoundingClientRect().top + 24;
    let active = turns[0].anchorId;
    for (const row of element.querySelectorAll<HTMLElement>("[data-message-id]")) {
      if (row.getBoundingClientRect().top > top) break;
      if (ids.has(row.dataset.messageId!)) active = row.dataset.messageId!;
    }
    setActiveTurnId(active);
  };
  const navigateTurn = (id: string) => {
    const element = messages.current;
    const row = element && Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]")).find((row) => row.dataset.messageId === id);
    if (!element || !row) return;
    followBottom.current = false;
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    previousTop.current = element.scrollTop;
    if (prepend.current) Object.assign(prepend.current, anchor());
    setActiveTurnId(id);
  };
  useLayoutEffect(() => {
    historyOperation.current = undefined; prepend.current = undefined; followBottom.current = true; previousTop.current = 0
    setHistoryBusy(false); setHistoryDate(''); setActiveTurnId(undefined)
  }, [scope])
  useLayoutEffect(() => {
    const element = messages.current
    if (!element) return
    const saved = prepend.current
    if (saved && view?.messages[0]?.id !== saved.first) {
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.dataset.messageId === saved.id)
      element.scrollTop = row ? element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset : saved.top
      prepend.current = undefined
    } else if (followBottom.current) element.scrollTop = element.scrollHeight
    if (prepend.current?.done) prepend.current = undefined
    previousTop.current = element.scrollTop
    updateActiveTurn()
  }, [view?.messages, processGroups, snapshot.drafts, historyBusy, scope, tab])
  const onScroll = () => {
    const element = messages.current
    if (!element) return
    const upward = element.scrollTop < previousTop.current
    previousTop.current = element.scrollTop
    if (prepend.current) Object.assign(prepend.current, anchor())
    followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    updateActiveTurn()
    if (upward && element.scrollTop < element.clientHeight / 2) loadOlder()
  }
  const task = view?.tasks.find(item => item.taskId === selectedTask)
  const empty = !view || (tab === 'conversation' ? !view.messages.length && !view.missingBodies?.length : tab === 'tasks' ? !view.tasks.length : false)
  const imageFor = (page: 'conversation' | 'tasks') => illustrationFor(page, view?.settings ?? blankSettings) === 'welcome' ? __SERVANT_WELCOME_CHARACTER_DATA_URI__ : __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__
  const corner = showCornerIllustration(!empty, view?.settings ?? blankSettings)
  const keepCurrentUpgrade = view?.storageScope ? async (path: string, operationId: string) => {
    await props.api.keepCurrentLocalUpgradeTarget({ mode: 'local', storageScope: view.storageScope!, operationId, path,
      confirmation: 'keep-current-with-original-unexported' })
    await controller.refresh(true)
  } : undefined
  const keepRetainedStage = view?.storageScope ? async (path: string, operationId: string, stageOwner?: Parameters<FrameworkClientApi['keepCurrentLocalUpgradeTarget']>[0]['stageOwner']) => {
    await props.api.keepCurrentLocalUpgradeTarget({ mode: 'local', storageScope: view.storageScope!, operationId, path,
      ...(stageOwner ? { stageOwner } : {}),
      confirmation: 'keep-retained-stage-without-cleanup' })
    await controller.refresh(true)
  } : undefined
  const settingsContent = <>
      {!view && <p role="status">{tr('正在读取设置…', 'Loading settings…')}</p>}
      {view && <div className={css.settingsSurface}>
        <SegmentedControl id="framework-settings" label={tr('设置', 'Settings')} value={settingsTab} onChange={setSettingsTab} options={[
          { value: 'settings', label: tr('设置', 'Settings') }, { value: 'knowledge', label: tr('经验', 'Knowledge') }, { value: 'resources', label: tr('资源', 'Resources') },
        ]} />
        <div className={css.settingsBody}>
          {settingsTab === 'settings' && <div className={css.settingsColumn}>
      {view?.activeMode === 'local' && <LocalUpgradeStatus value={view.localUpgrade} tr={tr} className={css.notice} onKeepCurrent={keepCurrentUpgrade} onKeepStage={keepRetainedStage} />}
      {view && <FrameworkSettingsForm key={view?.activeMode ?? 'local'} {...props} controller={controller} view={view} />}
      {view?.activeMode === 'local' && (view.pendingRecordMove?.storageScope ?? view.storageScope) && <RecordMovePanel key={'move:' + (view.pendingRecordMove?.storageScope ?? scope) + ':' + (view.pendingRecordMove?.commandId ?? '')} api={props.api} storageScope={(view.pendingRecordMove?.storageScope ?? view.storageScope)!} settingsRevision={view.revision} pendingRequest={view.pendingRecordMove} tr={tr} changed={async () => { await controller.latest(); await controller.refresh(true) }} />}
      {view?.activeMode === 'local' && view.storageScope && <ManualCleanupPanel key={scope} api={props.api} storageScope={view.storageScope} tr={tr} changed={async () => { await controller.latest(); await controller.refresh(true) }} />}
          </div>}
          {settingsTab === 'knowledge' && <KnowledgePanel key={scope} api={props.api} view={view} tr={tr} open={open} />}
      {settingsTab === 'resources' && <div className={css.knowledge}>{view?.resources.map(resource => <section className={css.knowledgeCard} key={resource.instanceUUID ?? resource.name}><div className={css.rowBetween}><h3>{resource.name}</h3><span className={css.badge}>{frameworkStateLabel(resource.status, tr)}</span></div>
        <p>{tr('每任务 Worker 席位', 'Worker seats per task')}：{resource.workerSeats ?? tr('未知', 'Unknown')}</p><code>{resource.instanceUUID}</code>{resource.detail && <p>{resource.detail}</p>}</section>)}
        <RoleExecutions executions={view?.executions ?? []} tr={tr} controller={controller} view={view} /></div>}
        </div>
      </div>}
  </>
  if (props.settingsOnly) return <section className={css.globalSettings} aria-label={t('settings.open')}><h2>DeepSeek Servant</h2>
    {(error || snapshot.error) && <p className={css.notice} role="alert">{error || snapshot.error}</p>}{settingsContent}
  </section>
  return <section className={css.page} aria-label="DeepSeek Servant">
    <header className={css.heading}><div className={css.identity}>
      <img className={css.avatar} src={__SERVANT_ICON_DATA_URI__} alt="" />
      <div><h1>{view?.settings.name || 'DeepSeek Servant'}</h1><p>{tr('围绕您的目标，持续做事与积累经验。', 'Work toward your goals and build reusable experience')}</p></div>
    </div><div className={css.headerStatus}>
      <span className={css.status}><StateDot state={snapshot.error ? 'error' : snapshot.loading ? 'ongoing' : 'idle'} />{view ? frameworkStateLabel(view.connection.status, tr) : tr('未连接', 'Not connected')}</span>
      <Button size="sm" onClick={() => refresh(tab === 'archives', true)}>{tr('刷新', 'Refresh')}</Button>
      <Button size="sm" aria-label={tr('设置', 'Settings')} onClick={() => { setSettingsTab('settings'); setSettingsOpen(true) }}><IconSettingsOutlineRegular size={18} /></Button>
    </div></header>
    <nav className={css.navigation}><div className={css.navigationControls}>
      <SegmentedControl id="framework-tabs" label={tr('页面', 'Pages')} value={tab === 'archives' ? 'tasks' : tab} onChange={next => setTab(next)} options={[
        { value: 'conversation', label: tr('对话', 'Conversation') }, { value: 'tasks', label: tr('任务', 'Tasks') },
      ]} />
      <Menu open={modeOpen} portal side="bottom" align="start" selectedId={view?.activeMode}
        items={[{ id: 'local', label: 'local' }, { id: 'git', label: 'DSS-cah' }]}
        onSelect={id => { setModeOpen(false); const request = ++modeNavigation.current; setChangingMode(true); run(controller.selectMode(id === 'git' ? 'git' : 'local').finally(() => { if (request === modeNavigation.current) setChangingMode(false) })) }}
        onClose={() => setModeOpen(false)} anchor={<Button variant="outline" size="sm" aria-label={tr('模式', 'Mode')} aria-haspopup="menu" aria-expanded={modeOpen}
          onClick={() => setModeOpen(!modeOpen)}><span>{!view ? tr('模式', 'Mode') : view.activeMode === 'git' ? 'DSS-cah' : 'local'}</span><IconChevronDownOutlineRegular size={14} /></Button>} />
    </div>{view && <div className={css.workspaceSummary}><span>{view.settings.workspace}</span>{view.connection.workerSeats !== undefined && <span>{tr('已生效每任务 Worker 席位', 'Applied Worker seats per task')}: {view.connection.workerSeats}{view.connection.workerSeats !== view.settings.workerSeats && <> ({tr('已保存设置', 'Saved setting')}: {view.settings.workerSeats})</>}</span>}</div>}</nav>
    {(error || snapshot.error || view?.connection.detail) && <div className={css.notice} role="alert">{error || snapshot.error || view?.connection.detail}</div>}
    {view?.activeMode === 'local' && !settingsOpen && <LocalUpgradeStatus value={view.localUpgrade} tr={tr} className={css.notice} onKeepCurrent={keepCurrentUpgrade} />}
    {exported && <p className={css.notice} role="status" style={{ flexShrink: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{tr('记录已导出到', 'Records exported to')}: {exported}</p>}
    <div className={`${css.content} ${corner ? css.contentWithCorner : ''}`}>
      {tab === 'conversation' && <div className={css.conversation}>
        <nav className={css.historyNavigation} aria-label={t('conversation.history')}>
          <Button size="sm" disabled={historyBusy || !view?.pageBefore} onClick={loadOlder}>{t('conversation.older')}</Button>
          {view?.pageAfter && <Button size="sm" disabled={historyBusy} onClick={() => history(() => controller.navigateHistory({ date: view.historyDate, afterId: view.pageAfter, limit: 50 }))}>{t('conversation.newer')}</Button>}
          <HistoryDatePicker value={historyDate} disabled={!view} t={t} onPick={date => { setHistoryDate(date); history(() => date ? controller.navigateHistory({ date, limit: 50 }) : controller.latest()) }} />
          {view?.historyWindow && <Button size="sm" onClick={() => { setHistoryDate(''); history(() => controller.latest()) }}>{t('conversation.latest')}</Button>}
        </nav>
        <div className={css.conversationTranscript} data-conversation-transcript>
        {!!view?.missingBodies?.length && <div className={css.notice} role="alert" data-missing-conversation-bodies>
          <p>{tr('以下消息的本机正文当前缺失；不会从原 SQL 回补。其他消息仍可阅读。', 'These local message bodies are currently missing; they will not be restored from original SQL. Other messages remain readable.')}</p>
          {view.missingBodies.map(row => <p key={row.id}><code>{row.id}</code> · <code>{row.path}</code></p>)}
        </div>}
        <ConversationTurnNavigator key={scope + ':' + (view?.historyDate ?? '')} turns={turns} activeId={activeTurnId} onNavigate={navigateTurn} zh={zh} />
        <div ref={messages} className={css.messages} role="log" tabIndex={0} aria-live="polite" aria-busy={historyBusy} onScroll={onScroll}
          onWheel={event => { if (event.deltaY < 0 && event.currentTarget.scrollTop < event.currentTarget.clientHeight / 2) loadOlder() }}>
          {empty && !processGroups.count && (historyDate ? <p className={css.muted}>{t('conversation.noHistory')}</p> : <div className={css.welcome}><img className={css.welcomeIcon} src={imageFor('conversation')} alt="" /><h2>{t('conversation.empty')}</h2><p>{t('conversation.hint')}</p></div>)}
          {view && visibleMessages.map((message, index) => <Fragment key={message.id}>
            {processGroups.before.get(message.id)?.map(group => <ForegroundProcess key={group.id} group={group} zh={zh} />)}
            <article data-message-id={message.id} className={`${css.message} ${css.messageRow} ${message.role === 'user' ? css.userMessage : ''}`}>
              <div className={css.messageHeader} data-message-header>
                {(view.activeMode === 'git' || message.role !== 'user' || view.settings.userName) && <div className={css.messageAuthor}
                  title={[message.participantId, message.role, message.createdAt, message.device, message.model, message.modelVersion].filter(Boolean).join(' · ')}>{frameworkMessageAuthor(view.activeMode, message, view.settings)}</div>}
                <Button size="sm" onClick={() => remember(draft, message.id)}>{tr('回复此条', 'Reply')}</Button>
              </div>
              <div className={css.messageBody} data-message-body>
                {message.replyTo && message.replyTo !== visibleMessages[index - 1]?.id && <p className={css.replyPreview} data-reply-preview>{tr('回复', 'Reply to')} {replyPreview(message.replyTo)}</p>}
                {message.role === 'assistant' ? <FrameworkMarkdown text={message.text} zh={zh} openFile={openMarkdownFile} /> : <div className={css.messageText}>{message.text}</div>}
                {attachmentCards(message.attachments)}
              </div>
            </article>
            {processGroups.after.get(message.id)?.map(group => <ForegroundProcess key={group.id} group={group} zh={zh} />)}
          </Fragment>)}
          {processGroups.tail.map(group => <ForegroundProcess key={group.id} group={group} zh={zh} />)}
          {pending.map(item => <article className={css.message} key={item.input.id}><div className={css.messageText}>{item.input.text}</div>
            {attachmentCards(item.input.attachments)}
            <p className={css.muted}>{item.state === 'sent' ? tr('消息已持久保存', 'Message durably saved') : item.state === 'sending' ? tr('正在发送', 'Sending') : tr('发送失败；输入已保留', 'Send failed; input retained')}</p>
            {item.error && <p className={css.errorDetail} role="alert">{item.error}</p>}
            {item.state !== 'sending' && item.state !== 'sent' && <Button size="sm" onClick={() => { if (item.input.text === draftText.current && item.input.replyTo === replyTo && sameAttachmentReferences(item.input.attachments, selectedAttachments.map(row => row.reference!).filter(Boolean))) send(); else run(controller.send(item.input)) }}>{tr('重试发送', 'Retry send')}</Button>}
          </article>)}
        </div></div>
        {props.transportConnected !== false && !changingMode && !snapshot.error && view?.foregroundProcessing && <ForegroundProcessing
          key={scope + ':' + view.foregroundProcessing.executionId + ':' + view.foregroundProcessing.turnId}
          processing={view.foregroundProcessing} name={view.settings.name || 'DeepSeek Servant'} zh={zh} />}
        <Fragment key={scope}>{!changingMode && props.transportConnected !== false && props.nativeQuestions?.(view?.executions ?? [], zh)}</Fragment>
        <div className={css.composer}><textarea aria-label={tr('消息', 'Message')} placeholder={t('conversation.placeholder')} value={draft} onChange={event => remember(event.target.value)}
          onPaste={event => { const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length && canSelectAttachments && view?.storageScope && !changingMode) { event.preventDefault(); chooseAttachments(files) } }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} />
          <input ref={attachmentInput} type="file" multiple hidden aria-label={tr('选择图片、视频或文件', 'Choose images, videos or files')} disabled={!view?.storageScope || !canSelectAttachments || changingMode} onChange={event => { if (attachmentPickerScope.current === undefined || attachmentPickerScope.current === scope) chooseAttachments(Array.from(event.currentTarget.files ?? [])); else setError(tr('会话已切换，请重新选择附件。', 'The conversation changed. Please select your attachments again.')); attachmentPickerScope.current = undefined; event.currentTarget.value = '' }} />
          {!!selectedAttachments.length && <div aria-label={tr('待发送附件', 'Selected attachments')} style={{ maxHeight: 180, overflowY: 'auto' }}>{selectedAttachments.map(row => <div key={row.id} data-selected-attachment data-upload-state={row.state} className={css.artifact} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            <span>{attachmentLabel(row.reference?.mimeType ?? row.mimeType)} · {row.name}{row.bytes === undefined ? '' : ' · ' + attachmentByteLabel(row.bytes)}</span>
            <span role="status">{row.state === 'ready' ? view?.activeMode === 'local' ? tr('已引用原文件，等待发送', 'Original selected, ready to send') : tr('已上传，等待发送', 'Uploaded, ready to send') : row.state === 'uploading' ? view?.activeMode === 'local' ? tr('正在读取原路径', 'Reading original path') : tr('正在上传', 'Uploading') : row.state === 'queued' ? view?.activeMode === 'local' ? tr('等待引用原文件', 'Waiting to select original') : tr('等待上传', 'Waiting to upload') : row.issue === 'git-size' ? tr('Git 每个文件不得超过 104,857,600 字节（100 MiB）', 'Git files cannot exceed 104,857,600 bytes (100 MiB)') : row.issue === 'unavailable' ? tr('当前接入端不支持附件上传', 'This connection does not support attachment uploads') : view?.activeMode === 'local' ? tr('此附件尚未就绪；请查看原因或重新选择原文件', 'This attachment is not ready; check its error or select the original again') : tr('上传尚未确认；原文件已保留，可按原标识重试', 'Upload not confirmed; original retained for retry with the same identity')}</span>
            {row.originalPath && <span>{row.originalPath}</span>}
            {row.error && <p role="alert">{row.error}</p>}
            {row.state === 'error' && !row.issue && <Button size="sm" onClick={() => attachmentDrafts.retry(scope, row.id)}>{view?.activeMode === 'local' ? tr('重试引用', 'Retry selection') : tr('重试上传', 'Retry upload')}</Button>}
            <Button size="sm" onClick={() => { remember(draftText.current); attachmentDrafts.remove(scope, row.id) }}>{tr('移除', 'Remove')}</Button>
          </div>)}</div>}
          {replyTo && <p className={css.replyPreview} data-reply-selection>{tr('回复', 'Reply to')} {replyPreview(replyTo)} <Button size="sm" onClick={() => { setReplyTo(undefined); draftsByScope.current.set(scope, { text: draft, recipient }) }}>{tr('取消引用', 'Clear reply')}</Button></p>}
          <div className={css.composerFooter}>{groupChat ? <SegmentedControl id="framework-recipient" label={tr('收件方', 'Recipient')} value={recipient} onChange={target => remember(draft, replyTo, target)} options={[{ value: 'ai', label: 'AI' }, { value: 'human', label: tr('群聊', 'People') }]} /> : <span className={css.composerHint}>{t('conversation.keyboard')}</span>}
            <div className={css.composerActions}>
              <Button size="sm" disabled={!view?.storageScope || !canSelectAttachments || changingMode} title={view?.activeMode === 'local' && !localPickerAvailable ? tr('此浏览器文件选择器不能提供 Host 原路径；请使用下方 Host 文件路径入口。', 'This browser picker cannot provide the original Host path. Use the Host file path field below.') : !canSelectAttachments ? tr('当前接入端不支持此模式的附件选择', 'This connection does not support attachment selection in this mode') : tr('选择图片、视频或文件', 'Choose images, videos or files')} onClick={() => { attachmentPickerScope.current = scope; attachmentInput.current?.click() }}>{tr('添加附件', 'Attach files')}</Button>
              {view && props.modelControl && <fieldset disabled={!!modelSaving || changingMode} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} aria-label={tr('前台模型', 'Foreground model')}
                title={tr('下轮对话使用；后台设为“跟随前台”时，后续后台任务沿用此选择。', 'Used for the next conversation turn. Future background tasks set to Follow Foreground follow this choice.')}>
                {props.modelControl(view.settings.foreground, model => saveForegroundModel({ mode: view.activeMode, storageScope: view.storageScope,
                  commandId: crypto.randomUUID(), model }), tr('前台模型', 'Foreground model'), { composer: true, disabled: !!modelSaving || changingMode })}
              </fieldset>}
              <Button variant="primary" disabled={!view || changingMode || composerSending || (!draft.trim() && !selectedAttachments.length) || selectedAttachments.some(row => row.state !== 'ready')} onClick={send}>{tr('发送', 'Send')}</Button>
            </div></div>
          {view?.activeMode === 'local' && <div className={css.composerFooter}>
            <label className={css.field}><span>{tr('以 Host 电脑为准的绝对文件路径；远程浏览器文件不会自动上传', 'Absolute file path on the Host computer; a remote browser file is not uploaded automatically')}</span>
              <Input value={hostPath} disabled={!view.storageScope || !props.api.selectLocalAttachment || changingMode} onChange={event => { const value = event.target.value; hostPathDrafts.current.set(scope, value); setHostPath(value) }} /></label>
            <Button size="sm" disabled={!view.storageScope || !props.api.selectLocalAttachment || changingMode || !hostPath} onClick={addHostPath}>{tr('引用 Host 文件', 'Attach Host file')}</Button>
          </div>}
          {modelAttempt && !modelSaving && view && modelAttempt.mode === view.activeMode && modelAttempt.storageScope === view.storageScope
            && <Button size="sm" onClick={() => saveForegroundModel(modelAttempt)}>{tr('核对并重试模型设置', 'Resolve and retry model setting')}</Button>}
        </div><p className={css.footnote}>{t('conversation.background')}</p>
      </div>}
      {(tab === 'tasks' || tab === 'archives') && <div style={{ width: '100%', minWidth: 0 }}><div className={css.historyNavigation}><Button size="sm" onClick={() => setTab('tasks')}>{t('tasks.current')}</Button><Button size="sm" onClick={() => { setTab('archives'); refresh(true) }}>{tr('成果档案', 'Archives')}</Button></div>
      {tab === 'tasks' && <div className={`${css.taskLayout} ${task ? css.hasSelection : ''}`}><div className={css.taskList}>
        <OriginalTaskReadStatus status={view?.originalTaskRead} tr={tr} />
        {empty && !view?.originalTaskRead && <div className={`${css.empty} ${css.illustratedEmpty}`}><img className={css.welcomeIcon} src={imageFor('tasks')} alt="" /><h2>{t('tasks.empty')}</h2><p>{t('tasks.hint')}</p></div>}
        {view?.tasks.map(item => <button key={item.taskId} className={`${css.taskRow} ${task?.taskId === item.taskId ? css.selected : ''}`} onClick={() => setSelectedTask(item.taskId)}>
          <span className={css.taskRowTitle}>{item.title}</span><span className={css.rowMeta} title={[item.taskId, item.route, item.owner].join(' · ')}><StateDot state={item.status === 'complete' ? 'done' : item.status === 'cancelled' ? 'idle' : item.control === 'paused' || item.control === 'cancelled' ? 'warning' : 'ongoing'} />{item.status === 'complete' ? tr('已完成', 'Completed') : item.status === 'cancelled' ? tr('已取消', 'Cancelled') : item.control === 'paused' || item.control === 'cancelled' ? tr('已暂停', 'Paused') : frameworkStateLabel(item.status, tr)}</span>
        </button>)}</div>{task && <section className={css.taskDetail}><Button size="sm" onClick={() => setSelectedTask(undefined)}>{tr('返回', 'Back')}</Button><h2>{task.title}</h2>
          <p>{task.route === 'P' ? tr('Planner 规划与验收', 'Planner planning and acceptance') : tr('Organizer 分派与总验收', 'Organizer assignment and total acceptance')}</p>
          {task.originalSource === 'local-sql' && <p role="status">{tr('正在显示原有记录。任务操作会等待该任务自己的转换，其他任务照常进行。', 'Showing the original record. Task controls wait only for this task’s restoration; other tasks continue.')}</p>}
          <section className={css.section}><h3>{tr('成员', 'Members')}</h3>{task.members.map(member => <div key={member.name} className={css.child}>{member.name} · {frameworkMemberStatus(member.status, zh)}</div>)}</section>
          {view && <TaskControls key={scope + task.taskId} task={task} view={view} controller={controller} tr={tr} />}
          <RoleExecutions executions={task.executions} tr={tr} controller={controller} view={view} />
          <section className={css.section}><h3>{tr('成果与证据', 'Results and evidence')}</h3>{task.resultPaths.map(path => <button key={path} className={css.artifact} title={path} onClick={() => { setError(''); void open(path, undefined, task.originalSource === 'local-sql' ? task.taskId : undefined) }}><code>{path}</code></button>)}{task.workspaceResults?.map(workspaceResult)}</section>
        </section>}</div>}
      {(tab === 'tasks' || tab === 'archives') && view && <LegacyTasks tasks={view.legacyTasks} controller={controller} mode={view.activeMode} storageScope={view.storageScope} open={open} openRecords={openLegacyRecords} exportRecords={exportLegacyRecords} tr={tr} />}
      {tab === 'archives' && <div className={css.knowledge}>{view?.archives.map(item => <section className={css.knowledgeCard} key={item.path}><h3>{item.title}</h3><code>{item.taskId}</code><button className={css.artifact} title={item.path} onClick={() => { setError(''); void open(item.path, undefined, item.originalTaskId) }}>{item.path}</button>{item.files?.map(path => <button className={css.artifact} key={path} title={path} onClick={() => { setError(''); void open(path, undefined, item.originalTaskId) }}>{path}</button>)}{!!item.missingReferences?.length && <section className={css.section}><h4><StateDot state="warning" />{tr('未保存的原件', 'Originals not retained')}</h4><p>{tr('归档时未找到这些原件，未保存副本。', 'These originals were not found when the archive was saved; no copy was retained.')}</p>{item.missingReferences.map(path => <p key={path}><code>{path}</code></p>)}</section>}{item.skillPublication && <section className={css.section}>
          {!!item.skillPublication.unmerged.length && <><h4><StateDot state="warning" />{tr('待处理技能提案', 'Skill proposals needing attention')}</h4>{item.skillPublication.unmerged.map((proposal, index) => <div className={css.child} key={proposal.proposalPreservedAt + ':' + index}>
            <p>{tr('技能路径：', 'Skill path: ')}<code>{proposal.path}</code></p><p className={css.errorDetail}>{proposal.reason}</p>
            <button className={css.artifact} title={proposal.proposalPreservedAt} onClick={() => { setError(''); void open(proposal.proposalPreservedAt) }}>{tr('查看保存的原提案：', 'Open saved original proposal: ')}{proposal.proposalPreservedAt}</button>
          </div>)}</>}
          {!!item.skillPublication.issues.length && <><h4>{tr('技能发布提示', 'Skill publication notices')}</h4>{item.skillPublication.issues.map((issue, index) => <p className={css.errorDetail} key={index}>{issue}</p>)}</>}
        </section>}{item.workspaceResults?.map(workspaceResult)}{view.activeMode === 'local' && item.path.endsWith('/records.md') && <Button onClick={() => run(props.api.exportRecords({ mode: 'local', storageScope: view.storageScope, recordPath: item.path }).then(result => { if (controller.snapshot().value?.storageScope === view.storageScope) setExported(result.path) }))}>{tr('导出完整记录', 'Export complete records')}</Button>}</section>)}</div>}
      </div>}
    </div>
    {corner && <div className={css.cornerArt} aria-hidden="true"><img className={css.cornerCharacter} src={imageFor(tab === 'conversation' ? 'conversation' : 'tasks')} alt="" /></div>}
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title={tr('设置', 'Settings')} closeLabel={tr('关闭', 'Close')} className={css.settingsModal} contentClassName={css.settingsModalContent}>
      {settingsOpen && settingsContent}
    </Modal>
    <Modal open={!!attachmentDownload} onClose={closeAttachment} title={attachmentDownload?.reference.name ?? tr('附件', 'Attachment')} closeLabel={tr('关闭', 'Close')}>
      {attachmentDownload && <div style={{ overflowWrap: 'anywhere' }}>
        <p>{attachmentLabel(attachmentDownload.reference.mimeType)} · {attachmentDownload.reference.name} · {attachmentByteLabel(attachmentDownload.reference.bytes)}</p>
        {attachmentDownload.downloadUrl ? <a href={attachmentDownload.downloadUrl} download={attachmentDownload.reference.name}>{tr('下载原文件', 'Download original')}</a> : attachmentDownload.failed ? <p role="alert">{attachmentDownload.capability === 'webcrypto' ? tr('当前 DSS 界面缺少 WebCrypto SHA-256，无法校验此次附件下载。', 'This DSS interface lacks WebCrypto SHA-256 and cannot verify this attachment download.') : attachmentDownload.capability === 'client-memory' ? tr('当前 DSS 界面无法为完整附件分配内存，此次下载未完成。', 'This DSS interface could not allocate memory for the complete attachment; this download did not finish.') : tr('附件读取失败，请关闭后重试。', 'The attachment could not be read. Close and try again.')}</p> : <p role="status">{tr('正在准备原文件下载', 'Preparing original download')}</p>}
        {attachmentDownload.downloadUrl?.startsWith('blob:') && <p className={css.muted}>{tr('当前客户端在内存中准备完整文件并用 WebCrypto 校验；大文件受客户端内存限制。', 'This client prepares the complete file in memory and verifies it with WebCrypto. Large files depend on client memory.')}</p>}
      </div>}
    </Modal>
    <Modal open={documentLoading || !!document} onClose={closeDocument} title={documentTitle} headless className={css.materialModal}>
      <div className={css.materialHeader}>
        <h2 className={css.materialTitle} title={documentTitle}>{documentTitle}</h2>
        <button type="button" className={css.materialClose} aria-label={tr('关闭', 'Close')} title={tr('关闭', 'Close')} onClick={closeDocument}><span aria-hidden="true">×</span></button>
      </div>
      <div className={css.materialBody}>
      {document?.reference && <div><code title={document.reference.instanceUUID}>{document.reference.owner} · {document.nativePath ?? document.reference.path}</code>
        <Button size="sm" disabled={!!physicalIssue(document.reference) || !props.api.openWorkspaceFile} onClick={() => { setError(''); void openNative(document.reference!) }}>{tr('打开原文件', 'Open original file')}</Button>
        {!props.api.openWorkspaceFile && <p>{tr('当前接入端没有原生文件打开能力，可使用预览。', 'This connection cannot open native files. Preview is available.')}</p>}
      </div>}
      {documentLoading && <StateDot state="ongoing" />}{document?.text !== undefined && (isMarkdownDocument(document.path) ? <FrameworkMarkdown key={scope + document.path} text={document.text} zh={zh} openFile={openMarkdownFile} /> : <div className={css.messageText}>{document.text}</div>)}
      {document?.downloadUrl && <a className={css.artifact} href={document.downloadUrl} download>{tr('下载原文件', 'Download original file')}</a>}
      {document?.binary && <div><p>{document.binary.bytes} bytes</p><code>SHA-256 {document.binary.sha256}</code><a className={css.artifact} href={document.binary.downloadUrl} download>{tr('下载附件', 'Download attachment')}</a></div>}
      </div>
    </Modal>
  </section>
}
function RoleExecutions({ executions, tr, controller, view }: { controller: FrameworkClientController; view?: FrameworkClientView; executions: FrameworkClientView['tasks'][number]['executions']; tr: (cn: string, en: string) => string }) {
  return <section className={css.section}><h3>{tr('角色执行', 'Role executions')}</h3>{roles.map(role => <div key={role} className={css.child}><h4>{role}</h4>{executions.filter(execution => execution.role === role).map(execution => <div key={execution.executionId} className={css.execution}><div>{execution.member} {execution.workerId} · {frameworkStateLabel(execution.state, tr)}<code>{execution.executionId}</code>{execution.detail && <p>{execution.detail}</p>}{view && <ExecutionStop key={frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope) + execution.executionId} execution={execution} view={view} controller={controller} tr={tr} />}</div></div>)}
    {!executions.some(execution => execution.role === role) && <p className={css.muted}>{tr('暂无执行', 'No current execution')}</p>}</div>)}</section>
}
/** Schema parsing can reorder settings and nested model fields. Identity and
 * saved-selection comparisons follow values, never object insertion order. */
function settingsFingerprint(settings: FrameworkClientSettings): string {
  return JSON.stringify(settings, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
}
function FrameworkSettingsForm(props: FrameworkPageProps & { controller: FrameworkClientController; view?: FrameworkClientView }) {
  const { view, controller } = props, zh = props.language !== 'en', tr = (cn: string, en: string) => zh ? cn : en
  const [settings, setSettings] = useState(() => structuredClone(view?.settings ?? blankSettings))
  const [edited, setEdited] = useState<ReadonlySet<keyof FrameworkClientSettings>>(() => new Set())
  const editVersion = useRef(0), settingsRef = useRef(settings)
  settingsRef.current = settings
  const edit = <K extends keyof FrameworkClientSettings>(key: K, value: FrameworkClientSettings[K]) => {
    ++editVersion.current
    setEdited(current => new Set(current).add(key))
    settingsRef.current = { ...settingsRef.current, [key]: value }
    setSettings(settingsRef.current)
  }
  const saveAttempt = useRef<{ fingerprint: string; commandId: string; settings: string; changedFields: Array<keyof FrameworkClientSettings>; editVersion: number; confirmed?: boolean }>()
  useEffect(() => {
    // Refresh untouched fields while retaining this form's explicit edits.
    if (view) setSettings(current => ({ ...structuredClone(view.settings),
      ...Object.fromEntries([...edited].map(key => [key, current[key]])) }))
  }, [view?.revision, view?.settings, edited])
  const [saving, setSaving] = useState(false), [picking, setPicking] = useState(false)
  const [participating, setParticipating] = useState<{ enabled: boolean }>()
  const [error, setError] = useState('')
  const connectionAttempt = useRef<object>()
  const [saved, setSaved] = useState(false)
  const mode = view?.activeMode ?? 'local'
  const savedCurrent = saved && !!view && settingsFingerprint(settings) === settingsFingerprint(view.settings)
  const canWithdraw = !!view?.connection.participating || view?.connection.status === 'starting' || (saving && connectionAttempt.current === saveAttempt.current) || participating?.enabled === true
  return <form className={css.settings} onSubmit={event => {
    event.preventDefault(); if (saving) return; setSaving(true); setError(''); setSaved(false)
    const serialized = settingsFingerprint(settings), prior = saveAttempt.current
    // Keep one pending UI attempt while its connection is unresolved.
    // Retrying the same settings uses the current configuration, not a history log.
    const changedFields = [...edited].sort()
    const fingerprint = JSON.stringify([mode, serialized, changedFields])
    if (!prior || prior.confirmed || prior.fingerprint !== fingerprint) saveAttempt.current = {
      fingerprint, commandId: crypto.randomUUID(), settings: serialized, changedFields, editVersion: editVersion.current }
    const attempt = connectionAttempt.current = saveAttempt.current!
    // The form transmits actual field intent, including explicit restoration
    // of an old value or clearing an optional control.
    void controller.configure({ mode, commandId: attempt.commandId, settings, changedFields: attempt.changedFields }).then(() => {
      attempt.confirmed = true
      if (connectionAttempt.current !== attempt) return
      if (editVersion.current === attempt.editVersion) setEdited(new Set())
      setSaved(true)
    }, reason => { if (connectionAttempt.current === attempt) setError(frameworkErrorText(reason)) }).finally(() => setSaving(false))
  }}><div className={css.settingsColumn}>
    {([['name', tr('名称', 'Name')], ['userName', tr('本地显示名称', 'Local display name')], ['collaborationId', tr('协作域', 'Collaboration')], ['workspace', tr('本机任务工作区', 'Local task workspace')],
      ...(mode === 'local' ? [['localDirectory', tr('Local 数据目录', 'Local data directory')]] : [['ownerRepo', tr('Git 仓库 owner/repository', 'Git owner/repository')], ['repositoryDirectory', tr('仓库内目录', 'Repository directory')]])] as Array<[keyof FrameworkClientSettings, string]>).map(([key, label]) => <label className={css.field} key={key}><span>{label}</span><Input value={String(settings[key] ?? '')} onChange={event => edit(key, event.target.value)} /></label>)}
    {mode === 'git' && <p className={css.muted}>{tr('Git 模式的日常读写使用 main 分支。', 'Git mode uses the main branch for everyday reads and writes.')}</p>}
    {props.onPickDirectory && <Button type="button" disabled={picking} onClick={() => { setPicking(true); setError(''); const selected = settings.workspace; void props.onPickDirectory!().then(workspace => { if (workspace !== null && settingsRef.current.workspace === selected) edit('workspace', workspace) }, reason => setError(frameworkErrorText(reason))).finally(() => setPicking(false)) }}>{tr('选择本机任务工作区目录', 'Browse local task workspace')}</Button>}
    <label className={css.field}><span>{tr('每任务 Worker 席位', 'Worker seats per task')}</span><Input type="number" min={0} step={1} value={settings.workerSeats} onChange={event => edit('workerSeats', Number(event.target.value))} /></label>
    <div className={css.runtimeControls}>
      {props.presetControl && <div className={css.field}><span>{tr('工作模式', 'Working mode')}</span>{props.presetControl(settings.presetId, presetId => edit('presetId', presetId))}<p className={css.muted}>{tr('选择 Agent 的工具与工作方式', 'Choose the Agent tools and working style')}</p></div>}
      {props.modelControl && <div className={css.field}><span>{tr('后台模型', 'Background model')}</span>{props.modelControl(settings.background, background => edit('background', background), tr('后台模型', 'Background model'), { followModel: settings.foreground, autoLabel: tr('跟随前台', 'Follow Foreground'), autoHint: '' })}</div>}
    </div>
    <section className={css.experimental}><h3>{tr('实验性', 'Experimental')}</h3><div className={css.experimentalGroups}><section className={css.experimentalCard}>
      <h4>{tr('页面插画', 'Page illustrations')}</h4>
      <label className={css.illustrationOption}><span>{tr('显示右下角人物', 'Show the bottom-right character')}</span><input type="checkbox" checked={settings.showCornerCharacter !== false} onChange={event => edit('showCornerCharacter', event.target.checked)} /></label>
      <label className={css.illustrationOption}><span>{tr('互换对话与任务页插画', 'Swap conversation and task illustrations')}</span><input type="checkbox" checked={settings.swapPageIllustrations === true} onChange={event => edit('swapPageIllustrations', event.target.checked)} /></label>
    </section></div></section>
    {mode === 'git' && <GitInvitation key={view?.storageScope ?? 'unresolved'} api={props.api} view={view} tr={tr} />}
    <div className={css.actions}><Button type="button" disabled={participating?.enabled === false} onClick={() => {
      const attempt = { enabled: !canWithdraw }; connectionAttempt.current = attempt; setParticipating(attempt); setError(''); setSaved(false)
      void controller.participation(attempt.enabled).catch(reason => { if (connectionAttempt.current === attempt) setError(frameworkErrorText(reason)) })
        .finally(() => setParticipating(current => current === attempt ? undefined : current))
    }}>{canWithdraw ? tr('退出协作后台', 'Leave collaboration background') : tr('开始协作后台', 'Start collaboration background')}</Button><Button type="submit" variant="primary" disabled={saving}>{tr('保存并连接', 'Save and connect')}</Button>{props.onOpenCredentials && mode === 'git' && <Button onClick={() => { void props.onOpenCredentials!().catch(reason => setError(frameworkErrorText(reason))) }}>{tr('Git 身份认证', 'Git authentication')}</Button>}</div>
    {error && <p className={css.errorDetail} role="alert">{error}</p>}{savedCurrent && <p className={css.muted} role="status">{tr('设置已保存。', 'Settings saved.')}</p>}
  </div></form>
}

function LegacyTasks({ tasks, controller, mode, storageScope, open, openRecords, exportRecords, tr }: { tasks: FrameworkLegacyTask[]; controller: FrameworkClientController; mode: 'local' | 'git'; storageScope?: string; open: (path: string) => Promise<void>; openRecords: (task: FrameworkLegacyTask) => Promise<void>; exportRecords: (task: FrameworkLegacyTask) => Promise<void>; tr: (cn: string, en: string) => string }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set()), [error, setError] = useState('')
  const attempts = useRef(new Map<string, { fingerprint: string; commandId: string; pending: boolean }>())
  const act = (task: FrameworkLegacyTask, action: 'resume' | 'answer', waitId?: string) => {
    const key = JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId, waitId]), answer = action === 'answer' ? answers[key] ?? '' : undefined
    const fingerprint = JSON.stringify([key, action, answer]), prior = attempts.current.get(key)
    if (prior?.pending) return
    const commandId = prior?.fingerprint === fingerprint ? prior.commandId : crypto.randomUUID()
    const attempt = { fingerprint, commandId, pending: true }; attempts.current.set(key, attempt); setBusy(current => new Set(current).add(key)); setError('')
    void controller.legacyControl({ mode, storageScope, commandId, migrationId: task.migrationId, oldTaskId: task.oldTaskId, action, waitId, answer })
      .catch(reason => setError(frameworkErrorText(reason))).finally(() => { attempt.pending = false; setBusy(current => { const next = new Set(current); next.delete(key); return next }) })
  }
  if (!tasks?.length) return null
  return <section className={css.knowledge}><h3>{tr('迁入的历史与接续', 'Imported history and continuation')}</h3>{error && <p className={css.errorDetail} role="alert">{error}</p>}
    {tasks.map(task => { const key = JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId]); return <section className={css.knowledgeCard} key={key}>
      <div className={css.rowBetween}><h4>{task.oldTaskId}</h4><span className={css.badge}>{frameworkStateLabel(task.continuation, tr)}</span></div><code>{task.taskId}</code>
      {task.issues?.map((issue, index) => <p key={index} className={css.errorDetail}>{issue}</p>)}
      {task.recordPath && <button className={css.artifact} onClick={() => { void open(task.recordPath!) }}>{tr('原任务资料', 'Original task data')}<code>{task.recordPath}</code></button>}
      {task.recordsAvailable && <Button onClick={() => { void openRecords(task) }}>{tr('完整原记录', 'Complete original records')}</Button>}
      {task.recordsAvailable && mode === 'local' && <Button onClick={() => { void exportRecords(task) }}>{tr('导出完整原记录', 'Export complete original records')}</Button>}
      {task.artifacts?.map(artifact => <div key={artifact.id + '\0' + artifact.sourcePath} className={css.artifact} data-legacy-artifact={artifact.id}>
        {artifact.status === 'archived' && artifact.archivedPath ? <button onClick={() => { void open(artifact.archivedPath!) }}>{tr('原附件', 'Original attachment')}: {artifact.id}</button> : <p>{tr('附件原引用（尚未导入）', 'Original attachment reference (not imported)')}: {artifact.id}</p>}
        <code style={{ overflowWrap: 'anywhere' }}>{artifact.sourcePath}</code>
        {artifact.originalAbsolutePath && physicalMarkdownPath(artifact.originalAbsolutePath) ? <p>{tr('历史原地址', 'Historical original address')}: <code style={{ overflowWrap: 'anywhere' }}>{artifact.originalAbsolutePath}</code> · {tr('仅为保留的历史出处，未核验文件现在是否仍存在。', 'Retained historical location only; current file existence has not been verified.')}</p> : <p>{tr('无法确定原绝对位置', 'The original absolute location cannot be determined.')}</p>}
        {artifact.sha256 && <p>{tr('历史记录的原始 SHA-256', 'Original SHA-256 from historical record')} <code>{artifact.sha256}</code></p>}
        {artifact.status !== 'archived' && <p>{artifact.detail || tr('仅保留原引用，不自动采集或复制原文件。', 'The original reference is retained without automatically collecting or copying the file.')}</p>}
      </div>)}
      {task.continuation === 'paused' && <Button disabled={busy.has(JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId, undefined]))} onClick={() => act(task, 'resume')}>{tr('继续任务', 'Resume task')}</Button>}
      {task.continuation !== 'complete' && task.continuation !== 'cancelled' && (task.waits ?? []).map(wait => {
        const answerKey = JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId, wait.id])
        return <form key={wait.id} className={css.formCard} onSubmit={event => { event.preventDefault(); act(task, 'answer', wait.id) }}>
          <p className={css.messageText}>{wait.question}</p><code>{wait.memberIdentity} · {wait.id}</code>
          <label className={css.field}><span>{tr('回复这个问题', 'Answer this question')}</span><textarea value={answers[answerKey] ?? ''} onChange={event => setAnswers({ ...answers, [answerKey]: event.target.value })} /></label>
          <Button type="submit" disabled={busy.has(answerKey)}>{tr('发送答复', 'Send answer')}</Button>
        </form>
      })}
      {task.continuation === 'wait-user' && !task.waits?.length && <p className={css.muted}>{tr('请打开原记录查看尚待解析的问题。', 'Open the original record to inspect unresolved questions.')}</p>}
    </section> })}
  </section>
}

function GitInvitation({ api, view, tr }: { api: FrameworkClientApi; view?: FrameworkClientView; tr: (cn: string, en: string) => string }) {
  const [username, setUsername] = useState(''), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(''), [error, setError] = useState('')
  const inFlight = useRef(false)
  const invite = () => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    void api.invite({ mode: 'git', storageScope: view?.storageScope, username: username.trim() }).then(result => {
      setNotice(result.status === 'pending' ? tr('邀请待接受', 'Invitation pending') : tr('已加入仓库协作', 'Repository access accepted')); setConfirm(false); setUsername('')
    }, reason => setError(frameworkErrorText(reason))).finally(() => { inFlight.current = false; setBusy(false) })
  }
  return <section className={css.section}>
    <h3>{tr('邀请协作者', 'Invite collaborator')}</h3><code>{view?.settings.ownerRepo}</code>
    <p className={css.muted}>{tr('接受邀请后可读写整个仓库；后台参与需对方自行启用。', 'Accepting grants read/write access to the whole repository; background participation must be enabled separately.')}</p>
    <label className={css.field}><span>{tr('GitHub 用户名', 'GitHub username')}</span><Input autoComplete="off" value={username} disabled={busy} onChange={event => { setUsername(event.target.value); setConfirm(false); setNotice(''); setError('') }} /></label>
    <div className={css.actions}>{confirm ? <><Button type="button" disabled={busy} onClick={invite}>{tr('确认邀请', 'Confirm invitation')}</Button><Button type="button" disabled={busy} onClick={() => setConfirm(false)}>{tr('取消', 'Cancel')}</Button></> : <Button type="button" disabled={!username.trim()} onClick={() => setConfirm(true)}>{tr('邀请写入协作者', 'Invite write collaborator')}</Button>}</div>
    <GitAuthorization api={api} view={view} tr={tr} />
    {notice && <p role="status">{notice}</p>}{error && <p className={css.errorDetail} role="alert">{error}</p>}
  </section>
}

function GitAuthorization({ api, view, tr }: { api: FrameworkClientApi; view?: FrameworkClientView; tr: (cn: string, en: string) => string }) {
  const [members, setMembers] = useState<Awaited<ReturnType<FrameworkClientApi['gitMembers']>>>()
  const [confirm, setConfirm] = useState<Parameters<FrameworkClientApi['gitMemberAction']>[0]>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const refreshOwner = useRef<object>()
  const refresh = async () => {
    const owner = {}; refreshOwner.current = owner
    try {
      const result = await api.gitMembers({ mode: 'git', storageScope: view?.storageScope })
      if (refreshOwner.current === owner) setMembers(result)
    } catch (reason) { if (refreshOwner.current === owner) throw reason }
  }
  const run = (fn: () => Promise<unknown>) => { setBusy(true); setError(''); void fn().catch(reason => setError(frameworkErrorText(reason))).finally(() => setBusy(false)) }
  const remove = (input: Parameters<FrameworkClientApi['gitMemberAction']>[0]) => {
    refreshOwner.current = undefined; setNotice('')
    run(async () => {
      await api.gitMemberAction(input)
      setConfirm(undefined); setMembers(undefined); setNotice(tr('仓库授权变更已完成。', 'Repository access change completed.'))
      // The mutation receipt is complete. A display refresh neither owns its busy
      // state nor retries or reverses the requested access change.
      void refresh().catch(reason => { frameworkErrorText(reason); setError(tr('授权变更已完成，但列表刷新失败。请刷新仓库授权。', 'The access change completed, but the list could not be refreshed. Refresh repository access.')) })
    })
  }
  return <section className={css.section}><h4>{tr('仓库授权管理', 'Repository access management')}</h4>
    <p className={css.muted}>{tr('这是仓库访问授权，不是在线实例名单。', 'Repository access permissions, not online instances.')}</p>
    <Button type="button" disabled={busy} onClick={() => run(refresh)}>{tr('刷新仓库授权', 'Refresh repository access')}</Button>
    {members?.invitations.map(item => <div key={item.id}>{item.login} · {frameworkStateLabel(item.status, tr)} <Button type="button" disabled={busy} onClick={() => setConfirm({ mode: 'git', storageScope: view?.storageScope, action: 'cancelInvitation', invitationId: item.id })}>{tr('撤销邀请', 'Revoke invitation')}</Button></div>)}
    {members?.collaborators.map(item => <div key={item.id}>{item.login} · {frameworkStateLabel(item.status, tr)} <span>{Object.entries(item.permissions).filter(([, allowed]) => allowed).map(([permission]) => permission).join(', ')}</span> <Button type="button" disabled={busy} onClick={() => setConfirm({ mode: 'git', storageScope: view?.storageScope, action: 'remove', username: item.login })}>{tr('移除协作者', 'Remove collaborator')}</Button></div>)}
    {confirm && <div role="group"><p>{confirm.action === 'remove' ? confirm.username : members?.invitations.find(item => item.id === confirm.invitationId)?.login}</p><Button type="button" disabled={busy} onClick={() => remove(confirm)}>{tr('确认撤销授权', 'Confirm access removal')}</Button><Button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{tr('取消撤销', 'Cancel removal')}</Button></div>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
function TaskControls({ task, view, controller, tr }: { task: FrameworkClientView['tasks'][number]; view: FrameworkClientView; controller: FrameworkClientController; tr: (cn: string, en: string) => string }) {
  const [intent, setIntent] = useState<'running' | 'paused' | 'cancelled'>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const attempt = useRef<{ intent: 'running' | 'paused' | 'cancelled'; commandId: string; lifecycleId?: string }>()
  const chooseIntent = (value: 'running' | 'paused' | 'cancelled') => { attempt.current = { intent: value, commandId: crypto.randomUUID(), lifecycleId: task.lifecycleId }; setIntent(value) }
  if (task.archived || task.status !== 'running') return null
  return <section className={css.section}>
    <p>{tr('暂停后可接续；取消将结束任务并保留已有成果与记录。', 'Paused tasks can resume. Cancellation ends the task and preserves existing results and records.')} · {frameworkControlLabel(task.control === 'cancelled' ? 'paused' : task.control ?? 'running', tr)}</p>
    <Button disabled={busy} onClick={() => chooseIntent(task.control === 'paused' || task.control === 'cancelled' ? 'running' : 'paused')}>{task.control === 'paused' || task.control === 'cancelled' ? tr('接续任务', 'Resume task') : tr('暂停任务', 'Pause task')}</Button>
    <Button disabled={busy} onClick={() => chooseIntent('cancelled')}>{tr('取消任务', 'Cancel task')}</Button>
    {intent && <>
      <p>{intent === 'cancelled' ? taskCancellationNotice(task, tr) : frameworkControlLabel(intent, tr)}</p>
      <Button disabled={busy} onClick={() => {
        if (attempt.current?.intent !== intent) attempt.current = { intent, commandId: crypto.randomUUID(), lifecycleId: task.lifecycleId }
        setBusy(true); setError('')
        void controller.taskControl({ mode: view.activeMode, storageScope: view.storageScope, taskId: task.taskId, ...(attempt.current.lifecycleId ? { lifecycleId: attempt.current.lifecycleId } : {}), commandId: attempt.current.commandId, intent })
          .then(() => { setIntent(undefined); attempt.current = undefined }, reason => setError(frameworkErrorText(reason))).finally(() => setBusy(false))
      }}>{intent === 'cancelled' ? tr('确认取消任务', 'Confirm task cancellation') : intent === 'paused' ? tr('确认暂停', 'Confirm pause') : tr('确认接续', 'Confirm resume')}</Button>
      <Button disabled={busy} onClick={() => setIntent(undefined)}>{tr('返回', 'Back')}</Button>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>
}
function ExecutionStop({ execution, view, controller, tr }: { execution: FrameworkClientView['tasks'][number]['executions'][number]; view: FrameworkClientView; controller: FrameworkClientController; tr: (cn: string, en: string) => string }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const command = useRef<string>()
  if (execution.state === 'stopped') return null
  return <div>{!confirm ? <Button disabled={busy} onClick={() => setConfirm(true)}>{tr('停止本端这次执行', 'Stop this Host execution')}</Button> : <><code>{execution.executionId}</code><Button disabled={busy} onClick={() => { command.current ??= crypto.randomUUID(); setBusy(true); setError(''); void controller.stopExecution({ mode: view.activeMode, storageScope: view.storageScope, commandId: command.current, workId: execution.workId, executionId: execution.executionId }).then(() => setConfirm(false), reason => setError(frameworkErrorText(reason))).finally(() => setBusy(false)) }}>{tr('确认停止这次执行', 'Confirm execution stop')}</Button><Button disabled={busy} onClick={() => setConfirm(false)}>{tr('返回', 'Back')}</Button></>}{error && <p role="alert">{error}</p>}</div>
}

type KnowledgePending = { convertedPath?: string; conflicts?: SkillMergeIssue[]; kind: 'edit'; input: Parameters<FrameworkClientApi['knowledgeEdit']>[0] } | { convertedPath?: string; kind: 'status'; input: Parameters<FrameworkClientApi['knowledgeStatus']>[0] }
// Like conversation drafts, unresolved edits survive page remounts within this client.
const knowledgePending = new WeakMap<FrameworkClientApi, Map<string, KnowledgePending>>()
function KnowledgePanel({ api, view, tr, open }: { api: FrameworkClientApi; view: FrameworkClientView; open: (path: string) => Promise<void>; tr: (cn: string, en: string) => string }) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<FrameworkClientApi['knowledgeList']>>>()
  const [selected, setSelected] = useState<Awaited<ReturnType<FrameworkClientApi['knowledgeRead']>>>()
  const [edit, setEdit] = useState<{ body: string }>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [status, setStatus] = useState<'disabled' | 'retired'>(), [reason, setReason] = useState('')
  const editAttempt = useRef<{ fingerprint: string; input: Parameters<FrameworkClientApi['knowledgeEdit']>[0] }>()
  const statusAttempt = useRef<{ fingerprint: string; input: Parameters<FrameworkClientApi['knowledgeStatus']>[0] }>()
  const active = useRef(true), reading = useRef(0)
  const [, redraw] = useState(0)
  let pending = knowledgePending.get(api)
  if (!pending) { pending = new Map(); knowledgePending.set(api, pending) }
  const operations = pending
  const scope = { mode: view.activeMode, storageScope: view.storageScope }
  const refresh = async () => { const value = await api.knowledgeList(scope); if (active.current) setCatalog(value) }
  const run = (action: () => Promise<unknown>) => { setBusy(true); setError(''); setNotice(''); void action().catch(error => { if (active.current) setError(frameworkErrorText(error)) }).finally(() => { if (active.current) setBusy(false) }) }
  useEffect(() => { active.current = true; run(refresh); return () => { active.current = false; reading.current++ } }, [])
  const read = (path: string) => run(async () => {
    const request = ++reading.current, result = await api.knowledgeRead({ ...scope, path })
    if (!active.current || request !== reading.current) return
    setSelected(result); setEdit(result.edit ? { ...result.edit } : undefined); setStatus(undefined); setReason(''); editAttempt.current = undefined; statusAttempt.current = undefined
  })
  const submit = async (operation: KnowledgePending) => {
    operations.set(operation.input.commandId, operation); redraw(value => value + 1)
    const result = operation.kind === 'edit' ? await api.knowledgeEdit(operation.input) : await api.knowledgeStatus(operation.input)
    if ('saved' in result && !result.saved) {
      if (operation.kind === 'edit') operation.conflicts = 'conflicts' in result ? result.conflicts : undefined
      operation.convertedPath = 'convertedPath' in result ? result.convertedPath : undefined
      if (active.current) {
        redraw(value => value + 1)
        setNotice(operation.convertedPath
          ? tr('原技能已转换。本次原提交未保存，草稿和原操作编号已保留，可单独查看新文件。', 'The original skill was converted. This submission was not saved; its draft and original command are retained. Open the new file separately.')
          : tr('本次修改未应用；当前正文和草稿均已保留。请查看冲突后重读正文，再明确保存。', 'This change was not applied. The current skill and your draft are retained. Review the conflict, reload the skill, then save your resolved edit.'))
      }
      void refresh().catch(error => { if (active.current) setError(frameworkErrorText(error)) })
      return false
    }
    operations.delete(operation.input.commandId)
    if (active.current) redraw(value => value + 1)
    if (operation.kind === 'edit') {
      if (active.current) setNotice(tr('技能正文已保存，原有停用/退役状态不变。', 'Skill definition saved; existing disabled or retired status is unchanged.')
        + ('issues' in result && result.issues.length ? '\n' + result.issues.join('\n') : ''))
      // Advance this editor to actual current authority after its own save.
      // Repeated edits must not keep a pre-save baseline; a newer selection or
      // a remounted retained operation must not replace an unrelated draft.
      if (selected?.path === operation.input.path && selected.revision === operation.input.expectedRevision && edit?.body === operation.input.body) {
        const request = reading.current
        try {
          const current = await api.knowledgeRead({ mode: operation.input.mode, storageScope: operation.input.storageScope, path: operation.input.path })
          if (active.current && request === reading.current) {
            setSelected(current); setEdit(current.edit ? { ...current.edit } : undefined)
            editAttempt.current = undefined; statusAttempt.current = undefined
          }
        } catch (error) { if (active.current) setError(tr('正文已保存，但重读失败；再次编辑前请重读：', 'Skill saved, but reload failed. Reload before editing again: ') + frameworkErrorText(error)) }
      }
    }
    // A committed write is complete. Refresh has its own read error and never
    // keeps the write busy or turns its receipt into a failed mutation.
    void refresh().catch(error => { if (active.current) setError(tr('知识已保存，但列表刷新失败：', 'Knowledge saved, but list refresh failed: ') + frameworkErrorText(error)) })
    return true
  }
  const save = () => {
    if (!selected || !edit) return
    const fingerprint = JSON.stringify([scope, selected.path, selected.revision, edit])
    if (editAttempt.current?.fingerprint !== fingerprint) editAttempt.current = { fingerprint, input: { ...scope, commandId: crypto.randomUUID(), path: selected.path, expectedRevision: selected.revision, baseBody: selected.text!, ...edit } }
    const input = editAttempt.current.input
    run(() => submit({ kind: 'edit', input }))
  }
  const changeStatus = () => {
    if (!selected || !status) return
    const expectedRevision = selected.revision
    const fingerprint = JSON.stringify([scope, selected.path, expectedRevision, status, reason])
    if (statusAttempt.current?.fingerprint !== fingerprint) statusAttempt.current = { fingerprint, input: { ...scope, commandId: crypto.randomUUID(), path: selected.path, expectedRevision, status, reason, updatedAt: new Date().toISOString() } }
    const input = statusAttempt.current.input
    run(async () => { const confirmed = await submit({ kind: 'status', input }); if (active.current && confirmed) { setStatus(undefined); setNotice(tr('状态已保存，原文保留。', 'Status saved; original body retained.')) } })
  }
  return <section className={css.knowledge}><div className={css.actions}><h2>{tr('知识管理', 'Knowledge management')}</h2><Button disabled={busy} onClick={() => run(refresh)}>{tr('刷新知识', 'Refresh knowledge')}</Button></div>
    {error && <p role="alert" className={css.errorDetail}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {[...operations.values()].filter(operation => operation.input.mode === scope.mode && operation.input.storageScope === scope.storageScope).map(operation => <article key={operation.input.commandId} className={css.knowledgeCard}><p>{operation.kind === 'edit' && operation.conflicts?.length ? tr('编辑冲突，草稿已保留', 'Edit conflict; draft retained') : tr('尚未确认的原操作', 'Unconfirmed original operation')} · {operation.kind}</p><code>{operation.input.path}</code>{operation.kind === 'edit' && <details><summary>{tr('查看保留的草稿', 'View retained draft')}</summary>{Object.entries(operation.input).filter(([key, value]) => ['title', 'description', 'applicability', 'body'].includes(key) && value !== undefined).map(([key, value]) => <div key={key}><strong>{key}</strong><pre>{value}</pre></div>)}</details>}{operation.kind === 'edit' && operation.conflicts?.map(issue => <details key={issue.path}><summary>{tr('查看同文件修改冲突', 'Review concurrent skill edit conflict')}</summary><p>{issue.reason}</p><strong>{tr('当前正文', 'Current skill')}</strong><pre>{issue.current ?? tr('文件已不存在', 'File no longer exists')}</pre></details>)}{operation.convertedPath && <Button disabled={busy} onClick={() => run(() => open(operation.convertedPath!))}>{tr('查看转换后的文件', 'Open converted file')} · {operation.convertedPath}</Button>}<Button disabled={busy} onClick={() => run(() => submit(operation))}>{tr('核对并重试原知识操作', 'Resolve and retry original knowledge operation')}</Button></article>)}
    {catalog?.items.map(item => <article className={css.knowledgeCard} key={item.path}><h3>{item.name}</h3><p>{item.description}</p><code>{item.path}</code><p>{item.kind === 'project-fact' ? tr('项目事实 · 只读', 'Project fact · Read only') : item.kind === 'preference' ? tr('偏好 · 只读', 'Preference · Read only') : <>{frameworkStateLabel(item.status, tr)} · {item.indexed ? tr('已索引', 'Indexed') : tr('未索引', 'Not indexed')}</>}</p>
      {item.error && <p role="alert">{item.error}</p>}
      {item.candidates.map(candidate => <p key={candidate.path}>{tr('候选', 'Candidate')} · {candidate.createdAt}<Button disabled={busy} onClick={() => run(() => open(candidate.path))}>{candidate.path}</Button></p>)}
      {item.resources?.map(path => <p key={path}><Button disabled={busy} onClick={() => run(() => open(path))}>{path}</Button></p>)}
      <Button disabled={busy} onClick={() => read(item.path)}>{item.readOnly || item.kind === 'project-fact' || item.kind === 'preference' ? tr('查看原记录', 'Read original record') : tr('查看与编辑', 'Read and edit')}</Button></article>)}
    {selected && <section className={css.formCard}><h3>{selected.path}</h3>{selected.record ? <KnowledgeRecordView record={selected.record} tr={tr} /> : !edit ? <><p>{tr('原记录只读。', 'Original record is read only.')}</p><pre>{selected.text}</pre></> : <>
      <label className={css.field}><span>{tr('知识正文', 'Knowledge body')}</span><textarea disabled={busy} value={edit.body} onChange={event => setEdit({ ...edit, body: event.target.value })} /></label>
      <Button disabled={busy} onClick={save}>{tr('保存技能正文', 'Save skill definition')}</Button>
    </>}
      <div className={css.actions}>{!selected.record && !selected.readOnly && <><Button disabled={busy} onClick={() => setStatus('disabled')}>{tr('停用', 'Disable')}</Button><Button disabled={busy} onClick={() => setStatus('retired')}>{tr('退役', 'Retire')}</Button></>}<Button disabled={busy} onClick={() => read(selected.path)}>{tr('重读原记录', 'Reload original record')}</Button></div>
      {status && <div><p>{frameworkStateLabel(status, tr)}</p><label className={css.field}><span>{tr('原因', 'Reason')}</span><Input disabled={busy} value={reason} onChange={event => setReason(event.target.value)} /></label><Button disabled={busy} onClick={changeStatus}>{tr('确认状态修改', 'Confirm status change')}</Button><Button disabled={busy} onClick={() => setStatus(undefined)}>{tr('取消', 'Cancel')}</Button></div>}
    </section>}
  </section>
}

const processLabels = {
  read: ["\u8BFB\u53D6\u6587\u4EF6", "read files", "Reading files"],
  readImage: ["\u8BFB\u53D6\u56FE\u7247", "read images", "Reading images"],
  search: ["\u641C\u7D22\u4EE3\u7801", "search code", "Searching code"],
  write: ["\u5199\u5165\u6587\u4EF6", "write files", "Writing files"],
  edit: ["\u7F16\u8F91\u6587\u4EF6", "edit files", "Editing files"],
  commands: ["\u8FD0\u884C\u547D\u4EE4", "run commands", "Running commands"],
  code: ["\u8FD0\u884C\u4EE3\u7801", "run code", "Running code"],
  webSearch: ["\u641C\u7D22\u7F51\u9875", "search the web", "Searching the web"],
  webFetch: ["\u8BBF\u95EE\u7F51\u9875", "fetch web content", "Fetching web content"],
  subagents: ["\u534F\u8C03\u5B50\u667A\u80FD\u4F53", "coordinate subagents", "Coordinating subagents"],
  plan: ["\u66F4\u65B0\u8BA1\u5212", "update the plan", "Updating the plan"],
  questions: ["\u63D0\u95EE", "ask a question", "Awaiting your input"],
  tools: ["\u8C03\u7528\u5DE5\u5177", "use tools", "Using tools"]
} as const;
function ForegroundProcess({ group, zh }: { group: FrameworkClientProcessGroup; zh: boolean }) {
  const labels = group.activity === 'thinking' ? undefined : processLabels[group.activity]
  const title = group.closed ? zh ? '已完成' : 'Completed' : !labels ? zh ? '请稍后，正在准备' : 'Please wait, getting ready' : group.preparing ? zh ? '准备' + labels[0] : 'Preparing to ' + labels[1] : zh ? group.activity === 'questions' ? '等待你的操作' : '正在' + labels[0] : labels[2]
  const description = group.closed ? zh ? '此过程已结束' : 'This process segment has ended' : title
  return <div className={css.processGroup} data-foreground-process-group={group.id} data-process-closed={group.closed} data-process-activity={group.activity} role="group" aria-label={description} title={description}>
    <StateDot state={group.closed ? 'idle' : 'ongoing'} /><span>{title}</span>
  </div>
}

/** Presentation clock only: native turn ownership and completion come from Host. */
function ForegroundProcessing({ processing, name, zh }: {
  processing: NonNullable<FrameworkClientView['foregroundProcessing']>; name: string; zh: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (processing.startedAt === undefined || !Number.isFinite(processing.startedAt)) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [processing.startedAt])
  const seconds = processing.startedAt === undefined || !Number.isFinite(processing.startedAt) ? undefined : Math.max(0, Math.floor((now - processing.startedAt) / 1000))
  return <div className={css.processingRow} data-foreground-processing={processing.executionId}>
    <div className={css.processingPill} role="status" aria-label={zh ? `${name}正在处理` : `${name} is working`}>
      <span className={css.processingDot} aria-hidden="true" />
      <span>{name}{zh ? '正在处理' : ' is working'}</span>
      {seconds !== undefined && <><span aria-hidden="true">·</span>
      <span role="timer" aria-live="off">{zh ? `已用时 ${seconds} 秒` : `${seconds}s elapsed`}</span></>}
    </div>
  </div>
}
