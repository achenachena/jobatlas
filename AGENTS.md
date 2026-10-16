# Project instructions

- Production deployment, server access, backups and rollback: [docs/DEPLOY.md](docs/DEPLOY.md).
  Releases go only through `.github/workflows/deploy.yml`, which deploys just the components that
  changed since their last successful release (web only, API only, both in order, or nothing for
  docs). Never deploy the web or the API outside it. A web change that needs a new API endpoint
  or field ships with the backend change and the regenerated API types.
