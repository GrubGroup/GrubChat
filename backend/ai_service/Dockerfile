# GrubGroup AI Service (FastAPI) — managed with uv
FROM python:3.14-slim

# Install uv (fast Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install dependencies first (better layer caching)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# Copy application code
COPY . .

EXPOSE 8000

# Run the FastAPI app. Bind 0.0.0.0 so Fly's public proxy + health checks reach
# it (the reliable path). The gateway calls this service over its public HTTPS
# URL, guarded by X-Internal-Secret — not the IPv6-only .internal network, which
# would require a dual-stack bind uvicorn doesn't do cleanly.
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
