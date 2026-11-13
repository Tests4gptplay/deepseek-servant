/** DSH schedule calendar layout, adapted for history queries (MIT; see THIRD_PARTY_NOTICES.md). */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, MenuSurface, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { daysIn, isoOf, shiftMonth, viewOf } from './calendar.js'
import css from './date-picker.module.css'

const weekdays = ['calendar.mon', 'calendar.tue', 'calendar.wed', 'calendar.thu', 'calendar.fri', 'calendar.sat', 'calendar.sun'] as const
const steps: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

export function HistoryDatePicker({ value, disabled, onPick, t }: {
  value: string; disabled: boolean; onPick(date: string): void; t: PropsLocale<'dsh.servant'>['t']
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => viewOf(value))
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const cells = useRef(new Map<number, HTMLDivElement>())
  const position = useAnchoredPosition({ open, anchorRef: anchor, panelRef: panel, gap: 4, margin: 12 })
  useDismissOnOutsidePointer(anchor, open, setOpen, panel)
  const today = viewOf('')
  const todayIso = isoOf(today, today.day)
  const close = () => { setOpen(false); anchor.current?.focus() }
  const pick = (date: string) => { close(); onPick(date) }
  useEffect(() => { if (open) cells.current.get(view.day)?.focus() }, [open, view])
  const onCellKey = (event: KeyboardEvent<HTMLDivElement>, day: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); pick(isoOf(view, day)); return
    }
    const step = steps[event.key]
    if (step) { event.preventDefault(); setView(current => ({ ...current, day: Math.min(Math.max(day + step, 1), daysIn(current)) })) }
  }
  const offset = (new Date(Date.UTC(view.year, view.month, 1)).getUTCDay() + 6) % 7
  const total = daysIn(view)
  const weeks = Array.from({ length: Math.ceil((offset + total) / 7) }, (_, week) => week)
  const monthTitle = new Intl.DateTimeFormat(t('calendar.locale'), {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(Date.UTC(view.year, view.month, 1))

  return <>
    <Button ref={anchor} size="sm" variant="outline" disabled={disabled} aria-label={t('conversation.date')}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => {
        if (!open) setView(viewOf(value))
        setOpen(current => !current)
      }}>{value ? value.replaceAll('-', '/') : t('conversation.date')}</Button>
    {open && createPortal(<MenuSurface ref={panel} className={css.calendar} role="dialog" aria-label={t('conversation.date')}
      style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}
      onClick={event => event.stopPropagation()}>
      <div className={css.head}>
        <Button size="sm" aria-label={t('calendar.previous')} onClick={() => setView(current => shiftMonth(current, -1))}
          icon={<IconChevronLeftOutlineRegular />} />
        <span className={css.title} aria-live="polite">{monthTitle}</span>
        <Button size="sm" aria-label={t('calendar.next')} onClick={() => setView(current => shiftMonth(current, 1))}
          icon={<IconChevronRightOutlineRegular />} />
      </div>
      <div className={css.grid} role="grid" aria-label={monthTitle}>
        <div className={css.week} role="row">{weekdays.map(key => <div key={key} role="columnheader" className={css.weekday}>{t(key)}</div>)}</div>
        {weeks.map(week => <div key={week} className={css.week} role="row">
          {Array.from({ length: 7 }, (_, column) => week * 7 + column - offset + 1).map(day =>
            day < 1 || day > total ? <div key={day} role="gridcell" aria-hidden="true" className={css.blank} /> :
              <div key={day} ref={element => { if (element) cells.current.set(day, element); else cells.current.delete(day) }}
                role="gridcell" aria-selected={isoOf(view, day) === value} aria-current={isoOf(view, day) === todayIso ? 'date' : undefined}
                tabIndex={day === view.day ? 0 : -1} className={`${css.cell} ${isoOf(view, day) === value ? css.selected : ''}`}
                onClick={() => pick(isoOf(view, day))} onKeyDown={event => onCellKey(event, day)}>{day}</div>)}
        </div>)}
      </div>
      <div className={css.footer}>
        <Button size="sm" onClick={() => pick('')}>{t('calendar.clear')}</Button>
        <Button size="sm" onClick={() => pick(todayIso)}>{t('calendar.today')}</Button>
      </div>
    </MenuSurface>, document.body)}
  </>
}
