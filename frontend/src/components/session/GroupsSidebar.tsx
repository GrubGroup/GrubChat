import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Icon } from '@/components/ui'
import { EASE } from '@/lib/motion'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { NewGroupModal } from '@/components/session/NewGroupModal'
import { useGroupId } from '@/hooks/useGroupId'
import { useGroupsStore } from '@/stores/groupsStore'
import { useGroupChatStore } from '@/stores/groupChatStore'
import { timeAgo } from '@/utils/timeAgo'
import { cn } from '@/utils/cn'
import type { Group } from '@/types'

// Resolve the preview line + relative time for a group's sidebar row. Prefers a
// live message from the open chat (so it updates in real time as you chat), then
// the group's last_message from the DB, then the static mock preview. System
// lines (e.g. "X has left the group") are skipped — they aren't chat previews.
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

// One sidebar row. Split out so usePreview can subscribe per-group to live chat.
function GroupRow({ group }: { group: Group }) {
  const groupId = useGroupId()
  const { preview, time } = usePreview(group)
  const selected = group.id === groupId

  return (
    <Link
      to={`/groups/${group.id}`}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[10px] p-2 text-left',
        'transition-colors duration-150 ease-out',
        selected
          ? 'border border-border bg-surface-raised'
          : 'border border-transparent hover:bg-surface-raised/60',
      )}
    >
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px] border border-border bg-surface-raised text-[15px]">
        {group.emoji}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-item-title font-semibold text-text">
            {group.name}
          </span>
          <span className="shrink-0 text-caption font-medium text-text-muted">{time}</span>
        </div>
        <p className="truncate text-caption font-medium text-text-muted">{preview}</p>
      </div>
    </Link>
  )
}

// Left column for the group-chat / agent-chat context: AppSidebar with the
// recent-groups list as its body. Clicking a group selects it as the active
// chat room; "New group" opens a name prompt and creates one (local-only).
export function GroupsSidebar() {
  const reduce = useReducedMotion()
  const navigate = useNavigate()
  const groups = useGroupsStore((s) => s.groups)
  const addGroup = useGroupsStore((s) => s.addGroup)
  const load = useGroupsStore((s) => s.load)
  // Subscribe at this level so the list re-sorts live as new messages arrive.
  const messagesByGroup = useGroupChatStore((s) => s.messagesByGroup)

  const [modalOpen, setModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)
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

  const handleCreate = async (name: string, memberIds: number[]) => {
    setCreating(true)
    try {
      const group = await addGroup(name, memberIds)
      navigate(`/groups/${group.id}`)
      setModalOpen(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <AppSidebar
      eyebrow="Groups"
      // Wider panel so the group-chat list isn't cramped (~+15% vs default w-56).
      panelWidth="w-64"
      headerAction={
        <button
          onClick={() => setModalOpen(true)}
          aria-label="New group"
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-inverse text-white transition-opacity hover:opacity-90"
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {/* Search (visual entry point; filters the list below) */}
      <div className="px-2.5 py-1.5">
        <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface-raised px-2.5 py-2">
          <span className="text-text-muted">
            <Icon name="search" size={14} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search groups"
            className="min-w-0 flex-1 bg-transparent text-caption font-medium text-text placeholder:text-text-muted focus:outline-none"
          />
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-2 pt-1">
        <AnimatePresence initial={false}>
          {visibleGroups.map((g) => (
            <motion.div
              key={g.id}
              layout={!reduce}
              initial={{ opacity: 0, y: reduce ? 0 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduce ? 0 : -4 }}
              transition={{ duration: reduce ? 0.12 : 0.2, ease: EASE }}
            >
              <GroupRow group={g} />
            </motion.div>
          ))}
        </AnimatePresence>
        {visibleGroups.length === 0 && (
          <p className="px-2 py-6 text-center text-caption text-text-muted">
            {query.trim() ? 'No groups match your search.' : 'No groups yet.'}
          </p>
        )}
      </div>

      <NewGroupModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleCreate}
        pending={creating}
      />
    </AppSidebar>
  )
}
