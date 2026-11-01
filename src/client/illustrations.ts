import type { AssistantSettings } from '../contracts/assistant.js'

export type IllustrationPage = 'conversation' | 'tasks'
export type IllustrationSettings = Pick<AssistantSettings, 'showCornerCharacter' | 'swapPageIllustrations'>

export function illustrationFor(page: IllustrationPage, settings: IllustrationSettings): 'welcome' | 'task' {
  return (page === 'conversation') !== (settings.swapPageIllustrations === true) ? 'welcome' : 'task'
}
export function showCornerIllustration(hasContent: boolean, settings: IllustrationSettings): boolean {
  return hasContent && settings.showCornerCharacter !== false
}
