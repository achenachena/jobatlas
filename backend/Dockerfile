FROM python:3.12.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
RUN uv sync --frozen --no-dev

# /var/lib/jobatlas holds the beat schedule in production (a volume takes this owner)
RUN useradd --system --uid 10001 jobatlas && install -d -o jobatlas /var/lib/jobatlas
USER jobatlas

CMD ["uvicorn", "app.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
