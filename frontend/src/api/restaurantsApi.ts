import type { MenuItem, Restaurant } from '@/types'
import { api } from '@/lib/axios'

export async function fetchRestaurants(): Promise<Restaurant[]> {
  // Page through the gateway list endpoint to pull the ENTIRE catalog (~2k+ rows).
  // The store maps every row into byId, so recommended/liked ids of ANY value
  // resolve — an unloaded id is silently dropped by Top Picks / Profile / Explore
  // (byId miss → filter(Boolean)) → "No matching spots". Without pagination the
  // gateway defaults to 20 and caps a single request, so we must page explicitly.
  // pageSize MUST be <= the gateway's MAX_LIST_LIMIT, else the gateway clamps the
  // page and the `data.length < pageSize` stop condition fires early (re-caps us).
  const pageSize = 1000
  const all: Restaurant[] = []
  for (let offset = 0; ; offset += pageSize) {
    const { data } = await api.get<Restaurant[]>('/restaurants', {
      params: { limit: pageSize, offset },
    })
    all.push(...data)
    if (data.length < pageSize) break // short/empty page → done
    if (offset > 100_000) break // safety guard against an infinite loop
  }
  return all
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
