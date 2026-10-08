from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. Every value can be set via environment (see .env.example)."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    env: str = Field(default="development", alias="JOBATLAS_ENV")
    # psycopg 3 driver serves both the async API and the sync worker; sessions are never shared.
    database_url: str = Field(
        default="postgresql+psycopg://jobatlas:jobatlas@localhost:5432/jobatlas",
        alias="DATABASE_URL",
    )
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")

    # Identify ourselves honestly on every outbound request.
    http_user_agent: str = Field(
        default="JobAtlasBot/0.1 (development; operator contact not configured)",
        alias="HTTP_USER_AGENT",
    )
    http_timeout_seconds: float = Field(default=20.0, alias="HTTP_TIMEOUT_SECONDS")
    http_max_response_bytes: int = Field(default=20_000_000, alias="HTTP_MAX_RESPONSE_BYTES")
    http_max_redirects: int = Field(default=5, alias="HTTP_MAX_REDIRECTS")
    http_per_host_min_interval_seconds: float = Field(
        default=1.0, alias="HTTP_PER_HOST_MIN_INTERVAL_SECONDS"
    )

    # Scheduling defaults (DEVELOPMENT.md §6.3). These are configurable starting points.
    source_active_interval_minutes: int = Field(default=30, alias="SOURCE_ACTIVE_INTERVAL_MINUTES")
    source_idle_interval_minutes: int = Field(default=360, alias="SOURCE_IDLE_INTERVAL_MINUTES")
    discovery_interval_minutes: int = Field(default=1440, alias="DISCOVERY_INTERVAL_MINUTES")
    scheduler_tick_seconds: int = Field(default=60, alias="SCHEDULER_TICK_SECONDS")
    source_lock_ttl_minutes: int = Field(default=30, alias="SOURCE_LOCK_TTL_MINUTES")

    # Common Crawl discovery
    commoncrawl_data_base: str = Field(
        default="https://data.commoncrawl.org", alias="COMMONCRAWL_DATA_BASE"
    )
    commoncrawl_collinfo_url: str = Field(
        default="https://index.commoncrawl.org/collinfo.json", alias="COMMONCRAWL_COLLINFO_URL"
    )
    discovery_max_blocks_per_run: int = Field(default=40, alias="DISCOVERY_MAX_BLOCKS_PER_RUN")
    discovery_max_verifications_per_run: int = Field(
        default=50, alias="DISCOVERY_MAX_VERIFICATIONS_PER_RUN"
    )

    geocoder_provider: str = Field(default="none", alias="GEOCODER_PROVIDER")
    geocoder_base_url: str | None = Field(default=None, alias="GEOCODER_BASE_URL")
    geocoder_retry_days: int = Field(default=7, alias="GEOCODER_RETRY_DAYS")
    geocoder_batch_size: int = Field(default=50, alias="GEOCODER_BATCH_SIZE")

    # Lifecycle (DEVELOPMENT.md §7.2)
    freshness_hours: int = Field(default=48, alias="FRESHNESS_HOURS")
    missing_min_interval_minutes: int = Field(default=30, alias="MISSING_MIN_INTERVAL_MINUTES")
    missing_close_without_detail_hours: int = Field(
        default=24, alias="MISSING_CLOSE_WITHOUT_DETAIL_HOURS"
    )

    # Search
    search_snapshot_ttl_seconds: int = Field(default=300, alias="SEARCH_SNAPSHOT_TTL_SECONDS")
    search_max_map_points: int = Field(default=5000, alias="SEARCH_MAX_MAP_POINTS")
    api_rate_limit_per_minute: int = Field(default=120, alias="API_RATE_LIMIT_PER_MINUTE")

    jsonld_max_job_pages: int = Field(default=30, alias="JSONLD_MAX_JOB_PAGES")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
