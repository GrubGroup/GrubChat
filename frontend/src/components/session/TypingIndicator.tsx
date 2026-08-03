import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { SessionMember } from '@/types'
import type { Typer } from '@/stores/groupChatStore'
import { Avatar } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { memberColor } from '@/constants/memberColors'
import { nameForMember } from '@/utils/memberName'

export interface TypingIndicatorProps {
  typers: Typer[]
  /** Session roster, so a typer's name resolves to their real display name. */
  members?: SessionMember[]
}

// Drop typers whose last signal is older than this (safety net for a missed
// typing:stop — e.g. the other tab closed mid-type).
const EXPIRY_MS = 3000

// Max avatars to stack before collapsing the rest into a "+N" chip. Groups cap
// at 8 members, so 4 avatars + "+N" covers the fullest case cleanly.
const MAX_AVATARS = 4

// The socket carries the typer's name; fall back to the roster resolver by id.
function displayName(t: Typer, members?: SessionMember[]): string {
  return t.name ?? nameForMember(t.userId, members)
}

// Prefer the avatar carried on the typing broadcast (works even when the typer
// isn't in the session roster, e.g. a plain group-chat typer); fall back to the
// roster by id. Null → the Avatar shows colored initials.
function avatarForTyper(t: Typer, members?: SessionMember[]): string | null {
  return t.avatarUrl ?? members?.find((m) => m.user_id === t.userId)?.avatar_url ?? null
}

// A single merged "typing" bubble: stacked avatars of everyone currently typing
// (no names) followed by animated dots. One bubble regardless of how many people
// are typing.
export function TypingIndicator({ typers, members }: TypingIndicatorProps) {
  const reduce = useReducedMotion()
  // Prune expired typers on a 1s tick so they disappear even without new events.
  // The clock is read in the effect (never during render) and the result is held
  // in state, so this component stays pure — reading Date.now() while rendering
  // would make the output depend on when React happened to re-render.
  const [active, setActive] = useState<Typer[]>([])
  useEffect(() => {
    const prune = () => setActive(typers.filter((t) => Date.now() - t.at < EXPIRY_MS))
    prune()
    if (typers.length === 0) return
    const id = setInterval(prune, 1000)
    return () => clearInterval(id)
  }, [typers])

  const shown = active.slice(0, MAX_AVATARS)
  const overflow = active.length - shown.length

  // AnimatePresence stays mounted; the bubble fades/slides in and out as typing
  // starts/stops instead of snapping. (The 3 dots keep their CSS bounce.)
  return (
    <AnimatePresence initial={false}>
      {active.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : 6 }}
          transition={{ duration: reduce ? 0.15 : 0.22, ease: EASE }}
          className="flex items-center gap-2.5 px-5 pb-1 pt-1"
        >
          {/* Stacked avatars of everyone typing (capped, with a +N overflow chip) */}
          <div className="flex -space-x-1.5">
            {shown.map((t) => (
              <Avatar
                key={t.userId ?? displayName(t, members)}
                name={displayName(t, members)}
                src={avatarForTyper(t, members)}
                size="sm"
                colorClass={memberColor(t.userId ?? -1)}
                className="border border-surface-raised"
              />
            ))}
            {overflow > 0 && (
              <span className="flex h-8 w-8 items-center justify-center rounded-pill border border-surface-raised bg-surface-sunken text-caption font-medium text-text-muted">
                +{overflow}
              </span>
            )}
          </div>

          {/* One dots bubble */}
          <div className="w-fit rounded-2xl rounded-tl-md bg-surface-sunken px-3.5 py-2.5">
            <span className="flex items-center gap-1" aria-hidden="true">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="h-1.5 w-1.5 animate-bounce rounded-pill bg-text-muted"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
