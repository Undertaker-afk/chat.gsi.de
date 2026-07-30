COMPOSE := podman compose

.PHONY: help up down logs check metrics grafana crawl crawl-force crawl-skip-existing crawl-requested reindex reindex-restore status psql migrate backup dev-noauth clean

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

up:            ## start the whole stack (db, valkey, keycloak, frontend)
	$(COMPOSE) up -d --build

down:          ## stop everything
	$(COMPOSE) down

logs:          ## follow logs
	$(COMPOSE) logs -f

metrics:       ## print the whole exposition the way Prometheus sees it
	@curl -fsS http://localhost:3000/metrics || \
	  { echo "frontend not up, or METRICS_TOKEN is set (send it as a Bearer header)"; exit 1; }

grafana:       ## print the dashboard URLs
	@echo "grafana:    http://localhost:3001   (login via Keycloak, llmbot-admin only)"
	@echo "prometheus: http://localhost:9090"
	@echo "raw:        http://localhost:3000/metrics"

check:         ## verify LLM proxy reachability, embedding dims and database
	$(COMPOSE) run --rm crawler check

crawl:         ## incremental crawl of all enabled sources
	$(COMPOSE) run --rm crawler crawl

crawl-force:   ## full re-embed, ignoring content hashes
	$(COMPOSE) run --rm crawler crawl --force

crawl-skip-existing:   ## skip existing pages in the database - do not fetch/re-index unchanged content
	$(COMPOSE) run --rm crawler crawl --skip-existing

crawl-requested: ## run crawls queued from the admin UI (for a short systemd timer)
	$(COMPOSE) run --rm crawler crawl --requested

reindex:       ## rebuild chunks+embeddings from stored markdown (no wiki access needed)
	$(COMPOSE) run --rm crawler reindex

reindex-restore: ## undelete swept documents, then rebuild their chunks
	$(COMPOSE) run --rm crawler reindex --undelete

status:        ## recent crawl runs
	$(COMPOSE) run --rm crawler status

migrate:       ## apply one migration to an EXISTING database: make migrate FILE=db/migrations/007_....sql
	@test -n "$(FILE)" || { echo "usage: make migrate FILE=db/migrations/007_....sql"; exit 1; }
	@# 001-006 run automatically via docker-entrypoint-initdb.d, but only on an
	@# empty data volume. Anything added later has to be applied by hand.
	$(COMPOSE) exec -T db psql -U $${POSTGRES_USER:-llmbot} -d $${POSTGRES_DB:-llmbot} \
	  -v ON_ERROR_STOP=1 -f - < $(FILE)

psql:          ## open a shell on the database
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-llmbot} -d $${POSTGRES_DB:-llmbot}

ann-index:     ## enable approximate search (only when exact scan gets slow -- see 003_indexes.sql)
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-llmbot} -d $${POSTGRES_DB:-llmbot} -v ON_ERROR_STOP=1 \
	  -c "ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_ann halfvec(2048);" \
	  -c "UPDATE chunks SET embedding_ann = (l2_normalize(subvector(embedding,1,2048)))::halfvec(2048) WHERE embedding_ann IS NULL;" \
	  -c "CREATE INDEX IF NOT EXISTS chunks_embedding_ann ON chunks USING hnsw (embedding_ann halfvec_cosine_ops) WITH (m=16, ef_construction=64);"
	@echo "ANN index built. retrieval.ts must be switched to two-stage before this is used."

backup:        ## dump the database to data/backups/
	@mkdir -p data/backups
	$(COMPOSE) exec -T db pg_dump -U $${POSTGRES_USER:-llmbot} $${POSTGRES_DB:-llmbot} \
	  | gzip > data/backups/llmbot-$$(date +%Y%m%d-%H%M%S).sql.gz
	@echo "wrote data/backups/"

dev-noauth:    ## run the frontend without Keycloak (low-memory dev only)
	cd frontend && NODE_ENV=development DEV_NO_AUTH=true npm run dev

login-info:    ## print the dev login details
	@echo "app:      http://localhost:3000"
	@echo "keycloak: http://keycloak.localhost:8081  (realm: gsi)"
	@echo "user:     testuser / testuser  (has llmbot-admin, so Grafana works)"

clean:         ## remove containers and volumes (DESTROYS the corpus)
	$(COMPOSE) down -v