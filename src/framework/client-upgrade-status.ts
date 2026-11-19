import * as React from 'react'
const h = React.createElement

/** Reading old identities never hides already converted Tasks. */
export function OriginalTaskReadStatus({ status, tr }: { status?: 'loading' | 'failed'; tr: (cn: string, en: string) => string }) {
  if (!status) return null
  return h('p', { role: 'status' }, status === 'loading'
    ? tr('正在读取原有任务记录，已转换任务可继续使用。', 'Reading original task records. Converted tasks remain available.')
    : tr('原有任务记录尚未读出，可刷新重试；已转换任务仍可使用。', 'Original task records could not be read. Refresh to retry; converted tasks remain available.'))
}
