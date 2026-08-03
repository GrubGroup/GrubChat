import { create } from 'zustand'
import type { LocationPref, Profile } from '@/types'
import { fetchProfile, saveProfile } from '@/api/profileApi'
import { likeRestaurant, unlikeRestaurant } from '@/api/restaurantsApi'

interface ProfileState {
  profile: Profile | null
  preferredLocation?: LocationPref // in-flight picker value (see types/profile.ts)
  loading: boolean
  saving: boolean
  // Restaurant ids with a like/unlike request in flight — lets the Explore star
  // disable itself mid-request so a double-tap can't fire opposing calls.
  likePending: Set<number>
  load: () => Promise<void>
  toggleDietary: (value: string) => void
  // Set a cuisine's explicit state (tri-state picker): 'like' → preferred,
  // 'avoid' → disliked, 'neutral' → removed from both. Always mutually exclusive.
  setCuisineState: (value: string, state: 'neutral' | 'like' | 'avoid') => void
  setBudget: (min: number, max: number) => void
  setLocation: (address: string, coords?: { lat: number; lon: number }) => void
  // Preferred search radius (miles) around the default address.
  setRadius: (miles: number) => void
  // Like or unlike a restaurant and PERSIST it (POST/DELETE /restaurants/:id/like).
  // Optimistic: toggles locally at once, then reconciles from the server's returned
  // list; rolls back on failure. Async so callers can await if they need to.
  toggleLikedRestaurant: (id: number) => Promise<void>
  // Persist the profile. Resolves true on success, false on failure (never
  // throws), so callers can gate navigation / show an error. `saving` is always
  // reset.
  save: () => Promise<boolean>
}

// Remove `value` from an array if present, else add it. Pure.
function toggleIn(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
}

// A blank profile for a brand-new user (no row yet). Mutators need a base
// object to spread onto; the gateway upserts it on the first save().
function emptyProfile(): Profile {
  const now = new Date().toISOString()
  return {
    id: 0,
    user_id: 0,
    dietary_restrictions: [],
    disliked_cuisines: [],
    preferred_cuisines: [],
    budget_min: 15,
    budget_max: 25,
    default_address: null,
    default_lat: null,
    default_lon: null,
    default_radius: null,
    liked_restaurant_ids: [],
    created_at: now,
    updated_at: now,
  }
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: null,
  preferredLocation: undefined,
  loading: false,
  saving: false,
  likePending: new Set<number>(),

  load: async () => {
    set({ loading: true })
    const profile = await fetchProfile()
    // New user (gateway 404 → null): seed a blank profile so onboarding's
    // mutators have a base to edit; save() upserts it. Also seed the picker
    // value from a persisted default_address so the location field prefills.
    const seeded = profile ?? emptyProfile()
    set({
      profile: seeded,
      preferredLocation: seeded.default_address
        ? { mode: 'named', label: seeded.default_address }
        : get().preferredLocation,
      loading: false,
    })
  },

  toggleDietary: (value) => {
    const p = get().profile
    if (!p) return
    set({ profile: { ...p, dietary_restrictions: toggleIn(p.dietary_restrictions, value) } })
  },

  setCuisineState: (value, state) => {
    const p = get().profile
    if (!p) return
    // Drop from both lists, then add to the one the target state names — keeps
    // preferred/disliked mutually exclusive by construction.
    const preferred = p.preferred_cuisines.filter((v) => v !== value)
    const disliked = p.disliked_cuisines.filter((v) => v !== value)
    if (state === 'like') preferred.push(value)
    else if (state === 'avoid') disliked.push(value)
    set({ profile: { ...p, preferred_cuisines: preferred, disliked_cuisines: disliked } })
  },

  setBudget: (min, max) => {
    const p = get().profile
    if (!p) return
    set({ profile: { ...p, budget_min: min, budget_max: max } })
  },

  // Persist the default dining address onto the profile. Address is required;
  // coords are optional (cleared when omitted, since a plain text edit has none).
  setLocation: (address, coords) => {
    const p = get().profile
    if (!p) return
    set({
      profile: {
        ...p,
        default_address: address || null,
        default_lat: coords?.lat ?? null,
        default_lon: coords?.lon ?? null,
      },
      preferredLocation: address ? { mode: 'named', label: address } : undefined,
    })
  },

  setRadius: (miles) => {
    const p = get().profile
    if (!p) return
    set({ profile: { ...p, default_radius: miles } })
  },

  toggleLikedRestaurant: async (id) => {
    const p = get().profile
    // Ignore a repeat tap while this id's request is still in flight.
    if (!p || get().likePending.has(id)) return
    const wasLiked = p.liked_restaurant_ids.includes(id)
    const optimistic = wasLiked
      ? p.liked_restaurant_ids.filter((r) => r !== id)
      : [...p.liked_restaurant_ids, id]
    // Optimistic write + mark this id in flight.
    const pending = new Set(get().likePending)
    pending.add(id)
    set({ profile: { ...p, liked_restaurant_ids: optimistic }, likePending: pending })
    try {
      // The endpoint returns the authoritative liked list — reconcile from it so
      // concurrent likes on other cards aren't clobbered by this response.
      const server = wasLiked ? await unlikeRestaurant(id) : await likeRestaurant(id)
      const cur = get().profile
      if (cur) set({ profile: { ...cur, liked_restaurant_ids: server } })
    } catch {
      // Roll back this id to its pre-toggle membership so a failed request doesn't
      // linger as an optimistic like; leave any other changes since then intact.
      const cur = get().profile
      if (cur) {
        const reverted = wasLiked
          ? Array.from(new Set([...cur.liked_restaurant_ids, id]))
          : cur.liked_restaurant_ids.filter((r) => r !== id)
        set({ profile: { ...cur, liked_restaurant_ids: reverted } })
      }
    } finally {
      const next = new Set(get().likePending)
      next.delete(id)
      set({ likePending: next })
    }
  },

  save: async () => {
    const p = get().profile
    if (!p) return false
    set({ saving: true })
    // Fold any in-flight picker label onto the profile before persisting, so the
    // location picker path (which only sets preferredLocation) still saves the
    // default_address. An explicit default_address on the profile wins.
    const loc = get().preferredLocation
    const toSave: Profile =
      loc?.label && !p.default_address
        ? { ...p, default_address: loc.label, default_lat: loc.lat ?? null, default_lon: loc.lon ?? null }
        : p
    try {
      const saved = await saveProfile(toSave)
      set({ profile: saved, saving: false })
      return true
    } catch {
      // Never strand the caller: reset the flag and report failure so the UI can
      // surface an error instead of hanging.
      set({ saving: false })
      return false
    }
  },
}))
