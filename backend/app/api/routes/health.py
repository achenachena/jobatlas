from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from redis import Redis
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_session

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live() -> dict:
    return {"status": "ok"}


@router.get("/health/ready")
def ready(session: Session = Depends(get_session)) -> JSONResponse:
    checks: dict[str, str] = {}
    try:
        head = session.scalar(text("SELECT version_num FROM alembic_version"))
        checks["database"] = "ok" if head else "no_migrations"
        # every city has its region (atlas-groups), so the map's grouping is never missing
        ungrouped = session.scalar(text(
            "SELECT count(*) FROM atlas_cities c WHERE NOT EXISTS "
            "(SELECT 1 FROM atlas_city_groups g WHERE g.city_id = c.id)"))  # fmt: skip
        checks["grouping"] = "ok" if not ungrouped else f"{ungrouped} cities without a group"
    except Exception as exc:  # noqa: BLE001 - report any dependency failure as not ready
        checks["database"] = f"error:{type(exc).__name__}"
    try:
        with Redis.from_url(get_settings().redis_url, socket_timeout=2) as redis:
            redis.ping()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["redis"] = f"error:{type(exc).__name__}"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse(
        {"status": "ok" if ok else "unavailable", "checks": checks}, status_code=200 if ok else 503
    )
