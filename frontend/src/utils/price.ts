// `Restaurant.price_avg` is a raw per-person dollar figure; the UI shows a $-level
// glyph instead. Mirrors the inline idiom in RankedRestaurantCard so the two can't
// drift: ~$15 → "$", ~$30 → "$$", capped at "$$$$". Empty string when the average
// is unknown, so callers can render nothing rather than a bare "$".
export function priceLevel(priceAvg?: number | null): string {
  return priceAvg != null ? '$'.repeat(Math.min(4, Math.ceil(priceAvg / 15))) : ''
}
