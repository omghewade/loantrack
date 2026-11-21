NS ?= loantrack
PY ?= python3

.PHONY: help up down reset logs test lint deploy rollout-v2 rollback status open

help:            ## list targets
	@grep -E '^[a-z0-9-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

up:              ## docker compose: build and start (http://localhost:8080)
	@test -f .env || (echo "no .env - run: cp .env.example .env" && exit 1)
	docker compose up -d --build --wait

down:            ## docker compose: stop, keep data
	docker compose down

reset:           ## docker compose: stop and DELETE the database volume
	docker compose down -v

logs:            ## docker compose: follow logs
	docker compose logs -f --tail=100

test:            ## backend unit tests
	cd backend && $(PY) -m pytest -q

lint:            ## backend lint + format check
	cd backend && ruff check . && ruff format --check .

deploy:          ## kubernetes: deploy v1 to minikube (idempotent)
	./scripts/deploy.sh

rollout-v2:      ## kubernetes: build v2 and roll it out
	APP_VERSION=v2 ./scripts/deploy.sh

rollback:        ## kubernetes: undo the last backend rollout
	kubectl -n $(NS) rollout undo deployment/backend
	kubectl -n $(NS) rollout status deployment/backend

status:          ## kubernetes: everything in the namespace
	kubectl -n $(NS) get all
	kubectl -n $(NS) get pvc,configmap,secret

open:            ## kubernetes: port-forward the frontend to http://localhost:8081
	kubectl -n $(NS) port-forward svc/frontend 8081:80
