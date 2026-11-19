import css from './page.module.css'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Menu, RiskConfirmation, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, PermissionIconFullAccessRegular, PermissionIconAutoReviewRegular, IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PermissionSelection } from '@deepseek-ai/dsh-permission-presets/types'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import type { FrameworkClientApi, FrameworkClientView } from '../framework/client-contracts.js'

declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { 'deepseek-servant-permission': unknown } }
const noSubscribe = () => () => {}
const noSnapshot = () => undefined

/** DSS-wide user action; native controls and native risk copy, not the session-only PermissionSelect. */
export function PermissionPicker({ ctx, api, view, zh }: { ctx: Context; api: FrameworkClientApi; view: FrameworkClientView; zh: boolean }) {
  const t = ctx.locale.bind('permission.access')
  const requestedForeground = view.executions?.find(row => row.role === 'Foreground')?.sessionId
  const sessions = ctx.get('sessions', true) as unknown as ISessions
  const catalog = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
  const binding = requestedForeground ? sessions.binding(requestedForeground as SessionId) : undefined
  const foreground = requestedForeground && !binding?.session.getSnapshot().removed && (catalog.byId[requestedForeground as SessionId] || binding) ? requestedForeground : undefined
  const [reference, setReference] = useState<SessionReference>()
  useEffect(() => {
    if (!foreground) { setReference(undefined); return }
    const owned = sessions.retain(foreground as SessionId, { source: 'deepseek-servant-permission' })
    setReference(owned)
    return () => owned.release()
  }, [sessions, foreground])
  const projection = reference && reference.sessionId === foreground ? reference.binding.session.projections.faceOf('permissions') : undefined
  const actual = useSyncExternalStore(projection?.subscribe ?? noSubscribe, projection?.getSnapshot ?? noSnapshot) as PermissionSelection | undefined
  const [options, setOptions] = useState<Array<{ value: string; name: string; description?: string }>>([])
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false)
  const [confirmation, setConfirmation] = useState<string>(), [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [selected, setSelected] = useState(view.settings.permissionPreset)
  useEffect(() => setSelected(view.settings.permissionPreset), [view.settings.permissionPreset])
  const label = (value: string, name: string) => value === 'read-only' ? t('preset.readOnly') : value === 'workspace-write' ? t('preset.workspaceWrite')
    : value === 'danger-full-access' ? t('preset.fullAccess') : value === 'auto' ? t('auto.label') : name
  const load = async () => {
    setLoading(true); setError('')
    try {
      if (!api.permissionCatalog) throw new Error('DSS permissions are unavailable.')
      const result = await api.permissionCatalog({ mode: view.activeMode })
      setOptions(result.options); setSelected(result.current); setOpen(true)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setLoading(false) }
  }
  const select = async (preset: string) => {
    setSaving(true); setError('')
    try {
      if (!api.permissionSelect) throw new Error('DSS permissions are unavailable.')
      const saved = await api.permissionSelect({ mode: view.activeMode, storageScope: view.storageScope, preset })
      setSelected(saved.settings.permissionPreset)
    } catch (failure) { setError((zh ? '部分角色可能未应用；可重新选择同一目标重试。' : 'Some roles may not have applied this choice; select the same target to retry. ') + (failure instanceof Error ? failure.message : String(failure))) }
    finally { setSaving(false) }
  }
  const choose = (preset: string) => {
    setOpen(false)
    if (preset === selected) { void select(preset); return }
    if (preset === 'danger-full-access' || preset === 'auto') { setAcknowledged(false); setConfirmation(preset) }
    else void select(preset)
  }
  const auto = confirmation === 'auto'
  const glyph = (value?: string) => value === undefined ? <IconShieldOutlineRegular /> : value === 'danger-full-access' ? <PermissionIconFullAccessRegular /> : value === 'auto' ? <PermissionIconAutoReviewRegular /> : value === 'workspace-write' ? <PermissionIconWorkspaceWriteRegular /> : <PermissionIconReadOnlyRegular />
  return <div aria-label={zh ? 'DSS 前台和后台权限' : 'DSS foreground and background permissions'}>
    <Menu open={open} portal side="top" selectedId={actual?.currentValue} items={options.map(option => ({ id: option.value, label: label(option.value, option.name), icon: glyph(option.value) }))}
      onSelect={choose} onClose={() => setOpen(false)} anchor={<button type="button" className={css.composerAdd} aria-label={zh ? '权限' : 'Permissions'} disabled={loading || saving}
        title={(actual ? (zh ? '前台当前：' : 'Foreground now: ') + label(actual.currentValue, options.find(option => option.value === actual.currentValue)?.name ?? actual.currentValue) : foreground ? (zh ? '读取当前权限' : 'Reading current permissions') : (zh ? '无当前前台会话' : 'No current foreground session')) + (selected ? (zh ? '；DSS 选择目标：' : '; DSS selected target: ') + label(selected, options.find(option => option.value === selected)?.name ?? selected) : (zh ? '；尚未设置 DSS 组选择' : '; no DSS group choice set')) + (zh ? '；选择会作用于此 DSS 前台和后台，不更改其它原生会话。' : '; a choice applies to this DSS foreground and background, not other native sessions.')}
        onClick={() => open ? setOpen(false) : void load()}>{glyph(actual?.currentValue)}</button>}/>
    {confirmation && <RiskConfirmation open title={t(auto ? 'auto.confirm.title' : 'confirm.title')}
      description={t(auto ? 'auto.confirm.description' : 'confirm.description')} acknowledgeLabel={t(auto ? 'auto.confirm.acknowledge' : 'confirm.acknowledge')}
      cancelLabel={t('confirm.cancel')} closeLabel={t('close')} confirmLabel={t(auto ? 'auto.confirm.enable' : 'confirm.enable')}
      acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} onCancel={() => setConfirmation(undefined)}
      onConfirm={() => { const preset = confirmation; setConfirmation(undefined); void select(preset) }}/>} 
    {error && <p role="alert">{error}</p>}
  </div>
}
