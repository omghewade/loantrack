# syntax=docker/dockerfile:1

# ---------- stage 1: stamp asset URLs (no tooling from here ships in the final image) ----------
FROM alpine:3.20.3 AS build
ARG APP_VERSION=dev
WORKDIR /src
COPY src/ ./
# Append a content hash to app.js / styles.css so browsers fetch the new files after a rollout,
# and write the version into the footer.
RUN set -eu; \
    for f in app.js styles.css; do \
      hash="$(sha256sum "$f" | cut -c1-12)"; \
      sed -i "s|\"$f\"|\"$f?v=$hash\"|" index.html; \
    done; \
    sed -i "s|__APP_VERSION__|${APP_VERSION}|" index.html

# ---------- stage 2: unprivileged nginx serving static files + /api proxy ----------
FROM nginxinc/nginx-unprivileged:1.27.3-alpine

ENV BACKEND_URL=http://backend:8000 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY --from=build /src/ /usr/share/nginx/html/
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

# Image default user is nginx (uid 101); stated explicitly so it is visible in review.
USER 101
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
