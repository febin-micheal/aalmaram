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
# Designed to outlive the terminal that started it: run under nohup, state in files.

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/launch-attempts.log"
RESULT="$HERE/instance.env"
PIDFILE="$HERE/launch.pid"

INSTANCE_NAME=${INSTANCE_NAME:-aalmaram}
SSH_PUBKEY=${SSH_PUBKEY:-$HOME/.ssh/aalmaram_deploy.pub}
BASE_INTERVAL=${BASE_INTERVAL:-300}       # 5 minutes between real attempts
THROTTLE_BACKOFF=${THROTTLE_BACKOFF:-900} # 15 minutes after an HTTP 429
BIG_SHAPE_EVERY=${BIG_SHAPE_EVERY:-6}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-0}           # 0 = forever

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

[ -f "$HERE/network.env" ] || { log "FATAL: deploy/network.env missing — run oci-network.sh first"; exit 1; }
# shellcheck disable=SC1091
. "$HERE/network.env"
[ -f "$SSH_PUBKEY" ] || { log "FATAL: no SSH public key at $SSH_PUBKEY"; exit 1; }

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# --- availability domain -----------------------------------------------------
AD=$(oci iam availability-domain list --compartment-id "$COMPARTMENT_OCID" \
     --query 'data[0].name' --raw-output 2>/dev/null)
[ -n "$AD" ] || { log "FATAL: could not list availability domains"; exit 1; }
log "availability domain: $AD"

# --- image -------------------------------------------------------------------
# Query rather than hard-code: image OCIDs are region-specific and Canonical republishes
# them regularly, so a pinned OCID goes stale and fails in a confusing way.
IMAGE_ID=${IMAGE_OCID:-$(oci compute image list --compartment-id "$COMPARTMENT_OCID" \
  --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
  --shape "VM.Standard.A1.Flex" --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output 2>/dev/null)}

if [ -z "$IMAGE_ID" ] || [ "$IMAGE_ID" = "null" ]; then
  log "FATAL: no Ubuntu 24.04 aarch64 image found for VM.Standard.A1.Flex"
  exit 1
fi
IMAGE_NAME=$(oci compute image get --image-id "$IMAGE_ID" --query 'data."display-name"' --raw-output 2>/dev/null)
log "image: $IMAGE_NAME"
log "       $IMAGE_ID"
log "subnet: $SUBNET_OCID"
log "starting retry loop — every ~${BASE_INTERVAL}s with jitter; every ${BIG_SHAPE_EVERY}th attempt tries the larger shape"
log ""

attempt=0
while :; do
  attempt=$((attempt + 1))

  if [ $((attempt % BIG_SHAPE_EVERY)) -eq 0 ]; then
    OCPUS=2; MEM=12
  else
    OCPUS=1; MEM=6
  fi

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
  status=$?

  if [ $status -eq 0 ] && echo "$out" | grep -q '^ocid1.instance'; then
    INSTANCE_ID=$(echo "$out" | grep '^ocid1.instance' | head -1)
    log "attempt $attempt (${OCPUS} OCPU / ${MEM} GB): SUCCESS — $INSTANCE_ID"

    PUBLIC_IP=""
    for _ in $(seq 1 20); do
      PUBLIC_IP=$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" \
                  --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
      [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "null" ] && break
      sleep 5
    done

    cat > "$RESULT" <<EOF
INSTANCE_OCID=$INSTANCE_ID
PUBLIC_IP=$PUBLIC_IP
SHAPE=VM.Standard.A1.Flex
OCPUS=$OCPUS
MEMORY_GB=$MEM
IMAGE_NAME=$IMAGE_NAME
LAUNCHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    log "public IP: $PUBLIC_IP"
    log "wrote $RESULT"

    # Ubuntu's cloud-init and firewall need a moment after RUNNING.
    log "waiting for SSH (up to 5 minutes)…"
    ssh_ok=0
    for i in $(seq 1 30); do
      if ssh -i "${SSH_PUBKEY%.pub}" -o StrictHostKeyChecking=accept-new \
             -o ConnectTimeout=8 -o BatchMode=yes "ubuntu@$PUBLIC_IP" true 2>/dev/null; then
        ssh_ok=1
        log "SSH is up after $((i * 10))s"
        break
      fi
      sleep 10
    done
    [ $ssh_ok -eq 1 ] || log "WARNING: instance is RUNNING but SSH did not answer within 5 minutes"

    log "DONE — stopping the retry loop"
    exit 0
  fi

  # Anything that is not a capacity problem will not fix itself by waiting.
  if echo "$out" | grep -qiE 'NotAuthenticated|not authorized|NotAuthorizedOrNotFound|QuotaExceeded|LimitExceeded'; then
    log "attempt $attempt: FATAL — not a capacity problem, stopping so it can be looked at"
    echo "$out" | head -20 | tee -a "$LOG"
    exit 1
  fi

  # Oracle rate-limits launch_instance per user (HTTP 429). Retrying through a throttle
  # only deepens it, and a throttled attempt never had a chance at capacity — so back off
  # hard and do not let it consume an attempt number or the big-shape rotation.
  if echo "$out" | grep -qiE 'TooManyRequests|"status": 429'; then
    attempt=$((attempt - 1))
    log "throttled (429) — backing off ${THROTTLE_BACKOFF}s; this does not count as an attempt"
    sleep $((THROTTLE_BACKOFF + RANDOM % 120))
    continue
  fi

  # "Out of host capacity" arrives as a 500 InternalError for A1.Flex. That is the queue.
  reason=$(echo "$out" | grep -oiE 'out of host capacity|outofcapacity|internalerror' | head -1)
  reason=${reason:-$(echo "$out" | tr '\n' ' ' | cut -c1-140)}
  log "attempt $attempt (${OCPUS} OCPU / ${MEM} GB): $reason"

  [ "$MAX_ATTEMPTS" -gt 0 ] && [ "$attempt" -ge "$MAX_ATTEMPTS" ] && { log "gave up after $attempt attempts"; exit 1; }

  # Jitter so we are not hammering the same instant every cycle.
  sleep $((BASE_INTERVAL + RANDOM % 90))
done
