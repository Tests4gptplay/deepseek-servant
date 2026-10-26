export const MODE_NS = 'dsh.servant.modes'
export const modeZh = {
  mode: '运行模式', local: 'Local', git: 'Private Git · 实验',
  switchHint: '切换仅影响新输入；两个模式中已开始的任务继续运行。',
  loading: '正在读取模式…', retry: '重试', title: 'Private Git 协作',
  subtitle: '每个参与者保留自己的前台、规划者和 Worker；通过已确认的私有 Git 记录协作。',
  settings: '协作设置', repository: '私有仓库 owner/repo', credentialRef: '凭据引用',
  token: 'GitHub 凭据', tokenHint: '仅保存到 DSH Credentials。留空可使用环境变量或已登录的 GitHub CLI。',
  credentialConfigured: '凭据已配置', credentialMissing: '未配置存储凭据，可使用已登录的 GitHub CLI',
  saveCredential: '保存凭据', credentialSaved: '凭据已保存', workspace: '本实例工作目录',
  pickDirectory: '选择目录', preset: 'Agent 预设', provider: '模型供应商（留空跟随宿主）', model: '模型 ID（留空跟随宿主）',
  effort: '推理强度（可选）', seats: '本实例 Worker 席位', save: '保存设置', connect: '连接私有仓库',
  refresh: '同步 Git', account: '当前 GitHub 账户', head: '已确认提交', connected: '已连接',
  unconfigured: '待连接', offline: '同步待恢复', conversation: '协作对话', send: '提交到 Git',
  inputHint: '输入目标，或说明要协助哪个参与者的任务…', pending: '未提交草稿',
  readPending: '提交成功，等待读回确认', committed: 'Git 已确认', taskList: '协作任务',
  noTasks: '尚无协作任务。', noMessages: '连接独立私有协作仓库后，从这里发送首个目标。',
  members: '仓库成员', membersHint: '受邀成员接受后可读写整个仓库。请使用专门的协作私库。',
  username: 'GitHub 用户名', invite: '邀请写入协作者', confirmInvite: '确认邀请',
  cancel: '取消', pendingInvitation: '待对方在 GitHub 接受', accepted: '已接受',
  refreshMembers: '刷新成员', revoke: '撤销邀请', remove: '移除协作者', confirmRemove: '确认移除',
  older: '更早的对话', saved: '设置已保存', error: '操作失败', you: '你', assistant: '协作前台',
} as const
export type ModeTextKey = keyof typeof modeZh
export const modeEn: Record<ModeTextKey, string> = {
  mode: 'Execution mode', local: 'Local', git: 'Private Git · Experimental',
  switchHint: 'Switching routes new input only. Existing tasks keep running in both modes.',
  loading: 'Loading mode…', retry: 'Retry', title: 'Private Git collaboration',
  subtitle: 'Each participant keeps their own foreground, planner and workers, coordinated through confirmed private Git records.',
  settings: 'Collaboration settings', repository: 'Private repository owner/repo', credentialRef: 'Credential reference',
  token: 'GitHub credential', tokenHint: 'Stored only in DSH Credentials. Leave blank to use the environment or signed-in GitHub CLI.',
  credentialConfigured: 'Credential configured', credentialMissing: 'No stored credential; signed-in GitHub CLI can be used',
  saveCredential: 'Save credential', credentialSaved: 'Credential saved', workspace: 'This instance’s working directory',
  pickDirectory: 'Choose directory', preset: 'Agent preset', provider: 'Provider (blank follows host)', model: 'Model ID (blank follows host)',
  effort: 'Reasoning effort (optional)', seats: 'This instance’s worker seats', save: 'Save settings', connect: 'Connect private repository',
  refresh: 'Sync Git', account: 'GitHub account', head: 'Confirmed commit', connected: 'Connected',
  unconfigured: 'Not connected', offline: 'Sync pending', conversation: 'Collaboration conversation', send: 'Commit to Git',
  inputHint: 'Enter a goal, or say which participant and task to assist…', pending: 'Uncommitted drafts',
  readPending: 'Committed; awaiting independent readback', committed: 'Git confirmed', taskList: 'Collaborative tasks',
  noTasks: 'No collaborative tasks yet.', noMessages: 'Connect a dedicated private collaboration repository, then send a goal here.',
  members: 'Repository members', membersHint: 'After accepting, collaborators can read and write the entire repository. Use a dedicated private collaboration repository.',
  username: 'GitHub username', invite: 'Invite write collaborator', confirmInvite: 'Confirm invitation',
  cancel: 'Cancel', pendingInvitation: 'Awaiting acceptance on GitHub', accepted: 'Accepted',
  refreshMembers: 'Refresh members', revoke: 'Revoke invitation', remove: 'Remove collaborator', confirmRemove: 'Confirm removal',
  older: 'Older conversation', saved: 'Settings saved', error: 'Operation failed', you: 'You', assistant: 'Coop foreground',
}
export type ModeText = (key: ModeTextKey) => string
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'dsh.servant.modes': ModeTextKey }
}
