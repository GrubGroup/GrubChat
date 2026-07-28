// Central runtime flags. The app runs exclusively against the live gateway.
export const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? 'http://localhost:4000'

// Browser-exposed Geoapify key (origin-restricted in the Geoapify dashboard).
// Powers the autocomplete on the host session location field. Free tier, no
// credit card. Empty when unset — the location input then degrades to plain
// free text + server-side geocode validation, so the app still works with no key.
export const GEOAPIFY_API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY ?? ''
