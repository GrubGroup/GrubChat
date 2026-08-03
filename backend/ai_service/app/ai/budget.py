"""The "no price ceiling" sentinel shared by the chat, storage and ranking paths.

A diner's budget is a CEILING — "I'm willing to spend up to this much" — never a
target. ``NO_CAP`` is the value that says "this diner set no ceiling at all", and
it is deliberately ``0`` rather than a new column or a magic band, because 0 is
ALREADY what the rest of the codebase means by "no budget data":

  * ``orchestrator_agent._reconcile`` has always skipped a falsy effective cap
    (0 is "no data", NOT "this diner can spend $0" — including it would filter
    out every restaurant).
  * ``MemberPref.budget_min/budget_max`` default to 0 for a member with no
    Profile row, and ``pipeline.run_pipeline`` fans out ``p.budget_* if p else 0``.
  * The gateway seeds a brand-new Profile with ``0, 0``
    (``restaurantsController.js``'s raw INSERT).

So an explicit 0 flows through every existing layer with the semantics we want,
needs no migration, and cannot be confused with a real answer — no one's budget
ceiling is zero dollars.

WHY NOT NULL: on ``Qa`` the budget columns are nullable, but NULL already means
"the member has not answered the budget question yet" — ``_compute_missing``
keys off ``is not None`` and ``MemberPref.effective_budget_cap`` falls back to
the durable Profile for it. NULL is also unreachable as a deliberate write:
``profile_service.qa_diff`` and ``crud.session.upsert_qa_signals`` both skip
None values so a partial turn never clears a stored field. We need a value that
means "answered: no ceiling", which is exactly what 0 provides.

WHY NOT A ``budget_flexible`` COLUMN: ``app/models/qa.py`` is ``table=True`` and
the DDL for this database is hand-applied (there is no ``prisma migrate`` script
in the gateway's package.json), so shipping a field before the ALTER lands makes
every Qa read raise ``UndefinedColumn`` — a total analyze + pipeline outage
rather than a degraded path.

The LLM never sees this number: the preference prompt asks for a BOOLEAN
(``budget_flexible``) and ``conversation_agent._reconcile`` is the single place
that translates it into NO_CAP. Teaching the model to emit 0 would collide with
"a lone number is a ceiling -> budget_max" and risk a real $0 cap.
"""

from __future__ import annotations

# The stored "this diner set no price ceiling" value for budget_min/budget_max.
NO_CAP = 0


def is_no_cap(budget_max: int | None) -> bool:
    """True when a stored budget_max means "no ceiling" rather than a real cap.

    NULL is deliberately NOT no-cap: it means "not answered yet", which is what
    keeps the durable Profile budget as the fallback until the member speaks.
    Negative values can't be entered through any UI but are treated as no-cap
    too, since a negative ceiling would filter out every restaurant.
    """
    return budget_max is not None and budget_max <= NO_CAP
