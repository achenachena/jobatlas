# Production deployment

## Where things run

| Part | Location |
| --- | --- |
| Web | Vercel project `prj_i67jEDOTnQWeVGL2Oq8MwYRZB844` (team `team_AOWw5xwHPLgnSpEeewbgQtz9`), https://jobatlas-eight.vercel.app |
| API | https://jobatlas.184-195-161-235.sslip.io (Caddy, automatic TLS) |
| Server | EC2 `i-0ab4772542d5a3371`, us-east-1, t3.small (CPU credits `standard`), Ubuntu, IPv4 only |
| Source on server | `/home/ubuntu/jobatlas` (git checkout, detached at the released SHA) |
| Server config | `/home/ubuntu/deploy/.env` (`POSTGRES_PASSWORD`, `JOBATLAS_ENV`, `CORS_ORIGINS`, `ATLAS_USER_AGENT`, `API_DOMAIN`); never committed |
| Stack | `infra/compose.prod.yaml`, Compose project `jobatlas` |
| Data | Docker volumes `jobatlas_pgdata` (database) and `jobatlas_caddy_data` (TLS certificates) |
| Backups | `/home/ubuntu/backups/` on the server |

The instance public IP changes if the instance is stopped and started; then update the API
domain in `.env`, the `VITE_API_BASE_URL` Vercel variable and the `API_URL` GitHub variable.

## How a release works

`.github/workflows/deploy.yml` runs after `ci` passes on `main`. One run releases one commit:

1. Build the web app for that commit once and stage it on Vercel (not live).
2. Get temporary AWS credentials through GitHub OIDC (role `jobatlas-github-deploy`).
3. Over SSM: check out the commit on the server and `docker compose up -d --build`. The
   `migrate` service applies migrations before the API starts.
4. `GET /api/v2/health/ready` must return 200.
5. Promote the staged web build.

Only one release runs at a time. A run stops at the first failing step; the step name says
which stage failed, and the web stays on the previous build until step 5. A run whose commit
is no longer the head of `main` does nothing. Vercel Git deploys of `main` are disabled in
`apps/web/vercel.json`, so the web never goes live ahead of the API.

GitHub environment `production` holds `VERCEL_TOKEN` (secret) and the variables
`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `AWS_DEPLOY_ROLE_ARN`, `DEPLOY_INSTANCE_ID`, `API_URL`.
No long-lived AWS key exists. IAM:

- `jobatlas-github-deploy`: trusted only for `repo:achenachena/jobatlas:environment:production`;
  may only run `AWS-RunShellScript` on this instance and read the result.
- `jobatlas-ec2-ssm` (instance profile): `AmazonSSMManagedInstanceCore`, so the SSM agent can register.

Release or re-release a specific commit (also the rollback path, see below):

```sh
gh workflow run deploy -f sha=<full commit sha>
```

## Shell access

SSM (no open port needed):

```sh
aws ssm start-session --region us-east-1 --target i-0ab4772542d5a3371
sudo -iu ubuntu
```

SSH is allowed only from the owner's IP; the key is kept outside the repository.

Useful commands on the server (as `ubuntu`, in `~/jobatlas`):

```sh
alias dc='docker compose --env-file ~/deploy/.env -f infra/compose.prod.yaml'
dc ps
dc logs -f --tail=100 api worker scheduler
dc exec worker jobatlas atlas-sync        # import new Job Bank months now
```

Never run `dc down -v`: it deletes the database and certificate volumes.

## Fresh database

```sh
dc stop scheduler worker
dc run --rm worker jobatlas atlas-cities
dc run --rm worker jobatlas atlas-sync --max-months 3   # first release quickly
dc run --rm worker jobatlas atlas-sync                  # then the remaining history
dc start worker scheduler
```

The full Job Bank history is about 3.8 million postings and takes hours on this instance.

## Backup and restore

Back up before any release with an irreversible migration:

```sh
f=~/backups/jobatlas-$(date -u +%Y%m%dT%H%MZ).dump
docker exec jobatlas-db-1 pg_dump -U jobatlas -d jobatlas -Fc > "$f" && sha256sum "$f"
```

Copy it off the server and compare the checksum; `pg_restore --list <file>` confirms it is
readable.

Restore (replaces the current database):

```sh
dc stop api worker scheduler
docker exec -i jobatlas-db-1 pg_restore -U jobatlas -d jobatlas --clean --if-exists < <file>
dc start api worker scheduler
```

## Rollback

- No migration since the target commit: `gh workflow run deploy -f sha=<previous sha>`.
- A migration since then that the old code cannot read (for example `0015` drops the v1 tables):
  restore the backup taken before that release, then release the old commit. Rolling back only
  the web leaves it talking to an API it does not match.
