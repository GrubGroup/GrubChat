// Runner for backfill_flexible_budget.sql — re-points legacy onboarding
// "Flexible" profiles ({0, 200}) at the NO_CAP encoding ({0, 0}). See the .sql
// file next to this one for WHY, and for why skipping the backfill is safe.
//
//   cd backend/gateway
//   node scripts/backfill_flexible_budget.mjs            # dry run: counts only
//   node scripts/backfill_flexible_budget.mjs --apply    # actually writes
//
// Reads DATABASE_URL from the environment (or backend/gateway/.env, which
// dotenv loads via the gateway's own config). Uses the Prisma client already in
// node_modules, so there is nothing new to install.
//
// DRY RUN BY DEFAULT: it prints the affected rows and exits without writing
// unless --apply is passed. The write is a single UPDATE with no DDL, so it is
// safe to re-run — a second pass matches zero rows.

import { PrismaClient } from '@prisma/client'

const apply = process.argv.includes('--apply')
const prisma = new PrismaClient()

try {
  const where = { budget_min: 0, budget_max: 200 }
  const affected = await prisma.profile.findMany({
    where,
    select: { id: true, user_id: true, budget_min: true, budget_max: true },
  })

  console.log(
    `${affected.length} profile(s) on the legacy Flexible band {0, 200}` +
      (affected.length
        ? `: user_ids ${affected.map((p) => p.user_id).join(', ')}`
        : ' — nothing to do.'),
  )

  if (!affected.length) {
    // Report the current distribution so a no-op run is still informative.
    const total = await prisma.profile.count()
    const noCap = await prisma.profile.count({ where: { budget_max: 0 } })
    console.log(`(${total} profiles total, ${noCap} already on NO_CAP {*, 0})`)
  } else if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to update.')
  } else {
    const { count } = await prisma.profile.updateMany({
      where,
      data: { budget_max: 0 },
    })
    console.log(`\nUpdated ${count} profile(s) to budget_max = 0 (Flexible).`)
    const remaining = await prisma.profile.count({ where })
    console.log(`Verification: ${remaining} row(s) still on {0, 200} (expected 0).`)
  }
} finally {
  await prisma.$disconnect()
}
