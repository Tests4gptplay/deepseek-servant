import { useState, useSyncExternalStore } from 'react'
import { ServantPage, ServantSettingsPage, type ServantPageProps, type ServantSettingsProps } from '../client/page.js'
import { ModelPicker } from '../client/model-picker.js'
import { PresetPicker } from '../client/preset-picker.js'
import { CoopPage, type CoopControls } from '../experimental/private-git/client/page.js'
import type { ModeClient } from './client.js'
import type { ModeText } from './locales.js'
import type { ServantMode } from './mode-router.js'
import css from './page.module.css'

export interface ModeInjected { modeClient: ModeClient; modeText: ModeText }
function ModeShell({ children, settings, modeClient, modeText: t, controls }: ModeInjected & { children: React.ReactNode; settings?: boolean; controls: CoopControls }) {
  const state = useSyncExternalStore(modeClient.subscribe, modeClient.snapshot)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const select = async (mode: ServantMode) => {
    setBusy(true); setError('')
    try { await modeClient.select(mode) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section className={css.shell}>
    <header className={css.bar}>
      <label>{t('mode')}<select aria-label={t('mode')} value={state.activeMode} disabled={!state.ready || busy} onChange={event => void select(event.target.value as ServantMode)}>
        <option value="LOCAL">{t('local')}</option><option value="PRIVATE_GIT_EXPERIMENTAL">{t('git')}</option>
      </select></label><p>{t('switchHint')}</p>
    </header>
    {(error || state.error) && <div className={css.error} role="alert">{error || state.error} <button onClick={() => void modeClient.refresh()}>{t('retry')}</button></div>}
    <div className={css.content}>{!state.ready ? <p>{t('loading')}</p> : state.activeMode === 'LOCAL' ? children : <CoopPage client={modeClient} t={t} settingsOnly={settings} controls={controls} />}</div>
  </section>
}
function useNativeControls(props: ServantPageProps | ServantSettingsProps): CoopControls {
  const models = props.useModels(value => value)
  return { model: (value, onChange, disabled) => <ModelPicker value={value} onChange={onChange} disabled={disabled} models={models} onRefresh={props.onRefreshModels} t={props.t} label={props.t('settings.model')} />,
    preset: (value, onChange, disabled) => <PresetPicker value={value} onChange={onChange} disabled={disabled} onLoad={props.onLoadPresets} t={props.t} />,
    pickDirectory: props.onPickDirectory }
}
export function ModePage(props: ServantPageProps & ModeInjected) {
  const controls = useNativeControls(props)
  return <ModeShell {...props} controls={controls}><ServantPage {...props} /></ModeShell>
}
export function ModeSettingsPage(props: ServantSettingsProps & ModeInjected) {
  const controls = useNativeControls(props)
  return <ModeShell {...props} controls={controls} settings><ServantSettingsPage {...props} /></ModeShell>
}
