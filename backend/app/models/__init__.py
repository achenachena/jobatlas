"""Shared SQLAlchemy base. All current entities are in app.atlas.models."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
