import { useCallback, useEffect, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './page.module.css'

export interface ServantPreset extends AgentPresetRow { name: string }
export function PresetPicker({ value, onChange, onLoad, disabled, t }: {
  value: string; onChange(id: string): void; onLoad(): Promise<readonly ServantPreset[]>
  disabled?: boolean; t: PropsLocale<'dsh.servant'>['t']
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<readonly ServantPreset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined)
    try { setRows(await onLoad()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }, [onLoad])
  useEffect(() => { void refresh() }, [refresh, t])
  const selected = rows.find(row => row.id === value)
  const items: MenuEntry[] = rows.map(row => ({
    id: 'preset:' + row.id, disabled: row.broken !== undefined,
    label: <span className={css.modelOption}><span>{row.name}</span>
      {row.description && <small>{row.description}</small>}
      {row.broken && <small>{row.broken}</small>}
    </span>,
  }))
  if (loading && !rows.length) items.push({ id: 'loading', label: t('mode.loading'), disabled: true })
  if (error) items.push({ id: 'error', label: error, disabled: true }, { id: 'retry', label: t('runtime.retry') })
  if (!loading && !error && !rows.length) items.push({ id: 'empty', label: t('mode.empty'), disabled: true })
  return <Menu open={open} portal className={css.menuAnchor} side="bottom" align="start"
    listClassName={css.presetMenu} items={items} selectedId={'preset:' + value}
    onClose={() => setOpen(false)} onSelect={id => {
      if (id === 'retry') { void refresh(); return }
      const row = rows.find(row => id === 'preset:' + row.id)
      if (row && row.broken === undefined) { onChange(row.id); setOpen(false) }
    }}
    anchor={<Button type="button" variant="outline" disabled={disabled} aria-label={t('settings.preset')}
      aria-expanded={open} aria-haspopup="menu" className={css.modelTrigger}
      title={selected?.description} onClick={() => {
        if (!open) void refresh()
        setOpen(!open)
      }}>
      <span>{selected?.name ?? (loading ? t('mode.loading') : value)}</span><IconChevronDownOutlineRegular size={14} />
    </Button>} />
}
