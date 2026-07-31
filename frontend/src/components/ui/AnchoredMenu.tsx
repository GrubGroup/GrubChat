import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { cn } from '@/utils/cn'

export interface AnchoredMenuProps {
  open: boolean
  /** The FIELD to anchor to — not its wrapper, so an error/hint line below the
   * input does not push the menu down. */
  anchorRef: RefObject<HTMLElement | null>
  /** Called when the page or a scroll container moves under the menu. */
  onDismiss: () => void
  /** IDREF target for the combobox's aria-controls. */
  id?: string
  role?: 'listbox' | 'menu'
  /** Re-measure when the menu's own height can change (async suggestions). */
  revision?: unknown
  /** Hard cap in px — pass 240 to reproduce `max-h-60`. */
  maxHeight?: number
  className?: string
  children: ReactNode
}

/**
 * A menu that overlays the page like a native <select> popup instead of
 * inflating whatever is scrolling behind it.
 *
 * Rendered through a portal to <body> with `position: fixed`, so it is excluded
 * from Modal's body scroller's scrollable-overflow region AND out of reach of
 * the dialog panel's `overflow-hidden` and its 0.22s enter/exit transform.
 *
 * Things that keep working across the portal, so callers need no changes:
 *  - React portals bubble events through the REACT tree, so a click inside still
 *    hits Modal's panel-level stopPropagation and never reaches the backdrop's
 *    onClose. Option clicks do not close the dialog.
 *  - `onMouseDown` + `preventDefault()` on an option still beats the input's
 *    blur timer: preventDefault-on-mousedown is native behaviour on the real DOM
 *    node, and React attaches its listeners to the portal container too.
 *  - `aria-controls` is an IDREF, so it resolves wherever the node lives.
 *
 * Every visual class is copied verbatim from the two menus this replaces; only
 * top/left/width/max-height come from inline style. `cn` does not tailwind-merge
 * (utils/cn.ts), so positioning must not be expressed as a utility here.
 */
export function AnchoredMenu({
  open,
  anchorRef,
  onDismiss,
  id,
  role = 'listbox',
  revision,
  maxHeight,
  className,
  children,
}: AnchoredMenuProps) {
  const { menuRef, rect } = useAnchoredPosition<HTMLUListElement>(anchorRef, open, onDismiss, {
    revision,
    maxHeight,
  })

  if (!open) return null

  // Before the first measurement the node must be in the DOM (so scrollHeight is
  // real) but must not paint at 0,0 — and its height must be UNCAPPED so the
  // flip decision sees the natural height.
  const cap = rect ? Math.min(maxHeight ?? Number.POSITIVE_INFINITY, rect.maxHeight) : undefined

  return createPortal(
    <ul
      ref={menuRef}
      id={id}
      role={role}
      // Keep focus in the field: a mousedown on the menu's own padding would
      // otherwise blur the input and trip its close timer.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: rect?.top ?? 0,
        left: rect?.left ?? 0,
        width: rect?.width,
        maxHeight: cap,
        visibility: rect ? 'visible' : 'hidden',
      }}
      className={cn(
        'z-popover overflow-auto rounded-input border border-border bg-surface py-1 shadow-lg',
        className,
      )}
    >
      {children}
    </ul>,
    document.body,
  )
}
