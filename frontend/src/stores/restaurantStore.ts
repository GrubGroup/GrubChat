import { create } from 'zustand'
import type { MenuItem, Restaurant } from '@/types'
import { fetchMenu, fetchRestaurants } from '@/api/restaurantsApi'

interface RestaurantState {
  byId: Record<number, Restaurant>
  menus: Record<number, MenuItem[]>
  loaded: boolean
  // Set when the last load() failed. Lets a page (e.g. Explore) show an error +
  // retry instead of a silent blank grid — a failed fetch previously rejected and
  // left loaded=false, which reads identically to "still loading".
  error: boolean
  load: () => Promise<void>
  loadMenu: (restaurantId: number) => Promise<void>
}

export const useRestaurantStore = create<RestaurantState>((set, get) => ({
  byId: {},
  menus: {},
  loaded: false,
  error: false,

  load: async () => {
    try {
      const list = await fetchRestaurants()
      const byId: Record<number, Restaurant> = {}
      for (const r of list) byId[r.id] = r
      set({ byId, loaded: true, error: false })
    } catch {
      // Mark loaded so the UI leaves the loading state and can render the error
      // view; keep any previously-loaded catalog rather than clearing it. Retry is
      // user-driven — load() always refetches (it doesn't guard on `loaded`).
      set({ loaded: true, error: true })
    }
  },

  loadMenu: async (restaurantId) => {
    if (get().menus[restaurantId]) return
    const items = await fetchMenu(restaurantId)
    set((s) => ({ menus: { ...s.menus, [restaurantId]: items } }))
  },
}))
