# JobAtlas

Canada job-posting atlas. The running application uses Job Bank open data, GeoNames city
anchors and Natural Earth outlines. Job Bank publishes monthly: the default seven-day
window ends at the dataset cutoff, not necessarily today.

The v1 collectors, LinkedIn experiments, street map, legacy API and data tables have been
retired. There is no `/legacy` app or `/api/v1` API.

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

## Deployment: GitHub + Vercel + AWS

GitHub Actions runs backend tests (with PostgreSQL) and frontend unit tests on PRs to
`main` and pushes to `main`. Branch pushes without a PR do not run CI. Formatting,
OpenAPI regeneration checks and browser E2E remain local tools; CI does not repeat the
frontend build performed by Vercel.

### Vercel frontend

Import this GitHub repository into Vercel with production branch `main`:

- Root Directory: `apps/web`; enable inclusion of files outside the root directory
  because the frontend imports `packages/api-client`.
- Framework: Vite; install: `npm ci`; build: `npm run build`; output: `dist`.
- Node.js: 24.x, matching the package engine requirement.
- Set `VITE_API_BASE_URL=https://<API_DOMAIN>` for the desired environments.

Vercel builds and deploys directly from GitHub, including branch previews. No Vercel
CLI, token or second build is needed in Actions. Frontend deployment is independent
of backend CI; coordinate backwards-compatible API changes accordingly. Preview
origins need explicit entries in the backend's `CORS_ORIGINS` to call the API.

### AWS backend (EC2 + Docker Compose)

The server deployment uses the existing single-server Compose layout: API, worker,
scheduler, PostgreSQL/PostGIS, Redis and Caddy. It does not provision AWS resources.

One-time setup:

1. Prepare an EC2 Linux host with Git, Docker and the Compose plugin. Point an API
   domain at its stable public address. Allow HTTP/HTTPS and SSH from the deployment
   runner; do not publish database or Redis ports.
2. Clone the repository into `~/jobatlas` under the deployment user. Give this clone
   read access to GitHub and the user permission to run Docker. This is a deployment
   checkout: the workflow resets tracked files to the tested commit.
3. Create `~/jobatlas/.env` on the server with `POSTGRES_PASSWORD`, `API_DOMAIN`,
   `CORS_ORIGINS` (comma-separated frontend origins), and `ATLAS_USER_AGENT`.
   Use a URL-safe database password because Compose embeds it in `DATABASE_URL`.
   Keep this file on the server, outside Git.
4. Add GitHub repository secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, and
   `DEPLOY_KNOWN_HOSTS`. The last is the server's verified SSH known-hosts entry;
   verify its fingerprint through the EC2 console before saving it. The SSH key
   must be authorized for the deployment user on the host.
5. Merge to `main`. After CI succeeds, Actions deploys that exact commit. Older
   completed CI runs are skipped if `main` has moved on. Compose runs migrations
   before starting the API, worker and scheduler. A failed migration stops deployment.

For the initial data import, run on the server:

```sh
docker compose --env-file .env -f infra/compose.prod.yaml exec worker jobatlas atlas-cities
docker compose --env-file .env -f infra/compose.prod.yaml exec worker jobatlas atlas-sync
```

Database and Caddy data persist in Docker volumes. This is a simple single-host
release with possible brief downtime; it has no automatic rollback or post-release
readiness gate. Database migrations may be irreversible. Back up persistent data
before schema-changing releases. PostgreSQL/Redis health checks in Compose control
startup ordering; they are not extra CI jobs.
