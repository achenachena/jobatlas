# @jobatlas/api-client

Generated TypeScript types for the public API, produced from FastAPI's OpenAPI document
(`/api/v1/openapi.json`). Generation is wired up in stage 2, once the `/search`, `/jobs` and
`/regions` contracts exist; stage 1 exposes only health endpoints, so nothing is generated yet.
Planned command (run against a running API):

    npx openapi-typescript http://localhost:8010/api/v1/openapi.json -o packages/api-client/schema.d.ts
