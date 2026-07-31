"""SQLModel read-side mirror of Prisma table "User"."""

from datetime import datetime

from sqlalchemy import Column
from sqlalchemy import Enum as SAEnum
from sqlmodel import Field, SQLModel

from app.models.enums import Role
from app.models.timestamps import utcnow


class User(SQLModel, table=True):
    """Application user; mirrors Prisma model User."""

    __tablename__ = "User"

    id: int | None = Field(default=None, primary_key=True)
    username: str = Field(unique=True)
    email: str = Field(unique=True)
    role: Role = Field(
        default=Role.USER,
        sa_column=Column(SAEnum(Role, name="Role"), nullable=False),
    )
    display_name: str | None = None
    avatar_url: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    # Soft-delete marker (NULL = active). Mirrors Prisma User.deactivated_at.
    deactivated_at: datetime | None = None
