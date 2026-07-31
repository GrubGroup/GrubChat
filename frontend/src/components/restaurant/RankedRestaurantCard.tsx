import { useEffect } from 'react'
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion'
import type { RankedPick } from '@/types'
import { Badge, Button, Icon } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { cn } from '@/utils/cn'
import { formatHours, isOpenAt } from '@/utils/hours'

// Counts from 0 up to `value` on mount and whenever `value` changes (e.g. when
// switching between picks re-renders the detail). Reduced-motion renders the
// final value directly. Hooks always run — only the output branches — so hook
// order stays stable.
function AnimatedPct({ value }: { value: number }) {
  const reduce = useReducedMotion()
  const mv = useMotionValue(0)
  const rounded = useTransform(mv, (v) => Math.round(v))
  useEffect(() => {
    if (reduce) return
    const controls = animate(mv, value, { duration: 0.6, ease: EASE })
    return () => controls.stop()
  }, [mv, value, reduce])
  if (reduce) return <>{value}</>
  return <motion.span>{rounded}</motion.span>
}

export interface RankedRestaurantCardProps {
  rank: number
  pick: RankedPick
  selected: boolean
  hasVoted: boolean
  onVote: () => void
  onSelect: () => void
  /** Show the open/closed + hours line (top-picks list + in-chat picks card). */
  showHours?: boolean
  /** Show the host-only "Confirm this restaurant" button. Non-hosts pass false. */
  showConfirm?: boolean
  /** Confirm handler — closes the session and creates the Event. */
  onConfirm?: () => void
  /** Disable the confirm button while a close request is in flight. */
  confirming?: boolean
}

export function RankedRestaurantCard({
  rank,
  pick,
  selected,
  hasVoted,
  onVote,
  onSelect,
  showHours = false,
  showConfirm = false,
  onConfirm,
  confirming = false,
}: RankedRestaurantCardProps) {
  const reduce = useReducedMotion()
  const { restaurant } = pick
  const pct = pick.match_score != null ? Math.round(pick.match_score * 100) : null
  const priceDollars = restaurant.price_avg != null ? '$'.repeat(Math.min(4, Math.ceil(restaurant.price_avg / 15))) : ''

  // Open/closed: prefer the backend verdict (computed at the session's chosen
  // event time). Fall back to a client-side check "right now" when absent.
  const hoursText = formatHours(pick.hours ?? restaurant.hours)
  const open = pick.is_open != null ? pick.is_open : isOpenAt(restaurant.hours ?? pick.hours, new Date())

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-2 border-b border-border px-4 py-4 text-left transition-colors',
        selected ? 'border-l-2 border-l-primary bg-surface-raised' : 'hover:bg-surface-raised/50',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="pt-0.5 text-body font-semibold text-text-muted">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-display text-[15px] font-semibold text-text">{restaurant.name}</span>
            {pct != null && (
              <span className="font-display text-section-title font-bold text-primary-text">
                <AnimatedPct value={pct} />
                <span className="text-caption">%</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-caption text-text-muted">
            <span className="flex items-center gap-1">
              <Icon name="map-pin" size={11} />
              {restaurant.address?.split(',')[0]?.slice(0, 14) ?? 'nearby'}
            </span>
            <span>{priceDollars}</span>
          </div>
        </div>
      </div>

      {/* vote progress bar — fills from empty on reveal */}
      <div className="ml-6 h-1 overflow-hidden rounded-pill bg-surface-sunken">
        <motion.div
          className="h-full rounded-pill bg-primary/40"
          initial={{ width: reduce ? `${pct ?? 0}%` : 0 }}
          animate={{ width: `${pct ?? 0}%` }}
          transition={{ duration: reduce ? 0 : 0.5, ease: EASE }}
        />
      </div>

      <div className="ml-6 flex flex-wrap items-center gap-1.5">
        {restaurant.dietary_tags.slice(0, 3).map((t) => (
          <Badge key={t} tone="success">
            {t}
          </Badge>
        ))}
        {showHours && (
          <Badge tone={open ? 'success' : 'neutral'}>
            {open ? 'Open' : 'Closed'}
            {hoursText ? ` · ${hoursText}` : ''}
          </Badge>
        )}
      </div>

      {pick.justification && (
        <p className="ml-6 line-clamp-2 text-caption text-text-muted">{pick.justification}</p>
      )}

      <div className="ml-6 flex items-center justify-between">
        <span className="text-caption text-text-muted">
          {pick.voteCount} {pick.voteCount === 1 ? 'vote' : 'votes'}
        </span>
        <Button
          variant={hasVoted ? 'primary' : 'ghost'}
          size="sm"
          // tap-target: the 36px pill is unchanged; only the hit area reaches 44px.
          className="tap-target"
          leftIcon={hasVoted ? <Icon name="check" size={13} /> : undefined}
          onClick={(e) => {
            e.stopPropagation()
            onVote()
          }}
        >
          {hasVoted ? 'Voted' : 'Vote'}
        </Button>
      </div>

      {showConfirm && onConfirm && (
        <div className="ml-6">
          <Button
            fullWidth
            variant="accent"
            size="sm"
            isLoading={confirming}
            leftIcon={<Icon name="check" size={13} />}
            onClick={(e) => {
              e.stopPropagation()
              onConfirm()
            }}
          >
            Confirm this restaurant
          </Button>
        </div>
      )}
    </div>
  )
}
