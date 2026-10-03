#!/usr/bin/env bash
#
# Conformance: drive a real Hermes gateway relay transport against a real
# WhatRouter, with the WhatsApp side faked.
#
#   HERMES_CHECKOUT=/path/to/hermes-agent scripts/conformance/run.sh
#
# The checkout must be at the commit in scripts/conformance/HERMES_PIN (the
# relay contract is experimental and additive-only: re-run this on every bump).
# Nothing is installed into the checkout — `uv` builds a throwaway environment
# with just `websockets` and friends, and PYTHONPATH points at the sources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${WHATROUTER_PORT:-8467}"
SECRET_A="conformance-secret-a-0000000000000000"
SECRET_B="conformance-secret-b-1111111111111111"
MANAGEMENT_SECRET="conformance-management-2222222222222222"

if [[ -z "${HERMES_CHECKOUT:-}" ]]; then
  echo "error: set HERMES_CHECKOUT to a hermes-agent checkout at $(cat "$ROOT/scripts/conformance/HERMES_PIN")" >&2
  exit 2
fi
if [[ ! -d "$HERMES_CHECKOUT/gateway/relay" ]]; then
  echo "error: $HERMES_CHECKOUT does not look like a hermes-agent checkout (no gateway/relay)" >&2
  exit 2
fi

cd "$ROOT"
npm run build >/dev/null

SCRATCH="$(mktemp -d -t whatrouter-conformance-XXXXXX)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

cat > "$SCRATCH/config.yaml" <<YAML
listen: 127.0.0.1:${PORT}
public_url: http://127.0.0.1:${PORT}
data_dir: ${SCRATCH}/data
log_level: info
whatsapp:
  chunk_delay_ms: 0
default_profile: null
allow_unrouted_outbound: false
management:
  secret: ${MANAGEMENT_SECRET}
groups:
  "120363000000000001@g.us":
    listen_source: explicit
    listen: ["*"]
profiles:
  a:
    gateway_id: gw-a
    secret: ${SECRET_A}
    display_name: Profile A
    routes:
      - dm: "+34600000001"
      - group: "120363000000000001@g.us"
  b:
    gateway_id: gw-b
    secret: ${SECRET_B}
    display_name: Profile B
    routes:
      - dm: "+34600000002"
YAML

echo "==> starting whatrouter on 127.0.0.1:${PORT} (fake whatsapp)"
WHATROUTER_FAKE_WHATSAPP=1 node dist/whatrouter.js serve --config "$SCRATCH/config.yaml" \
  >"$SCRATCH/whatrouter.log" 2>&1 &
SERVER_PID=$!

ready=0
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if node -e "fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" != "1" ]]; then
  echo "error: whatrouter did not become healthy" >&2
  tail -n 40 "$SCRATCH/whatrouter.log" >&2 || true
  exit 1
fi

echo "==> running the probe against the real hermes relay transport"
set +e
PYTHONPATH="$HERMES_CHECKOUT" \
WHATROUTER_URL="http://127.0.0.1:${PORT}" \
WR_SECRET_A="$SECRET_A" \
WR_SECRET_B="$SECRET_B" \
WR_MANAGEMENT_SECRET="$MANAGEMENT_SECRET" \
  uv run --quiet --python 3.13 --with websockets --with pyyaml --with httpx --no-project \
  python "$ROOT/scripts/conformance/probe.py"
status=$?
set -e

if [[ "$status" != "0" ]]; then
  echo "--- whatrouter log (tail) ---" >&2
  tail -n 40 "$SCRATCH/whatrouter.log" >&2 || true
fi
exit "$status"
