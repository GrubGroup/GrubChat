import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Avatar, Button, Icon, IconButton, Input, Modal, SkeletonRow, Spinner } from '@/components/ui'
import { COLUMN_HEADER_H } from '@/components/layout/AppSidebar'
import { fetchGroup, addGroupMember } from '@/api/groupsApi'
import { searchUsers } from '@/api/usersApi'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useGroupsStore } from '@/stores/groupsStore'
import { useSessionStore, selectIsHost, selectSession } from '@/stores/sessionStore'
import { memberColor } from '@/constants/memberColors'
import { cn } from '@/utils/cn'
import { nameForMember } from '@/utils/memberName'
import type { GroupDetail, UserSearchResult } from '@/types'
import { isAxiosError } from 'axios'

export interface GroupDetailPanelProps {
  open: boolean
  groupId: number
  currentUserId: number
  onClose: () => void
  // Called after a member is successfully added, so the parent can refresh
  // sidebar previews / header counts.
  onMembersChanged?: () => void
  // Called after the current user leaves the group, so the parent can navigate
  // away from the now-inaccessible chat.
  onLeft?: () => void
}

const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY_LENGTH = 2

// Format an ISO date as e.g. "Jul 2". Deterministic given the input.
function formatCreated(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Right-side slide-in panel showing a group's members, with an "Add people" row
// that expands into a username search, and a "Leave group" action. Members are
// loaded fresh from the gateway each time the panel opens; adds/leaves are
// immediate (the group already exists).
export function GroupDetailPanel({
  open,
  groupId,
  currentUserId,
  onClose,
  onMembersChanged,
  onLeft,
}: GroupDetailPanelProps) {
  const leaveGroup = useGroupsStore((s) => s.leaveGroup)
  const reduce = useReducedMotion()
  // Below md the width-squeeze column would crush the chat, so render a sheet.
  const isMobile = useIsMobile()

  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [adding, setAdding] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const [showHostLock, setShowHostLock] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Block the host from leaving while their session is still open. The session
  // is "ended" only once the restaurant is confirmed (closed_at set, via the
  // session:confirmed socket → sessionStore.close()), after which this lifts.
  const isHost = useSessionStore(selectIsHost(groupId))
  const session = useSessionStore(selectSession(groupId))
  const hostLocked = isHost && session != null && session.closed_at == null

  // Add-people search state (the row expands into these).
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch detail when the panel opens. setState lives in the async .then
  // callback (not synchronously in the effect body), and detail === null renders
  // the loading spinner. The parent keys this component by groupId, so switching
  // groups remounts with fresh (null) state.
  useEffect(() => {
    if (!open) return
    fetchGroup(groupId)
      .then(setDetail)
      .catch(() => setDetail(null))
  }, [open, groupId])

  // Reload the member list after an add.
  const refresh = async () => {
    const next = await fetchGroup(groupId).catch(() => null)
    setDetail(next)
  }

  // Escape-to-close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const resetSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSearchOpen(false)
    setQuery('')
    setResults([])
    setSearching(false)
    setError(null)
  }

  const handleClose = () => {
    resetSearch()
    onClose()
  }

  const handleQueryChange = (value: string) => {
    setQuery(value)
    setError(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = value.trim()
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        setResults(await searchUsers(q))
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)
  }

  const memberIds = new Set(detail?.members.map((m) => m.user_id) ?? [])
  const visibleResults = results.filter((u) => !memberIds.has(u.id))

  const handleAdd = async (user: UserSearchResult) => {
    setAdding(true)
    setError(null)
    try {
      await addGroupMember(groupId, { user_id: user.id })
      setQuery('')
      setResults([])
      await refresh()
      onMembersChanged?.()
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined
      if (status === 409) setError('That user is already a member.')
      else if (status === 404) setError('No user found.')
      else if (status === 403) setError("You're not a member of this group.")
      else setError('Could not add member. Try again.')
    } finally {
      setAdding(false)
    }
  }

  const handleLeave = async () => {
    // Never let the host abandon an open session, even if this is reached
    // outside the button's own guard.
    if (hostLocked) {
      setConfirmingLeave(false)
      setShowHostLock(true)
      return
    }
    setLeaving(true)
    setError(null)
    try {
      await leaveGroup(groupId, currentUserId)
      setConfirmingLeave(false)
      onLeft?.()
    } catch {
      setError('Could not leave the group. Try again.')
      setConfirmingLeave(false)
    } finally {
      // Reset on BOTH paths. On success the panel usually unmounts via the
      // redirect (making this a no-op), but if it lingers for any reason the
      // button must not stay stuck spinning — that was half of the "leaving
      // hangs forever" bug.
      setLeaving(false)
    }
  }

  const members = detail?.members ?? []
  const created = formatCreated(detail?.created_at)

  // The scrolling body, hosted two ways: the in-flow desktop column below, or the
  // mobile sheet. Extracted so both hosts render the SAME markup and state — the
  // add-people search and member list are never duplicated.
  const body = (
    <>
          {/* Group identity: emoji avatar, name, count + created date */}
          <div className="flex flex-col items-center gap-2.5 border-b border-border bg-surface-panel px-5 py-7 text-center">
            <span className="flex h-20 w-20 items-center justify-center rounded-pill bg-surface-raised text-text-muted shadow-sm ring-1 ring-border-strong">
              <Icon name="message" size={34} />
            </span>
            <p className="font-display text-panel-title font-bold text-text">{detail?.name ?? 'Group'}</p>
            <p className="text-caption text-text-muted">
              <span className="font-semibold text-primary-text">{members.length}</span>{' '}
              {members.length === 1 ? 'member' : 'members'}
              {created && ` · Created ${created}`}
            </p>
          </div>

          {/* Members */}
          <div className="flex flex-col px-5 py-4">
            <div className="flex items-center justify-between">
              <p className="text-overline font-semibold uppercase tracking-wide text-text-subtle">Members</p>
              <span className="rounded-pill bg-surface-sunken px-2 py-0.5 text-caption font-medium text-text-muted">
                {members.length}
              </span>
            </div>

            {/* Add people row → expands into search */}
            {!searchOpen ? (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="group mt-3 flex items-center gap-3 text-left"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-pill border border-dashed border-border-strong text-text-muted transition-colors group-hover:border-primary/50 group-hover:text-primary-text">
                  <Icon name="plus" size={16} />
                </span>
                <span className="text-body font-medium text-text transition-colors group-hover:text-primary-text">
                  Add people
                </span>
              </button>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                <Input
                  inputSize="sm"
                  placeholder="Search by username"
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  leftIcon={
                    <span className="text-primary-text">
                      <Icon name="search" size={14} />
                    </span>
                  }
                  error={error ?? undefined}
                  autoFocus
                />
                {query.trim().length >= MIN_QUERY_LENGTH && (
                  <div className="max-h-52 overflow-y-auto rounded-input border border-border bg-surface-raised shadow-sm">
                    {searching ? (
                      <div className="py-1">
                        <SkeletonRow />
                        <SkeletonRow />
                      </div>
                    ) : visibleResults.length === 0 ? (
                      <p className="py-4 text-center text-body text-text-muted">No users found.</p>
                    ) : (
                      visibleResults.map((u) => (
                        <button
                          key={u.id}
                          type="button"
                          disabled={adding}
                          onClick={() => handleAdd(u)}
                          className={cn(
                            'group flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0',
                            'transition-colors hover:bg-surface-sunken disabled:opacity-50',
                          )}
                        >
                          <Avatar
                            name={u.display_name ?? u.username}
                            src={u.avatar_url}
                            size="sm"
                            colorClass={memberColor(u.id)}
                          />
                          <div className="min-w-0 flex-1">
                            {u.display_name && (
                              <p className="truncate text-body font-semibold text-text">{u.display_name}</p>
                            )}
                            <p className="truncate text-caption text-text-muted">@{u.username}</p>
                          </div>
                          <span className="text-text-subtle transition-colors group-hover:text-primary-text">
                            <Icon name="plus" size={14} />
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
                <button
                  type="button"
                  onClick={resetSearch}
                  className="self-start text-caption text-text-muted hover:text-text"
                >
                  Done
                </button>
              </div>
            )}

            {/* Member rows */}
            <div className="mt-1 flex flex-col">
              {detail === null ? (
                <div className="flex items-center justify-center py-6 text-text-muted">
                  <Spinner size="sm" />
                </div>
              ) : members.length === 0 ? (
                <p className="py-4 text-body text-text-muted">No members yet.</p>
              ) : (
                <AnimatePresence initial={false}>
                  {members.map((m) => {
                    const name = m.display_name ?? nameForMember(m.user_id)
                    const isYou = m.user_id === currentUserId
                    return (
                      <motion.div
                        key={m.user_id}
                        layout={!reduce}
                        initial={{ opacity: 0, scale: reduce ? 1 : 0.6, y: reduce ? 0 : 6 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: reduce ? 1 : 0.6 }}
                        transition={
                          reduce ? { duration: 0.15 } : { type: 'spring', stiffness: 480, damping: 30 }
                        }
                        className="flex items-center gap-3 py-2.5"
                      >
                        <Avatar name={name} src={m.avatar_url} size="md" colorClass={memberColor(m.user_id)} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body font-semibold text-text">{name}</p>
                          {isYou ? (
                            <p className="text-caption font-semibold text-primary-text">You</p>
                          ) : (
                            <p className="text-caption text-text-muted">Member</p>
                          )}
                        </div>
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
              )}
            </div>
          </div>
    </>
  )

  const leaveButton = (
    <button
      type="button"
      onClick={() => (hostLocked ? setShowHostLock(true) : setConfirmingLeave(true))}
      className={cn(
        // h-11 matches the composer bar's controls across the divider, so the two
        // bottom bars read as one aligned row rather than two mismatched footers.
        'flex h-11 w-full items-center justify-center gap-2 rounded-input bg-error/10',
        'text-body font-semibold text-error-text hover:bg-error/15',
      )}
    >
      <Icon name="logout" size={16} />
      Leave group
    </button>
  )

  return (
    <>
    {/* DESKTOP (≥md): non-blocking side panel — an in-flow flex item whose width
        animates from 0 to w-80. The chat area (flex-1) reflows and shrinks in the
        same frames, so it reads as a responsive layout shift rather than a modal
        overlay — no backdrop, no page dimming, the rest of the UI stays
        interactive. Kept mounted (width 0 when closed) so the exit animation
        plays. Hidden below md: at 390px that same width squeeze would crush the
        chat to nothing, so the sheet below takes over. */}
    <div
      className={cn(
        'hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out md:block',
        // Proportional (not a fixed w-80): clamp between 15rem and 20rem, tracking
        // 24vw so a narrower window shrinks the panel and leaves the chat room —
        // which is what stops the header buttons from being squeezed into wrapping.
        open ? 'w-[clamp(15rem,24vw,20rem)]' : 'w-0',
      )}
      aria-hidden={!open}
      inert={!open}
    >
      <aside
        aria-label="Group details"
        // Same clamp as the open-state container so the content keeps a stable
        // width while the outer element clips it open/closed (the reveal animation).
        className="flex h-full w-[clamp(15rem,24vw,20rem)] flex-col border-l border-border bg-surface-raised"
      >
        {/* Header — same height as the chat/sidebar headers so borders line up */}
        <div
          className={cn(
            'flex items-center justify-between border-b border-border px-5',
            COLUMN_HEADER_H,
          )}
        >
          <h2 className="font-display text-section-title font-semibold text-text">Group details</h2>
          <IconButton label="Close" size="sm" icon={<Icon name="x" size={14} />} onClick={handleClose} />
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto">{body}</div>

        {/* Leave group — same px-4/pt-3/pb-3 as the chat composer bar so the two
            bottom bars are the same height and their top borders line up. */}
        <div className="border-t border-border px-4 pb-3 pt-3">{leaveButton}</div>
      </aside>
    </div>

    {/* MOBILE (<md): the same content as a bottom sheet. Modal handles the
        backdrop, Escape, scroll lock and the OS back gesture. Gated in JS rather
        than with `md:hidden` because those are BEHAVIOURS — a display:none Modal
        would still lock scroll and park a history entry on desktop. */}
    {isMobile && (
      <Modal
        open={open}
        onClose={handleClose}
        title="Group details"
        variant="sheet"
        size="md"
        footer={leaveButton}
      >
        {/* -mx-5 -mt-5 cancels Modal's body padding so the identity hero keeps its
            full-bleed panel background, as it does in the desktop column. */}
        <div className="-mx-5 -mt-5 flex flex-col">{body}</div>
      </Modal>
    )}

    {/* Leave confirmation — a sibling, so its clicks don't bubble into
        handleClose. */}
    <Modal
      open={confirmingLeave}
      onClose={() => (leaving ? undefined : setConfirmingLeave(false))}
      title="Leave group?"
      size="sm"
    >
      <div className="flex flex-col gap-5">
        <p className="text-body text-text-muted">
          You'll be removed from <span className="font-semibold text-text">{detail?.name ?? 'this group'}</span>{' '}
          and stop receiving its messages. You can be added back by another member.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmingLeave(false)} disabled={leaving}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleLeave} isLoading={leaving}>
            Leave group
          </Button>
        </div>
      </div>
    </Modal>

    {/* Host guard — shown instead of leaving while this user hosts an open
        session. Dismissing only closes the notice; it never leaves the group. */}
    <Modal
      open={showHostLock}
      onClose={() => setShowHostLock(false)}
      title="You're hosting this session"
      size="sm"
    >
      <div className="flex flex-col gap-5">
        <p className="text-body text-text-muted">
          You're the host of the current session and can't leave this group until you end it.
          Confirm a restaurant (or force-finish) to close the session, then you can leave.
        </p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => setShowHostLock(false)}>
            Back to session
          </Button>
        </div>
      </div>
    </Modal>
    </>
  )
}
