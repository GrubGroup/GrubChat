import { BrandReveal } from '@/components/ui'

// Full-screen branded loader shown (live mode only) while the Better Auth
// session check resolves and the post-auth forwarding runs — so an
// already-signed-in user reloading never flashes the marketing landing page
// before the app renders. Uses BrandReveal: the GrubChat logo builds itself in.
export function AppSplash() {
  return <BrandReveal />
}
