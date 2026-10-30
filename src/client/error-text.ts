import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

// Keep persisted messages and diagnostics verbatim. Translate only known DSS
// diagnostics at the presentation boundary; paths and unknown errors stay intact.
export const servantDiagnostics = [
  ['记录目录必须是完整路径。', 'The records directory must be an absolute path.'],
  ['记录目录不可用：', 'The records directory is unavailable: '],
  ['记录目录已变化，请刷新后重试。', 'The records directory changed. Refresh and try again.'],
  ['请输入文件夹的完整绝对路径。', 'Enter the full absolute path of the folder.'],
  ['请选择一个文件夹。', 'Choose a folder.'],
  ['不能迁移到当前记录子文件夹内部。', 'The destination cannot be inside the current records folder.'],
  ['目标文件夹已有 Servant 记录，请选择其他文件夹；不会覆盖已有记录。', 'The destination already contains Servant records. Choose another folder; existing records will not be overwritten.'],
  ['当前记录存储没有可管理的本地文件夹。', 'The current record storage has no manageable local folder.'],
  ['记录迁移校验失败，原目录保持不变。', 'Record migration verification failed. The original directory is unchanged.'],
  ['记录迁移不接受符号链接：', 'Record migration does not accept symbolic links: '],
  ['每个记录文件只能保存一个记录', 'Each record file may contain only one record.'],
  ['记录路径、身份或封装不匹配', 'The record path, identity or envelope does not match.'],
  ['记录分类目录不是普通文件夹：', 'The record category is not a regular directory: '],
  ['记录目录不能是符号链接：', 'The record directory cannot be a symbolic link: '],
  ['记录不是普通文件：', 'The record is not a regular file: '],
  ['Servant 记录目录不是普通文件夹：', 'The Servant records directory is not a regular directory: '],
  ['不支持的 Servant 记录目录格式：', 'Unsupported Servant records directory format: '],
  ['当前宿主没有本地打开文件能力。路径：', 'This host cannot open local files. Path: '],
  ['任务不存在或不属于当前助理。', 'The task does not exist or does not belong to this assistant.'],
  ['请先查看清理范围并确认删除已结束任务记录。', 'Preview the cleanup scope and confirm deletion of ended task records first.'],
  ['清理策略不能为空。', 'A retention policy is required.'],
  ['此操作只用于需要人工核对的未知旧执行。', 'This action is only for an unknown previous execution that needs manual verification.'],
  ['该任务没有这个产物引用。', 'This task has no such artifact reference.'],
  ['此产物位于任务工作区之外，请按显示的路径自行查看。', 'This artifact is outside the task workspace. Open the displayed path yourself.'],
  ['助理设置已经变化，请刷新后再保存。', 'Assistant settings changed. Refresh before saving.'],
  ['前台消息保留在原工作区；请先完成本轮回复或清理前台对话，再切换工作区。', 'Foreground messages remain in the original workspace. Finish this reply or clear the foreground conversation before switching workspaces.'],
  ['前台正在处理已提交的消息，请等本轮结束后再更换模型。', 'The foreground is processing a submitted message. Wait for this turn to finish before changing models.'],
  ['消息标识和正文不能为空。', 'A message identity and body are required.'],
  ['同一消息标识不能用于不同正文。', 'A message identity cannot be reused for different text.'],
  ['同一交付标识不能用于不同交付内容。', 'A delivery identity cannot be reused for different content.'],
  ['本轮前台回复已结束：', 'This foreground reply ended: '],
  ['前台作业正在结束，请结束后再清理对话。', 'Foreground jobs are stopping. Wait until they finish before clearing the conversation.'],
  ['后台执行仍未停止，保留其状态：', 'A background execution has not stopped; its state was retained: '],
  ['任务状态仍待收束：', 'The task state still needs to be finalized: '],
  ['请重新查看本次清理范围。', 'Preview this cleanup scope again.'],
  ['任务仍有尚未结束的执行或作业。', 'The task still has unfinished executions or jobs.'],
  ['前台正在处理消息，请等本轮结束后再更换工作区或前台模型。后台任务保持其创建时的配置。', 'The foreground is processing a message. Wait for this turn to finish before changing its workspace or model. Background tasks retain the configuration captured when they were created.'],
  ['部分后台执行未能停止，任务状态已保留，请查看具体错误后重试。', 'Some background executions could not be stopped. Their task state was retained. Review the errors and try again.'],
] as const

export function localizeServantError(text: string | undefined, t: PropsLocale<'dsh.servant'>['t']): string | undefined {
  if (!text || !t('calendar.locale').toLowerCase().startsWith('en')) return text
  for (const [source, translated] of servantDiagnostics) {
    if (text === source) return translated
    if (source.endsWith('：') && text.startsWith(source)) return translated + text.slice(source.length)
    // Per-record fault reports prefix the native path, which must remain verbatim.
    if (!source.endsWith('：') && text.endsWith(': ' + source)) return text.slice(0, -source.length) + translated
  }
  const pending = /^(\d+) 条前台消息等待修复后重新接纳。$/.exec(text)
  return pending ? `${pending[1]} foreground message(s) await repair before readmission.` : text
}
