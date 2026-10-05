#!/usr/bin/env bash
# Once a day, under the engine's lock (cron: 40 6 * * * flock -w 900 /tmp/coop-engine.lock <engine>/scripts/run-fees.sh): claim the creator
# fees of graduated pools and forward the dev's share (src/fees.ts). Telegram through COOP's bot, as scripts/run-epochs.sh does: a note for
# every forwarding, an alert when a token's run failed (it resumes from its saved state on the next run).
# Usage: run-fees.sh          (execute, for cron)
#        run-fees.sh --dry    (dry run: prints what it would claim and send)
set -u
cd "$(dirname "$0")/.."
. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
LOG="${FEES_LOG:-fees.log}"
TG_ENV="${TELEGRAM_ENV:-./telegram.env}"

alert() {
  if [ "${ALERT_DRY:-0}" = "1" ]; then printf -- '--- would alert ---\n%s\n\n' "$1"; return 0; fi
  [ -f "$TG_ENV" ] || { echo "no telegram env at $TG_ENV; alert not sent" >&2; return 0; }
  set -a; . "$TG_ENV"; set +a
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || { echo "telegram not configured" >&2; return 0; }
  ALERT_TEXT="$1" python3 - <<'PY'
import os, json, urllib.request
token, chat, text = os.environ["TELEGRAM_BOT_TOKEN"], os.environ["TELEGRAM_CHAT_ID"], os.environ["ALERT_TEXT"]
req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=json.dumps({"chat_id": chat, "text": text[:4000]}).encode(), headers={"content-type": "application/json"})
try: urllib.request.urlopen(req, timeout=15)
except Exception as e: print("telegram send failed:", e)
PY
}

if [ "${1:-}" = "--dry" ]; then npx tsx src/cli.ts fees --all; exit $?; fi

RUN=$(mktemp)
npx tsx src/cli.ts fees --all --execute > "$RUN" 2>&1
rc=$?
cat "$RUN" >> "$LOG"
fwd=$(grep -E '^\[fees [^]]+\] forwarded [0-9]' "$RUN" | cut -c1-300)
[ -n "$fwd" ] && alert "COOP engine · pool fees forwarded at $(date -u +%H:%M) UTC
$fwd"
# Raydium's program keeps a share of the creator fee at claim time (5% on tier 9 since 2026-10-01); the engine reads the rate at every claim
# and says so when it moved. The dev's 0.42% is fixed by the split; what moves is the platform's part.
changed=$(grep -E 'RAYDIUM SHARE CHANGED' "$RUN" | head -n 3 | cut -c1-300)
[ -n "$changed" ] && alert "COOP engine · Raydium changed the creator-fee rates at $(date -u +%H:%M) UTC
$changed"
if [ "$rc" -ne 0 ]; then
  failed=$(grep -E 'FAILED' "$RUN" | tail -n 5 | cut -c1-300)
  alert "COOP engine · pool-fee run failed at $(date -u +%H:%M) UTC
${failed:-$(tail -n 5 "$RUN" | cut -c1-300)}
It resumes from its saved state on the next run. Log: $LOG"
fi
rm -f "$RUN"
exit $rc
