/** Calendar arithmetic adapted from DeepSeek Harness ui-schedule (MIT; see THIRD_PARTY_NOTICES.md). */
export interface MonthView { year: number; month: number; day: number }
export function viewOf(date: string): MonthView {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match) return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) }
  const today = new Date()
  return { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() }
}
export function daysIn(view: Pick<MonthView, 'year' | 'month'>): number {
  return new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate()
}
export function shiftMonth(view: MonthView, step: number): MonthView {
  const months = view.year * 12 + view.month + step
  const moved = { year: Math.floor(months / 12), month: ((months % 12) + 12) % 12 }
  return { ...moved, day: Math.min(view.day, daysIn(moved)) }
}
export function isoOf(view: Pick<MonthView, 'year' | 'month'>, day: number): string {
  return `${view.year}-${String(view.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
