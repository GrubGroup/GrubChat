import { create } from 'zustand'
import { DEFAULT_THEME, isKnownTheme, type Theme } from '@/constants/theme'

// The user's chosen color theme ('system' | 'light' | 'dark').
//
// Persisted to localStorage directly (no zustand `persist` middleware — same
// rationale as voicePrefStore: a single value, and nothing else uses the
// middleware). A theme is a per-DEVICE rendering preference, not dining data, so
// it lives client-side rather than in the `Profile` row that feeds the SQLModel
// mirror + recommendation pipeline.
//
// The store is the source of truth AFTER hydration; the anti-FOUC script in
// index.html applies the same resolution PRE-paint (first frame) so there's no
// light flash. `applyTheme(readStored())` at module load self-heals any
// divergence between the two.
const STORAGE_KEY = 'gg:theme'

// Media query for the OS dark preference — read for 'system', and watched at
// module level (below) so a live OS flip updates the app while in 'system' mode.
// Guarded: `matchMedia` is absent in some non-browser/test contexts.
const darkQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

// Read once at module load, tolerating a disabled/absent localStorage (privacy
// mode, SSR). An unknown/stale value resolves to the default.
function readStored(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isKnownTheme(raw) ? raw : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

// Does the given theme paint dark right now? 'system' defers to the OS query.
function resolveDark(theme: Theme): boolean {
  if (theme === 'system') return darkQuery?.matches ?? false
  return theme === 'dark'
}

// Apply a theme to the live document: toggle the `.dark` class (which swaps the
// Tier-2 tokens in index.css), set `color-scheme` so native form widgets and
// scrollbars render dark, and keep the <meta name="theme-color"> chrome color in
// sync. Mirrors the anti-FOUC script in index.html — keep the two in step.
function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const dark = resolveDark(theme)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  const meta = document.querySelector('meta[name="theme-color"]')
  // The warm dark page base (#141413) in dark; the light page base otherwise.
  if (meta) meta.setAttribute('content', dark ? '#141413' : '#f5f3ee')
}

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readStored(),
  setTheme: (theme) => {
    if (!isKnownTheme(theme)) return
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* storage unavailable — keep the in-memory choice for this session */
    }
    applyTheme(theme)
    set({ theme })
  },
}))

// Re-apply on a live OS theme change, but ONLY while the stored mode is 'system'
// — an explicit light/dark pick must not be stomped by an OS flip. Registered at
// MODULE level (not in a React hook): module init runs exactly once and is NOT
// re-invoked by StrictMode, so there's no double-subscribe; the listener lives
// for the app's lifetime, so no teardown is needed.
darkQuery?.addEventListener('change', () => {
  if (useThemeStore.getState().theme === 'system') applyTheme('system')
})

// Sync the document to the stored choice at import time. Idempotent with the
// FOUC script (same result), so importing this store early in main.tsx just
// guarantees the class is present even if the inline script was stripped.
applyTheme(readStored())
