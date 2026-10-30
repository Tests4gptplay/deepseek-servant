import { useState, useSyncExternalStore } from 'react'
import { Button, Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ServantPage, ServantSettingsPage, type ServantPageProps, type ServantSettingsProps } from '../client/page.js'
import { ModelPicker } from '../client/model-picker.js'
import { PresetPicker } from '../client/preset-picker.js'
import { CoopPage, type CoopControls } from '../experimental/private-git/client/page.js'
import type { ModeClient } from './client.js'
import type { ModeText } from './locales.js'
import css from './page.module.css'

export interface ModeInjected { modeClient: ModeClient; modeText: ModeText }

/** Shared by the native Settings page and both assistant gear dialogs. */
export function ExperimentalCoopSettings({ modeClient, modeText: t, controls }: ModeInjected & { controls: CoopControls }) {
  const state = useSyncExternalStore(modeClient.subscribe, modeClient.snapshot)
  const [expanded, setExpanded] = useState(state.activeMode === 'PRIVATE_GIT_EXPERIMENTAL')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = state.activeMode === 'PRIVATE_GIT_EXPERIMENTAL'
  const select = async (enabled: boolean) => {
    setBusy(true); setError('')
    try { await modeClient.select(enabled ? 'PRIVATE_GIT_EXPERIMENTAL' : 'LOCAL'); if (enabled) setExpanded(true) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section className={css.experimental}>
    <div className={css.heading}><div><h4>{t('git')}</h4><p>{t('subtitle')}</p></div>
      <label className={css.toggle}><input type="checkbox" checked={active} disabled={!state.ready || busy}
        onChange={event => void select(event.target.checked)} />{t('useMode')}</label>
    </div>
    <div className={css.warning} role="note"><strong>{t('memoryWarningTitle')}</strong><p>{t('memoryWarning')}</p></div>
    <p className={css.hint}>{t('switchHint')}</p>
    <button className={css.configure} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'collapseSettings' : 'settings')}</button>
    {(error || state.error) && <p className={css.error} role="alert">{error || state.error} <button onClick={() => void modeClient.refresh()}>{t('retry')}</button></p>}
    {expanded && <CoopPage client={modeClient} t={t} settingsOnly controls={controls} />}
  </section>
}
function useNativeControls(props: ServantPageProps | ServantSettingsProps): CoopControls {
  const models = props.useModels(value => value)
  const mode = props as ServantPageProps & ModeInjected
  const state = useSyncExternalStore(mode.modeClient.subscribe, mode.modeClient.snapshot)
  const autoModel = state.view?.defaultModel
  return { model: (value, onChange, disabled) => <ModelPicker value={value} onChange={onChange} disabled={disabled} models={{ ...models, current: autoModel?.provider && autoModel?.model ? { provider: autoModel.provider, model: autoModel.model, reasoningEffort: autoModel.reasoningEffort } as typeof models.current : null }} autoLabel={mode.modeText('autoModel')} autoHint={mode.modeText('autoModelHint')} onRefresh={props.onRefreshModels} t={props.t} label={props.t('settings.model')} />,
    preset: (value, onChange, disabled) => <PresetPicker value={value} onChange={onChange} disabled={disabled} onLoad={props.onLoadPresets} t={props.t} />,
    pickDirectory: props.onPickDirectory }
}
export function ModeSelector({ modeClient, modeText: t }: ModeInjected) {
  const state = useSyncExternalStore(modeClient.subscribe, modeClient.snapshot)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = state.activeMode
  return <div className={css.selector}>
    <Menu open={open} portal side="bottom" align="start" selectedId={selected}
      items={[{ id: 'LOCAL', label: 'local' }, { id: 'PRIVATE_GIT_EXPERIMENTAL', label: 'DSS-cah' }]}
      onSelect={id => {
        setOpen(false); setError(''); setBusy(true)
        void modeClient.select(id === 'LOCAL' ? 'LOCAL' : 'PRIVATE_GIT_EXPERIMENTAL')
          .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false))
      }} onClose={() => setOpen(false)}
      anchor={<Button variant="outline" size="sm" aria-label={t('mode')} aria-haspopup="menu" aria-expanded={open}
        disabled={!state.ready || busy} onClick={() => setOpen(!open)}>
        <span>{selected === 'LOCAL' ? 'local' : 'DSS-cah'}</span><IconChevronDownOutlineRegular size={14} />
      </Button>} />
    {error && <span role="alert" className={css.error}>{error}</span>}
  </div>
}
export function ModePage(props: ServantPageProps & ModeInjected) {
  const controls = useNativeControls(props)
  return <ServantPage {...props} modeSelector={<ModeSelector {...props} />}
    experimentalSettings={<ExperimentalCoopSettings {...props} controls={controls} />} />
}
export function ModeSettingsPage(props: ServantSettingsProps & ModeInjected) {
  const controls = useNativeControls(props)
  return <ServantSettingsPage {...props} experimentalSettings={<ExperimentalCoopSettings {...props} controls={controls} />} />
}
