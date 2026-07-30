#!/usr/bin/env bash
# Outside-in verification.
#
# Everything here is checked the way a stranger on the internet would see it: over the
# public domain, with no session, no local shortcuts, no compose network. Checking from
# inside the VM would prove the containers talk to each other, which is not the question.

set -uo pipefail

DOMAIN=${1:-family.bulkbeing.in}
BASE="https://$DOMAIN"
fails=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; fails=$((fails + 1)); }

echo "Verifying $BASE from outside"
echo

# --- DNS ---------------------------------------------------------------------
resolved=$(dig +short "$DOMAIN" A | tail -1)
if [ -n "$resolved" ]; then pass "DNS resolves to $resolved"; else fail "DNS does not resolve"; fi

# --- HTTP -> HTTPS -----------------------------------------------------------
redirect=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$DOMAIN/" --max-time 15)
code=${redirect%% *}
if [[ "$code" =~ ^30[128]$ && "$redirect" == *https://* ]]; then
  pass "HTTP $code redirects to HTTPS (${redirect#* })"
else
  fail "HTTP did not redirect to HTTPS (got: $redirect)"
fi

# --- certificate -------------------------------------------------------------
cert=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null |
       openssl x509 -noout -issuer -dates 2>/dev/null)
if [ -n "$cert" ]; then
  pass "TLS certificate present"
  echo "$cert" | sed 's/^/      /'
else
  fail "no TLS certificate — Caddy may not have completed the ACME challenge"
fi

# --- health ------------------------------------------------------------------
health=$(curl -s -o /tmp/health.$$ -w '%{http_code}' "$BASE/api/v1/health/" --max-time 15)
if [ "$health" = "200" ] && grep -q '"status": *"ok"' /tmp/health.$$; then
  pass "/api/v1/health/ 200 $(cat /tmp/health.$$)"
else
  fail "/api/v1/health/ returned $health"
fi
rm -f /tmp/health.$$

# --- the API is closed to strangers -----------------------------------------
for path in /api/v1/overview/ /api/v1/persons/ /api/v1/relate/; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path" --max-time 15)
  if [ "$status" = "403" ]; then
    pass "$path refuses anonymous callers (403)"
  else
    fail "$path returned $status — expected 403"
  fi
done

# --- admin renders but does not leak ----------------------------------------
admin=$(curl -s -o /tmp/admin.$$ -w '%{http_code}' "$BASE/admin/login/" --max-time 15)
if [ "$admin" = "200" ] && grep -qi 'csrfmiddlewaretoken' /tmp/admin.$$; then
  pass "admin login page renders with a CSRF token"
else
  fail "admin login page returned $admin"
fi
grep -qi 'DEBUG = True\|Traceback' /tmp/admin.$$ && fail "debug output visible in production"
rm -f /tmp/admin.$$

# --- the SPA is served -------------------------------------------------------
spa=$(curl -s -o /tmp/spa.$$ -w '%{http_code}' "$BASE/" -L --max-time 15)
if [ "$spa" = "200" ] && grep -qi 'aalmaram\|<div id="root">' /tmp/spa.$$; then
  pass "the explorer is served at /"
else
  fail "/ returned $spa"
fi
rm -f /tmp/spa.$$

# --- security headers --------------------------------------------------------
headers=$(curl -sI "$BASE/" --max-time 15)
for header in "strict-transport-security" "x-content-type-options" "x-frame-options" "content-security-policy"; do
  if echo "$headers" | grep -qi "^$header:"; then
    pass "$header present"
  else
    fail "$header missing"
  fi
done

# --- postgres must not be reachable -----------------------------------------
if command -v nc >/dev/null && [ -n "$resolved" ]; then
  if nc -z -w4 "$resolved" 5432 2>/dev/null; then
    fail "PORT 5432 IS OPEN TO THE INTERNET"
  else
    pass "Postgres port 5432 is not reachable from outside"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  printf '\033[32mAll checks passed.\033[0m\n'
  exit 0
fi
printf '\033[31m%s check(s) failed.\033[0m\n' "$fails"
exit 1
