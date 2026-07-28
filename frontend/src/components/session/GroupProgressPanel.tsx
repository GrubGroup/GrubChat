import { MemberRoster } from './MemberRoster'
import { SegmentedProgress } from './SegmentedProgress'
import {
  useSessionStore,
  selectMembers,
  selectDoneCount,
  selectProgressTotal,
} from '@/stores/sessionStore'

export interface GroupProgressPanelProps {
  /** The group whose session progress to render (session state is keyed by group). */
  groupId: number
  /** Render only the header band (title + count + segmented bar). */
  headerOnly?: boolean
  /** Render only the member roster. */
  rosterOnly?: boolean
}

// Right-panel content: "Group progress N/total" + segmented bar (header) and the
// member roster (body). Split via props so the header can align to the shared
// column header height while the roster scrolls below it.
export function GroupProgressPanel({ groupId, headerOnly, rosterOnly }: GroupProgressPanelProps) {
  const members = useSessionStore(selectMembers(groupId))
  // currentUserId is GLOBAL identity, not per-group.
  const currentUserId = useSessionStore((s) => s.currentUserId)
  const doneCount = useSessionStore(selectDoneCount(groupId))
  // Prefer the server-authoritative total so the denominator is correct even
  // before this client's roster has fully loaded (or after a reload).
  const total = useSessionStore(selectProgressTotal(groupId))

  if (rosterOnly) {
    return <MemberRoster members={members} currentUserId={currentUserId} />
  }

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-caption font-semibold text-text">Group progress</span>
        <span className="text-caption font-semibold text-text-muted">
          {doneCount}/{total}
        </span>
      </div>
      <SegmentedProgress value={doneCount} total={total} />
    </div>
  )

  if (headerOnly) return header

  // Full (fallback): header + roster.
  return (
    <div className="flex flex-col gap-3">
      {header}
      <MemberRoster members={members} currentUserId={currentUserId} />
    </div>
  )
}
