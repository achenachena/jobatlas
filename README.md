# JobAtlas

An interactive map of Canadian job postings by city, occupation, and time.

**[Live demo](https://jobatlas-eight.vercel.app)**

![JobAtlas map demo](docs/demo.gif)

I built JobAtlas during my software engineering job search in Canada to explore where
jobs were being posted. Filter by occupation, compare cities, and replay Job Bank history
from January 2023, or explore employer boards from Greenhouse, Lever, and Ashby.

## Engineering

```text
Job Bank + employer boards → Celery workers → PostgreSQL → FastAPI → React + Three.js
```

- **Repeatable ingestion:** deduplicate Job Bank records by source ID or a stable row
  fingerprint; check monthly files for updates daily and sweep employer boards hourly.
- **Consistent reads:** publish each dataset version in one transaction and pin historical
  playback to a release, so updates do not mix versions mid-session.
- **Incremental computation:** recompute changed periods and reuse unchanged metrics.
  PostgreSQL integration tests compare incremental results with a full rebuild.

**Stack:** Python, FastAPI, PostgreSQL, Celery, Redis · TypeScript, React, Three.js ·
Docker, GitHub Actions, AWS, Vercel.

## Run locally

Requires Docker Compose.

```sh
cp .env.example .env
docker compose -f infra/compose.yaml up -d --build
docker compose -f infra/compose.yaml exec worker jobatlas atlas-cities
docker compose -f infra/compose.yaml exec worker jobatlas atlas-groups
docker compose -f infra/compose.yaml exec worker jobatlas atlas-sync
```

Open [localhost:5173](http://localhost:5173); the API schema is at
[localhost:8010/api/v2/openapi.json](http://localhost:8010/api/v2/openapi.json).

Tests: `uv run pytest` in `backend/`; `npm test` and `npm run e2e` in `apps/web/`.
Backend integration tests require PostgreSQL and `JOBATLAS_TEST_DATABASE_URL`.

More: [pipeline, metrics, and employer-board setup](docs/atlas-v2.md) ·
[deployment and rollback](docs/DEPLOY.md).

## Data and coverage

Job Bank publishes monthly and has limited tech-role coverage. Employer-board history
starts with a partial backfill. Neither covers the entire market; the datasets stay
separate to avoid double-counting. The map distinguishes missing data from zero postings.

Contains information licensed under the
[Open Government Licence – Canada](https://open.canada.ca/data/en/dataset/ea639e28-c0fc-48bf-b5dd-b8899bd43072).
Locations: [GeoNames](https://www.geonames.org/) (CC BY 4.0).
Map outlines: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
Metro boundaries: adapted from Statistics Canada, 2021 Census, under the
[Statistics Canada Open Licence](https://www.statcan.gc.ca/en/reference/licence).
This personal project is not endorsed by the Government of Canada or Statistics Canada.
