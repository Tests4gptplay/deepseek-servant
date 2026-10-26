import { useState, useSyncExternalStore } from 'react'
import { ServantPage, ServantSettingsPage, ServantSettingsDialog, type ServantPageProps, type ServantSettingsProps } from '../client/page.js'
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
  return { model: (value, onChange, disabled) => <ModelPicker value={value} onChange={onChange} disabled={disabled} models={{ ...models, current: autoModel?.provider && autoModel?.model ? { provider: autoModel.provider, model: autoModel.model, reasoningEffort: autoModel.reasoningEffort } as typeof models.current : null }} autoHint={mode.modeText('autoModelHint')} onRefresh={props.onRefreshModels} t={props.t} label={props.t('settings.model')} />,
    preset: (value, onChange, disabled) => <PresetPicker value={value} onChange={onChange} disabled={disabled} onLoad={props.onLoadPresets} t={props.t} />,
    pickDirectory: props.onPickDirectory }
}
export function ModePage(props: ServantPageProps & ModeInjected) {
  const controls = useNativeControls(props)
  const state = useSyncExternalStore(props.modeClient.subscribe, props.modeClient.snapshot)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const experimentalSettings = <ExperimentalCoopSettings {...props} controls={controls} />
  if (state.activeMode === 'LOCAL') return <ServantPage {...props} experimentalSettings={experimentalSettings} />
  return <section className={css.shell}>
    <CoopPage client={props.modeClient} t={props.modeText} onOpenSettings={() => setSettingsOpen(true)} />
    <ServantSettingsDialog {...props} experimentalSettings={experimentalSettings} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </section>
}
export function ModeSettingsPage(props: ServantSettingsProps & ModeInjected) {
  const controls = useNativeControls(props)
  return <ServantSettingsPage {...props} experimentalSettings={<ExperimentalCoopSettings {...props} controls={controls} />} />
}
