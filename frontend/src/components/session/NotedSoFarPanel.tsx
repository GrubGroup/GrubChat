import { useMemo, useState } from 'react'
import { Icon } from '@/components/ui'
import {
  useChatStore,
  selectCurrentSignals,
  selectDisplayPreferredCuisines,
  selectDisplayDislikedCuisines,
  selectMissingSignals,
  selectChatMessages,
} from '@/stores/chatStore'
import { useSessionStore, selectIsHost } from '@/stores/sessionStore'

// How many cuisine tags to show before collapsing behind a "+N more" toggle. A
// broad answer ("Asian") is intentionally shown EXPANDED into its member cuisines
// (chinese, japanese, ...) so the diner sees what the group covers — the same set
// the orchestrator ranks on — and the toggle keeps that ~20-tag list from
// overflowing the panel.
const TAG_LIMIT = 6

// A row is one of three states:
//   pending   — not reached/answered yet (hollow dot, "· pending")
//   confirmed — the user gave a value (check + the captured tags/value)
//   none      — the user reached the question and expressed NO preference of
//               their own ("anything works" / "no budget" / "no location
//               change") — they're happy with the group's. Check + "None".
type RowState = 'pending' | 'confirmed' | 'none'

// One captured-preference row, keyed to a backend ask-order signal so its
// state tracks `missing_signals` exactly.
interface NotedRow {
  key: string
  label: string
  // The chip contents: either a set of tags (collapsible) or a single value.
  tags?: string[]
  value?: string
  state: RowState
}

const pretty = (tag: string) => tag.replace(/_/g, ' ')

// Collapsible list of tag pills. Shows the first `TAG_LIMIT` and a "+N more"
// button that expands in place, so a long preference list stays readable.
function TagPills({ tags }: { tags: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const overflow = tags.length - TAG_LIMIT
  const shown = expanded ? tags : tags.slice(0, TAG_LIMIT)
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((t) => (
        <span
          key={t}
          className="rounded-pill bg-surface-sunken px-2 py-0.5 text-[11px] capitalize text-text"
        >
          {pretty(t)}
        </span>
      ))}
      {overflow > 0 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          // tap-target: the pill stays its small size, the hit area reaches 44px.
          className="tap-target rounded-pill px-2 py-0.5 text-[11px] font-medium text-primary-text hover:bg-surface-sunken"
        >
          {expanded ? 'show less' : `+${overflow} more`}
        </button>
      )}
    </div>
  )
}

// "Noted so far" — the current user's captured Qa preferences, mirrored live from
// the analyze round-trip (chatStore.currentSignals). Every field the agent asks
// about is shown as a row whose state tracks the agent: pending (hollow dot)
// until reached, then either confirmed (check + value) once captured, or "None"
// (check) when the user reached it and expressed no preference of their own — a
// field the agent has stopped asking about (dropped from missing_signals) but
// that stayed empty because the user is happy with the group's choice. The host
// never sees a "Your spot" row (they set the group location in the pre-session
// modal); a non-host does. Long cuisine lists collapse behind a "+N more" toggle.
export interface NotedSoFarPanelProps {
  /** The group whose captured preferences to render (state is keyed by group). */
  groupId: number
}

export function NotedSoFarPanel({ groupId }: NotedSoFarPanelProps) {
  const signals = useChatStore(selectCurrentSignals(groupId))
  // Cuisine CHIPS render the expanded members (asian -> chinese, japanese, ...);
  // `signals` (compact) is still used for the pending/None/confirmed state logic
  // and the non-cuisine rows (budget, location, dietary).
  const displayPreferred = useChatStore(selectDisplayPreferredCuisines(groupId))
  const displayDisliked = useChatStore(selectDisplayDislikedCuisines(groupId))
  const missing = useChatStore(selectMissingSignals(groupId))
  // Whether the user has taken at least one turn. Before that, an empty +
  // not-missing field is "pending" (not yet reached), NOT "None" — the greeting
  // hasn't asked anything and missing_signals is still empty.
  const messages = useChatStore(selectChatMessages(groupId))
  const hasAnswered = messages.some((m) => m.role === 'user')
  const isHost = useSessionStore(selectIsHost(groupId))

  const rows = useMemo<NotedRow[]>(() => {
    const isMissing = (key: string) => missing.includes(key)
    // Resolve a row's state from whether it has content and whether the agent
    // still lists it as missing. An empty field the agent has moved past (not in
    // missing_signals) after a real turn means the user answered "no preference".
    const resolve = (key: string, hasContent: boolean): RowState => {
      if (hasContent) return 'confirmed'
      if (hasAnswered && !isMissing(key)) return 'none'
      return 'pending'
    }
    const out: NotedRow[] = []

    // Dietary is captured in onboarding (durable Profile), not this chat — show it
    // only if the member volunteered one, and always as confirmed.
    if (signals.dietary_restrictions.length) {
      out.push({
        key: 'dietary_restrictions',
        label: 'Dietary',
        tags: signals.dietary_restrictions,
        state: 'confirmed',
      })
    }

    // Chips show the EXPANDED members (displayPreferred/Disliked); the row state
    // keys off the compact `signals` list, which is empty/non-empty in lockstep
    // with the expanded one, so completion tracking is unchanged.
    out.push({
      key: 'preferred_cuisines',
      label: 'Likes',
      tags: displayPreferred,
      state: resolve('preferred_cuisines', signals.preferred_cuisines.length > 0),
    })
    out.push({
      key: 'disliked_cuisines',
      label: 'Avoids',
      tags: displayDisliked,
      state: resolve('disliked_cuisines', signals.disliked_cuisines.length > 0),
    })

    const { budget_min: bmin, budget_max: bmax } = signals
    // Price range only — no "pp"/per-person suffix.
    const budgetValue =
      bmin != null && bmax != null
        ? `$${bmin}–${bmax}`
        : bmax != null
          ? `Up to $${bmax}`
          : bmin != null
            ? `From $${bmin}`
            : ''
    out.push({
      key: 'budget',
      label: 'Budget',
      value: budgetValue,
      state: resolve('budget', budgetValue !== ''),
    })

    // "Your spot" is a non-host-only question (the host set the group location up
    // front). Only show the row for a non-host.
    if (!isHost) {
      out.push({
        key: 'location',
        label: 'Your spot',
        value: signals.location_label ?? '',
        state: resolve('location', !!signals.location_label),
      })
    }

    return out
  }, [signals, displayPreferred, displayDisliked, missing, hasAnswered, isHost])

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-overline font-semibold uppercase tracking-wide text-text-muted">
        Noted so far
      </h3>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => {
          // A row shows its captured value only when confirmed with content.
          const hasContent = row.state === 'confirmed' && (row.tags ? row.tags.length > 0 : row.value !== '')
          const done = row.state === 'confirmed' || row.state === 'none'
          return (
            <li
              key={row.key}
              className={
                hasContent
                  ? 'flex flex-col gap-1 rounded-input bg-surface-raised px-2.5 py-2 text-caption text-text'
                  : 'flex items-center gap-2 rounded-input px-2.5 py-2 text-caption text-text-subtle'
              }
            >
              <span className="flex items-center gap-2">
                <span className={done ? 'text-success-text' : 'text-text-subtle'}>
                  <Icon name={done ? 'check' : 'circle'} size={14} />
                </span>
                <span className="font-medium">{row.label}</span>
                {/* "None" for a reached-but-no-preference field; "pending" for one
                    not yet reached. Confirmed rows show their value below instead. */}
                {row.state === 'none' && <span className="text-text-muted">· None</span>}
                {row.state === 'pending' && <span className="text-text-subtle">· pending</span>}
              </span>
              {hasContent &&
                (row.tags ? (
                  <div className="pl-6">
                    <TagPills tags={row.tags} />
                  </div>
                ) : (
                  <span className="pl-6 text-text-muted">{row.value}</span>
                ))}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
