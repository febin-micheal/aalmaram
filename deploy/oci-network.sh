#!/usr/bin/env bash
# Network prerequisites for the Aalmaram VM — check first, create only what is missing.
#
# The console wizard that failed on capacity may or may not have left a VCN behind, and
# re-running a create blindly would either error or quietly build a second parallel VCN.
# So every step here queries for an existing resource by display name and reuses it.
# Running this twice is a no-op; that is the point.
#
# Creates nothing outside Always Free: a VCN, an internet gateway, a route table rule, a
# public subnet and security list rules cost nothing.

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

VCN_NAME=${VCN_NAME:-aalmaram-vcn}
SUBNET_NAME=${SUBNET_NAME:-aalmaram-public-subnet}
IG_NAME=${IG_NAME:-aalmaram-igw}
VCN_CIDR=${VCN_CIDR:-10.0.0.0/16}
SUBNET_CIDR=${SUBNET_CIDR:-10.0.0.0/24}

created=()
reused=()

say() { printf '%s\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# The root compartment IS the tenancy — `compartment list` only returns its children, so
# read the tenancy OCID straight from the CLI config.
C=$(awk -F= '/^tenancy[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2}' "${OCI_CONFIG_FILE:-$HOME/.oci/config}" 2>/dev/null | head -1)
COMPARTMENT=${COMPARTMENT_OCID:-$C}
[ -n "$COMPARTMENT" ] || die "could not determine the root compartment OCID"
say "compartment: $COMPARTMENT"
say ""

# --- VCN ---------------------------------------------------------------------
VCN_ID=$(oci network vcn list --compartment-id "$COMPARTMENT" --display-name "$VCN_NAME" \
  --query "data[?\"lifecycle-state\"=='AVAILABLE'] | [0].id" --raw-output 2>/dev/null)

if [ -n "$VCN_ID" ] && [ "$VCN_ID" != "null" ]; then
  reused+=("VCN $VCN_NAME = $VCN_ID")
else
  say "creating VCN $VCN_NAME ($VCN_CIDR)…"
  VCN_ID=$(oci network vcn create --compartment-id "$COMPARTMENT" --display-name "$VCN_NAME" \
    --cidr-blocks "[\"$VCN_CIDR\"]" --dns-label aalmaram --wait-for-state AVAILABLE \
    --query 'data.id' --raw-output) || die "VCN create failed"
  created+=("VCN $VCN_NAME = $VCN_ID")
fi

# --- internet gateway --------------------------------------------------------
IG_ID=$(oci network internet-gateway list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
  --display-name "$IG_NAME" --query "data[?\"lifecycle-state\"=='AVAILABLE'] | [0].id" --raw-output 2>/dev/null)

if [ -n "$IG_ID" ] && [ "$IG_ID" != "null" ]; then
  reused+=("internet gateway = $IG_ID")
else
  say "creating internet gateway…"
  IG_ID=$(oci network internet-gateway create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --is-enabled true --display-name "$IG_NAME" --wait-for-state AVAILABLE \
    --query 'data.id' --raw-output) || die "internet gateway create failed"
  created+=("internet gateway = $IG_ID")
fi

# --- default route table: 0.0.0.0/0 -> IGW -----------------------------------
RT_ID=$(oci network vcn get --vcn-id "$VCN_ID" --query 'data."default-route-table-id"' --raw-output)
HAS_ROUTE=$(oci network route-table get --rt-id "$RT_ID" \
  --query "data.\"route-rules\"[?destination=='0.0.0.0/0'] | length(@)" --raw-output 2>/dev/null || echo 0)

if [ "$HAS_ROUTE" = "0" ]; then
  say "adding default route 0.0.0.0/0 -> internet gateway…"
  oci network route-table update --rt-id "$RT_ID" --force \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IG_ID\"}]" \
    >/dev/null || die "route rule update failed"
  created+=("route 0.0.0.0/0 -> IGW on $RT_ID")
else
  reused+=("default route already present on $RT_ID")
fi

# --- security list: 22, 80, 443 ----------------------------------------------
SL_ID=$(oci network vcn get --vcn-id "$VCN_ID" --query 'data."default-security-list-id"' --raw-output)
OPEN_PORTS=$(oci network security-list get --security-list-id "$SL_ID" \
  --query "data.\"ingress-security-rules\"[].\"tcp-options\".\"destination-port-range\".max" --raw-output 2>/dev/null | tr -d '[] ' | tr '\n' ',')

if echo "$OPEN_PORTS" | grep -q 443 && echo "$OPEN_PORTS" | grep -q 80; then
  reused+=("security list already allows 22/80/443 = $SL_ID")
else
  say "opening TCP 22, 80, 443 (stateful) on the default security list…"
  rule() { echo "{\"protocol\":\"6\",\"source\":\"0.0.0.0/0\",\"isStateless\":false,\"tcpOptions\":{\"destinationPortRange\":{\"min\":$1,\"max\":$1}}}"; }
  oci network security-list update --security-list-id "$SL_ID" --force \
    --ingress-security-rules "[$(rule 22),$(rule 80),$(rule 443)]" \
    --egress-security-rules '[{"protocol":"all","destination":"0.0.0.0/0","isStateless":false}]' \
    >/dev/null || die "security list update failed"
  created+=("ingress 22/80/443 on $SL_ID")
fi

# --- public subnet -----------------------------------------------------------
SUBNET_ID=$(oci network subnet list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
  --display-name "$SUBNET_NAME" --query "data[?\"lifecycle-state\"=='AVAILABLE'] | [0].id" --raw-output 2>/dev/null)

if [ -n "$SUBNET_ID" ] && [ "$SUBNET_ID" != "null" ]; then
  reused+=("subnet $SUBNET_NAME = $SUBNET_ID")
else
  say "creating public subnet $SUBNET_NAME ($SUBNET_CIDR)…"
  SUBNET_ID=$(oci network subnet create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --display-name "$SUBNET_NAME" --cidr-block "$SUBNET_CIDR" --dns-label public \
    --prohibit-public-ip-on-vnic false --wait-for-state AVAILABLE \
    --query 'data.id' --raw-output) || die "subnet create failed"
  created+=("subnet $SUBNET_NAME = $SUBNET_ID")
fi

# --- report ------------------------------------------------------------------
say ""
say "REUSED:"
[ ${#reused[@]} -eq 0 ] && say "  (nothing existed)" || printf '  %s\n' "${reused[@]}"
say ""
say "CREATED:"
[ ${#created[@]} -eq 0 ] && say "  (nothing needed creating)" || printf '  %s\n' "${created[@]}"
say ""

mkdir -p "$(dirname "$0")"
cat > "$(dirname "$0")/network.env" <<EOF
COMPARTMENT_OCID=$COMPARTMENT
VCN_OCID=$VCN_ID
SUBNET_OCID=$SUBNET_ID
EOF
say "wrote $(dirname "$0")/network.env (gitignored)"
