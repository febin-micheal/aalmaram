#!/bin/sh
# Restore rehearsal, and real restores.
#
# A backup that has never been restored is a hope, not a backup. This script exists to be
# run on a schedule against a scratch database, not only in an emergency.
#
#   Rehearsal:  restore the newest remote dump into a throwaway database and count rows.
#               Touches nothing real.
#   Real:       same, but targets the live database. Requires --i-mean-it.
#
# Usage:
#   prod-restore.sh rehearse                 newest remote dump -> scratch db, report counts
#   prod-restore.sh rehearse <name.dump.age> a specific remote dump
#   prod-restore.sh live <name.dump.age> --i-mean-it

set -eu

MODE=${1:-rehearse}
WANTED=${2:-}
CONFIRM=${3:-}

SCRATCH_DB=${SCRATCH_DB:-aalmaram_restore_check}
WORK=/tmp/restore-check
AGE_IDENTITY=${AGE_IDENTITY:-/secrets/age-identity.txt}

log() { echo "[restore] $*"; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

: "${POSTGRES_HOST:?}" "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${RCLONE_REMOTE:?}"
[ -f "$AGE_IDENTITY" ] || die "no age identity at $AGE_IDENTITY — cannot decrypt"

rm -rf "$WORK"; mkdir -p "$WORK"

# --- fetch ------------------------------------------------------------------
if [ -z "$WANTED" ]; then
    WANTED=$(rclone lsf "$RCLONE_REMOTE" --include '*.dump.age' | sort | tail -1)
    [ -n "$WANTED" ] || die "no dumps found at $RCLONE_REMOTE"
fi
log "fetching $WANTED from $RCLONE_REMOTE"
rclone copy "$RCLONE_REMOTE/$WANTED" "$WORK/" || die "download failed"

encrypted="$WORK/$WANTED"
plain="$WORK/restored.dump"

# --- decrypt ----------------------------------------------------------------
head -c 22 "$encrypted" | grep -q "age-encryption.org" || die "$WANTED is not an age file"
age -d -i "$AGE_IDENTITY" -o "$plain" "$encrypted" || die "decryption failed"
log "decrypted $(du -h "$plain" | cut -f1)"

# --- restore ----------------------------------------------------------------
if [ "$MODE" = "live" ]; then
    [ "$CONFIRM" = "--i-mean-it" ] || die "refusing to overwrite the live database without --i-mean-it"
    TARGET="$POSTGRES_DB"
    log "restoring into the LIVE database $TARGET"
    pg_restore -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$TARGET" \
        --clean --if-exists --no-owner "$plain" 2>&1 | tail -5 || true
else
    TARGET="$SCRATCH_DB"
    log "restoring into scratch database $TARGET (the live database is untouched)"
    dropdb -h "$POSTGRES_HOST" -U "$POSTGRES_USER" --if-exists "$TARGET"
    createdb -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$TARGET"
    pg_restore -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$TARGET" --no-owner "$plain" 2>&1 | tail -5 || true
fi

# --- verify -----------------------------------------------------------------
count() {
    psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$1" -tAc \
        "SELECT COALESCE((SELECT count(*) FROM $2), 0)" 2>/dev/null || echo "?"
}

echo
log "row counts restored into $TARGET:"
for table in genealogy_person genealogy_union genealogy_unionmembership accounts_user; do
    printf '  %-28s %s\n' "$table" "$(count "$TARGET" "$table")"
done

if [ "$MODE" != "live" ]; then
    echo
    log "same tables in the LIVE database, for comparison:"
    for table in genealogy_person genealogy_union genealogy_unionmembership accounts_user; do
        printf '  %-28s %s\n' "$table" "$(count "$POSTGRES_DB" "$table")"
    done

    live_persons=$(count "$POSTGRES_DB" genealogy_person)
    restored_persons=$(count "$TARGET" genealogy_person)
    echo
    if [ "$live_persons" = "$restored_persons" ]; then
        log "MATCH: $restored_persons persons in both. The backup is restorable."
    else
        log "DIFFERENT: live=$live_persons restored=$restored_persons"
        log "(expected if rows changed after the dump was taken — check the timestamps)"
    fi

    log "dropping scratch database $TARGET"
    dropdb -h "$POSTGRES_HOST" -U "$POSTGRES_USER" --if-exists "$TARGET"
fi

rm -rf "$WORK"
log "done"
