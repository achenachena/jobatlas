"""Uniform error envelope: {"error": {"code", "message", "details"?}, "request_id"}.

422 validation, 404 not found, 410 expired snapshot, 429 rate limited, 503 dependency down.
"""

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException


def _rid() -> str | None:
    return structlog.contextvars.get_contextvars().get("request_id")


def envelope(status: int, code: str, message: str, details=None) -> JSONResponse:
    body: dict = {"error": {"code": code, "message": message}, "request_id": _rid()}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(body, status_code=status, headers={"X-Request-ID": _rid() or ""})


def install(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        details = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
        return envelope(422, "VALIDATION_ERROR", "invalid request", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        if isinstance(exc.detail, dict) and "code" in exc.detail:
            return envelope(exc.status_code, exc.detail["code"], exc.detail.get("message", ""))
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 429: "RATE_LIMITED"}.get(
            exc.status_code, "HTTP_ERROR"
        )
        return envelope(exc.status_code, code, str(exc.detail))

    @app.exception_handler(RedisError)
    async def _redis(_: Request, exc: RedisError):
        return envelope(503, "DEPENDENCY_UNAVAILABLE", "message broker unavailable")

    @app.exception_handler(OperationalError)
    async def _db(_: Request, exc: OperationalError):
        return envelope(503, "DEPENDENCY_UNAVAILABLE", "database unavailable")
