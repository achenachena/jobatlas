"""Source admission (spec §3.3). One registry, one gate, used by sync, release building and
every v2 query. "approved" counts only with its evidence: licence, terms link, evidence
reference, verification date, unexpired, and explicit permission for derived statistics and
public display. Setting status="approved" without those fields does not admit a source.

Evidence for each entry: docs/data-source-decision.md (checked 2026-10-14).
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.atlas.models import AtlasSource

OGL_ATTRIBUTION = "Contains information licensed under the Open Government Licence – Canada."

REGISTRY: list[dict] = [
    {
        "key": "jobbank-open-data",
        "provider": "Employment and Social Development Canada — Job Bank open data",
        "official_domain": "open.canada.ca",
        "terms_url": "https://open.canada.ca/en/open-government-licence-canada",
        "licence": "Open Government Licence – Canada 2.0",
        "evidence_ref": "https://open.canada.ca/data/en/dataset/ea639e28-c0fc-48bf-b5dd-b8899bd43072"
        " (licence field: Open Government Licence - Canada); docs/data-source-decision.md §2–3",
        "verified_on": date(2026, 10, 14),
        "expires_on": None,
        "permissions": {
            "read": True,
            "cache_days": None,
            "store_records": True,
            "derived_stats": True,
            "public_display": True,
            "history_retention": True,
            "conditions": "attribution statement; no implied government endorsement; no "
            "government names, crests or logos",
            "deletion": "follow corrections in later monthly files; personal information is "
            "not licensed and not stored",
        },  # fmt: skip
        "capabilities": {
            "countries": ["CA"],
            "geo": "city (municipality name + province)",
            "occupation": "NOC 2021 five-digit code + title",
            "time": "First Posting Date (first published on Job Bank), date precision",
            "history_start": "2023-01-01",
            "incremental": "monthly file per month of first posting",
            "closure": False,
            "publication_lag": "monthly; file appears 2–8 days after the month ends",
        },  # fmt: skip
        "constraints": {
            "refresh": "check daily, import new or modified months",
            "requests": "≈1 file (≈46 MB) per month",
            "retry": "exponential backoff",
        },
        "attribution": OGL_ATTRIBUTION + " Source: Job Bank, Employment and Social Development "
        "Canada (open data). This is not an official product and is not endorsed by the "
        "Government of Canada.",
        "status": "approved",
        "status_basis": "Public licence (OGL-Canada 2.0) expressly allows copy, modify, publish "
        "and commercial use with attribution.",
        "owner": "JobAtlas operator",
    },
]

REQUIRED_EVIDENCE = ("terms_url", "licence", "evidence_ref", "verified_on")


def admitted(row: AtlasSource | None, today: date | None = None) -> tuple[bool, str]:
    """(admitted, reason). The single admission rule for sync, release building and queries."""
    if row is None:
        return False, "unknown source"
    if row.status != "approved":
        return False, f"status {row.status}: {row.status_basis}"
    missing = [f for f in REQUIRED_EVIDENCE if not getattr(row, f)]
    if missing:
        return False, f"approved without evidence ({', '.join(missing)})"
    today = today or datetime.now(UTC).date()
    if row.expires_on is not None and row.expires_on < today:
        return False, f"permission expired on {row.expires_on.isoformat()}"
    perms = row.permissions or {}
    for need in ("derived_stats", "public_display"):
        if perms.get(need) is not True:
            return False, f"permission '{need}' not granted"
    return True, "approved with evidence"


def sync_registry(session: Session) -> None:
    """Make the database mirror REGISTRY (the code is the reviewed source of truth)."""
    for entry in REGISTRY:
        values = {"expires_on": None, **entry}
        session.execute(
            insert(AtlasSource)
            .values(**values)
            .on_conflict_do_update(index_elements=["key"], set_=values)
        )
    session.flush()


def source(session: Session, key: str) -> AtlasSource | None:
    return session.scalar(select(AtlasSource).where(AtlasSource.key == key))
