// FRONTEND-ONLY placeholder: there is no MenuItem table in the Prisma schema and
// no gateway endpoint behind it, so `fetchMenu()` returns an empty list and the
// menu pane renders its "Menu coming soon." empty state. This type describes the
// shape the UI is already built against — wire it up when the real table lands.
export interface MenuItem {
  id: number
  restaurant_id: number
  name: string
  description?: string
  price: number
  dietary_tags: string[]
  image_url?: string
}

// A line in the shared group event (client-side for now; realtime later).
export interface EventItem {
  menuItemId: number
  restaurantId: number
  name: string
  price: number
  quantity: number
  addedByUserId: number
}
