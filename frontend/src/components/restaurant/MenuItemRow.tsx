import type { MenuItem } from '@/types'
import { Button } from '@/components/ui'
import { TagRow } from './TagRow'

export interface MenuItemRowProps {
  item: MenuItem
  onAdd: () => void
}

export function MenuItemRow({ item, onAdd }: MenuItemRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="font-medium text-text">{item.name}</p>
        {item.description && <p className="text-body text-text-muted">{item.description}</p>}
        {item.dietary_tags.length > 0 && (
          <div className="mt-1.5">
            <TagRow dietaryTags={item.dietary_tags} />
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-2">
        <span className="text-body font-medium text-text">${item.price}</span>
        <Button size="sm" variant="ghost" onClick={onAdd}>
          Add
        </Button>
      </div>
    </div>
  )
}
