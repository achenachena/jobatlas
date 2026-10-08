# JobAtlas

Map-first job discovery for the GTA. Product spec: [docs/PRD-v0.2.txt](docs/PRD-v0.2.txt).
Implementation plan: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

**Status: stage 1 (data feasibility + skeleton).** Real employer discovery and Greenhouse
ingestion work end to end; there is no search API or map UI yet. See
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
```

After that the scheduler keeps going on its own: due sources every 60 s tick (active sources
every 30 min, sources without target-region jobs every 6 h) and discovery daily.

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

- Map style/tiles provider (stage 3) and geocoding provider (stage 2): see `.env.example`.
  Public Nominatim is not to be used for batch work.
- Production hosting, backups schedule, and their costs.
