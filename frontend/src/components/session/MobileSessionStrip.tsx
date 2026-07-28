import { useState } from 'react'
import { Icon, Modal } from '@/components/ui'
import { GroupProgressPanel } from './GroupProgressPanel'
import { NotedSoFarPanel } from './NotedSoFarPanel'
import { SessionTimer } from './SessionTimer'
import {
  useSessionStore,
  selectSession,
  selectActiveSessionId,
  selectStartedAt,
} from '@/stores/sessionStore'

export interface MobileSessionStripProps {
  /** The group whose session to reflect (session state is keyed by group). */
  groupId: number
}

// Below `md`, the agent chat's two side surfaces — the full-width SessionTopBar
// and the w-60 right aside (progress + roster + "Noted so far") — collapse into
// THIS one strip: label, live countdown, N/total, and a chevron that opens the
// aside's content as a sheet. One row instead of two bars plus a column, so the
// conversation keeps the screen.
export function MobileSessionStrip({ groupId }: MobileSessionStripProps) {
  const session = useSessionStore(selectSession(groupId))
  const activeSessionId = useSessionStore(selectActiveSessionId(groupId))
  const startedAt = useSessionStore(selectStartedAt(groupId))
  const triggerExpiryGeneration = useSessionStore((s) => s.triggerExpiryGeneration)

  const [open, setOpen] = useState(false)

  if (activeSessionId == null || session == null) return null

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="flex w-full shrink-0 items-center gap-2 border-b border-border bg-surface-panel px-4 py-2 text-left md:hidden"
      >
        {/* headerOnly = the "Group progress N/total" line + segmented bar, the
            same header the desktop aside shows — no roster, no duplication. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <GroupProgressPanel headerOnly groupId={groupId} />
        </div>
        <SessionTimer
          startedAt={startedAt}
          minutes={session.time_limit}
          onExpire={() => void triggerExpiryGeneration(groupId)}
        />
        <span className="text-text-muted">
          <Icon name="chevron-up" size={16} />
        </span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Session details"
        variant="sheet"
        size="md"
      >
        <div className="flex flex-col gap-5">
          <GroupProgressPanel groupId={groupId} />
          <NotedSoFarPanel groupId={groupId} />
        </div>
      </Modal>
    </>
  )
}
