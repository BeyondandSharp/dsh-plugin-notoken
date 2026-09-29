#!/usr/bin/env bash
# End-to-end verification of the notoken login entry against throwaway DSH
# instances. It proves the entry mints the real browser cookie (303 plus
# Set-Cookie, with no token anywhere in the response), that the clean URL's
# behaviour is unchanged, and that the connection trust fence — including its
# diagnostics and the `allowCrossSiteNavigation` opt-in — behaves as documented.
#
#   bash verify/e2e.sh
#
# Point DSH_CLI at your dsh executable when `dsh` is not on PATH, e.g.
#   DSH_CLI='node /path/to/checkout/apps/cli/lib/bin.js' bash verify/e2e.sh
#
# Nothing here touches the live GUI or the live profile: each instance gets its
# own DSH_HOME (removed before the run) and its own port.

set -uo pipefail

PLUGIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# A command line, not just a path: it may be `dsh`, or `node /path/to/bin.js`.
CLI=${DSH_CLI:-dsh}
HEADERS=$(mktemp)
BODY=$(mktemp)
PID=""
FAILURES=0
CHECKS=0

if ! command -v "${CLI%% *}" >/dev/null 2>&1; then
  echo "error: '${CLI%% *}' not found on PATH." >&2
  echo "       set DSH_CLI, e.g. DSH_CLI='node /path/to/dsh/apps/cli/lib/bin.js'" >&2
  exit 2
fi

stop_instance() {
  if [ -n "$PID" ]; then
    kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    sleep 1
    kill -KILL -"$PID" 2>/dev/null || true
    PID=""
  fi
}

cleanup() {
  stop_instance
  rm -f "$HEADERS" "$BODY"
}
trap cleanup EXIT

check() {
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s (%s)\n' "$1" "$3"
  else
    printf 'FAIL  %s: expected %s, got %s\n' "$1" "$2" "$3"
    FAILURES=$((FAILURES + 1))
  fi
}

status_of() {
  curl -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000
}

# boot_instance <overlay-file> <port> <label>
boot_instance() {
  INSTANCE_PORT="$2"
  HOME_DIR="$PLUGIN_DIR/.verify-home-$3"
  LOG="$PLUGIN_DIR/.verify-home-$3.log"
  JAR="$HOME_DIR/cookies.txt"
  BASE="http://127.0.0.1:$2"
  rm -rf "$HOME_DIR" "$LOG"
  mkdir -p "$HOME_DIR"
  echo "booting throwaway instance '$3' on port $2 (DSH_HOME=$HOME_DIR)"
  # A shipped profile name cannot be a --from-default-profile target, so each
  # throwaway profile is a distinct name composed from the shipped web template.
  setsid env DSH_HOME="$HOME_DIR" $CLI \
    --profile "notoken-verify-$3" --from-default-profile web \
    --patch "$PLUGIN_DIR/verify/$1" --port "$2" --no-open >"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 180); do
    grep -q '^dsh web: ' "$LOG" 2>/dev/null && break
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if ! grep -q '^dsh web: ' "$LOG" 2>/dev/null; then
    echo "FAIL  instance '$3' did not become ready; last log lines:"
    tail -n 30 "$LOG"
    exit 1
  fi
}

# ── phase 1: default (strict) configuration ─────────────────────────────────
boot_instance overlay.yml 3199 strict

# 1. the login entry itself mints the session cookie without exposing the token.
CODE=$(curl -sS -D "$HEADERS" -o "$BODY" -c "$JAR" -w '%{http_code}' "$BASE/__dsh_login")
check 'GET /__dsh_login -> 303' 303 "$CODE"
check 'entry sets the dsh-auth cookie' yes "$(grep -qi '^set-cookie: dsh-auth-' "$HEADERS" && echo yes || echo no)"
check 'entry redirects to ./' yes "$(grep -qi '^location: \./' "$HEADERS" && echo yes || echo no)"
check 'entry response carries no token' no "$(grep -qi 'token' "$HEADERS" "$BODY" && echo yes || echo no)"

# 2. the clean URL works with the minted cookie.
check 'GET / with cookie -> 200' 200 "$(status_of -b "$JAR" "$BASE/")"
check 'GET / with cookie serves html' yes "$(curl -s -b "$JAR" "$BASE/" | grep -qi '<!doctype html' && echo yes || echo no)"

# 3. the clean URL is unchanged without a cookie.
check 'GET / without cookie -> 401' 401 "$(status_of "$BASE/")"

# 4. the connection trust fence still refuses what it always refused.
check 'untrusted Host -> 403' 403 "$(status_of -H 'Host: evil.example.com' "$BASE/__dsh_login")"
check 'untrusted Host gets no cookie' no "$(curl -s -D - -o /dev/null -H 'Host: evil.example.com' "$BASE/__dsh_login" | grep -qi '^set-cookie:' && echo yes || echo no)"
check 'cross-site marker -> 403 by default' 403 "$(status_of -H 'Sec-Fetch-Site: cross-site' "$BASE/__dsh_login")"
check 'Origin: null -> 403 by default' 403 "$(status_of -H 'Origin: null' "$BASE/__dsh_login")"
check '403 body names the fence' yes "$(curl -s -H 'Host: evil.example.com' "$BASE/__dsh_login" | grep -qi 'connection trust fence' && echo yes || echo no)"

# 5. method handling.
check 'POST /__dsh_login -> 405' 405 "$(status_of -X POST "$BASE/__dsh_login")"

# 6. the minted cookie stays bound to the authority it was minted for.
check 'foreign loopback authority -> 401' 401 "$(status_of -b "$JAR" -H 'Host: 127.0.0.1:9999' "$BASE/")"

stop_instance

# ── phase 2: allowCrossSiteNavigation ───────────────────────────────────────
boot_instance overlay-cross-site.yml 3200 cross-site

# A navigation the browser labelled cross-site is served the shell IN THIS
# RESPONSE: a 303 back to '/' would loop, because the whole app-initiated chain
# withholds the SameSite=Strict cookie.
check 'cross-site navigation -> 200 shell' 200 "$(status_of -c "$JAR" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' "$BASE/__dsh_login")"
check 'shell response sets the cookie' yes "$(curl -s -D - -o /dev/null -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' "$BASE/__dsh_login" | grep -qi '^set-cookie: dsh-auth-' && echo yes || echo no)"
check 'shell response is html' yes "$(curl -s -D - -o /dev/null -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' "$BASE/__dsh_login" | grep -qi '^content-type: text/html' && echo yes || echo no)"
check 'shell body is the application shell' yes "$(curl -s -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' "$BASE/__dsh_login" | grep -qi 'id="root"' && echo yes || echo no)"
check 'the launched cookie works on /' 200 "$(status_of -b "$JAR" "$BASE/")"
# Subresource shapes keep the redirect: a fetch follows it fine.
check 'Origin: null subresource -> 303' 303 "$(status_of -H 'Origin: null' -H 'Sec-Fetch-Mode: cors' "$BASE/__dsh_login")"
check 'android-app Origin subresource -> 303' 303 "$(status_of -H 'Origin: android-app://com.google.android.webapk' -H 'Sec-Fetch-Mode: cors' "$BASE/__dsh_login")"
check 'still 403 for an untrusted Host' 403 "$(status_of -H 'Host: evil.example.com' -H 'Sec-Fetch-Site: cross-site' "$BASE/__dsh_login")"
# Faithful end-to-end: proxy shape (`error_page 401`) plus a cookie withheld on
# every hop, which is what an installed application launch actually sends.
if node "$PLUGIN_DIR/verify/webapk-flow.mjs" "$INSTANCE_PORT" >/dev/null 2>&1; then
  check 'installed-app launch through a proxy completes' yes yes
else
  check 'installed-app launch through a proxy completes' yes no
fi

printf '\n%d checks, %d failures\n' "$CHECKS" "$FAILURES"
if [ "$FAILURES" -ne 0 ]; then
  echo '--- instance log tails ---'
  tail -n 20 "$PLUGIN_DIR"/.verify-home-*.log
  exit 1
fi
echo 'e2e: PASS'
