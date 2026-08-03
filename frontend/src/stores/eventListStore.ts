import { create } from 'zustand'
import type { EventRecord } from '@/types'
import { fetchEvents } from '@/api/eventsApi'

// The Events-tab dining-history list. Separate from `eventStore` (the in-session
// order "cart"): this store holds the durable Event rows from GET /api/events and
// is refreshed live when a session:confirmed broadcast lands (see useSocket).
interface EventListState {
  events: EventRecord[]
  loaded: boolean
  loading: boolean
  // Set when the last load() failed. Lets the Events page show an error + retry
  // instead of a silent blank page (a failed fetch previously left loaded=false
  // AND events=[], which reads identically to "no events" but shows nothing).
  error: string | null
  load: () => Promise<void>
  // Clear back to the initial state (called on sign-out so one user's events
  // never briefly show for the next).
  reset: () => void
}

export const useEventListStore = create<EventListState>((set, get) => ({
  events: [],
  loaded: false,
  loading: false,
  error: null,

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const events = await fetchEvents()
      set({ events, loaded: true, error: null })
    } catch {
      // Mark loaded so the UI leaves the loading state and can render the error
      // view; keep any previously-loaded events in place rather than clearing.
      set({ error: "Couldn't load your events.", loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  reset: () => set({ events: [], loaded: false, loading: false, error: null }),
}))
