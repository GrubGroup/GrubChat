import { useEffect, useMemo, useState } from 'react'
import type { EventRecord } from '@/types'
import { Avatar, Badge, Button, Icon } from '@/components/ui'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { memberColor } from '@/constants/memberColors'
import { useEventListStore } from '@/stores/eventListStore'

// A cuisine/dietary emoji is not on the API row, so pick a stable default.
const EVENT_EMOJI = '🍽️'

function EventRow({
  e,
  active,
  onSelect,
}: {
  e: EventRecord
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={
        active
          ? 'flex w-full items-center gap-3 border-b border-border bg-surface-sunken px-4 py-3 text-left transition-colors duration-150 ease-out'
          : 'flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-surface-sunken/50'
      }
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-border bg-surface-raised text-lg">
        {EVENT_EMOJI}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-item-title font-semibold text-text">{e.restaurant_name}</span>
          <span className="shrink-0 text-caption text-text-muted">{e.time_slot ?? ''}</span>
        </div>
        <p className="truncate text-caption text-text-muted">
          {e.occasion ? `${e.occasion} · ` : ''}
          {e.group_name ?? 'Group'}
        </p>
      </div>
    </button>
  )
}

// A labeled group of event rows in the sidebar ("Upcoming" / "Previous").
// Renders nothing when empty, so a user with only past outings sees just one header.
function EventSection({
  label,
  list,
  activeId,
  onSelect,
}: {
  label: string
  list: EventRecord[]
  activeId: number | null
  onSelect: (id: number) => void
}) {
  if (list.length === 0) return null
  return (
    <>
      <p className="px-4 pt-3 text-overline font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </p>
      {list.map((e) => (
        <EventRow key={e.id} e={e} active={activeId === e.id} onSelect={() => onSelect(e.id)} />
      ))}
    </>
  )
}

export function EventsPage() {
  const events = useEventListStore((s) => s.events)
  const loaded = useEventListStore((s) => s.loaded)
  const error = useEventListStore((s) => s.error)
  const load = useEventListStore((s) => s.load)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // Snapshot "now" once at mount (lazy initializer keeps render pure) — it's the
  // upcoming/previous cutoff. A mid-session tick past an event's time isn't worth
  // a re-render; the split refreshes on next mount / navigation.
  const [now] = useState(() => Date.now())

  useEffect(() => {
    void load()
  }, [load])

  const active = events.find((e) => e.id === selectedId) ?? events[0] ?? null

  // Split the flat list into outings still ahead (upcoming) vs. past (previous).
  // Cutoff is the exact current time, so an outing earlier today reads as previous.
  // Upcoming is soonest-first; previous is newest-first.
  const { upcoming, previous } = useMemo(() => {
    const up: EventRecord[] = []
    const prev: EventRecord[] = []
    for (const e of events) {
      ;(new Date(e.date).getTime() >= now ? up : prev).push(e)
    }
    up.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    prev.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    return { upcoming: up, previous: prev }
  }, [events, now])

  return (
    <div className="flex h-screen overflow-hidden bg-surface-raised">
      <AppSidebar activeTab="events" eyebrow="Events">
        {loaded && !error && events.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">
            No events yet. Start a session and confirm a pick to book one.
          </p>
        )}
        {error && events.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">
            Couldn't load your events.
          </p>
        )}
        <EventSection
          label="Upcoming"
          list={upcoming}
          activeId={active?.id ?? null}
          onSelect={setSelectedId}
        />
        <EventSection
          label="Previous"
          list={previous}
          activeId={active?.id ?? null}
          onSelect={setSelectedId}
        />
      </AppSidebar>

      {/* Detail */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {active ? (
          <>
            <div className="relative flex h-56 shrink-0 flex-col justify-end bg-surface-inverse p-6 text-white">
              <span className="absolute right-6 top-6 text-caption text-white/70">
                {active.time_slot ?? ''}
              </span>
              <p className="text-caption text-white/70">
                📍 {active.address ?? active.group_name ?? 'Location TBD'}
              </p>
              <h1 className="font-display text-display font-bold">{active.restaurant_name}</h1>
              {active.occasion && <p className="text-body text-white/80">{active.occasion}</p>}
            </div>

            <div className="flex flex-col gap-5 p-6">
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">
                  <Icon name="map-pin" size={11} /> {active.address ?? 'Address TBD'}
                </Badge>
                {active.group_name && (
                  <Badge tone="neutral">
                    <Icon name="users" size={11} /> {active.group_name}
                  </Badge>
                )}
              </div>

              <div className="rounded-card bg-surface-sunken p-4">
                <p className="mb-1 text-overline font-semibold uppercase tracking-wide text-text-muted">
                  Details
                </p>
                <p className="text-body text-text-muted">
                  {active.occasion ? `${active.occasion} at ` : 'Dining at '}
                  {active.restaurant_name}
                  {active.time_slot ? ` · ${active.time_slot}` : ''}.
                </p>
              </div>

              {/* Participants — everyone who was in the session this event came
                  from (gateway joins Event.attendees). */}
              {active.attendees && active.attendees.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                      Who's going
                    </p>
                    <span className="text-xs text-text-muted">
                      {active.attendees.length}{' '}
                      {active.attendees.length === 1 ? 'person' : 'people'}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {active.attendees.map((a) => {
                      const name = a.display_name ?? a.username
                      return (
                        <div
                          key={a.id}
                          className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
                        >
                          <Avatar name={name} size="sm" colorClass={memberColor(a.id)} />
                          <span className="flex-1 text-sm text-text">{name}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : error ? (
          <EventsErrorState onRetry={() => void load()} />
        ) : (
          <EventsEmptyState />
        )}
      </div>
    </div>
  )
}

// Shown when GET /api/events failed — an honest error with a retry, so a read
// failure surfaces instead of rendering a silent blank page.
function EventsErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium text-text">Couldn't load your events</p>
      <p className="max-w-xs text-xs text-text-muted">
        Something went wrong fetching your outings. Give it another try.
      </p>
      <Button variant="primary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

// Shown when the caller has no events yet (nothing booked). Honest empty state —
// events appear here once a session's host confirms a restaurant.
function EventsEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-raised text-2xl">
        🍽️
      </span>
      <p className="text-sm font-medium text-text">No events yet</p>
      <p className="max-w-xs text-xs text-text-muted">
        Start a group session and confirm a restaurant — your booked outings will
        show up here.
      </p>
    </div>
  )
}
