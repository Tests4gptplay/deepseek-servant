import { useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelRoute } from '../contracts/task.ts'
import { isAutoModel } from '../domain/model-route.ts'
import type { ServantModels } from './models.ts'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
export function ModelPicker({ value, models, onChange, onRefresh, disabled, label, composer, followModel, t }: {
  value: ModelRoute; models: ServantModels; onChange(value: ModelRoute): void; onRefresh(): Promise<void>
  disabled?: boolean; label: string; composer?: boolean; followModel?: ModelRoute; t: Translate
}) {
  const [open, setOpen] = useState(false)
  const homePane = composer ? 'root' : 'model'
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>(homePane)
  const auto = !composer && isAutoModel(value)
  const effective = isAutoModel(value) ? followModel ?? models.current : value
  const selectedGroup = models.groups.find(group => group.id === effective?.provider)
  const selectedModel = selectedGroup?.models.find(model => model.id === effective?.model)
  const effort = effective?.reasoningEffort ?? selectedModel?.reasoning?.defaultEffort
  const effortName = selectedModel?.reasoning?.efforts.find(choice => choice.id === effort)?.name ?? effort
  const modelName = selectedModel?.name ?? effective?.model
  const caption = [auto ? 'Auto' : undefined, modelName, effortName].filter(Boolean).join(' · ')
  const routes = new Map<string, ModelRoute>()
  const items: MenuEntry[] = []
  if (pane === 'root') {
    items.push({ id: 'model', label: <span className={css.modelMenuRow}><span>{t('settings.model')}</span><span>{caption || t('model.loading')}</span></span> })
    if (!auto && selectedModel?.reasoning) items.push({ id: 'effort', label: <span className={css.modelMenuRow}><span>{t('model.effort')}</span><span>{effortName ?? t('model.providerDefault')}</span></span> })
  } else {
    if (composer || pane === 'effort') items.push({ id: 'back', label: t('model.back') }, { type: 'separator', id: 'back-divider' })
    if (pane === 'effort') {
      items.push({ id: 'effort-default', label: t('model.providerDefault') })
      for (const choice of selectedModel?.reasoning?.efforts ?? []) items.push({ id: 'effort:' + choice.id, label: choice.name })
    } else {
      if (!composer) {
        items.push({ id: 'auto', label: <span className={css.modelOption}><span>Auto</span><small>{t('model.autoHint')}</small></span> })
        if (!auto && selectedModel?.reasoning) items.push({ id: 'effort', label: <span className={css.modelMenuRow}><span>{t('model.effort')}</span><span>{effortName ?? t('model.providerDefault')}</span></span> })
        items.push({ type: 'separator', id: 'model-options-divider' })
      }
      for (const group of models.groups) {
        const choices = group.models
        if (!choices.length) continue
        items.push({ type: 'label', id: 'group:' + group.id, text: group.name })
        for (const model of choices) {
          const id = JSON.stringify([group.id, model.id])
          const sameRoute = effective?.provider === group.id && effective?.model === model.id
          routes.set(id, { provider: group.id, model: model.id, reasoningEffort: sameRoute ? effective?.reasoningEffort : model.reasoning?.defaultEffort })
          items.push({ id, label: model.name })
        }
      }
      if (models.status === 'loading') items.push({ id: 'loading', label: t('model.loading'), disabled: true })
      if (models.error) items.push({ id: 'error', label: models.error, disabled: true })
      for (const failure of models.failures) items.push({ id: 'failure:' + failure.id, label: failure.name + ': ' + failure.message, disabled: true })
      if (models.status === 'error' || models.failures.length) items.push({ id: 'retry', label: t('runtime.retry') })
    }
  }
  const selectedId = pane === 'model' ? auto ? 'auto' : JSON.stringify([effective?.provider, effective?.model])
    : pane === 'effort' ? effective?.reasoningEffort ? 'effort:' + effective.reasoningEffort : 'effort-default' : undefined
  const choose = (id: string) => {
    if (id === 'model' || id === 'effort') { setPane(id); return }
    if (id === 'back') { setPane(homePane); return }
    if (id === 'retry') { void onRefresh(); return }
    let next: ModelRoute | undefined
    if (id === 'auto' && !composer) next = {}
    else if (id === 'effort-default') next = { provider: effective?.provider, model: effective?.model }
    else if (id.startsWith('effort:')) next = { ...effective, reasoningEffort: id.slice(7) }
    else next = routes.get(id)
    if (next) { onChange(next); setOpen(false) }
  }
  return <Menu open={open} portal className={css.menuAnchor} side={composer ? 'top' : 'bottom'} align={composer ? 'end' : 'start'}
    listClassName={css.modelMenu} items={items} selectedId={selectedId} onSelect={choose} onClose={() => setOpen(false)}
    anchor={<Button type="button" variant={composer ? 'ghost' : 'outline'} disabled={disabled} aria-label={label}
      aria-expanded={open} aria-haspopup="menu" title={auto ? t('model.autoHint') : selectedGroup?.name}
      className={css.modelTrigger} onClick={() => { setPane(homePane); setOpen(!open) }}>
      <span>{caption || t('model.loading')}</span><IconChevronDownOutlineRegular size={14} />
    </Button>} />
}
