from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_async_session

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live() -> dict:
    return {"status": "ok"}


@router.get("/health/ready")
async def ready(session: AsyncSession = Depends(get_async_session)) -> JSONResponse:
    checks: dict[str, str] = {}
    try:
        head = (await session.execute(text("SELECT version_num FROM alembic_version"))).scalar()
        checks["database"] = "ok" if head else "no_migrations"
    except Exception as exc:  # noqa: BLE001 - report any dependency failure as not ready
        checks["database"] = f"error:{type(exc).__name__}"
    try:
        redis = Redis.from_url(get_settings().redis_url, socket_timeout=2)
        await redis.ping()
        await redis.aclose()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["redis"] = f"error:{type(exc).__name__}"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse(
        {"status": "ok" if ok else "unavailable", "checks": checks}, status_code=200 if ok else 503
    )
