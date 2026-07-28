import { useEffect, useRef } from 'react'

/*
 * Makes a TRANSIENT surface — a bottom sheet, the groups drawer, a mobile
 * drill-down — dismissible by the OS back gesture.
 *
 * On a phone a full-screen sheet with no back-gesture escape feels broken, but
 * app navigation here is in-memory zustand (`navStore`), so the back gesture
 * exits the app instead. While `active`, this hook parks one history entry;
 * popping it fires `onDismiss()` rather than leaving the app.
 *
 * Deliberately owns NO screen navigation. Screen-to-screen history is the
 * router's job (a routes branch is landing in parallel), and this is the ONLY
 * file in the app that touches `history` / `popstate` — so that migration is a
 * rewrite of these internals with every call site left alone.
 */

// Marks the entries we park, so an inspector (or a future router) can tell ours
// apart from a real navigation. We never *read* it to decide anything — ownership
// is tracked per instance below, which stays correct when surfaces nest.
const MARKER = '__ggDismiss'

type Surface = {
  dismiss: () => void
  /** Whether this instance's history entry is still on the stack. */
  parked: boolean
}

// LIFO stack of the surfaces currently parking an entry. Only the innermost
// (last) one reacts to a back gesture, so a sheet opened on top of a drawer
// closes by itself. One shared listener rather than one per instance, so there's
// no ambiguity about which surface owns a given popstate.
const stack: Surface[] = []

// Popstate events that are our OWN unwind — `history.back()` called because the
// surface closed by another path (backdrop, Escape, an in-app chevron) — and so
// must not be read as a back gesture.
let selfPops = 0

function onPopState() {
  if (selfPops > 0) {
    selfPops--
    return
  }
  const top = stack.pop()
  if (!top) return
  top.parked = false // the browser already consumed the entry
  top.dismiss()
}

function detach(surface: Surface) {
  const i = stack.indexOf(surface)
  if (i !== -1) stack.splice(i, 1)
  if (stack.length === 0) window.removeEventListener('popstate', onPopState)
}

export function useDismissOnBack(active: boolean, onDismiss: () => void): void {
  // Callers pass an inline arrow, so keep the callback out of the effect deps —
  // otherwise every render would park a fresh entry.
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!active) return

    const surface: Surface = { dismiss: () => dismissRef.current(), parked: true }
    if (stack.length === 0) window.addEventListener('popstate', onPopState)
    stack.push(surface)
    // Preserve whatever state is already there — we're adding an entry, not
    // taking the history over.
    window.history.pushState({ ...window.history.state, [MARKER]: true }, '')

    return () => {
      detach(surface)
      // Closed by some path other than the back gesture (or unmounted mid-sheet):
      // pop our own entry so the stack stays balanced and the user's next back
      // press isn't silently swallowed. `selfPops` keeps the resulting popstate
      // from re-firing onDismiss.
      if (surface.parked) {
        surface.parked = false
        selfPops++
        window.history.back()
      }
    }
  }, [active])
}
