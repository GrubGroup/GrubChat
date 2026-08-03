-- Re-point legacy onboarding "Flexible" profiles at the NO_CAP encoding.
--
-- DATA ONLY — no DDL, no schema change, nothing for Prisma to migrate. Run it
-- once by hand against the database (psql "$DATABASE_URL" -f this file).
--
-- WHY: the onboarding budget step used to save "Flexible" as {min: 0, max: 200}.
-- Because the recommendation reads budget_max as a CEILING, that is
-- indistinguishable from the "$40+" band {40, 200} at ranking time — so anyone
-- who picked "Flexible" was treated as a $200-a-head diner and pulled the whole
-- group's picks upmarket, which is the opposite of what they asked for.
-- "Flexible" now saves {0, 0} (see frontend/src/utils/formatBudget.ts NO_CAP and
-- backend/ai_service/app/ai/budget.py), which makes that member impose no
-- ceiling at all.
--
-- SAFE: {0, 200} is only ever produced by the old Flexible band. "Under $15" is
-- {0, 15}; "$40+" is {40, 200} and is excluded here by min = 0; a profile the
-- gateway auto-creates starts at {0, 0}. So this cannot capture a real answer.
--
-- OPTIONAL: skipping it leaves those users on a $200 ceiling, which is harmless
-- under the new scoring — the group's budget fit is the WORST member's fit, so a
-- ceiling above everyone else's is inert. The only visible cost of skipping is
-- cosmetic: their profile reads "$0–200" instead of "Flexible", and no band chip
-- shows as selected in the editor.

UPDATE "Profile"
SET budget_max = 0
WHERE budget_min = 0
  AND budget_max = 200;
