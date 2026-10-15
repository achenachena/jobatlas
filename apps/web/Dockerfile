# Build context is the repo root so the generated API types (packages/api-client) are present.
FROM node:24.15.0-alpine
WORKDIR /app
COPY packages/api-client/schema.d.ts packages/api-client/schema.d.ts
COPY apps/web/package.json apps/web/package-lock.json apps/web/
WORKDIR /app/apps/web
RUN npm ci
COPY apps/web/ ./
EXPOSE 5173
# Build at startup so Compose runtime VITE_API_BASE_URL is embedded correctly.
# The user-facing local service serves production assets, not StrictMode dev replays.
CMD ["sh", "-c", "npm run build && npx vite preview --host 0.0.0.0 --port 5173"]
