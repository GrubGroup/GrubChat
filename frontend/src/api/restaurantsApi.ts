import type { MenuItem, Restaurant } from '@/types'
import { api } from '@/lib/axios'

export async function fetchRestaurants(): Promise<Restaurant[]> {
  // Ask for the whole catalog (gateway caps at 100; the seed is ~54–67 rows).
  // Without an explicit limit the gateway defaults to 20, so any recommended
  // restaurant with id > 20 would be absent from restaurantStore.byId and the
  // Top Picks page would silently drop every such pick → "No matching spots".
  const { data } = await api.get<Restaurant[]>('/restaurants', { params: { limit: 100 } })
  return data
}

// Menus have no backend table yet, so there is nothing to fetch — return empty.
// The restaurantId param is kept for call-site compatibility (store.loadMenu).
export async function fetchMenu(restaurantId: number): Promise<MenuItem[]> {
  void restaurantId
  return []
}

// Like / unlike a restaurant for the current user. Both endpoints are idempotent
// and return the caller's FULL updated liked list, so callers reconcile from the
// response rather than trusting a local toggle. This persists to
// `Profile.liked_restaurant_ids` — the signal the ai_service preference agent reads.
// (PUT /profile deliberately ignores that column, so these are the ONLY way to
// persist a like.)
export async function likeRestaurant(id: number): Promise<number[]> {
  const { data } = await api.post<{ liked_restaurant_ids: number[] }>(`/restaurants/${id}/like`)
  return data.liked_restaurant_ids
}

export async function unlikeRestaurant(id: number): Promise<number[]> {
  const { data } = await api.delete<{ liked_restaurant_ids: number[] }>(`/restaurants/${id}/like`)
  return data.liked_restaurant_ids
}
