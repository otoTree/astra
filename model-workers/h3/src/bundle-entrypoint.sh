#!/usr/bin/env bash
set -Eeuo pipefail

model_pid=""
agent_pid=""

shutdown() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "${agent_pid}" ]] && kill -0 "${agent_pid}" 2>/dev/null; then kill -TERM "${agent_pid}" 2>/dev/null || true; fi
  if [[ -n "${model_pid}" ]] && kill -0 "${model_pid}" 2>/dev/null; then kill -TERM "${model_pid}" 2>/dev/null || true; fi
  wait "${agent_pid}" 2>/dev/null || true
  wait "${model_pid}" 2>/dev/null || true
  exit "${status}"
}
trap shutdown EXIT INT TERM

python3 /opt/astra/h3/asset_bootstrap.py &
model_pid=$!

for _ in $(seq 1 "${ASTRA_BUNDLE_MODEL_WAIT_ATTEMPTS:-120}"); do
  if curl --fail --silent --show-error http://127.0.0.1:9000/health/live >/dev/null 2>&1; then break; fi
  if ! kill -0 "${model_pid}" 2>/dev/null; then
    wait "${model_pid}"
    exit 78
  fi
  sleep "${ASTRA_BUNDLE_MODEL_WAIT_SECONDS:-2}"
done

if ! curl --fail --silent --show-error http://127.0.0.1:9000/health/live >/dev/null 2>&1; then
  echo '{"component":"astra-h3-bundle","status":"failed","error":"model_app_live_timeout"}' >&2
  exit 78
fi

/usr/local/bin/bun run /opt/astra/apps/worker-agent/src/main.ts &
agent_pid=$!

wait -n "${model_pid}" "${agent_pid}"
