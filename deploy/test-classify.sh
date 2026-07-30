#!/usr/bin/env bash
# Tests for the launch loop's error classifier.
#
# The classifier decides whether an overnight run keeps waiting or stops, so it is worth
# more than a reading. classify() is pulled out of the real script rather than copied, so
# these test what actually ships. Samples are real Oracle responses where we have them.
#
#   ./deploy/test-classify.sh
eval "$(sed -n '/^classify() {/,/^}/p' deploy/oci-launch-retry.sh)"

pass=0; fail=0
t() {
  got=$(classify "$2")
  if [ "$got" = "$3" ]; then printf '  \033[32m✓\033[0m %-38s -> %s\n' "$1" "$got"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-38s -> %s (expected %s)\n' "$1" "$got" "$3"; fail=$((fail+1)); fi
}

t "A1 capacity (real Oracle response)" '{"code": "InternalError", "message": "Out of host capacity.", "status": 500, "target_service": "compute"}' capacity
t "capacity, plain wording"            'ServiceError: OutOfHostCapacity for shape VM.Standard.A1.Flex' capacity
t "429 (the one we actually hit)"      '{"code": "TooManyRequests", "message": "Too many requests for the user", "status": 429}' throttle
t "RequestException (attempt 2)"       'RequestException: {"client_version": "Oracle-PythonCLI/3.90.0", "logging_tips": "Please run the OCI CLI command using --debug flag"}' transport
t "connect timeout"                    'oci.exceptions.ConnectTimeout: HTTPSConnectionPool(host=..): Max retries exceeded' transport
t "DNS failure"                        'Temporary failure in name resolution' transport
t "TLS failure"                        'SSLError: certificate verify failed' transport
t "expired/invalid credential"         '{"code": "NotAuthenticated", "message": "The required information to complete authentication was not provided", "status": 401}' fatal
t "policy denial"                      '{"code": "NotAuthorizedOrNotFound", "status": 404}' fatal
t "Always Free quota exhausted"        '{"code": "LimitExceeded", "message": "Service limit for A1 exceeded", "status": 400}' fatal
t "bad shape config"                   '{"code": "InvalidParameter", "message": "shape-config invalid", "status": 400}' fatal
t "something nobody predicted"         '{"code": "SomeNewOracleError", "message": "wat", "status": 418}' unknown
t "empty output"                       '' unknown

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
