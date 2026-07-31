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
 * Surfaces both NEST (a sheet over a drawer) and HAND OFF (a ⋯ action sheet
 * closing as it opens the panel it launched). A hand-off happens inside ONE
 * React commit: the closing surface's cleanup and the opening surface's setup
 * run back-to-back. Parking eagerly — pushState on setup, history.back() on
 * cleanup — races there: history.back() is async and picks its target entry
 * BEFORE the sibling's synchronous pushState runs, so a close+open pair
 * desyncs the parked entries and strands one real navigation entry. A later
 * dismiss then pops THAT, kicking the user off the page (open Edit group / Start
 * session from a group chat, close it, and you'd land on /groups instead of the
 * chat).
 *
 * So the effects never touch history directly. They only update the desired
 * `stack`; a microtask, coalesced to run once per commit, then reconciles the
 * number of parked browser entries to `stack.length`. A close+open in the same
 * commit nets to zero history operations — the one parked entry is simply handed
 * from the closing surface to the opening one.
 *
 * Deliberately owns NO screen navigation. Screen-to-screen history is the
 * router's job, and this is the ONLY file in the app that touches
 * `history` / `popstate`.
 */

// Marks the entries we park, so an inspector (or a future router) can tell ours
// apart from a real navigation.
const MARKER = '__ggDismiss'

type Surface = { dismiss: () => void }

// LIFO stack of the surfaces that WANT an entry parked. Only the innermost
// (last) reacts to a back gesture, so a sheet opened over a drawer closes by
// itself first.
const stack: Surface[] = []

// How many marker entries are actually on the browser history stack. Reconciled
// toward `stack.length`; the two diverge only for the microtask between a commit
// and the reconcile that follows it.
let parkedCount = 0

// Popstate events that are our OWN unwind — a reconcile's history.back() — and so
// must not be read as a back gesture.
let selfPops = 0

let reconcileScheduled = false

function onPopState() {
  if (selfPops > 0) {
    selfPops--
    return
  }
  // A real back gesture: the browser already consumed the innermost entry, so
  // drop our count to match and dismiss the surface that owned it.
  if (parkedCount > 0) parkedCount--
  const top = stack.pop()
  if (top) top.dismiss()
  if (parkedCount === 0) window.removeEventListener('popstate', onPopState)
}

// Bring the number of parked browser entries in line with the desired stack,
// once per commit. Adding an entry is synchronous (pushState); removing one is
// async (history.back → popstate), so each removal bumps `selfPops` to keep the
// resulting popstate from being read as a back gesture.
function reconcile() {
  reconcileScheduled = false
  const want = stack.length
  while (parkedCount < want) {
    if (parkedCount === 0) window.addEventListener('popstate', onPopState)
    // Preserve whatever state is already there — we're adding an entry, not
    // taking the history over.
    window.history.pushState({ ...window.history.state, [MARKER]: true }, '')
    parkedCount++
  }
  while (parkedCount > want) {
    selfPops++
    parkedCount--
    window.history.back()
  }
  if (parkedCount === 0) window.removeEventListener('popstate', onPopState)
}

function scheduleReconcile() {
  if (reconcileScheduled) return
  reconcileScheduled = true
  // Runs after the whole commit's effects have updated `stack`, before paint —
  // so a hand-off's close and open are both seen and cancel out.
  queueMicrotask(reconcile)
}

export function useDismissOnBack(active: boolean, onDismiss: () => void): void {
  // Callers pass an inline arrow, so keep the callback out of the effect deps —
  // otherwise every render would re-register the surface.
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!active) return

    const surface: Surface = { dismiss: () => dismissRef.current() }
    stack.push(surface)
    scheduleReconcile()

    return () => {
      // Closed by any path (backdrop, Escape, an in-app chevron, a hand-off, or
      // an unmount mid-sheet): drop the desire for the entry and let reconcile
      // release it. A back gesture already removed this surface via onPopState,
      // so guard the splice.
      const i = stack.indexOf(surface)
      if (i !== -1) stack.splice(i, 1)
      scheduleReconcile()
    }
  }, [active])
}
