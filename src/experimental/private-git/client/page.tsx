import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { CoopCollaborator, CoopInvitation, CoopSettings, CoopView } from '../contracts.js'
import type { ModeClient } from '../../../mode-router/client.js'
import type { ModeText } from '../../../mode-router/locales.js'
import { GITHUB_CLI_SETUP_REQUIRED, GITHUB_CLI_ACCESS_REQUIRED } from '../github.js'
import css from './page.module.css'

export interface CoopControls {
  model(value: CoopSettings, onChange: (value: Pick<CoopSettings, 'provider' | 'model' | 'reasoningEffort'>) => void, disabled: boolean): ReactNode
  preset(value: string, onChange: (value: string) => void, disabled: boolean): ReactNode
  pickDirectory?: () => Promise<string | null>
}
type CoopPageProps = { client: ModeClient; t: ModeText; settingsOnly?: boolean; controls?: CoopControls; onOpenSettings?: () => void }
export function CoopPage(props: CoopPageProps) {
  const { view } = useSyncExternalStore(props.client.subscribe, props.client.snapshot)
  const scope = JSON.stringify([view?.connection?.repository.id, view?.connection?.identity.id, view?.settings.repositoryDirectory])
  return <CoopPageScope key={scope} {...props} />
}

function CoopPageScope({ client, t, settingsOnly, controls, onOpenSettings }: CoopPageProps) {
  const { view } = useSyncExternalStore(client.subscribe, client.snapshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [text, setText] = useState('')
  useEffect(() => { void client.loadCoop() }, [client])
  const [settings, setSettings] = useState<CoopSettings | undefined>(view?.settings)
  const [login, setLogin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [older, setOlder] = useState<CoopView['messages']>([])
  const [before, setBefore] = useState<string | null>()
  const [members, setMembers] = useState<CoopCollaborator[]>([])
  const [invitations, setInvitations] = useState<CoopInvitation[]>([])
  const prefix = useId()
  const connectionKey = view?.connection?.repository.id + '/' + view?.connection?.identity.id + '/' + view?.settings.repositoryDirectory
  useEffect(() => { setOlder([]); setBefore(undefined) }, [connectionKey])
  const savedSettings = JSON.stringify(view?.settings)
  useEffect(() => { if (view?.settings) setSettings(view.settings) }, [savedSettings])
  if (!view || !settings) return <p className={css.page}>{t('loading')}</p>
  const run = async (operation: () => Promise<unknown>, message?: string) => {
    setBusy(true); setError(''); setNotice('')
    try { await operation(); if (message) setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { await client.refresh(); setBusy(false) }
  }
  const errorText = error || view.error || ''
  const cliError = errorText.includes(GITHUB_CLI_SETUP_REQUIRED) || errorText.includes(GITHUB_CLI_ACCESS_REQUIRED)
  const displayError = errorText.replace(GITHUB_CLI_SETUP_REQUIRED, t('githubCliSetup')).replace(GITHUB_CLI_ACCESS_REQUIRED, t('githubCliAccess'))
  // This form submits a complete model route. null survives JSON RPC and
  // explicitly removes Auto/unsupported-effort overrides on the Host.
  const save = () => client.call('configure', { ...settings,
    provider: settings.provider ?? null, model: settings.model ?? null, reasoningEffort: settings.reasoningEffort ?? null })
  const connect = async () => { await save(); await client.call('connect') }
  const field = (key: Exclude<keyof CoopSettings, 'remoteEnabled'>, label: string, type = 'text') => <label className={css.field} htmlFor={prefix + key}>{label}
    <input id={prefix + key} type={type} min={type === 'number' ? 1 : undefined}
      value={settings[key] ?? ''} disabled={busy} onChange={event => setSettings({ ...settings, [key]: type === 'number' ? Number(event.target.value) : event.target.value })} />
  </label>
  // Member actions are bound to the identity the user actually reviewed.
  // The Host checks it again; an account/repository switch cannot retarget a click.
  const memberCall = (method: string, params: Record<string, unknown> = {}) => client.call(method, { ...params,
    expectedRepositoryId: view.connection?.repository.id, expectedParticipantId: view.connection?.identity.id })
  const refreshMembers = async () => {
    setMembers(await memberCall('collaborators') as CoopCollaborator[])
    if (view.connection?.repository.permissions.admin) setInvitations(await memberCall('invitations') as CoopInvitation[])
  }
  const send = async () => {
    const result = await client.call('send', { text, id: crypto.randomUUID() }) as { state: string; error?: string }
    setText('')
    if (result.state === 'COMMITTED_PENDING_READ') setNotice(t('readPending'))
    if (result.state === 'PENDING_UNCOMMITTED') setNotice(t('pending') + (result.error ? ': ' + result.error : ''))
  }
  return <section className={settingsOnly ? css.page + ' ' + css.embedded : css.page} aria-label={t('title')}>
    {!settingsOnly && <header className={css.heading}><div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div>
      <div className={css.actions}><span>{t(view.status)}</span>
        <button disabled={busy || !view.connection} onClick={() => void run(() => client.call('sync'))}>{t('refresh')}</button>
        <button onClick={onOpenSettings}>{t('settings')}</button>
      </div>
    </header>}
    {view.connection && <div className={css.meta}>
      <span>{t('account')}: {view.connection.identity.login}</span>
      <span>{view.connection.repository.fullName}</span>
      {view.confirmedHead && <span title={view.confirmedHead}>{t('head')}: {view.confirmedHead.slice(0, 12)}</span>}
    </div>}
    {displayError && <p className={css.notice} role="alert">{displayError} <button disabled={busy} onClick={() => void run(cliError ? connect : () => client.call('retryNative'))}>{t('retry')}</button></p>}
    {notice && <p className={css.notice} role="status">{notice}</p>}
    {settingsOnly && <section className={css.card} aria-label={t('settings')}>
      <div className={css.grid}>
        {field('ownerRepo', t('repository'))}{field('repositoryDirectory', t('repositoryDirectory'))}<div>{field('workspace', t('workspace'))}{controls?.pickDirectory && <button disabled={busy} onClick={() => void run(async () => { const workspace = await controls.pickDirectory!(); if (workspace) setSettings({ ...settings, workspace }) })}>{t('pickDirectory')}</button>}</div>
        {field('workerSeats', t('seats'), 'number')}
        {controls ? <><div className={css.field}>{t('preset')}{controls.preset(settings.presetId, presetId => setSettings({ ...settings, presetId }), busy)}</div>
          <div className={css.field}>{t('model')}{controls.model(settings, value => setSettings({ ...settings, provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort }), busy)}</div></>
          : <>{field('presetId', t('preset'))}{field('provider', t('provider'))}{field('model', t('model'))}{field('reasoningEffort', t('effort'))}</>}
      </div><label className={css.hint}><input type="checkbox" checked={settings.remoteEnabled} disabled={busy} onChange={event => setSettings({ ...settings, remoteEnabled: event.target.checked })} /> {t('remoteEnabled')}</label><p className={css.hint}>{t('remoteHint')}</p><div className={css.actions}>
        <button disabled={busy} onClick={() => void run(save, t('saved'))}>{t('save')}</button>
        <button disabled={busy || !settings.ownerRepo.trim()} onClick={() => void run(connect)}>{t('connect')}</button>
      </div>
      <section className={css.members}>
        <h2>{t('members')}</h2><p className={css.hint}>{t('membersHint')}</p>
        {!view.connection && <p className={css.hint}>{t('connectForMembers')}</p>}
        <button disabled={busy || !view.connection} onClick={() => void run(refreshMembers)}>{t('refreshMembers')}</button>
        {view.connection?.repository.permissions.admin && <div className={css.actions}>
          <label>{t('username')} <input value={login} disabled={busy} autoComplete="off" onChange={event => { setLogin(event.target.value); setConfirm('') }} /></label>
          {confirm !== 'invite' ? <button disabled={busy || !login.trim()} onClick={() => setConfirm('invite')}>{t('invite')}</button> : <>
            <button disabled={busy} onClick={() => void run(async () => {
              const result = await memberCall('invite', { login: login.trim() }) as { status: 'pending' | 'accepted' }
              setNotice(t(result.status === 'pending' ? 'pendingInvitation' : 'accepted')); setConfirm(''); setLogin(''); await refreshMembers()
            })}>{t('confirmInvite')}</button><button onClick={() => setConfirm('')}>{t('cancel')}</button>
          </>}
        </div>}
        <ul className={css.list}>{invitations.map(invite => <li key={invite.id}><span>{invite.login} · {t('pendingInvitation')}</span>
          <button disabled={busy} onClick={() => void run(async () => { await memberCall('cancelInvitation', { id: invite.id }); await refreshMembers() })}>{t('revoke')}</button></li>)}
          {members.map(member => <li key={member.id}><span>{member.login} · {t('accepted')}</span>
            {view.connection?.repository.permissions.admin && member.id !== view.connection.identity.id && (confirm === 'remove-' + member.id
              ? <><button disabled={busy} onClick={() => void run(async () => { await memberCall('removeCollaborator', { login: member.login }); setConfirm(''); await refreshMembers() })}>{t('confirmRemove')}</button><button onClick={() => setConfirm('')}>{t('cancel')}</button></>
              : <button disabled={busy} onClick={() => setConfirm('remove-' + member.id)}>{t('remove')}</button>)}
          </li>)}</ul>
      </section>
    </section>}
    {view.pending.length > 0 && <section className={css.card}><h2>{t('pending')}</h2><ul>{view.pending.map(draft => <li key={draft.id}>{draft.createdAt} · {draft.error ?? draft.state}</li>)}</ul></section>}
    {!settingsOnly && <>
      <section className={css.conversation} aria-label={t('conversation')}>
        {(before === undefined ? view.moreBefore : before) && <button disabled={busy} onClick={() => void run(async () => {
          const page = await client.call('history', { before: before ?? view.moreBefore }) as Pick<CoopView, 'messages' | 'moreBefore'>
          setOlder([...page.messages, ...older]); setBefore(page.moreBefore ?? null)
        })}>{t('older')}</button>}
        {!view.messages.length && <p className={css.hint}>{t('noMessages')}</p>}
        {[...older.filter(item => !view.messages.some(value => value.id === item.id)), ...view.messages].map(message => <article key={message.id} className={message.role === 'user' ? css.user : css.assistant}>
          <header><strong>{t(message.role === 'user' ? 'you' : 'assistant')}</strong><time>{message.createdAt}</time></header><div>{message.text}</div>
        </article>)}
      </section>
      <form className={css.composer} onSubmit={event => { event.preventDefault(); if (text.trim() && !busy) void run(send) }}>
        <textarea aria-label={t('conversation')} placeholder={t('inputHint')} value={text} onChange={event => setText(event.target.value)} rows={4} disabled={busy || !view.connection} />
        <button type="submit" disabled={busy || !view.connection || !text.trim()}>{t('send')}</button>
      </form>
      <section className={css.card}><h2>{t('taskList')}</h2>{!view.tasks.length ? <p className={css.hint}>{t('noTasks')}</p> :
        <ul className={css.list}>{view.tasks.map(task => <li key={task.id}><div><strong>{task.title}</strong><p>{task.id} · {task.coordinator}</p></div><span>{task.status}</span></li>)}</ul>}
      </section>
    </>}
  </section>
}
