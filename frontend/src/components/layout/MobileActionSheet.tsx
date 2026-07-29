import { Icon, Modal, type IconName } from '@/components/ui'
import { useIsMobile } from '@/hooks/useIsMobile'
import { cn } from '@/utils/cn'

export interface MobileActionSheetItem {
  icon: IconName
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Shown under the label — usually WHY the row is disabled. */
  note?: string
}

export interface MobileActionSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  items: MobileActionSheetItem[]
}

// The sheet behind a mobile header's ⋯ overflow. Header actions that can't fit
// beside a title at 390px (a "Start session" button plus an "Edit group" button
// plus a name plus an avatar stack) become full-width rows here — each one a real
// touch target with room for its own explanatory note.
//
// Gated on useIsMobile because Modal's scroll lock and parked history entry are
// behaviours: a display:none sheet left open by a resize would still hold both.
export function MobileActionSheet({ open, onClose, title, items }: MobileActionSheetProps) {
  const isMobile = useIsMobile()
  if (!isMobile) return null

  return (
    <Modal open={open} onClose={onClose} title={title} variant="sheet" size="md">
      <div className="-my-2 flex flex-col">
        {items.map((item) => (
          <button
            key={item.label}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
            className={cn(
              'flex min-h-14 items-center gap-3 rounded-input px-2 text-left transition-colors',
              item.disabled
                ? 'cursor-not-allowed text-text-subtle'
                : 'text-text active:bg-surface-sunken',
            )}
          >
            <span
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken',
                item.disabled ? 'text-text-subtle' : 'text-primary',
              )}
            >
              <Icon name={item.icon} size={16} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-item-title font-semibold">{item.label}</span>
              {item.note && <span className="text-caption text-text-muted">{item.note}</span>}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
