import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { SessionMember } from '@/types'
import { Avatar, Icon } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { memberColor } from '@/constants/memberColors'
import { nameForMember } from '@/utils/memberName'

export interface MemberRosterProps {
  members: SessionMember[]
  currentUserId: number
}

// Roster of session members with per-member identity color + ready/chatting status.
export function MemberRoster({ members, currentUserId }: MemberRosterProps) {
  const reduce = useReducedMotion()
  return (
    <ul className="flex flex-col gap-2">
      {members.map((m) => {
        const name = nameForMember(m.user_id, members)
        const isYou = m.user_id === currentUserId
        return (
          <li key={m.user_id} className="flex items-center gap-2">
            <Avatar name={name} src={m.avatar_url} size="sm" colorClass={memberColor(m.user_id)} />
            <span className="flex-1 text-body text-text">{isYou ? name : name}</span>
            {/* Crossfade the "marked ready" moment instead of hard-swapping. */}
            <AnimatePresence mode="wait" initial={false}>
              {m.status ? (
                <motion.span
                  key="ready"
                  aria-label="ready"
                  className="text-success-text"
                  initial={{ scale: reduce ? 1 : 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                >
                  <Icon name="check" size={14} />
                </motion.span>
              ) : (
                <motion.span
                  key="chatting"
                  className="text-caption text-text-muted"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                >
                  chatting
                </motion.span>
              )}
            </AnimatePresence>
          </li>
        )
      })}
    </ul>
  )
}
