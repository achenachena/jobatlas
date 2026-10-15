# JobAtlas

Canada job-posting atlas. The running application uses Job Bank open data, GeoNames city
anchors and Natural Earth outlines. Job Bank publishes monthly: the default seven-day
window ends at the dataset cutoff, not necessarily today.

The v1 collectors, LinkedIn experiments, street map, legacy API and data tables have been
retired. There is no `/legacy` app or `/api/v1` API. See
[cleanup record](docs/LEGACY_CLEANUP_2026-10-15.zh-CN.md).

## Run

```sh
cp .env.example .env
docker compose -f infra/compose.yaml up -d --build
```

Web: http://localhost:5173/ . Readiness: http://localhost:8010/api/v2/health/ready .
OpenAPI: http://localhost:8010/api/v2/openapi.json .

For a fresh database, load cities and the licensed monthly files:

```sh
docker compose -f infra/compose.yaml exec worker jobatlas atlas-cities
docker compose -f infra/compose.yaml exec worker jobatlas atlas-sync
```

The scheduler checks for new or changed Job Bank files daily. The only worker queue is
`atlas`. The database persists in `jobatlas_pgdata`; do not delete that volume to clean old
collectors. Migration 0015 removes only retired tables and unused source declarations.
It is intentionally irreversible. Historical schema migrations remain so existing databases
can upgrade; they contain no working collectors.

## Development and verification

Backend: Python 3.12 and `uv sync --frozen` in `backend/`. Frontend: Node 24.15+ and `npm ci`
in `apps/web/`. Configure database and Redis using `.env.example`.

```sh
cd backend
uv run pytest -q
# Include PostgreSQL integration tests with an isolated test database:
JOBATLAS_TEST_DATABASE_URL=postgresql+psycopg://jobatlas:jobatlas@localhost:54329/jobatlas_test uv run pytest -q
```

```sh
cd apps/web
npm run build
npm test -- --run
npm run e2e
```

Regenerate API types using `npm run generate` in `packages/api-client/`.

## Data and licences

- [Job Bank dataset](https://open.canada.ca/data/en/dataset/ea639e28-c0fc-48bf-b5dd-b8899bd43072):
  Contains information licensed under the Open Government Licence – Canada.
- [GeoNames](https://www.geonames.org/export/): city locations, CC BY 4.0.
- [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/): public-domain outlines.

Only Job Bank is registered as a posting source. Demo mode is explicitly labelled and never
substituted for a failed real-data request. See [data definitions](docs/atlas-v2.md) and
[source decision](docs/data-source-decision.md). This is not an official government product.
