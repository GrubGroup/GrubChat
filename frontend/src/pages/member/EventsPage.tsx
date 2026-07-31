import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { EventRecord } from '@/types'
import { Avatar, Badge, Button, Icon } from '@/components/ui'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { BottomTabBar, TabBarSpacer } from '@/components/layout/BottomTabBar'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { memberColor } from '@/constants/memberColors'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useEventListStore } from '@/stores/eventListStore'
import { cn } from '@/utils/cn'
import { idFromSlug, toSlugId } from '@/utils/slug'

// A cuisine/dietary emoji is not on the API row, so pick a stable default.
const EVENT_EMOJI = '🍽️'

// Sidebar subtitle: the event date + time, e.g. "Mon, Jul 28 · 7:00 PM".
// Invalid dates render "".
function formatEventDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

function EventRow({ e, active }: { e: EventRecord; active: boolean }) {
  return (
    <Link
      to={`/events/${toSlugId(`${e.group_name ?? ''} ${e.restaurant_name}`, e.id)}`}
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
        <span className="block truncate text-item-title font-semibold text-text">
          {e.restaurant_name}
        </span>
        <p className="truncate text-caption text-text-muted">{formatEventDate(e.date)}</p>
      </div>
    </Link>
  )
}

// A labeled group of event rows in the sidebar ("Upcoming" / "Previous").
// Renders nothing when empty, so a user with only past outings sees just one header.
function EventSection({
  label,
  list,
  activeId,
}: {
  label: string
  list: EventRecord[]
  activeId: number | null
}) {
  if (list.length === 0) return null
  return (
    <>
      <p className="px-4 pt-3 text-overline font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </p>
      {list.map((e) => (
        <EventRow key={e.id} e={e} active={activeId === e.id} />
      ))}
    </>
  )
}

// The events search box. Filters the list below by a case-insensitive substring
// match on the event name (restaurant) + group name (see EventsPage's useMemo).
// Rendered in both list regions (desktop sidebar + mobile root) so the two stay
// identical — mirrors the Groups search (components/session/GroupList.tsx).
function EventSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="px-2.5 py-1.5">
      <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface-raised px-2.5 py-2">
        <span className="text-text-muted">
          <Icon name="search" size={14} />
        </span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search by event or group name"
          aria-label="Search events"
          className="min-w-0 flex-1 bg-transparent text-caption font-medium text-text placeholder:text-text-muted focus:outline-none"
        />
      </div>
    </div>
  )
}

export function EventsPage() {
  const events = useEventListStore((s) => s.events)
  const loaded = useEventListStore((s) => s.loaded)
  const error = useEventListStore((s) => s.error)
  const load = useEventListStore((s) => s.load)
  // Which event the detail pane shows comes from the URL — `/events/:eventId` — so a
  // booked outing is linkable and survives a refresh. The list read (GET /api/events)
  // is the only source; there's no fetch-by-id endpoint, so an unknown id simply
  // falls back to the newest event rather than 404ing.
  const { eventId } = useParams()
  const navigate = useNavigate()
  // Below `md` the list + detail split becomes a drill-down (frames 08 → 09); the
  // URL drives which is shown, so /events is the list and /events/:id the detail.
  const isMobile = useIsMobile()
  // Snapshot "now" once at mount (lazy initializer keeps render pure) — it's the
  // upcoming/previous cutoff. A mid-session tick past an event's time isn't worth
  // a re-render; the split refreshes on next mount / navigation.
  const [now] = useState(() => Date.now())
  // Client-side search — a purely presentational substring filter over the
  // already-fetched list, mirroring the Groups search. Local state, no store.
  const [query, setQuery] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  // `active` (the detail pane's event) comes from the URL slug, falling back to
  // the newest event so the desktop detail column is never empty.
  const active = events.find((e) => e.id === idFromSlug(eventId)) ?? events[0] ?? null

  // An event still ahead of the cutoff is "upcoming". Deleted-account attendees
  // are greyed + X'd only on upcoming events; past events already happened, so
  // they render unchanged (the person was there at the time).
  const activeIsUpcoming = active != null && new Date(active.date).getTime() >= now

  // Split the flat list into outings still ahead (upcoming) vs. past (previous).
  // Cutoff is the exact current time, so an outing earlier today reads as previous.
  // Upcoming is soonest-first; previous is newest-first.
  const { upcoming, previous } = useMemo(() => {
    // Filter before the split so both sections + both device layouts stay in sync
    // from one source. Empty query matches everything.
    const q = query.trim().toLowerCase()
    const matches = (e: EventRecord) =>
      !q ||
      // Event name (the restaurant shown as the row/detail title) + group name only.
      [e.restaurant_name, e.group_name].some((f) => f?.toLowerCase().includes(q))
    const up: EventRecord[] = []
    const prev: EventRecord[] = []
    for (const e of events) {
      if (!matches(e)) continue
      ;(new Date(e.date).getTime() >= now ? up : prev).push(e)
    }
    up.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    prev.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    return { upcoming: up, previous: prev }
  }, [events, now, query])

  // Below `md` a URL naming a specific event IS the drill-down; /events is the
  // list root. Native Back (/events/:id → /events) closes the detail, so there's
  // nothing to intercept.
  const mobileDetailOpen = isMobile && eventId != null

  return (
    <div className="flex h-dvh overflow-hidden bg-surface-raised">
      <AppSidebar eyebrow="Events" panelWidth="w-64">
        <EventSearch value={query} onChange={setQuery} />
        {loaded && !error && events.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">
            No events yet. Start a session and confirm a pick to book one.
          </p>
        )}
        {loaded && !error && events.length > 0 && upcoming.length === 0 && previous.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">No events match your search.</p>
        )}
        {error && events.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">
            Couldn't load your events.
          </p>
        )}
        <EventSection label="Upcoming" list={upcoming} activeId={active?.id ?? null} />
        <EventSection label="Previous" list={previous} activeId={active?.id ?? null} />
      </AppSidebar>

      {/* MOBILE list root (<md) — the same list, as the Events tab's own screen.
          `bg-surface-panel` gives it the same two-tone beige as the Groups tab
          root: rows sit transparent on the beige panel and tint only on state. */}
      <div
        className={cn(
          'w-full flex-col overflow-y-auto bg-surface-panel md:hidden',
          mobileDetailOpen ? 'hidden' : 'flex',
        )}
      >
        {/* `brand` matches the Groups tab root: at ≥md the sidebar panel header
            carries the wordmark, and it's hidden here. */}
        <MobileHeader brand title="Events" />
        <EventSearch value={query} onChange={setQuery} />
        {loaded && events.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">
            No events yet. Start a session and confirm a pick to book one.
          </p>
        )}
        {loaded && events.length > 0 && upcoming.length === 0 && previous.length === 0 && (
          <p className="px-4 py-6 text-body text-text-muted">No events match your search.</p>
        )}
        {/* activeId=null: on mobile a tap drills into the detail rather than
            highlighting a row in place. */}
        <EventSection label="Upcoming" list={upcoming} activeId={null} />
        <EventSection label="Previous" list={previous} activeId={null} />
        <TabBarSpacer />
      </div>

      {/* Detail — the second column at ≥md, a pushed screen below it. */}
      <div
        className={cn(
          'flex-1 flex-col overflow-y-auto',
          mobileDetailOpen ? 'flex' : 'hidden md:flex',
        )}
      >
        {active ? (
          <>
            <MobileHeader
              className="md:hidden"
              onBack={() => navigate('/events')}
              title={active.restaurant_name}
              subtitle={active.group_name ?? undefined}
            />
            <div className="flex h-56 shrink-0 flex-col justify-end gap-1 bg-surface-inverse p-4 text-white md:p-6">
              {/* The time was absolutely positioned top-right, where it collided
                  with the text-display title at 390px. In flow above the address
                  it reads as part of the same block at every width. */}
              {active.time_slot && (
                <span className="text-caption text-white/70">{active.time_slot}</span>
              )}
              <p className="text-caption text-white/70">
                📍 {active.address ?? active.group_name ?? 'Location TBD'}
              </p>
              <h1 className="font-display text-section-title font-bold md:text-display">
                {active.restaurant_name}
              </h1>
              {active.occasion && <p className="text-body text-white/80">{active.occasion}</p>}
            </div>

            <div className="flex flex-col gap-5 p-4 md:p-6">
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
                    <p className="text-overline font-semibold uppercase tracking-wide text-text-muted">
                      Who's going
                    </p>
                    <span className="text-caption text-text-muted">
                      {active.attendees.length}{' '}
                      {active.attendees.length === 1 ? 'person' : 'people'}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {active.attendees.map((a) => {
                      const name = a.display_name ?? a.username
                      // Grey out + X a deleted attendee, but only for an upcoming
                      // event — a past event happened while they were still active.
                      const removed = activeIsUpcoming && a.deactivated === true
                      return (
                        <div
                          key={a.id}
                          className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
                        >
                          <Avatar
                            name={name}
                            size="sm"
                            colorClass={memberColor(a.id)}
                            className={removed ? 'opacity-50' : undefined}
                          />
                          <span
                            className={cn(
                              'flex-1 text-body',
                              removed ? 'text-text-muted line-through' : 'text-text',
                            )}
                          >
                            {name}
                          </span>
                          {removed && (
                            <span
                              className="flex items-center gap-1 text-caption text-text-muted"
                              title="This person deleted their account"
                            >
                              <Icon name="x" size={12} />
                              Removed
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
            {/* Frame 09 keeps the tab bar, so the detail needs the same clearance
                as the list — otherwise the attendee list ends under it. */}
            <TabBarSpacer />
          </>
        ) : error ? (
          <EventsErrorState onRetry={() => void load()} />
        ) : (
          <EventsEmptyState />
        )}
      </div>

      <BottomTabBar />
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
      <p className="text-body font-medium text-text">No events yet</p>
      <p className="max-w-xs text-caption text-text-muted">
        Start a group session and confirm a restaurant — your booked outings will
        show up here.
      </p>
    </div>
  )
}
