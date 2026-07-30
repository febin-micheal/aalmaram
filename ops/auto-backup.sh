#!/bin/sh
# Daily safety net.
#
# Runs as its own compose service so the owner never has to remember to back up, and so no
# host cron entry is needed. Dumps once on start — the safety net exists from the first
# `make up` — then once a day, keeping the newest RETAIN automatic dumps.
#
# Manual dumps from `make backup` are named manual-*.dump and are never pruned here.

set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
RETAIN=${RETAIN:-14}
INTERVAL=${INTERVAL:-86400}

mkdir -p "$BACKUP_DIR"

while true; do
    stamp=$(date +%Y%m%d-%H%M%S)
    target="$BACKUP_DIR/auto-$stamp.dump"

    if pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$target"; then
        echo "[auto-backup] wrote $target ($(du -h "$target" | cut -f1))"
        # Prune oldest automatic dumps beyond RETAIN. Manual dumps are untouched.
        ls -1t "$BACKUP_DIR"/auto-*.dump 2>/dev/null | tail -n "+$((RETAIN + 1))" | while read -r old; do
            echo "[auto-backup] pruning $old"
            rm -f "$old"
        done
    else
        # A failed dump must not kill the loop; the next cycle tries again.
        echo "[auto-backup] dump FAILED at $stamp" >&2
        rm -f "$target"
    fi

    sleep "$INTERVAL"
done
