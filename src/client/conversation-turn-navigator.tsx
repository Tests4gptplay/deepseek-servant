import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationTurn } from './conversation-turns.js'
import css from './conversation-turn-navigator.module.css'

export function ConversationTurnNavigator({ turns, activeId, onNavigate, zh }: {
  turns: readonly ConversationTurn[]; activeId?: string; onNavigate: (id: string) => void; zh: boolean
}) {
  const [hovered, setHovered] = useState<string>(), [focused, setFocused] = useState<string>()
  const [position, setPosition] = useState<{ left: number; width: number; top: number }>()
  const scroller = useRef<HTMLDivElement>(null), frame = useRef<HTMLElement>(null)
  const marks = useRef(new Map<string, HTMLButtonElement>()), pointerInside = useRef(false)
  const previewId = useId(), preview = turns.find(turn => turn.anchorId === (hovered ?? focused))
  const turnLabel = (index: number) => zh ? `当前已加载的第 ${index + 1} 轮` : `Loaded turn ${index + 1}`
  useLayoutEffect(() => {
    const element = scroller.current, mark = activeId ? marks.current.get(activeId) : undefined
    if (!element || !mark || pointerInside.current || focused) return
    const top = mark.offsetTop, bottom = top + mark.offsetHeight
    if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(0, top - element.clientHeight / 2)
  }, [activeId, turns, focused])
  useLayoutEffect(() => {
    if (!preview) { setPosition(undefined); return }
    const place = () => {
      const mark = marks.current.get(preview.anchorId), rail = frame.current
      if (!mark || !rail) { setPosition(undefined); return }
      const box = mark.getBoundingClientRect(), railBox = rail.getBoundingClientRect()
      if (!railBox.width || !railBox.height || box.bottom < railBox.top || box.top > railBox.bottom) { setPosition(undefined); return }
      const left = railBox.right + 10, width = Math.min(300, window.innerWidth - left - 12)
      if (width < 120) { setPosition(undefined); return }
      setPosition({ left, width, top: Math.max(12, Math.min(window.innerHeight - 112, box.top + box.height / 2 - 50)) })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (frame.current) observer?.observe(frame.current)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); observer?.disconnect() }
  }, [preview])
  if (turns.length < 2) return null
  return <div className={css.slot} data-conversation-turn-slot>
    <nav ref={frame} className={css.frame} aria-label={zh ? '回合导航' : 'Turn navigation'}
      onPointerEnter={() => { pointerInside.current = true }}
      onPointerLeave={() => { pointerInside.current = false; setHovered(undefined) }}
      onKeyDown={event => { if (event.key === 'Escape') { setHovered(undefined); setFocused(undefined) } }}>
      <div ref={scroller} className={css.scroller} onScroll={() => setHovered(undefined)}><div className={css.marks}>
        {turns.map((turn, index) => <button type="button" key={turn.anchorId}
          ref={element => { if (element) marks.current.set(turn.anchorId, element); else marks.current.delete(turn.anchorId) }}
          data-turn-anchor={turn.anchorId} className={`${css.mark} ${turn.anchorId === activeId ? css.active : ''}`}
          aria-label={(zh ? '跳转到' : 'Jump to ') + turnLabel(index)} aria-current={turn.anchorId === activeId ? 'true' : undefined}
          aria-describedby={turn === preview && position ? previewId : undefined}
          onPointerMove={() => setHovered(turn.anchorId)} onFocus={() => setFocused(turn.anchorId)} onBlur={() => setFocused(undefined)}
          onClick={() => { setHovered(undefined); setFocused(undefined); onNavigate(turn.anchorId) }} />)}
      </div></div>
    </nav>
    {preview && position && createPortal(<div id={previewId} role="tooltip" className={css.preview} style={position}>
      <div className={css.previewPrompt}>{preview.prompt || turnLabel(turns.indexOf(preview))}</div>
      {preview.response && <div className={css.previewResponse}>{preview.response}</div>}
    </div>, document.body)}
  </div>
}
