#!/bin/bash
# End-to-end check against an installed, enabled Tattle filter.
#
#   sudo -v && scripts/integration-test.sh [/Applications/Tattle.app]
#
# Adds temporary rules for /usr/bin/curl and /usr/bin/nc (removed on exit), makes real
# connections, and checks both the outcome and the verdict Tattle logged. Run it on a
# machine where Tattle is the only content filter, in Ask or Silently allow mode.
set -euo pipefail

APP="${1:-/Applications/Tattle.app}"
CTL="$APP/Contents/MacOS/tattlectl"
HOST_ALLOWED="example.com"
HOST_DENIED="example.org"
NC_HOST="1.1.1.1"
NC_PORT=443
RULES=()
FAILURES=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

cleanup() {
  if ((${#RULES[@]})); then
    sudo "$CTL" rules remove "${RULES[@]}" >/dev/null || echo "warning: couldn't remove test rules ${RULES[*]}" >&2
  fi
}
trap cleanup EXIT

add_rule() {
  local output id
  output=$(sudo "$CTL" rules add "$@" --note "integration-test")
  id=$(awk '{print $2}' <<<"$output")
  [[ "$id" =~ ^[0-9A-F-]{36}$ ]] || { echo "couldn't parse rule ID from: $output" >&2; exit 1; }
  RULES+=("$id")
}

# Looks for a logged connection from PROCESS to HOST with ACTION in the last 200 records.
logged() {
  local process=$1 host=$2 action=$3
  sleep 2  # the extension batches log writes
  "$CTL" log tail -n 200 --json | grep -F "\"path\":\"$process\"" | grep -F "$host" | grep -qF "\"action\":\"$action\""
}

[[ -x "$CTL" ]] || { echo "tattlectl not found at $CTL" >&2; exit 1; }

echo "Status"
if "$CTL" status >/dev/null; then pass "tattlectl reaches the extension"; else fail "tattlectl can't reach the extension"; exit 1; fi
if "$CTL" rules add --deny --host x.invalid >/dev/null 2>&1; then
  fail "unprivileged rules add was accepted"
else
  pass "unprivileged rules add is refused"
fi

echo "Rules"
add_rule --allow --path /usr/bin/curl --host "$HOST_ALLOWED" --port 443 --protocol tcp
add_rule --deny --path /usr/bin/curl --host "$HOST_DENIED"
add_rule --deny --path /usr/bin/nc --ip "$NC_HOST" --port "$NC_PORT"

if curl -sS -o /dev/null --max-time 10 "https://$HOST_ALLOWED/"; then pass "curl → $HOST_ALLOWED allowed"; else fail "curl → $HOST_ALLOWED should be allowed"; fi
if logged /usr/bin/curl "$HOST_ALLOWED" allow; then pass "allow verdict logged"; else fail "allow verdict for $HOST_ALLOWED not in log"; fi

if curl -sS -o /dev/null --max-time 10 "https://$HOST_DENIED/" 2>/dev/null; then fail "curl → $HOST_DENIED should be denied"; else pass "curl → $HOST_DENIED denied"; fi
if logged /usr/bin/curl "$HOST_DENIED" deny; then pass "deny verdict logged"; else fail "deny verdict for $HOST_DENIED not in log"; fi

if nc -z -G 5 "$NC_HOST" "$NC_PORT" 2>/dev/null; then fail "nc → $NC_HOST:$NC_PORT should be denied"; else pass "nc → $NC_HOST:$NC_PORT denied"; fi
if logged /usr/bin/nc "$NC_HOST" deny; then pass "nc deny verdict logged"; else fail "nc deny verdict not in log"; fi

echo "Loopback"
port=$(( (RANDOM % 20000) + 40000 ))
nc -l 127.0.0.1 "$port" >/dev/null 2>&1 &
listener=$!
sleep 0.5
add_rule --deny --path /usr/bin/nc --cidr 127.0.0.0/8
if nc -z -G 3 127.0.0.1 "$port"; then pass "loopback is never filtered"; else fail "loopback connection was blocked"; fi
kill "$listener" 2>/dev/null || true

echo "Export"
if "$CTL" export | grep -q '"format" : "tattle-rules"\|"format":"tattle-rules"'; then pass "export produces a rules document"; else fail "export output isn't a rules document"; fi

echo
if ((FAILURES)); then echo "$FAILURES check(s) failed."; exit 1; fi
echo "All checks passed."
