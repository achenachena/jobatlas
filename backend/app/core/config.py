from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")
    env: str = Field(default="development", alias="JOBATLAS_ENV")
    database_url: str = Field(
        default="postgresql+psycopg://jobatlas:jobatlas@localhost:5432/jobatlas",
        alias="DATABASE_URL",
    )
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")
    atlas_user_agent: str = Field(
        default="JobAtlasBot/0.1 (open-data import; contact not configured)",
        alias="ATLAS_USER_AGENT",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
