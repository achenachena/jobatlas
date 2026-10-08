# The upstream postgis/postgis image ships amd64 only; build PostGIS on the official
# multi-arch postgres image so the stack runs natively on arm64 and amd64.
FROM postgres:17.6-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
    && rm -rf /var/lib/apt/lists/*
