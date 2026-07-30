# Deploying Aalmaram

Provisioning and deploy tooling for the production VM at `family.bulkbeing.in`.

Nothing in this directory holds a credential. `network.env`, `instance.env`,
`launch-attempts.log` and `launch.pid` are generated at runtime and gitignored; OCI keys
live in `~/.oci/` and the SSH key in `~/.ssh/aalmaram_deploy`, both outside the repo.

## Why the CLI rather than the console

`VM.Standard.A1.Flex` is the Always Free ARM shape, and in a single-AD region like
`ap-hyderabad-1` it is usually out of capacity. That is not a failure to work around — it
is a queue. Capacity frees continuously as other tenants release instances, so the console
wizard fails while a patient poll succeeds, often within hours.

## One-time setup

```bash
pipx install oci-cli                    # installed this way; the standalone installer also works
```

The API signing keypair is generated with `openssl` rather than `oci setup keys`, because
that command insists on an interactive TTY for the passphrase prompt and an unattended CLI
needs a passphrase-free key anyway:

```bash
openssl genrsa -out ~/.oci/oci_api_key.pem 2048 && chmod 600 ~/.oci/oci_api_key.pem
openssl rsa -pubout -in ~/.oci/oci_api_key.pem -out ~/.oci/oci_api_key_public.pem
```

Upload `~/.oci/oci_api_key_public.pem` in the console under **Profile → My profile → API
keys → Add API key → Paste public key**, then copy the *Configuration file preview* it
shows into `~/.oci/config`.

Verify before doing anything else:

```bash
oci iam region list --output table
```

## Provision

```bash
./deploy/oci-network.sh          # idempotent: reuses any VCN/subnet that already exists
nohup ./deploy/oci-launch-retry.sh > /dev/null 2>&1 &
```

**Watch it:**

```bash
tail -f deploy/launch-attempts.log
```

**Stop it:**

```bash
kill "$(cat deploy/launch.pid)"
```

**When it succeeds** it writes `deploy/instance.env` with the instance OCID, public IP and
the shape it actually got, verifies SSH, and exits.

### Retry strategy

| | |
|---|---|
| Interval | 5 minutes + up to 90s jitter |
| Usual request | 1 OCPU / 6 GB — a smaller ask fits more free slots |
| Every 6th attempt | 2 OCPU / 12 GB, in case a larger slot opened |

### How failures are classified

An overnight loop that treats every failure as "still waiting for capacity" will happily
run for eight hours against an expired credential. So every failure is matched against
explicit patterns, and **the full raw error of every attempt is written to
`launch-errors.log`, never truncated**. The one-line entries in `launch-attempts.log` are
a readable summary, not the evidence.

| Class | Recognised by | Action |
|---|---|---|
| **capacity** | `Out of host capacity` / `InternalError` + HTTP 500 | Retry after ~5 min. This is the queue. |
| **throttle** | `TooManyRequests` / HTTP 429 | Back off 15 min. Does **not** count as an attempt — a throttled call never reached the capacity check. |
| **transport** | `RequestException`, `ConnectTimeout`, DNS/TLS/reset | Back off 2 min. Our network failed, not Oracle's capacity, so it does not count either. |
| **fatal** | auth, policy, quota, limit, bad parameter | Halt immediately. Waiting cannot fix any of these. |
| **unknown** | anything else | Log in full and halt after 3 in a row. Never silently absorbed into the retry. |

The confirmed A1.Flex capacity response, for reference:

```json
{ "code": "InternalError", "message": "Out of host capacity.", "status": 500 }
```

### Duplicate protection

A transport failure can hide a request that *did* reach Oracle: the launch succeeds and
the response is lost. Retrying blindly would create a second instance and burn the Always
Free quota. Every iteration therefore checks for an existing instance named `aalmaram`
first and adopts it rather than launching another.

Both shapes sit inside Always Free (4 OCPU / 24 GB across all A1 instances). The script
cannot create a paid resource.

## Resizing later

If the loop lands 1 OCPU / 6 GB and you want the full 2 OCPU / 12 GB later, A1.Flex can be
resized in place. It requires a reboot, so do it before real data is being entered:

```bash
. deploy/instance.env
oci compute instance update --instance-id "$INSTANCE_OCID" \
  --shape-config '{"ocpus":2,"memoryInGBs":12}' \
  --force --wait-for-state RUNNING
```

The public IP is retained across the reboot, so DNS does not change. Check capacity is
available first — the resize can itself fail with `OutOfCapacity`, leaving the instance on
its original shape (it does not destroy anything).

## After the instance exists

Deployment continues with Stage 2 of the plan: harden, install Docker, clone, write
`.env.production` on the VM, bring the stack up. The `make prod-*` targets in the root
Makefile drive it over SSH once `PROD_HOST` is set in `.deploy.env`.
