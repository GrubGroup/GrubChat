// Haversine great-circle distance, in miles, between two lat/long points.
//
// Used by the Explore page's "Nearby" sort and the per-card distance line, computed
// from the user's saved home location (Profile.default_lat/default_lon) against each
// restaurant's coords. Distance is only ever shown when BOTH points have coordinates
// — callers omit it otherwise rather than rendering a wrong "0 mi".

export interface Coords {
  lat: number
  lon: number
}

// Mean Earth radius in miles.
const EARTH_RADIUS_MI = 3958.8

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

export function distanceMi(a: Coords, b: Coords): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  // clamp the root against tiny FP overshoots > 1 before asin
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

// "0.3 mi" under 10 miles (one decimal reads precise up close), whole miles beyond.
export function formatDistanceMi(mi: number): string {
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`
}
