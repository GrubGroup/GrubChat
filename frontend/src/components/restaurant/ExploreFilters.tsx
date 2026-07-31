import { Chip } from '@/components/ui'

// Filter/sort chips for the Explore page. Keys match the predicates in
// useExploreFilters. "Nearby" and "Top rated" are sorts (mutually exclusive with
// each other); the rest are additive filters. "All" is a reset, lit when nothing
// is active.
const FILTERS: { key: string; label: string }[] = [
  { key: 'nearby', label: 'Nearby' },
  { key: 'vegan', label: 'Vegan-friendly' },
  { key: 'gluten-free', label: 'Gluten-free' },
  { key: 'budget', label: '$–$$' },
  { key: 'open', label: 'Open now' },
  { key: 'top-rated', label: 'Top rated' },
]

interface ExploreFiltersProps {
  active: Set<string>
  onToggle: (key: string) => void
  onClearFilters: () => void
  /** Whether "Nearby" is offered — only when a home location gives us distances. */
  canUseNearby: boolean
}

export function ExploreFilters({ active, onToggle, onClearFilters, canUseNearby }: ExploreFiltersProps) {
  // Drop "Nearby" when there's no home location to measure distance from, rather
  // than showing a chip that would sort by nothing.
  const filters = canUseNearby ? FILTERS : FILTERS.filter((f) => f.key !== 'nearby')

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip label="All" selected={active.size === 0} onToggle={onClearFilters} />
      {filters.map((f) => (
        <Chip
          key={f.key}
          label={f.label}
          selected={active.has(f.key)}
          onToggle={() => onToggle(f.key)}
        />
      ))}
    </div>
  )
}
