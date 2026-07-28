import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { EASE } from '@/lib/motion'
import { useDismissOnBack } from '@/hooks/useDismissOnBack'
import { useScrollLock } from '@/hooks/useScrollLock'
import { cn } from '@/utils/cn'
import { IconButton } from './IconButton'
import { Icon } from './Icon'

type ModalSize = 'sm' | 'md' | 'lg' | 'full'
type ModalVariant = 'center' | 'sheet'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  size?: ModalSize
  /** 'center' = classic centered dialog. 'sheet' = bottom sheet (mobile). */
  variant?: ModalVariant
  /** Sticky action row pinned below the scrolling body — sheets need their CTA
   * reachable without scrolling to the end of a long form. */
  footer?: ReactNode
  children: ReactNode
}

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  full: 'max-w-4xl',
}

// Focusable descendants, in DOM order — for the tab trap below.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  size = 'md',
  variant = 'center',
  footer,
  children,
}: ModalProps) {
  const reduce = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)
  const isSheet = variant === 'sheet'

  // The OS back gesture closes the dialog instead of leaving the app — the single
  // most-missed affordance on a full-height mobile sheet. Every caller gets it
  // here, so no sheet has to wire it up itself.
  useDismissOnBack(open, onClose)
  // Stop swipes inside the dialog from scroll-chaining to the page behind it.
  useScrollLock(open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Focus management: move focus into the dialog on open (unless a child already
  // claimed it via autoFocus) and hand it back to the opener on close, so keyboard
  // and screen-reader users aren't left behind the overlay.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const opener = document.activeElement as HTMLElement | null
    if (panel && !panel.contains(opener)) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? panel).focus()
    }
    return () => opener?.focus?.()
  }, [open])

  // Keep Tab inside the dialog while it's open.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      // offsetParent is null for anything display:none — skip hidden controls.
      (el) => el.offsetParent !== null,
    )
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    }
  }

  // Dialog entrance per variant: center scales/rises in; sheet slides up from the
  // bottom. Reduced-motion collapses both to an opacity-only crossfade. Kept
  // mounted via AnimatePresence so the exit animation plays on close.
  const panelMotion = isSheet
    ? {
        initial: { opacity: reduce ? 0 : 1, y: reduce ? 0 : '100%' },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: reduce ? 0 : 1, y: reduce ? 0 : '100%' },
      }
    : {
        initial: { opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : 8 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : 8 },
      }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn(
            'fixed inset-0 z-50 flex bg-overlay',
            // A sheet is flush to the bottom and side edges; a centered dialog
            // keeps its 1rem breathing room.
            isSheet ? 'items-end justify-center p-0' : 'items-center justify-center p-4',
          )}
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={trapTab}
            className={cn(
              // flex column + a height cap so a tall body scrolls INSIDE the
              // dialog instead of overflowing off-screen with no way to reach the
              // submit button (which is what happened at phone height before).
              // overflow-hidden clips the sticky footer to the rounded corners —
              // without it the footer's square bg paints over the centered
              // dialog's rounded BOTTOM corners on desktop.
              'flex w-full flex-col overflow-hidden bg-surface-raised shadow-xl focus:outline-none',
              sizeClasses[size],
              isSheet
                ? 'max-h-[92dvh] rounded-t-card'
                : 'max-h-[calc(100dvh-2rem)] rounded-card',
            )}
            {...panelMotion}
            transition={{ duration: reduce ? 0.2 : 0.22, ease: EASE }}
          >
            {/* Grabber — the standard "this sheet is draggable/dismissible" cue.
                Purely visual; dismissal is the backdrop, Escape, or back. */}
            {isSheet && (
              <div className="flex shrink-0 justify-center pb-1 pt-2.5">
                <span className="h-1 w-10 rounded-pill bg-border-strong" />
              </div>
            )}

            {title && (
              <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
                <h2 className="font-display text-section-title font-semibold text-text">{title}</h2>
                <IconButton
                  label="Close"
                  size="sm"
                  icon={<Icon name="x" size={14} />}
                  onClick={onClose}
                />
              </div>
            )}

            {/* min-h-0 lets this shrink below its content so overflow-y-auto
                actually engages inside the flex column. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>

            {/* Outer div carries the safe-area inset so the inner padding stays a
                constant 1.25rem regardless of the home indicator. */}
            {footer && (
              <div className="shrink-0 border-t border-border bg-surface-raised pb-safe-b">
                <div className="px-5 py-4">{footer}</div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
