import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Icon } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { useGroupId } from '@/hooks/useGroupId'
import { useGroupsStore } from '@/stores/groupsStore'
import { useGroupChatStore } from '@/stores/groupChatStore'
import { timeAgo } from '@/utils/timeAgo'
import { toSlugId } from '@/utils/slug'
import { cn } from '@/utils/cn'
import type { Group } from '@/types'

// Resolve the preview line + relative time for a group's row. Prefers a live
// message from the open chat (so it updates in real time as you chat), then the
// group's last_message from the DB, then the static mock preview. System lines
// (e.g. "X has left the group") are skipped — they aren't chat previews.
function usePreview(group: Group): { preview: string; time: string } {
  const live = useGroupChatStore((s) => s.messagesByGroup[group.id])
  const latest = live?.findLast((m) => m.type !== 'system')
  if (latest) {
    const who = latest.name ? `${latest.name}: ` : ''
    return { preview: `${who}${latest.text}`, time: timeAgo(latest.at) }
  }
  if (group.last_message) {
    const who = group.last_message.name ? `${group.last_message.name}: ` : ''
    return { preview: `${who}${group.last_message.text}`, time: timeAgo(group.last_message.at) }
  }
  return { preview: group.preview ?? 'No messages yet', time: group.time ?? '' }
}

// A group's last-activity time (epoch ms), matching usePreview's precedence:
// newest non-system live message → DB last_message → 0 (message-less sink last).
function lastActivity(
  group: Group,
  messagesByGroup: Record<number, { at: string; type?: string }[]>,
): number {
  const live = messagesByGroup[group.id]
  const at = live?.findLast((m) => m.type !== 'system')?.at ?? group.last_message?.at
  const ms = at ? new Date(at).getTime() : 0
  return Number.isNaN(ms) ? 0 : ms
}

// One list row. Split out so usePreview can subscribe per-group to live chat.
// `divider` renders the between-rows hairline; it's suppressed on the selected row
// and the row directly above it, so the selected card's rounded border floats
// cleanly instead of colliding with a stray straight line.
function GroupRow({ group, divider }: { group: Group; divider: boolean }) {
  const groupId = useGroupId()
  const { preview, time } = usePreview(group)
  const selected = group.id === groupId

  return (
    <Link
      to={`/groups/${toSlugId(group.name, group.id)}`}
      className={cn(
        // min-h-14 keeps the row a comfortable touch target on a phone without
        // changing its desktop look (content already renders ~50px tall).
        'relative flex min-h-16 w-full items-center gap-3 rounded-[10px] p-2.5 text-left md:min-h-14 md:gap-2.5 md:p-2',
        'transition-colors duration-150 ease-out',
        // Inset hairline pinned to the row's bottom edge — its right end stops at the
        // corner-radius tangent (right-2.5 == the rounded box's 10px radius) so it
        // lines up exactly with where the hover/selected box's edge curves in, and it
        // starts after the emoji tile (left-14 / md:left-13). Only shown between two
        // unselected rows (see `divider`) so it never butts against the selected card.
        divider &&
          'after:pointer-events-none after:absolute after:bottom-0 after:left-14 after:right-2.5 after:h-px after:bg-border after:content-[""] md:after:left-13 md:after:right-2',
        selected
          ? 'border border-border bg-surface-raised'
          : 'border border-transparent hover:bg-surface-raised/60',
      )}
    >
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px] border border-border bg-surface-raised text-text-muted">
        <Icon name="message" size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 md:gap-px">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-section-title font-semibold text-text md:text-item-title">
            {group.name}
          </span>
          <span className="shrink-0 text-body font-medium text-text-muted md:text-caption">{time}</span>
        </div>
        <p className="truncate text-body font-medium text-text-muted md:text-caption">{preview}</p>
      </div>
    </Link>
  )
}

// The recent-groups list: search box + live-sorted rows. Deliberately chrome-free
// so the SAME list serves both hosts — the desktop sidebar panel and the mobile
// Groups tab root — with no duplication. Picking a row selects the group and
// opens its chat, which below `md` is a pushed screen over this list.
export function GroupList() {
  const reduce = useReducedMotion()
  const groupId = useGroupId()
  const groups = useGroupsStore((s) => s.groups)
  const load = useGroupsStore((s) => s.load)
  // Subscribe at this level so the list re-sorts live as new messages arrive.
  const messagesByGroup = useGroupChatStore((s) => s.messagesByGroup)

  const [query, setQuery] = useState('')

  // Newest activity first (WhatsApp-style); sort a copy, never the store array.
  const sortedGroups = [...groups].sort(
    (a, b) => lastActivity(b, messagesByGroup) - lastActivity(a, messagesByGroup),
  )

  // Client-side name filter for the search box (purely presentational).
  const q = query.trim().toLowerCase()
  const visibleGroups = q
    ? sortedGroups.filter((g) => g.name.toLowerCase().includes(q))
    : sortedGroups

  // Load the real group list (with last messages) on mount. No-op in mock mode.
  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      {/* Search (visual entry point; filters the list below). MOBILE matches the
          Explore search field — `h-9`, `text-body`, darker `surface-sunken` fill,
          `/75` placeholder, and `pt-3.5` breathing it off the header. The `md:`
          variants restore the ORIGINAL desktop sidebar bar exactly: compact
          `text-caption`, `py-2`, lighter `surface-raised`, tighter `pt-1.5`. */}
      <div className="px-2.5 pb-1.5 pt-3.5 md:pt-1.5">
        <div className="flex h-9 items-center gap-2 rounded-[10px] border border-border bg-surface-sunken px-3 md:h-auto md:bg-surface-raised md:px-2.5 md:py-2">
          <span className="text-text-muted">
            <Icon name="search" size={14} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search groups"
            className="min-w-0 flex-1 bg-transparent text-body font-medium text-text placeholder:text-text-muted/75 focus:outline-none md:text-caption md:placeholder:text-text-muted"
          />
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-2 pt-1">
        <AnimatePresence initial={false}>
          {visibleGroups.map((g, i) => {
            // Show the divider only BETWEEN two unselected rows: hide it on the last
            // row, on the selected row, and on the row right above the selected one
            // (so the selected card's rounded border never collides with a hairline).
            const next = visibleGroups[i + 1]
            const divider =
              i < visibleGroups.length - 1 &&
              g.id !== groupId &&
              next?.id !== groupId
            return (
              <motion.div
                key={g.id}
                layout={!reduce}
                initial={{ opacity: 0, y: reduce ? 0 : -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduce ? 0 : -4 }}
                transition={{ duration: reduce ? 0.12 : 0.2, ease: EASE }}
              >
                <GroupRow group={g} divider={divider} />
              </motion.div>
            )
          })}
        </AnimatePresence>
        {visibleGroups.length === 0 && (
          <p className="px-2 py-6 text-center text-caption text-text-muted">
            {query.trim() ? 'No groups match your search.' : 'No groups yet.'}
          </p>
        )}
      </div>
    </>
  )
}
