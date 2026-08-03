"""SQLModel read-side mirror of Prisma table "Session"."""

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.models.timestamps import utcnow


class Session(SQLModel, table=True):
    """Group recommendation session; mirrors Prisma model Session."""

    __tablename__ = "Session"

    id: int | None = Field(default=None, primary_key=True)
    host_user_id: int = Field(foreign_key="User.id")
    group_id: int | None = Field(default=None, foreign_key="Group.id")
    time_limit: int
    # The host's chosen event time (from the pre-session modal). Drives restaurant
    # open/closed evaluation in the orchestrator; snapshotted onto Event.date at
    # close. Replaces the removed host Qa.time_slot free-text field.
    scheduled_for: datetime | None = None
    created_at: datetime = Field(default_factory=utcnow)
    closed_at: datetime | None = None
    # No group-budget column, and nothing computes one either. A budget is a
    # per-member CEILING; the orchestrator scores each candidate against the
    # members' individual ceilings on demand (orchestrator_agent._group_budget_fit)
    # and never reduces them to a single group number — an averaged "group
    # budget" is a spend TARGET, which let one high-budget member drag everyone
    # else's picks upmarket.
