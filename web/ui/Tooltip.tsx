// The app's own tooltip in place of the system one (whose white frame cannot be styled). Every
// element with a title keeps it in the markup; on hover the text moves to data-tip, so the system
// tooltip stays away, and this one shows it.
import { useEffect, useRef, useState } from 'preact/hooks'

const DELAY = 450

export function Tooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let timer = 0
    let current: Element | null = null
    const hide = () => {
      clearTimeout(timer)
      current = null
      setTip(null)
    }
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const target = (event.target as Element).closest?.('[title], [data-tip]')
      if (target === current) return
      hide()
      if (!target) return
      const title = target.getAttribute('title')
      if (title) {
        target.setAttribute('data-tip', title)
        target.removeAttribute('title')
      }
      const text = target.getAttribute('data-tip')
      if (!text) return
      current = target
      timer = window.setTimeout(() => {
        if (current !== target || !target.isConnected) return
        const rect = target.getBoundingClientRect()
        const below = rect.bottom + 40 < window.innerHeight
        setTip({ text, x: rect.left + rect.width / 2, y: below ? rect.bottom + 6 : rect.top - 6, below })
      }, DELAY)
    }
    window.addEventListener('pointerover', over)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('wheel', hide, { passive: true })
    window.addEventListener('keydown', hide)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerover', over)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('wheel', hide)
      window.removeEventListener('keydown', hide)
      window.removeEventListener('blur', hide)
    }
  }, [])
  // kept inside the window once its size is known
  useEffect(() => {
    const el = box.current
    if (!el || !tip) return
    const width = el.offsetWidth
    const left = Math.max(6, Math.min(window.innerWidth - width - 6, tip.x - width / 2))
    el.style.left = `${left}px`
    el.style.visibility = 'visible'
  }, [tip])
  if (!tip) return null
  return (
    <div ref={box} class="tooltip" role="tooltip" style={{ top: `${tip.y}px`, transform: tip.below ? undefined : 'translateY(-100%)', visibility: 'hidden' }}>
      {tip.text}
    </div>
  )
}
