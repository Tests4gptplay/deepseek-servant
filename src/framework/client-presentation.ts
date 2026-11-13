/** Local display labels are presentation, never account or storage identities.
 * Shared Git messages retain their actual participant label.
 */
export function frameworkMessageAuthor(mode: 'local' | 'git', message: { role: 'user' | 'assistant' | 'system'; participantId: string },
  settings: { name: string; userName: string }): string {
  if (mode !== 'local' || message.role === 'system') return message.participantId
  return (message.role === 'user' ? settings.userName : settings.name).trim() || message.participantId
}

/** Translate only recognized structured status values at the display boundary.
 * Diagnostics, source records and future/unknown values remain verbatim. */
const replySegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export function frameworkReplyPreview(text: string): string {
  const limit = 80, preview: string[] = []
  for (const { segment } of replySegments.segment(text.replace(/\s+/gu, ' ').trim())) {
    if (preview.length === limit) return preview.join('') + '…'
    preview.push(segment)
  }
  return preview.join('')
}

const stateLabels: Readonly<Record<string, readonly [string, string]>> = {
  connected: ['已连接', 'Connected'], disconnected: ['未连接', 'Disconnected'],
  connecting: ['连接中', 'Connecting'], running: ['运行中', 'Running'],
  paused: ['已暂停', 'Paused'], stopped: ['已停止', 'Stopped'],
  idle: ['回合空闲', 'Turn idle'], waiting: ['等待中', 'Waiting'],
  starting: ['启动中', 'Starting'], stopping: ['停止中', 'Stopping'],
  complete: ['已完成', 'Completed'], cancelled: ['已取消', 'Cancelled'],
  unknown: ['状态待确认', 'Needs confirmation'], unconfirmed: ['尚未确认', 'Unconfirmed'],
  online: ['在线', 'Online'], offline: ['离线', 'Offline'],
  lost: ['执行已丢失', 'Execution lost'], failed: ['失败', 'Failed'],
  superseded: ['已被替代', 'Superseded'], recovering: ['恢复中', 'Recovering'],
  pending: ['待处理', 'Pending'], accepted: ['已接受', 'Accepted'],
  'wait-result': ['等待结果', 'Awaiting result'], 'wait-user': ['等待用户', 'Awaiting user'],
  unresolved: ['待解析', 'Unresolved'], cleared: ['工作状态已清理', 'Working state cleared'],
  stored: ['已存储', 'Stored'], 'read-only': ['只读', 'Read only'],
  candidate: ['候选', 'Candidate'], validated: ['已验证', 'Validated'],
  active: ['可使用', 'Available'], revised: ['已被修订', 'Revised'], disabled: ['已停用', 'Disabled'], retired: ['已退役', 'Retired'],
}
export function frameworkStateLabel(status: string, tr: (cn: string, en: string) => string): string {
  const label = Object.hasOwn(stateLabels, status) ? stateLabels[status] : undefined
  return label ? tr(label[0], label[1]) : status
}
/** Dispatch intent is not proof that a physical execution has stopped. */
export function frameworkControlLabel(status: string, tr: (cn: string, en: string) => string): string {
  if (status === 'running') return tr('允许继续', 'Allowed to continue')
  if (status === 'paused') return tr('已暂停', 'Paused')
  return frameworkStateLabel(status, tr)
}
/** Member business status is distinct from native execution state. */
export function frameworkMemberStatus(status: string, zh: boolean): string {
  return frameworkStateLabel(status, (cn, en) => zh ? cn : en)
}

/** Display only the publication facts in the retention file already read by
 * the archive view. This never reads skills, retries or grants cleanup. */
export function frameworkArchiveSkillPublication(value: unknown): {
  issues: string[]; unmerged: Array<{ path: string; reason: string; proposalPreservedAt: string }>
} | undefined {
  if (!value || typeof value !== 'object') return undefined
  const saved = value as { issues?: unknown; unmerged?: unknown }
  const issues = Array.isArray(saved.issues) ? saved.issues.filter((item): item is string => typeof item === 'string') : []
  const unmerged = Array.isArray(saved.unmerged) ? saved.unmerged.filter((item): item is { path: string; reason: string; proposalPreservedAt: string } =>
    !!item && typeof item === 'object' && typeof item.path === 'string' && typeof item.reason === 'string' && typeof item.proposalPreservedAt === 'string')
    .map(({ path, reason, proposalPreservedAt }) => ({ path, reason, proposalPreservedAt })) : []
  return issues.length || unmerged.length ? { issues, unmerged } : undefined
}
