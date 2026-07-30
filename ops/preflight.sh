#!/usr/bin/env bash
# Pre-commit safety scan for a public repository holding a private family archive.
#
# Two separate questions, because they fail differently:
#   1. Would this commit include a file that must never be public? (paths)
#   2. Does any file *about* to be committed contain a secret or a real name? (contents)
#
# Exits non-zero on any finding. Run before every commit: `make preflight`.

set -uo pipefail
cd "$(dirname "$0")/.."

findings=0
note() { printf '  \033[31m✗\033[0m %s\n' "$*"; findings=$((findings + 1)); }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

staged=$(git add -A --dry-run 2>/dev/null | sed "s/^add //;s/'//g")
[ -z "$staged" ] && staged=$(git ls-files)

echo "Pre-flight scan of $(echo "$staged" | grep -c .) file(s)"
echo
echo "Paths that must never be committed:"

# Path patterns. Each is a category of "this is real, not example".
declare -A PATHS=(
  ["a real .env"]='(^|/)\.env$|(^|/)\.env\.production$|(^|/)\.env\.local$'
  ["database dumps"]='\.(dump|sql|sqlite3|bak)$'
  ["encrypted backups"]='\.age$|\.gpg$|\.enc$'
  ["backups directory contents"]='^backups/(auto|manual|aalmaram)'
  ["uploaded media"]='^backend/media/|^media/'
  ["the friction log"]='(^|/)NOTES\.md$'
  ["SSH private keys"]='(^|/)id_(rsa|ed25519|ecdsa)$|aalmaram_deploy$|\.pem$|\.ppk$'
  ["age identities"]='age-identity|age-key|identity\.txt$'
  ["rclone config"]='rclone\.conf$'
  ["the secrets directory"]='^secrets/'
  ["deploy host config"]='(^|/)\.deploy\.env$'
  ["cloud credentials"]='(^|/)\.aws/|(^|/)\.oci/|credentials\.json$|service-account.*\.json$'
)
for label in "${!PATHS[@]}"; do
  hits=$(echo "$staged" | grep -E "${PATHS[$label]}" || true)
  if [ -n "$hits" ]; then
    note "$label:"; echo "$hits" | sed 's/^/      /'
  fi
done
[ "$findings" -eq 0 ] && ok "no forbidden paths"

echo
echo "Secrets and personal data inside those files:"

# Content patterns. Skip lockfiles and this scanner (it necessarily contains the patterns).
scan_files=$(echo "$staged" | grep -vE 'package-lock\.json|ops/preflight\.sh|\.env\.production\.example')

declare -A CONTENT=(
  ["private key block"]='BEGIN (RSA |OPENSSH |EC |PGP )?PRIVATE KEY'
  ["age secret key"]='AGE-SECRET-KEY-1'
  ["AWS access key"]='AKIA[0-9A-Z]{16}'
  ["Backblaze application key"]='\b[A-Za-z0-9]{31}\b.*applicationKey|applicationKey.*=.*[A-Za-z0-9]{25,}'
  ["personal email"]='febinmichealantony|@gmail\.com'
  ["known dev password"]='localdevpassword'
  ["a filled-in SECRET_KEY"]='DJANGO_SECRET_KEY=(?!.*(build-time-only|change-me|dev-only|example|placeholder|CHANGEME))[^[:space:]]{20,}'
  ["a filled-in DB password"]='POSTGRES_PASSWORD=(?!.*(build-time-only|change-me|dev-only|example|placeholder|CHANGEME))[^[:space:]]{8,}'
  ["a filled-in age recipient"]='AGE_RECIPIENT=age1[a-z0-9]{20,}'
  ["a public IP address"]='\b((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b'
)
for label in "${!CONTENT[@]}"; do
  # Two patterns need PCRE lookahead to exclude self-declared placeholders.
  grep_flags="-lEI"
  case "$label" in "a filled-in "*) grep_flags="-lPI" ;; esac
  hits=$(echo "$scan_files" | tr '\n' '\0' | xargs -0 -r grep $grep_flags "${CONTENT[$label]}" 2>/dev/null || true)
  # Loopback and RFC1918 in docs/compose are expected; only flag routable addresses.
  if [ "$label" = "a public IP address" ] && [ -n "$hits" ]; then
    filtered=""
    for f in $hits; do
      if grep -oEI '\b((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b' "$f" 2>/dev/null |
         grep -vE '^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)' | grep -q .; then
        filtered="$filtered $f"
      fi
    done
    hits=$(echo "$filtered" | tr ' ' '\n' | grep -v '^$' || true)
  fi
  [ -n "$hits" ] && { note "$label in:"; echo "$hits" | sed 's/^/      /'; }
done

echo
if [ "$findings" -eq 0 ]; then
  ok "nothing sensitive found — safe to commit"
  exit 0
fi
printf '\n\033[31m%s finding(s). Nothing was committed.\033[0m\n' "$findings"
exit 1
