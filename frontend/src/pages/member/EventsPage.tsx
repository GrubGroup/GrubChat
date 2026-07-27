import { useEffect, useState } from 'react'
import type { EventRecord } from '@/types'
import { Avatar, Badge, Icon } from '@/components/ui'
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

export function EventsPage() {
  const events = useEventListStore((s) => s.events)
  const loaded = useEventListStore((s) => s.loaded)
  const load = useEventListStore((s) => s.load)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const active = events.find((e) => e.id === selectedId) ?? events[0] ?? null

  return (
    <div className="flex h-screen overflow-hidden bg-surface-raised">
      <AppSidebar eyebrow="Events">
        <p className="px-4 pt-3 text-overline font-semibold uppercase tracking-wide text-text-muted">
          Your events
        </p>
        {loaded && events.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">
            No events yet. Start a session and confirm a pick to book one.
          </p>
        )}
        {events.map((e) => (
          <EventRow
            key={e.id}
            e={e}
            active={active?.id === e.id}
            onSelect={() => setSelectedId(e.id)}
          />
        ))}
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
        ) : (
          <EventsEmptyState />
        )}
      </div>
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
