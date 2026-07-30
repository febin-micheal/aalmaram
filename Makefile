COMPOSE ?= docker compose
MANAGE = $(COMPOSE) run --rm backend python manage.py

PG_USER = $${POSTGRES_USER:-aalmaram}
PG_DB = $${POSTGRES_DB:-aalmaram}
BACKUP_DIR = backups
STAMP = $$(date +%Y%m%d-%H%M%S)

.PHONY: help build up down logs migrate makemigrations test test-cov check-frontend seed \
        superuser shell dbshell lint fmt clean reset-db backup restore backups

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

build:  ## Build the backend image
	$(COMPOSE) build

up:  ## Start postgres + django + vite
	$(COMPOSE) up -d
	@echo "admin:    http://localhost:8000/admin/"
	@echo "api:      http://localhost:8000/api/v1/health/"
	@echo "frontend: http://localhost:5173/"

down:  ## Stop everything (keeps the database volume)
	$(COMPOSE) down

logs:  ## Tail all service logs
	$(COMPOSE) logs -f

migrate:  ## Apply migrations
	$(MANAGE) migrate

makemigrations:  ## Generate migrations
	$(MANAGE) makemigrations

test:  ## Run the test suite
	$(COMPOSE) run --rm backend pytest

test-cov:  ## Run the test suite with coverage on the graph library
	$(COMPOSE) run --rm backend pytest --cov=apps --cov-report=term-missing

check-frontend:  ## Build the explorer and run the headless layout checks
	$(COMPOSE) run --rm --no-deps frontend sh -c "npm run build && npm run check"

seed:  ## Load the fictional demo dataset (200+ persons, 5 generations)
	$(MANAGE) seed_demo

superuser:  ## Create an admin user
	$(MANAGE) createsuperuser

shell:  ## Django shell
	$(MANAGE) shell

dbshell:  ## psql against the dev database
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-aalmaram} -d $${POSTGRES_DB:-aalmaram}

lint:  ## Ruff check
	$(COMPOSE) run --rm backend ruff check .

fmt:  ## Ruff format
	$(COMPOSE) run --rm backend ruff format .

clean:  ## Stop everything and drop the database volume
	$(COMPOSE) down -v

# --- real data: backup, restore, reset ---------------------------------------
# Dumps land in ./backups, which is gitignored. Real family data never leaves your machine.

backup:  ## Dump the database to ./backups/manual-<timestamp>.dump
	@mkdir -p $(BACKUP_DIR)
	@[ -w $(BACKUP_DIR) ] || { echo "$(BACKUP_DIR)/ is not writable by you ($$(id -un)). Fix with:"; \
		echo "  docker run --rm -v $$(pwd)/$(BACKUP_DIR):/b alpine chown -R $$(id -u):$$(id -g) /b"; exit 1; }
	@target=$(BACKUP_DIR)/manual-$(STAMP).dump; \
	if $(COMPOSE) exec -T db pg_dump -U $(PG_USER) -d $(PG_DB) -Fc > $$target; then \
		echo "wrote $$target ($$(du -h $$target | cut -f1))"; \
	else \
		rm -f $$target; echo "backup FAILED — nothing written"; exit 1; \
	fi

backups:  ## List existing dumps, newest first
	@ls -lht $(BACKUP_DIR)/*.dump 2>/dev/null || echo "no dumps yet — run: make backup"

reset-db:  ## Delete ALL family data (keeps admin accounts and uploaded files)
	@echo "This deletes every person, union, claim, merge and media row in the database."
	@echo "Admin accounts and files in backend/media/ are kept."
	@printf 'Type YES to continue: '; read answer; [ "$$answer" = "YES" ] || { echo "aborted"; exit 1; }
	@echo "Taking a safety dump first…"
	@mkdir -p $(BACKUP_DIR)
	@target=$(BACKUP_DIR)/manual-pre-reset-$(STAMP).dump; \
	if $(COMPOSE) exec -T db pg_dump -U $(PG_USER) -d $(PG_DB) -Fc > $$target; then \
		echo "safety dump: $$target"; \
	else \
		rm -f $$target; echo "safety dump FAILED — refusing to reset"; exit 1; \
	fi
	@$(MANAGE) reset_graph --confirm

restore:  ## Restore a dump: make restore FILE=backups/manual-....dump
	@[ -n "$(FILE)" ] || { echo "usage: make restore FILE=backups/<name>.dump"; exit 1; }
	@[ -f "$(FILE)" ] || { echo "no such file: $(FILE)"; exit 1; }
	@echo "This REPLACES the current database with $(FILE)."
	@printf 'Type YES to continue: '; read answer; [ "$$answer" = "YES" ] || { echo "aborted"; exit 1; }
	@echo "Stopping backend so Django holds no locks…"
	@$(COMPOSE) stop backend >/dev/null
	@$(COMPOSE) exec -T db pg_restore -U $(PG_USER) -d $(PG_DB) --clean --if-exists --no-owner < $(FILE) \
		|| echo "(pg_restore reported warnings — these are normal for --clean on a fresh database)"
	@$(COMPOSE) start backend >/dev/null
	@echo "restored from $(FILE)"
