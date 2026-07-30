#!/bin/sh
# Encrypted off-box backups.
#
# Three properties this is built for:
#
# 1. **The VM cannot read its own backups.** Encryption uses an age *public* key, so a
#    dump can be written without any decryption secret being present. Someone who takes
#    the whole machine gets ciphertext. The private identity lives in your password
#    manager (and, for operational convenience, in a root-only file — see DECISIONS.md #21).
# 2. **Off-box.** A backup on the same disk as the database is not a backup. Each dump is
#    pushed to object storage immediately after it is written.
# 3. **Loud failure.** A backup system that fails quietly is worse than none, because it
#    buys false confidence. Every failure prints and is visible in `docker compose logs`.
#
# Run once with RUN_ONCE=1 to take a single backup (that is what `make prod-backup` does).

set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
RETAIN_LOCAL=${RETAIN_LOCAL:-7}
RETAIN_REMOTE=${RETAIN_REMOTE:-30}
INTERVAL=${INTERVAL:-86400}
RUN_ONCE=${RUN_ONCE:-0}

log() { echo "[backup] $*"; }
fail() { echo "[backup] FAILED: $*" >&2; }

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required — backups are never written unencrypted}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE is required, e.g. b2:aalmaram-backups/prod}"

mkdir -p "$BACKUP_DIR"

take_backup() {
    stamp=$(date -u +%Y%m%d-%H%M%SZ)
    plain="$BACKUP_DIR/.tmp-$stamp.dump"
    target="$BACKUP_DIR/aalmaram-$stamp.dump.age"

    if ! pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$plain"; then
        fail "pg_dump at $stamp"
        rm -f "$plain"
        return 1
    fi

    # Encrypt to the public key. No secret is needed here, and none is present.
    if ! age -r "$AGE_RECIPIENT" -o "$target" "$plain"; then
        fail "age encryption at $stamp"
        rm -f "$plain" "$target"
        return 1
    fi
    rm -f "$plain"

    # Refuse to keep something that is not actually an age file.
    if ! head -c 22 "$target" | grep -q "age-encryption.org"; then
        fail "output is not age-encrypted — refusing to upload $target"
        rm -f "$target"
        return 1
    fi

    size=$(du -h "$target" | cut -f1)
    log "wrote $target ($size)"

    if ! rclone copy "$target" "$RCLONE_REMOTE" --no-traverse; then
        fail "rclone upload of $target — the local copy is kept"
        return 1
    fi
    log "uploaded to $RCLONE_REMOTE"

    # Prune local, then remote. Local is only a cache; the remote is the real backup.
    ls -1t "$BACKUP_DIR"/aalmaram-*.dump.age 2>/dev/null | tail -n "+$((RETAIN_LOCAL + 1))" |
        while read -r old; do
            log "pruning local $old"
            rm -f "$old"
        done

    rclone delete "$RCLONE_REMOTE" --min-age "$((RETAIN_REMOTE))d" 2>/dev/null ||
        log "remote prune skipped (nothing older than ${RETAIN_REMOTE}d)"

    log "remote now holds: $(rclone ls "$RCLONE_REMOTE" 2>/dev/null | wc -l) file(s)"
    return 0
}

if [ "$RUN_ONCE" = "1" ]; then
    take_backup
    exit $?
fi

while true; do
    take_backup || fail "cycle failed; retrying at the next interval"
    sleep "$INTERVAL"
done
