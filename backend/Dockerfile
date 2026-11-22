# syntax=docker/dockerfile:1

# ---------- stage 1: build the virtualenv (pip, wheels, build caches stay here) ----------
FROM python:3.12.8-slim-bookworm AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Cache boundary: dependencies are installed from requirements.txt alone, so editing app code
# reuses this layer and only the final COPY below is rebuilt.
COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

# ---------- stage 2: runtime ----------
FROM python:3.12.8-slim-bookworm AS runtime

ARG APP_VERSION=dev
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_VERSION=${APP_VERSION}

# Fixed UID/GID so Kubernetes runAsUser and file ownership are predictable.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
# Owned by root and read-only for the app user: the process cannot modify its own code.
COPY app ./app

USER 10001:10001
EXPOSE 8000

# /healthz never touches the database, so a slow DB does not make Docker kill the API.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]

CMD ["uvicorn", "app.main:build_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
