#!/usr/bin/env bash
# Start the PrismLCA dev app (Electron frontend + Python backend, spawned automatically).
#
#   ./start.sh            start (refuses if an instance is already running, and says which PIDs)
#   ./start.sh --restart  stop a running instance first, then start fresh
#   ./start.sh --status   say what is running, and exit
#
# Dev-only convenience — the packaged app ships its own launcher.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/frontend"

# What counts as a running instance: the dev-server wrapper AND the Electron binary of this checkout.
# Matching only "electron-vite" was wrong twice over. A wrapper killed by a timeout leaves the Electron
# process behind — it still holds the Brightway project, so the next start fails in a way that points
# nowhere. And the bare pattern also matches any shell whose own command line contains it, so the guard
# could refuse because of the very command that invoked it (which is how this was found).
# Both scoped to THIS checkout: the bare "electron-vite" matched every electron-vite app of the user
# and every other Prism checkout, and --restart killed them.
patterns=(
  "$here/frontend/node_modules/.*electron-vite"
  "$here/frontend/node_modules/electron/dist/electron"
)

# Never count ourselves: this shell and its parent. That makes the self-match impossible, not unlikely.
mine=" $$ ${PPID:-0} "

running() {
  local pat pid found=""
  for pat in "${patterns[@]}"; do
    while read -r pid; do
      [ -n "$pid" ] || continue
      case "$mine" in *" $pid "*) continue ;; esac
      # A zombie is not a running instance; it is a corpse waiting to be reaped.
      [ "$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')" = "Z" ] && continue
      # Electron's helpers (zygote, gpu, renderer, utility) are children of the main process and go
      # with it. Listing eight lines for one app makes the report unreadable and the kill list wrong.
      case "$(ps -o cmd= -p "$pid" 2>/dev/null)" in *--type=*) continue ;; esac
      # The MCP bridge (`electron --mcp-proxy`, spawned by Claude Code/Codex per session) is the same
      # binary but not the app: no window, no backend, no instance lock. Counting it refused every
      # start while a Claude Code session was open ("already running", 08.10.2026) — and --restart
      # would have cut that session's MCP connection.
      case "$(ps -o cmd= -p "$pid" 2>/dev/null)" in *--mcp-proxy*) continue ;; esac
      found="$found $pid"
    done < <(pgrep -f "$pat" 2>/dev/null || true)
  done
  printf '%s' "$found" | tr ' ' '\n' | sort -un | tr '\n' ' ' | sed 's/ *$//'
}

report() {
  local pid
  for pid in $(running); do
    printf '  %s  %s\n' "$pid" "$(ps -o cmd= -p "$pid" 2>/dev/null | cut -c1-90)"
  done
}

if [[ "${1:-}" == "--status" ]]; then
  if [ -n "$(running)" ]; then
    echo "PrismLCA is running:"
    report
  else
    echo "PrismLCA is not running."
  fi
  exit 0
fi

if [[ "${1:-}" == "--restart" ]]; then
  live="$(running)"
  if [ -n "$live" ]; then
    echo "Stopping:"
    report
    # shellcheck disable=SC2086  # deliberate word splitting: a list of PIDs
    kill $live 2>/dev/null || true
    for _ in $(seq 1 20); do
      [ -z "$(running)" ] && break
      sleep 0.5
    done
    live="$(running)"
    if [ -n "$live" ]; then
      # Ten seconds of asking nicely is enough.
      # shellcheck disable=SC2086
      kill -9 $live 2>/dev/null || true
      sleep 1
    fi
  fi
  # This checkout's backend only — `uv run prism-lca-backend` is spawned with the backend directory in
  # its command line; a packaged app's backend or another checkout's is not ours to stop.
  pkill -f "$here/backend/.*prism-lca-backend" 2>/dev/null || true
  sleep 1
fi

if [ -n "$(running)" ]; then
  echo "PrismLCA is already running — use ./start.sh --restart to replace it." >&2
  report >&2
  exit 1
fi

exec npm run dev
