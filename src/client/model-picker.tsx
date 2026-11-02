import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Input, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconDataOutlineRegular, Menu, MenuItemButton, rankByName, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelRoute } from '../contracts/task.ts'
import { isAutoModel } from '../domain/model-route.ts'
import type { ServantModels } from './models.ts'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
export function ModelPicker({ value, models, onChange, onRefresh, disabled, label, composer, followModel, autoHint, autoLabel, t }: {
  value: ModelRoute; models: ServantModels; onChange(value: ModelRoute): void; onRefresh(): Promise<void>
  disabled?: boolean; label: string; composer?: boolean; followModel?: ModelRoute; autoHint?: string; autoLabel?: string; t: Translate
}) {
  const [open, setOpen] = useState(false)
  const homePane = composer ? 'root' : 'model'
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>(homePane)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const previousPane = useRef(homePane)
  const showSearch = !!composer && pane === 'model' && models.groups.reduce((count, group) => count + group.models.length, 0) > 4
  useEffect(() => {
    if (!open) { previousPane.current = homePane; return }
    const prior = previousPane.current; previousPane.current = pane
    if (composer && pane === 'root' && prior === 'root') trigger.current?.focus()
    else if (showSearch) search.current?.focus()
    else {
      const target = composer && pane === 'root'
        ? content.current?.querySelector<HTMLButtonElement>(`[data-model-entry="${prior}"] button`)
        : content.current?.querySelector<HTMLButtonElement>('button[aria-current="page"]')
      ;(target ?? content.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
    }
  }, [open, pane, showSearch])
  useEffect(() => {
    if (!open || !composer || pane === 'root') return
    // The shared Menu closes Escape at document capture. A drilled composer
    // pane consumes it one level earlier, matching the native ModelSelect.
    const back = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.shiftKey
        || !(event.target instanceof Node) || !content.current?.contains(event.target)) return
      event.preventDefault(); event.stopPropagation(); setPane('root'); setQuery('')
    }
    window.addEventListener('keydown', back, true)
    return () => window.removeEventListener('keydown', back, true)
  }, [open, composer, pane])
  const auto = isAutoModel(value)
  const effective = isAutoModel(value) ? followModel ?? models.current : value
  const selectedGroup = models.groups.find(group => group.id === effective?.provider)
  const selectedModel = selectedGroup?.models.find(model => model.id === effective?.model)
  const effort = effective?.reasoningEffort ?? selectedModel?.reasoning?.defaultEffort
  const effortName = selectedModel?.reasoning?.efforts.find(choice => choice.id === effort)?.name ?? effort
  const modelName = selectedModel?.name ?? effective?.model
  const caption = [auto ? (autoLabel ?? 'Auto') : undefined, modelName, effortName].filter(Boolean).join(' · ')
  const routes = new Map<string, ModelRoute>()
  const items: MenuEntry[] = []
  if (pane === 'root') {
    items.push({ id: 'model', label: <span className={css.modelMenuRow}><span>{t('settings.model')}</span><span>{caption || t('model.loading')}</span><IconChevronRightOutlineRegular size={12} /></span> })
    if (!auto && selectedModel?.reasoning) items.push({ id: 'effort', label: <span className={css.modelMenuRow}><span>{t('model.effort')}</span><span>{effortName ?? t('model.providerDefault')}</span><IconChevronRightOutlineRegular size={12} /></span> })
  } else {
    if (composer || pane === 'effort') items.push({ id: 'back', label: t('model.back') }, { type: 'separator', id: 'back-divider' })
    if (pane === 'effort') {
      items.push({ id: 'effort-default', label: t('model.providerDefault') })
      for (const choice of selectedModel?.reasoning?.efforts ?? []) items.push({ id: 'effort:' + choice.id, label: choice.name })
    } else {
      items.push({ id: 'auto', label: <span className={css.modelOption}><span>{autoLabel ?? 'Auto'}</span><small>{(autoHint ?? t('model.autoHint'))}</small></span> })
      if (!composer && !auto && selectedModel?.reasoning) items.push({ id: 'effort', label: <span className={css.modelMenuRow}><span>{t('model.effort')}</span><span>{effortName ?? t('model.providerDefault')}</span></span> })
      items.push({ type: 'separator', id: 'model-options-divider' })
      for (const group of models.groups) {
        const choices = showSearch ? rankByName(group.models, query) : group.models
        if (!choices.length) continue
        items.push({ type: 'label', id: 'group:' + group.id, text: group.name })
        for (const model of choices) {
          const id = JSON.stringify([group.id, model.id])
          const sameRoute = effective?.provider === group.id && effective?.model === model.id
          routes.set(id, { provider: group.id, model: model.id, reasoningEffort: sameRoute ? effective?.reasoningEffort : model.reasoning?.defaultEffort })
          items.push({ id, label: model.name })
        }
      }
      if (showSearch && !routes.size) items.push({ id: 'empty', label: t('model.noMatches'), disabled: true })
    }
  }
  if (models.status === 'loading') items.push({ id: 'loading', label: t('model.loading'), disabled: true })
  if (models.error) items.push({ id: 'error', label: models.error, disabled: true })
  for (const failure of models.failures) items.push({ id: 'failure:' + failure.id, label: failure.name + ': ' + failure.message, disabled: true })
  if (models.status === 'error' || models.failures.length) items.push({ id: 'retry', label: t('runtime.retry') })
  const selectedId = pane === 'model' ? auto ? 'auto' : JSON.stringify([effective?.provider, effective?.model])
    : pane === 'effort' ? effective?.reasoningEffort ? 'effort:' + effective.reasoningEffort : 'effort-default' : undefined
  const choose = (id: string) => {
    if (id === 'model' || id === 'effort') { setQuery(''); setHighlighted(0); setPane(id); return }
    if (id === 'back') { setPane(homePane); return }
    if (id === 'retry') { void onRefresh(); return }
    let next: ModelRoute | undefined
    if (id === 'auto') next = {}
    else if (id === 'effort-default') next = { provider: effective?.provider, model: effective?.model }
    else if (id.startsWith('effort:')) next = { ...effective, reasoningEffort: id.slice(7) }
    else next = routes.get(id)
    if (next) { onChange(next); setOpen(false); trigger.current?.focus() }
  }
  const routeIds = [...routes.keys()], activeIndex = Math.min(highlighted, routeIds.length - 1)
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!composer || event.nativeEvent.isComposing) return
    if ((event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) && pane !== 'root') {
      event.preventDefault(); event.stopPropagation(); setPane('root'); setQuery(''); return
    }
    if (!showSearch) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      if (routeIds.length) setHighlighted((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + routeIds.length) % routeIds.length)
      search.current?.focus()
    } else if (event.target === search.current && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && activeIndex >= 0) {
      event.preventDefault(); event.stopPropagation(); choose(routeIds[activeIndex]!)
    }
  }
  useEffect(() => {
    if (open && showSearch) content.current?.querySelector<HTMLElement>('[data-model-highlighted="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, showSearch, activeIndex, query])
  return <Menu open={open} portal autoFocus={!composer} className={css.menuAnchor} side={composer ? 'top' : 'bottom'} align={composer ? 'end' : 'start'}
    // Menu supplies a 4px portal gap; the native composer uses 8px.
    getAnchorRect={composer ? () => { const r = trigger.current?.getBoundingClientRect(); return r ? new window.DOMRect(r.x, r.y - 4, r.width, r.height) : null } : undefined}
    listClassName={`${css.modelMenu} ${composer ? css.composerModelMenu : ''}`} items={composer ? [] : items} selectedId={selectedId} onSelect={choose} onClose={() => setOpen(false)}
    anchor={<Button ref={trigger} type="button" variant={composer ? 'ghost' : 'outline'} size={composer ? 'sm' : undefined} disabled={disabled} aria-label={label}
      aria-expanded={open} aria-haspopup="menu" title={auto ? caption + ' — ' + (autoHint ?? t('model.autoHint')) : composer ? caption : selectedGroup?.name}
      className={`${css.modelTrigger} ${composer ? css.composerModelTrigger : ''}`} onClick={() => { setPane(homePane); setQuery(''); setHighlighted(0); if (!open && models.status !== 'error') void onRefresh(); setOpen(!open) }}>
      {composer && <IconDataOutlineRegular size={16} className={css.modelIcon} />}<span className={css.modelLabel}>{composer ? [auto ? (autoLabel ?? 'Auto') : undefined, modelName].filter(Boolean).join(' · ') || t('model.loading') : caption || t('model.loading')}</span>
      {composer && effortName && <span className={css.modelEffort}>{effortName}</span>}<IconChevronDownOutlineRegular size={14} />
    </Button>}>
    {composer && <div ref={content} onKeyDownCapture={onKey}>
      {showSearch && <div className={css.modelSearch}><Input ref={search} aria-label={t('model.search')} placeholder={t('model.search')} value={query} onChange={event => { setQuery(event.target.value); setHighlighted(0) }} /></div>}
      {items.map(item => 'type' in item ? item.type === 'separator' ? <div key={item.id} role="separator" className={css.modelDivider} /> : <div key={item.id} className={css.modelGroup}>{item.text}</div>
        : <div key={item.id} data-model-entry={item.id} data-model-highlighted={showSearch && item.id === routeIds[activeIndex] || undefined} className={showSearch && item.id === routeIds[activeIndex] ? css.modelHighlighted : undefined}>
          <MenuItemButton current={selectedId === item.id} disabled={item.disabled} onSelect={() => choose(item.id)}><span className={css.modelChoice}>{item.label}{selectedId === item.id && <IconCheckOutlineRegular size={14} />}</span></MenuItemButton>
        </div>)}
    </div>}
  </Menu>
}
