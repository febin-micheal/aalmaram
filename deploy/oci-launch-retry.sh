#!/usr/bin/env bash
# Keep asking Oracle for an Always Free ARM instance until one is available.
#
# ap-hyderabad-1 has a single availability domain and A1.Flex capacity there is contended:
# "Out of host capacity" is the normal answer, not an error to give up on. Capacity is
# released continuously as other tenants release instances, so the winning strategy is a
# patient poll rather than anything clever.
#
# Two shapes are tried. Most attempts ask for 1 OCPU / 6 GB — the smaller the request, the
# more likely a free slot fits it. Every 6th attempt asks for 2 OCPU / 12 GB, because if a
# larger slot has opened it is worth taking; both are inside Always Free (4 OCPU / 24 GB
# total). Nothing here can create a paid resource.
#
# ERRORS ARE CLASSIFIED, NEVER ASSUMED. An overnight loop that quietly treats every failure
# as "still waiting for capacity" will happily run for eight hours against an expired
# credential. Each failure is matched against explicit patterns and only then acted on;
# anything unrecognised halts the loop rather than being absorbed into the retry. The full
# raw error of every failure is written to launch-errors.log — never truncated.
#
# Designed to outlive the terminal that started it: run under nohup/setsid, state in files.

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/launch-attempts.log"
ERRLOG="$HERE/launch-errors.log"
RESULT="$HERE/instance.env"
PIDFILE="$HERE/launch.pid"

INSTANCE_NAME=${INSTANCE_NAME:-aalmaram}
SSH_PUBKEY=${SSH_PUBKEY:-$HOME/.ssh/aalmaram_deploy.pub}
BASE_INTERVAL=${BASE_INTERVAL:-300}          # between real capacity attempts
THROTTLE_BACKOFF=${THROTTLE_BACKOFF:-900}    # after an HTTP 429
TRANSPORT_BACKOFF=${TRANSPORT_BACKOFF:-120}  # after a local network failure
BIG_SHAPE_EVERY=${BIG_SHAPE_EVERY:-6}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-0}              # 0 = forever
MAX_CONSECUTIVE_UNKNOWN=${MAX_CONSECUTIVE_UNKNOWN:-3}

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

record_error() {
    # The full text, always. The one-line summary in the main log is for reading; this is
    # for finding out what actually happened.
    {
        printf '\n===== %s  attempt %s  (%s OCPU / %s GB)  classified: %s =====\n' \
               "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4"
        printf '%s\n' "$5"
    } >> "$ERRLOG"
}

# --- error classification ----------------------------------------------------
# Order matters: the most specific and most serious first.
classify() {
    local out="$1"

    # Nothing about waiting fixes a credential, a policy or a quota.
    if echo "$out" | grep -qiE 'NotAuthenticated|NotAuthorizedOrNotFound|not authorized|InvalidAuthorization|QuotaExceeded|LimitExceeded|CannotParseRequest|InvalidParameter'; then
        echo fatal; return
    fi

    # Oracle rate-limits launch_instance per user. A throttled call never reached the
    # capacity check, so it says nothing about availability.
    if echo "$out" | grep -qiE 'TooManyRequests|"status": *429'; then
        echo throttle; return
    fi

    # oci.exceptions.RequestException inherits from requests' RequestException: it is the
    # connection-level failure class (DNS, TLS, connect/read timeout, reset). The request
    # never got a service response, so this is our network, not Oracle's capacity.
    if echo "$out" | grep -qiE 'RequestException|ConnectTimeout|ConnectionError|ReadTimeout|SSLError|ProxyError|Max retries exceeded|Connection aborted|Temporary failure in name resolution|Name or service not known'; then
        echo transport; return
    fi

    # The queue we are actually waiting in. A1.Flex exhaustion surfaces as a 500
    # InternalError; some regions phrase it plainly.
    if echo "$out" | grep -qiE 'Out of host capacity|OutOfCapacity|OutOfHostCapacity'; then
        echo capacity; return
    fi
    if echo "$out" | grep -qiE '"code": *"InternalError"|InternalError' && echo "$out" | grep -qiE '"status": *5[0-9][0-9]|InternalError'; then
        echo capacity; return
    fi

    echo unknown
}

# --- adopt an instance that already exists -----------------------------------
# A transport failure can hide a request that *did* reach Oracle — the launch succeeds and
# the response is lost. Retrying blindly would then create a second instance and burn the
# Always Free quota. So before every attempt, ask whether one already exists.
find_existing() {
    oci compute instance list --compartment-id "$COMPARTMENT_OCID" \
        --display-name "$INSTANCE_NAME" \
        --query "data[?\"lifecycle-state\"=='RUNNING' || \"lifecycle-state\"=='PROVISIONING' || \"lifecycle-state\"=='STARTING'] | [0].id" \
        --raw-output 2>/dev/null
}

finish() {
    local instance_id="$1" ocpus="$2" mem="$3"
    log "instance: $instance_id"

    local public_ip=""
    for _ in $(seq 1 30); do
        public_ip=$(oci compute instance list-vnics --instance-id "$instance_id" \
                    --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
        [ -n "$public_ip" ] && [ "$public_ip" != "null" ] && break
        sleep 5
    done

    local actual
    actual=$(oci compute instance get --instance-id "$instance_id" \
             --query 'data."shape-config".{o:ocpus,m:"memory-in-gbs"}' --raw-output 2>/dev/null | tr -d '{}" \n')

    cat > "$RESULT" <<EOF
INSTANCE_OCID=$instance_id
PUBLIC_IP=$public_ip
SHAPE=VM.Standard.A1.Flex
OCPUS=$ocpus
MEMORY_GB=$mem
SHAPE_CONFIRMED=$actual
IMAGE_NAME=${IMAGE_NAME:-unknown}
LAUNCHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    log "public IP: $public_ip"
    log "shape confirmed by API: $actual"
    log "wrote $RESULT"

    log "waiting for SSH (up to 5 minutes; cloud-init needs a moment)…"
    local ok=0
    for i in $(seq 1 30); do
        if ssh -i "${SSH_PUBKEY%.pub}" -o StrictHostKeyChecking=accept-new \
               -o ConnectTimeout=8 -o BatchMode=yes "ubuntu@$public_ip" true 2>/dev/null; then
            ok=1; log "SSH is up after $((i * 10))s"; break
        fi
        sleep 10
    done
    [ $ok -eq 1 ] || log "WARNING: instance is RUNNING but SSH did not answer within 5 minutes"
    log "DONE — stopping the retry loop"
}

# --- preconditions -----------------------------------------------------------
[ -f "$HERE/network.env" ] || { log "FATAL: deploy/network.env missing — run oci-network.sh first"; exit 1; }
# shellcheck disable=SC1091
. "$HERE/network.env"
[ -f "$SSH_PUBKEY" ] || { log "FATAL: no SSH public key at $SSH_PUBKEY"; exit 1; }

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

AD=$(oci iam availability-domain list --compartment-id "$COMPARTMENT_OCID" \
     --query 'data[0].name' --raw-output 2>/dev/null)
[ -n "$AD" ] || { log "FATAL: could not list availability domains"; exit 1; }
log "availability domain: $AD"

# Query rather than hard-code: image OCIDs are region-specific and Canonical republishes
# them regularly, so a pinned OCID goes stale and fails in a confusing way.
IMAGE_ID=${IMAGE_OCID:-$(oci compute image list --compartment-id "$COMPARTMENT_OCID" \
  --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
  --shape "VM.Standard.A1.Flex" --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output 2>/dev/null)}
[ -n "$IMAGE_ID" ] && [ "$IMAGE_ID" != "null" ] || { log "FATAL: no Ubuntu 24.04 aarch64 image for A1.Flex"; exit 1; }

IMAGE_NAME=$(oci compute image get --image-id "$IMAGE_ID" --query 'data."display-name"' --raw-output 2>/dev/null)
log "image: $IMAGE_NAME"
log "subnet: $SUBNET_OCID"
log "intervals: capacity ${BASE_INTERVAL}s · throttle ${THROTTLE_BACKOFF}s · transport ${TRANSPORT_BACKOFF}s"
log "full errors -> $ERRLOG; unknown errors halt after $MAX_CONSECUTIVE_UNKNOWN in a row"
log ""

attempt=0
consecutive_unknown=0
declare -A tally=([capacity]=0 [throttle]=0 [transport]=0 [unknown]=0)

while :; do
    # Cheap insurance against a duplicate created by a lost response.
    existing=$(find_existing)
    if [ -n "$existing" ] && [ "$existing" != "null" ]; then
        log "an instance named $INSTANCE_NAME already exists — adopting it instead of launching another"
        finish "$existing" "?" "?"
        exit 0
    fi

    attempt=$((attempt + 1))
    if [ $((attempt % BIG_SHAPE_EVERY)) -eq 0 ]; then OCPUS=2; MEM=12; else OCPUS=1; MEM=6; fi

    out=$(oci compute instance launch \
          --compartment-id "$COMPARTMENT_OCID" \
          --availability-domain "$AD" \
          --display-name "$INSTANCE_NAME" \
          --image-id "$IMAGE_ID" \
          --shape VM.Standard.A1.Flex \
          --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM}" \
          --subnet-id "$SUBNET_OCID" \
          --assign-public-ip true \
          --metadata "{\"ssh_authorized_keys\":\"$(cat "$SSH_PUBKEY")\"}" \
          --wait-for-state RUNNING \
          --query 'data.id' --raw-output 2>&1)

    if echo "$out" | grep -q '^ocid1.instance'; then
        log "attempt $attempt (${OCPUS} OCPU / ${MEM} GB): SUCCESS"
        finish "$(echo "$out" | grep '^ocid1.instance' | head -1)" "$OCPUS" "$MEM"
        exit 0
    fi

    kind=$(classify "$out")
    record_error "$attempt" "$OCPUS" "$MEM" "$kind" "$out"
    tally[$kind]=$(( ${tally[$kind]:-0} + 1 ))

    case "$kind" in
      fatal)
        log "attempt $attempt: FATAL — $(echo "$out" | grep -oiE 'NotAuthenticated|NotAuthorizedOrNotFound|not authorized|QuotaExceeded|LimitExceeded|CannotParseRequest|InvalidParameter' | head -1)"
        log "this will not fix itself by waiting. Full error in $ERRLOG:"
        echo "$out" | head -25 | tee -a "$LOG"
        exit 1
        ;;
      throttle)
        attempt=$((attempt - 1))   # a throttled call never had a chance at capacity
        log "attempt $((attempt + 1)): throttled (429) — backing off ${THROTTLE_BACKOFF}s, not counted"
        sleep $((THROTTLE_BACKOFF + RANDOM % 120))
        continue
        ;;
      transport)
        attempt=$((attempt - 1))   # our network failed, not Oracle's capacity
        log "attempt $((attempt + 1)): transport failure (connection/DNS/TLS) — retrying in ${TRANSPORT_BACKOFF}s, not counted"
        consecutive_unknown=0
        sleep $((TRANSPORT_BACKOFF + RANDOM % 60))
        continue
        ;;
      capacity)
        consecutive_unknown=0
        log "attempt $attempt (${OCPUS} OCPU / ${MEM} GB): out of capacity  [capacity:${tally[capacity]} throttle:${tally[throttle]} transport:${tally[transport]}]"
        ;;
      unknown)
        consecutive_unknown=$((consecutive_unknown + 1))
        log "attempt $attempt: UNRECOGNISED ERROR ($consecutive_unknown/$MAX_CONSECUTIVE_UNKNOWN) — not assuming this is capacity"
        echo "$out" | head -15 | tee -a "$LOG"
        if [ "$consecutive_unknown" -ge "$MAX_CONSECUTIVE_UNKNOWN" ]; then
            log "halting: $consecutive_unknown unrecognised errors in a row. Full text in $ERRLOG"
            exit 1
        fi
        ;;
    esac

    [ "$MAX_ATTEMPTS" -gt 0 ] && [ "$attempt" -ge "$MAX_ATTEMPTS" ] && { log "gave up after $attempt attempts"; exit 1; }
    sleep $((BASE_INTERVAL + RANDOM % 90))
done
