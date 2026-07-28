import { useEffect, useRef, useState } from 'react'
import { GEOAPIFY_API_KEY } from '@/lib/env'

// Location input hook backed by Geoapify autocomplete (a plain REST call — no
// SDK, no script tag). The free tier needs no credit card and hard-stops at its
// daily limit instead of billing. With no VITE_GEOAPIFY_API_KEY set, the hook
// never fetches and degrades to plain free-text entry so the field still works;
// the host modal's server-side /geocode "Check" remains the fallback.

const AUTOCOMPLETE_URL = 'https://api.geoapify.com/v1/geocode/autocomplete'
const DEBOUNCE_MS = 300
const MIN_CHARS = 3 // don't spend quota on 1-2 character noise
const LIMIT = 5

export interface PlaceSuggestion {
  placeId: string
  /** Full human-readable address string. */
  description: string
}

export interface ResolvedPlace {
  address: string
  lat: number
  lon: number
}

export interface PlacesInputResult {
  value: string
  setValue: (v: string) => void
  suggestions: PlaceSuggestion[]
  ready: boolean
  /** Resolve a picked suggestion to its address + coordinates (from cache). */
  select: (placeId: string) => ResolvedPlace | null
  /** Dismiss the current suggestion list (e.g. after a pick or on blur). */
  clear: () => void
}

// A parsed Geoapify feature we keep around so select() needs no second request.
interface Feature {
  placeId: string
  address: string
  lat: number
  lon: number
}

// Geoapify autocomplete returns GeoJSON; we only read these bits.
interface GeoapifyResponse {
  features?: Array<{
    properties?: {
      place_id?: string
      formatted?: string
      lat?: number
      lon?: number
    }
  }>
}

export function usePlacesInput(initial = ''): PlacesInputResult {
  const [value, setValue] = useState(initial)
  const [features, setFeatures] = useState<Feature[]>([])
  const ready = Boolean(GEOAPIFY_API_KEY)

  // Suppress the fetch triggered by our own setValue(address) after a pick.
  const skipNextFetch = useRef(false)

  useEffect(() => {
    if (!ready) return
    if (skipNextFetch.current) {
      skipNextFetch.current = false
      return
    }
    const text = value.trim()
    const controller = new AbortController()
    // Debounce all state changes into the timer callback so we never call
    // setState synchronously in the effect body (cascading-render rule).
    const timer = window.setTimeout(async () => {
      // Too short to be worth a request — clear any stale suggestions.
      if (text.length < MIN_CHARS) {
        setFeatures([])
        return
      }
      try {
        const url = `${AUTOCOMPLETE_URL}?text=${encodeURIComponent(
          text,
        )}&limit=${LIMIT}&apiKey=${encodeURIComponent(GEOAPIFY_API_KEY)}`
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) {
          setFeatures([])
          return
        }
        const data: GeoapifyResponse = await res.json()
        const parsed: Feature[] = (data.features ?? [])
          .map((f) => f.properties)
          .filter(
            (p): p is NonNullable<typeof p> =>
              Boolean(p?.place_id && p?.formatted) &&
              typeof p?.lat === 'number' &&
              typeof p?.lon === 'number',
          )
          .map((p) => ({
            placeId: p.place_id as string,
            address: p.formatted as string,
            lat: p.lat as number,
            lon: p.lon as number,
          }))
        setFeatures(parsed)
      } catch {
        // Aborted (stale) or network error — leave suggestions empty; the
        // modal's "Check" button + server geocode are the fallback.
        setFeatures([])
      }
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [value, ready])

  const suggestions: PlaceSuggestion[] = features.map((f) => ({
    placeId: f.placeId,
    description: f.address,
  }))

  const clear = () => setFeatures([])

  const select = (placeId: string): ResolvedPlace | null => {
    const match = features.find((f) => f.placeId === placeId)
    if (!match) return null
    // Reflect the pick without re-triggering a fetch, then dismiss the list.
    skipNextFetch.current = true
    setValue(match.address)
    setFeatures([])
    return { address: match.address, lat: match.lat, lon: match.lon }
  }

  return { value, setValue, suggestions, ready, select, clear }
}
