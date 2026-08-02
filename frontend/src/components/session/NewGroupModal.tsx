import { useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Avatar, Button, Icon, Input, Modal, SkeletonRow, Spinner } from '@/components/ui'
import { searchUsers } from '@/api/usersApi'
import { memberColor } from '@/utils/memberColor'
import { cn } from '@/utils/cn'
import type { UserSearchResult } from '@/types'

export interface NewGroupModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (name: string, memberIds: number[]) => void
  pending?: boolean
}

const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY_LENGTH = 2

// Instagram-style group creation: name the group, search users by username, add
// them as removable chips, then create with the whole roster at once. At least
// one other member is required (the caller is added server-side).
export function NewGroupModal({ open, onClose, onSubmit, pending = false }: NewGroupModalProps) {
  const reduce = useReducedMotion()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserSearchResult[]>([])
  const [selected, setSelected] = useState<UserSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resetAndClose = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setName('')
    setQuery('')
    setResults([])
    setSelected([])
    setSearching(false)
    onClose()
  }

  // Debounced username search, driven from the input's onChange (not an effect,
  // so state updates stay event-scoped). Results exclude selected users below.
  const handleQueryChange = (value: string) => {
    setQuery(value)
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

  const selectedIds = new Set(selected.map((u) => u.id))
  const visibleResults = results.filter((u) => !selectedIds.has(u.id))

  const addMember = (user: UserSearchResult) => {
    setSelected((s) => [...s, user])
    setQuery('')
    setResults([])
  }

  const removeMember = (id: number) => {
    setSelected((s) => s.filter((u) => u.id !== id))
  }

  const canCreate = name.trim().length > 0 && selected.length >= 1 && !pending

  const submit = () => {
    if (!canCreate) return
    onSubmit(
      name.trim(),
      selected.map((u) => u.id),
    )
  }

  return (
    <Modal open={open} onClose={resetAndClose} title="New group" size="sm">
      <div className="flex flex-col gap-4">
        <Input
          label="Group name"
          placeholder="e.g. Weekend Trip"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="flex flex-col gap-2">
          <Input
            label="Add members"
            placeholder="Search by username"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            leftIcon={<Icon name="search" size={16} />}
          />

          {/* Selected members as removable chips — each pops in with a spring
              overshoot when added and shrinks out when removed; survivors slide
              over via `layout`. Reduced motion collapses to a plain fade. */}
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <AnimatePresence initial={false}>
                {selected.map((u) => (
                  <motion.span
                    key={u.id}
                    layout={!reduce}
                    initial={{ opacity: 0, scale: reduce ? 1 : 0.5, y: reduce ? 0 : 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: reduce ? 1 : 0.5 }}
                    transition={
                      reduce
                        ? { duration: 0.15 }
                        : { type: 'spring', stiffness: 500, damping: 28 }
                    }
                    className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-panel py-1 pl-1 pr-2.5 text-body font-medium text-text"
                  >
                    {/* Brief ring flash on landing — the "just added" sparkle. The
                        ring lives in the class layer (ring-primary) and only its
                        OPACITY animates: framer-motion can't interpolate a token
                        inside a box-shadow string, so animating the shadow meant
                        hardcoding the light-mode orange, which read off-brand in
                        dark. An absolutely-positioned sibling gives the same halo. */}
                    <span className="relative inline-flex rounded-pill">
                      <Avatar
                        name={u.display_name ?? u.username}
                        src={u.avatar_url}
                        size="sm"
                        colorClass={memberColor(u.id)}
                        className="h-6 w-6 text-[9px]"
                      />
                      <motion.span
                        aria-hidden
                        initial={reduce ? false : { opacity: 0.55 }}
                        animate={{ opacity: 0 }}
                        transition={{ duration: 0.7, ease: 'easeOut' }}
                        className="pointer-events-none absolute inset-0 rounded-pill ring-[3px] ring-primary"
                      />
                    </span>
                    <span>@{u.username}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${u.username}`}
                      onClick={() => removeMember(u.id)}
                      className="text-text-subtle hover:text-text"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          )}

          {/* Search results dropdown */}
          {query.trim().length >= MIN_QUERY_LENGTH && (
            <div className="max-h-52 overflow-y-auto rounded-input border border-border bg-surface-raised shadow-sm">
              {searching ? (
                <div className="py-1">
                  <SkeletonRow />
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
                    onClick={() => addMember(u)}
                    className={cn(
                      'group flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0',
                      'transition-colors hover:bg-surface-sunken',
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
        </div>

        <Button fullWidth disabled={!canCreate} onClick={submit}>
          {pending ? <Spinner size="sm" /> : `Create group${selected.length ? ` (${selected.length + 1})` : ''}`}
        </Button>
      </div>
    </Modal>
  )
}
