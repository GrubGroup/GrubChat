import type { ReactNode } from 'react'
import { BrandMark, Icon } from '@/components/ui'
import { COLUMN_HEADER_H } from './AppSidebar'
import { cn } from '@/utils/cn'

export interface MobileHeaderProps {
  /** Back chevron on the left (drill-downs and pushed screens — incl. a group
   * chat, which pops back up to the groups list). */
  onBack?: () => void
  /** Show the GrubChat wordmark ABOVE the title — the tab ROOTS only (Groups,
   * Events), standing in for the hidden sidebar's panel header, which carries the
   * same wordmark-over-eyebrow stack at ≥md. Pushed screens omit it: their title
   * is the content, and the brand line would just eat vertical space. */
  brand?: boolean
  /** Small uppercase eyebrow ABOVE the title (e.g. "Private · only you can see this"). */
  overline?: ReactNode
  title: ReactNode
  /** Meta line BELOW the title (member count, "3 of 5 finished", …). */
  subtitle?: ReactNode
  /** Right-aligned controls — avatar stack, overflow ⋯, an action button. */
  actions?: ReactNode
  /** Paints the bar on the dedicated agent-session header surface — the
   * inverted top rung on paper, the DARKEST rung on ink. Private agent chat only. */
  inverse?: boolean
  className?: string
}

// The mobile top bar shared by the group chat, agent chat, drill-downs and the
// tab roots. Keeps COLUMN_HEADER_H (unless `brand` adds a row above) so its
// bottom border lines up with every desktop column header, and pads for the notch
// above that row (0px in a normal browser; non-zero only when installed to the
// home screen).
export function MobileHeader({
  onBack,
  brand = false,
  overline,
  title,
  subtitle,
  actions,
  inverse = false,
  className,
}: MobileHeaderProps) {
  return (
    <header
      className={cn(
        'shrink-0 border-b pt-safe-t',
        inverse ? 'border-on-header/10 bg-surface-header' : 'border-border bg-surface-raised',
        className,
      )}
    >
      <div className={cn('flex items-center gap-2 px-4', COLUMN_HEADER_H)}>
        {/* On a tab ROOT the brandmark sits to the LEFT of the section title
            (replacing the old wordmark row above it). The agent bar flips it to the
            header ink via currentColor. */}
        {brand && (
          <BrandMark
            size={30}
            className={cn('shrink-0', inverse ? 'text-on-header' : 'text-text')}
          />
        )}

        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back"
            // 44px square: a real touch target without needing tap-target, and
            // the negative margin keeps the glyph optically aligned to the title.
            className={cn(
              '-ml-2.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-pill',
              inverse ? 'text-on-header/80 hover:bg-on-header/10' : 'text-text-muted hover:bg-surface-sunken',
            )}
          >
            <Icon name="chevron-left" size={20} />
          </button>
        )}

        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {overline && (
            <p
              className={cn(
                'flex items-center gap-1.5 truncate text-overline uppercase tracking-wide',
                inverse ? 'text-on-header/50' : 'text-text-muted',
              )}
            >
              {overline}
            </p>
          )}
          {/* On a tab ROOT the title names the whole section, so it's the page
              <h1> at display size — matching how the section titles read on the
              desktop pages. On a pushed screen it's an inline entity name sharing
              the row with a back chevron and actions, so it stays item-title. */}
          <p
            className={cn(
              'truncate',
              brand
                ? 'font-display text-display font-bold tracking-tight'
                : 'text-item-title font-semibold',
              inverse ? 'text-on-header' : 'text-text',
            )}
          >
            {title}
          </p>
          {subtitle && (
            <p
              className={cn(
                'truncate text-caption font-medium',
                inverse ? 'text-on-header/50' : 'text-text-muted',
              )}
            >
              {subtitle}
            </p>
          )}
        </div>

        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </header>
  )
}
