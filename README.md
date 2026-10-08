# JobAtlas

Map-first job discovery for the GTA. Product spec: [docs/PRD-v0.2.txt](docs/PRD-v0.2.txt).
Implementation plan: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

**Status: stage 2 (backend data loop).** Discovery, Greenhouse/Ashby/Lever ingestion,
controlled JSON-LD pages, eligibility, address evidence, lifecycle and the public read API
work end to end; the map UI is stage 3. See
[docs/VALIDATION.md](docs/VALIDATION.md) for what is verified and what is not, and
[docs/SOURCES.md](docs/SOURCES.md) for data-source findings.

## Layout

```
backend/        FastAPI API, Celery worker + beat scheduler, CLI, Alembic migrations, tests
apps/web/       React + TypeScript + Vite (stage 1 shell only)
infra/          Docker Compose; PostGIS image built on the official multi-arch postgres image
docs/           PRD, development plan, source notes, validation record
```

## Run with Docker Compose

Requires Docker. From the repo root:

```bash
cp .env.example .env                                  # optional; defaults work
docker compose -f infra/compose.yaml up -d --build    # db, redis, migrate, api, worker, scheduler, web
curl http://localhost:8010/api/v1/health/ready        # {"status":"ok","checks":{...}}
open http://localhost:5173
```

Migrations run once in the `migrate` service; api/worker/scheduler wait for it.

Collect data once (runs inside the worker image against the compose DB):

```bash
# discover unknown employers from Common Crawl, verify live, register, initial sync
docker compose -f infra/compose.yaml exec worker jobatlas discover \
    --pattern greenhouse-job-boards --max-blocks 4 --verify 50 --sync-new
docker compose -f infra/compose.yaml exec worker jobatlas stats
docker compose -f infra/compose.yaml exec worker jobatlas sync-due   # sync whatever is due now
docker compose -f infra/compose.yaml exec worker jobatlas sweep      # Active -> Pending if stale
docker compose -f infra/compose.yaml exec worker jobatlas enrich-offices   # company HQ for remote jobs
docker compose -f infra/compose.yaml exec worker jobatlas geocode    # needs GEOCODER_PROVIDER
docker compose -f infra/compose.yaml exec worker jobatlas add-jsonld https://careers.example.com/
```

Public API (read-only, no account; OpenAPI at `/api/v1/openapi.json`):

```bash
curl 'http://localhost:8010/api/v1/search?q=backend%20engineer&time_window=3d&bbox=-79.6,43.58,-79.1,43.86'
curl 'http://localhost:8010/api/v1/search/<search_id>/jobs?cursor=<next_cursor>'
curl  http://localhost:8010/api/v1/jobs/<job_id>
curl 'http://localhost:8010/api/v1/regions?q=missis'
curl  http://localhost:8010/api/v1/coverage
```

After that the scheduler keeps going on its own: due sources every 60 s tick (active sources
every 30 min, sources without target-region jobs every 6 h), freshness sweep hourly, company
office lookup and geocoding daily, discovery daily.

Stop / clean up:

```bash
docker compose -f infra/compose.yaml down        # keep data
docker compose -f infra/compose.yaml down -v     # also delete the database volume
```

## Local development (without containers for the app)

Needs Python 3.12, [uv](https://docs.astral.sh/uv/), Node ≥ 22.22.2 or 24.15. Start only the
data services: `docker compose -f infra/compose.yaml up -d db redis`.

```bash
cd backend
uv sync
export DATABASE_URL=postgresql+psycopg://jobatlas:jobatlas@localhost:54329/jobatlas
export REDIS_URL=redis://localhost:63799/0
uv run alembic upgrade head
uv run uvicorn app.api.main:app --reload --port 8010
uv run celery -A app.workers.celery_app worker --loglevel=INFO     # separate shell
uv run celery -A app.workers.celery_app beat --loglevel=INFO       # separate shell, ONE only
uv run jobatlas --help

cd ../apps/web
npm ci && npm run dev
```

## Tests

```bash
cd backend
uv run ruff check . && uv run ruff format --check .
JOBATLAS_TEST_DATABASE_URL=postgresql+psycopg://jobatlas:jobatlas@localhost:54329/jobatlas_test \
  uv run pytest -q          # unit + integration on real PostGIS; integration skips without the URL

cd apps/web
npm run typecheck && npm test
```

Integration tests create the `jobatlas_test` database if missing and never use SQLite.

## Backups

The compose database lives in the `pgdata` volume.

```bash
docker compose -f infra/compose.yaml exec -T db pg_dump -U jobatlas -Fc jobatlas > jobatlas.dump
docker compose -f infra/compose.yaml exec -T db pg_restore -U jobatlas -d jobatlas --clean < jobatlas.dump
```

Scheduled backups and a production host are not set up yet (no hosting platform chosen).

## Not configured yet

- Map style/tiles provider (stage 3) and a production geocoding provider: see `.env.example`.
  Public Nominatim is only acceptable for low-volume development, never batch work.
- Production hosting, backups schedule, and their costs.
