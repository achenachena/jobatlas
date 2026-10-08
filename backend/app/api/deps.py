import time
from collections.abc import AsyncIterator
from functools import lru_cache

from fastapi import HTTPException, Request
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)


@lru_cache
def _redis() -> Redis:
    return Redis.from_url(get_settings().redis_url, socket_timeout=2, decode_responses=True)


async def get_redis() -> AsyncIterator[Redis]:
    yield _redis()


async def rate_limit(request: Request) -> None:
    """Fixed one-minute window per client IP. If Redis is down the limiter fails open (the
    search itself will then fail with 503 because snapshots need Redis)."""
    limit = get_settings().api_rate_limit_per_minute
    client = request.client.host if request.client else "unknown"
    key = f"rl:{client}:{int(time.time() // 60)}"
    try:
        r = _redis()
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, 70)
    except RedisError:
        log.warning("rate_limit_unavailable")
        return
    if count > limit:
        raise HTTPException(
            status_code=429, detail={"code": "RATE_LIMITED", "message": "too many requests"}
        )
