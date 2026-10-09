from typing import Literal

from fastapi import APIRouter, Depends, Query
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_redis, rate_limit
from app.db.session import get_async_session
from app.schemas.api import SearchPage, SearchResponse
from app.services import search as svc

router = APIRouter(tags=["search"], dependencies=[Depends(rate_limit)])


@router.get("/search", response_model=SearchResponse)
async def search(
    q: str | None = Query(default=None, max_length=svc.MAX_Q),
    region_id: str = Query(default="gta", max_length=64),
    bbox: str | None = Query(default=None, description="west,south,east,north (WGS84)"),
    time_window: Literal["today", "24h", "2d", "3d", "7d", "30d", "all"] = "all",
    workplace: Literal["all", "on_site", "hybrid", "remote"] = "all",
    zoom: float | None = Query(default=None, ge=0, le=24),
    limit: int = Query(default=30, ge=1, le=100),
    session: AsyncSession = Depends(get_async_session),
    redis: Redis = Depends(get_redis),
) -> dict:
    params = svc.SearchParams(
        q=q,
        region_id=region_id,
        bbox=svc.BBox.parse(bbox) if bbox else None,
        time_window=time_window,
        workplace=workplace,
        zoom=zoom,
        limit=limit,
    )
    return await svc.run_search(session, redis, params)


@router.get("/search/{search_id}/jobs", response_model=SearchPage)
async def search_page(
    search_id: str,
    cursor: str = Query(..., max_length=500),
    limit: int = Query(default=30, ge=1, le=100),
    session: AsyncSession = Depends(get_async_session),
    redis: Redis = Depends(get_redis),
) -> dict:
    return await svc.page(session, redis, search_id, cursor, limit)
