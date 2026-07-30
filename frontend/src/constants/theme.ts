// Selectable color themes for the app.
//
// A theme is a per-DEVICE rendering preference (which palette the UI paints
// with), not account data — so, exactly like the agent-voice choice
// (constants/voices.ts + stores/voicePrefStore.ts), it is persisted client-side
// in localStorage rather than in the `Profile` row. See stores/themeStore.ts.
//
// 'system' follows the OS `prefers-color-scheme`; 'light' / 'dark' pin the
// palette regardless of the OS. The `.dark` class on <html> (set by the store /
// the anti-FOUC script in index.html) is what actually swaps the Tier-2 tokens
// declared in index.css.

export type Theme = 'system' | 'light' | 'dark'

export interface ThemeOption {
  value: Theme
  label: string
}

// Order = the segmented control's left→right order (System · Light · Dark).
export const THEME_OPTIONS: ThemeOption[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

// 'system' is the default when nothing is stored yet — respect the OS setting.
export const DEFAULT_THEME: Theme = 'system'

// Guard a stored/loaded value against the known set — a stale/tampered value
// (removed option, hand-edited storage) resolves to the default.
export function isKnownTheme(value: string | null | undefined): value is Theme {
  return !!value && THEME_OPTIONS.some((t) => t.value === value)
}
