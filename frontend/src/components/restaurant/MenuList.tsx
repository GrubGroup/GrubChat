import { useEffect } from 'react'
import type { MenuItem } from '@/types'
import { MenuItemRow } from './MenuItemRow'
import { useRestaurantStore } from '@/stores/restaurantStore'
import { useEventStore } from '@/stores/eventStore'
import { useAuthStore } from '@/stores/authStore'

export interface MenuListProps {
  restaurantId: number
}

const EMPTY: MenuItem[] = []

export function MenuList({ restaurantId }: MenuListProps) {
  // Select the raw value (stable reference); default to a shared constant so the
  // selector never returns a fresh array (which would loop forever).
  const menu: MenuItem[] = useRestaurantStore((s) => s.menus[restaurantId]) ?? EMPTY
  const loadMenu = useRestaurantStore((s) => s.loadMenu)
  const add = useEventStore((s) => s.add)
  const userId = useAuthStore((s) => s.user?.id ?? 1)

  useEffect(() => {
    void loadMenu(restaurantId)
  }, [restaurantId, loadMenu])

  if (menu.length === 0) {
    return <p className="text-body text-text-muted">Menu coming soon.</p>
  }

  return (
    <div className="flex flex-col">
      <h3 className="mb-1 text-overline font-semibold uppercase tracking-wide text-text-muted">
        Menu highlights
      </h3>
      {menu.map((item) => (
        <MenuItemRow key={item.id} item={item} onAdd={() => add(item, userId)} />
      ))}
    </div>
  )
}
