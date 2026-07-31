COMPOSE ?= docker compose
MANAGE = $(COMPOSE) run --rm backend python manage.py

PG_USER = $${POSTGRES_USER:-aalmaram}
PG_DB = $${POSTGRES_DB:-aalmaram}
BACKUP_DIR = backups
STAMP = $$(date +%Y%m%d-%H%M%S)

.PHONY: help build up down logs migrate makemigrations test test-cov check-frontend seed \
        superuser shell dbshell lint fmt clean reset-db backup restore backups preflight \
        prod-config prod-build-local prod-deploy prod-ps prod-logs prod-migrate \
        prod-superuser prod-shell prod-backup prod-restore-rehearse prod-verify

# Deploy target. Kept in .deploy.env (gitignored) so no host or IP is ever committed.
-include .deploy.env
SSH_KEY ?= ~/.ssh/aalmaram_deploy
SSH = ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new ubuntu@$(PROD_HOST)
REMOTE_DIR ?= /opt/aalmaram
DC_PROD = docker compose -f docker-compose.prod.yml --env-file .env.production

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

check-frontend:  ## Build the explorer and run the headless layout + interaction checks
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

preflight:  ## Scan for secrets and personal data before committing
	@./ops/preflight.sh

# --- production --------------------------------------------------------------
# Everything below runs on the VM over SSH. Set PROD_HOST in .deploy.env first:
#     echo 'PROD_HOST=203.0.113.10' > .deploy.env

define require_host
	@[ -n "$(PROD_HOST)" ] || { echo "PROD_HOST is not set. Put it in .deploy.env"; exit 1; }
endef

prod-config:  ## Validate the production compose file locally
	@docker compose -f docker-compose.prod.yml --env-file .env.production.example config -q \
		&& echo "docker-compose.prod.yml is valid"

prod-build-local:  ## Build the production images locally (no deploy, no secrets needed)
	@docker compose -f docker-compose.prod.yml --env-file .env.production.example build backend backup

prod-deploy:  ## Pull, rebuild and restart the stack on the VM
	$(require_host)
	@$(SSH) 'cd $(REMOTE_DIR) && git pull --ff-only && $(DC_PROD) build && $(DC_PROD) up -d && \
		$(DC_PROD) run --rm backend python manage.py migrate --noinput'
	@echo "deployed (static files are baked into the image at build time)"

prod-ps:  ## Service status on the VM
	$(require_host)
	@$(SSH) 'cd $(REMOTE_DIR) && $(DC_PROD) ps'

prod-logs:  ## Tail production logs (make prod-logs SERVICE=caddy)
	$(require_host)
	@$(SSH) 'cd $(REMOTE_DIR) && $(DC_PROD) logs -f --tail=100 $(SERVICE)'

prod-migrate:  ## Run migrations on the VM
	$(require_host)
	@$(SSH) 'cd $(REMOTE_DIR) && $(DC_PROD) run --rm backend python manage.py migrate'

prod-superuser:  ## Create an admin account on the VM (prompts you at this terminal)
	$(require_host)
	@$(SSH) -t 'cd $(REMOTE_DIR) && $(DC_PROD) run --rm backend python manage.py createsuperuser'

prod-shell:  ## Django shell on the VM
	$(require_host)
	@$(SSH) -t 'cd $(REMOTE_DIR) && $(DC_PROD) run --rm backend python manage.py shell'

prod-backup:  ## Take one encrypted backup now and push it off-box
	$(require_host)
	@$(SSH) 'cd $(REMOTE_DIR) && $(DC_PROD) run --rm -e RUN_ONCE=1 backup'

prod-restore-rehearse:  ## Restore the newest remote backup into a scratch DB and diff counts
	$(require_host)
	@$(SSH) 'cd $(REMOTE_DIR) && $(DC_PROD) run --rm \
		-v $(REMOTE_DIR)/secrets:/secrets:ro --entrypoint /usr/local/bin/prod-restore.sh \
		backup rehearse'

prod-verify:  ## Check the live site from outside
	@./ops/verify-prod.sh

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
