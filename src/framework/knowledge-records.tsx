import type { KnowledgeReadRecord } from './knowledge.js'

/** Historical facts and preferences are readable records, not editable skills. */
export function KnowledgeRecordView({ record, tr }: { record: KnowledgeReadRecord; tr: (cn: string, en: string) => string }) {
  return <section aria-label={tr('历史知识正文', 'Historical knowledge record')}>
    <h4>{record.kind === 'preference' ? tr('偏好', 'Preference') : tr('项目事实', 'Project fact')}</h4>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.text}</pre>
    <dl><dt>{tr('范围', 'Scope')}</dt><dd>{JSON.stringify(record.scope)}</dd>
      {record.applicability !== undefined && <><dt>{tr('适用范围', 'Applicability')}</dt><dd>{record.applicability}</dd></>}
      <dt>{tr('来源', 'Source')}</dt><dd>{record.source}</dd></dl>
  </section>
}
