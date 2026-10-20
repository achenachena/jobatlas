import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.api import errors
from app.api.routes import atlas, health
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger

configure_logging()
log = get_logger(__name__)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="JobAtlas API", version="2.0.0", openapi_url="/api/v2/openapi.json")
    # Level 6, not the default 9: an 11x cheaper compression of a 1.6 MB history chunk for a
    # 22% larger body; at level 9 compression was most of the response time.
    app.add_middleware(GZipMiddleware, minimum_size=2000, compresslevel=6)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID", "ETag"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        import structlog

        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled_error", path=request.url.path)
            response = JSONResponse(
                {
                    "error": {"code": "INTERNAL", "message": "internal error"},
                    "request_id": request_id,
                },
                status_code=500,
            )
        finally:
            structlog.contextvars.clear_contextvars()
        response.headers["X-Request-ID"] = request_id
        return response

    errors.install(app)
    app.include_router(health.router, prefix="/api/v2")
    app.include_router(atlas.router, prefix="/api/v2")
    return app


app = create_app()
