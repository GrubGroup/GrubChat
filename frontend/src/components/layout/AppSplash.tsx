import { Spinner, Wordmark } from '@/components/ui'

// Full-screen branded loader shown (live mode only) while the Better Auth
// session check resolves and the post-auth forwarding runs — so an
// already-signed-in user reloading never flashes the marketing landing page
// before the app renders.
export function AppSplash() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-surface">
      <Wordmark size="lg" />
      <Spinner size="lg" className="text-text-muted" />
    </div>
  )
}
