#!/usr/bin/env bash
# One-command deploy: empty minikube -> working LoanTrack.
# Safe to re-run: every step is "create or update", nothing is deleted.
#
#   ./scripts/deploy.sh                 # deploy v1
#   APP_VERSION=v2 ./scripts/deploy.sh  # build v2 and roll it out
#   MINIKUBE_START_ARGS="--force" ./scripts/deploy.sh   # extra flags if minikube must start
set -euo pipefail

cd "$(dirname "$0")/.."
NS=loantrack
VERSION="${APP_VERSION:-v1}"

log()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

for cmd in minikube kubectl; do
  command -v "$cmd" >/dev/null || fail "$cmd is not installed"
done

log "Checking minikube"
if ! minikube status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  # shellcheck disable=SC2086 # word splitting of extra flags is intended
  minikube start ${MINIKUBE_START_ARGS:-}
fi
kubectl config use-context minikube >/dev/null

log "Loading credentials from .env"
if [[ ! -f .env ]]; then
  fail ".env not found - run: cp .env.example .env  (and set POSTGRES_PASSWORD)"
fi
set -a; source .env; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing in .env}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD missing in .env}"

log "Building images $VERSION and loading them into minikube"
# Build with the local Docker engine, then copy into the cluster's container runtime.
# (minikube image build cannot pass --build-arg when the cluster runs containerd.)
command -v docker >/dev/null || fail "docker is not installed"
for tier in backend frontend; do
  docker build -q -t "loantrack-$tier:$VERSION" --build-arg "APP_VERSION=$VERSION" "$tier"
  minikube image load "loantrack-$tier:$VERSION" --overwrite=true
done

log "Applying namespace, config and secrets"
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/10-configmap.yaml
# Secret from .env, never from a committed file. --dry-run | apply makes it create-or-update.
kubectl -n "$NS" create secret generic loantrack-db \
  --from-literal=POSTGRES_USER="$POSTGRES_USER" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
# Schema + seed SQL, from the same files Docker Compose uses.
kubectl -n "$NS" create configmap db-init \
  --from-file=001_create_loans.sql=db/migrations/001_create_loans.sql \
  --from-file=002_seed_loans.sql=db/seed/002_seed_loans.sql \
  --dry-run=client -o yaml | kubectl apply -f -

log "Deploying PostgreSQL"
kubectl apply -f k8s/20-postgres.yaml
kubectl -n "$NS" rollout status statefulset/postgres --timeout=180s

log "Deploying backend and frontend"
# Manifests pin :v1; swap the tag on the way in so a re-run never bounces v2 -> v1 -> v2.
for f in k8s/30-backend.yaml k8s/40-frontend.yaml; do
  sed -E "s#(image: loantrack-(backend|frontend)):v1\$#\1:$VERSION#" "$f"
  echo "---"
done | kubectl apply -f -
# Same tag + new code, or a changed ConfigMap, does not restart pods by itself. Stamp the pod
# template with a hash of the build inputs + config: it only changes (and rolls pods) when they
# change, so re-running with nothing new is a no-op. (Image IDs are not used: with Docker's
# containerd image store they change on every build, even a fully cached one.)
tree_hash() { find "$@" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12; }
config_hash=$(tree_hash k8s/10-configmap.yaml)
for tier in backend frontend; do
  kubectl -n "$NS" patch deployment "$tier" --type merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"loantrack/build\":\"$(tree_hash "$tier")-$config_hash\"}}}}}"
done
kubectl -n "$NS" rollout status deployment/backend  --timeout=180s
kubectl -n "$NS" rollout status deployment/frontend --timeout=120s

log "Done"
kubectl -n "$NS" get pods -o wide
URL="http://$(minikube ip):30080"
cat <<EOF

LoanTrack $VERSION is running.
  From this machine:   $URL      (or: minikube service frontend -n $NS --url)
  From a Windows browser with minikube inside WSL:
                       kubectl -n $NS port-forward svc/frontend 8081:80   ->  http://localhost:8081
EOF
