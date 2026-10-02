#!/usr/bin/env bash
# Cron entry point: run the scheduler, then alert on Telegram through COOP's own bot
# (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in $TELEGRAM_ENV, default ./telegram.env in the engine folder; see scripts/telegram-setup.sh) when
#   - a token's epoch failed,
#   - a pot above dust was swept but could not be converted, so nobody was paid,
#   - the operator wallet runs low on SOL (at most every 12 hours; every run once it is critical).
# Usage: run-epochs.sh              (execute mode, for cron)
#        run-epochs.sh --dry        (dry run, exit code only, no alert)
#        run-epochs.sh --test-alert (send one test alert, run nothing)
#        run-epochs.sh --selftest   (feed the checks a made-up run and print the alerts instead of sending them)
set -u
cd "$(dirname "$0")/.."
. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
LOG="${EPOCH_LOG:-epoch.log}"
TG_ENV="${TELEGRAM_ENV:-./telegram.env}"
LOW_STAMP="${LOW_BALANCE_STAMP:-data/.low-balance-alert}"

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

# What one run's output calls for. $1 = file with the run's output, $2 = its exit code.
checks() {
  local run="$1" rc="$2" failed summary kept low now last
  if [ "$rc" -ne 0 ]; then
    # only what matters: which token failed and why, plus the run summary; no library warnings, no "not due" lines
    failed=$(grep -E "FAILED:" "$run" | tail -n 5 | sed -E 's/^\[([^]]+)\] FAILED: /\1: /' | cut -c1-400)
    summary=$(grep -E "^\[all\]" "$run" | tail -n 1 | sed -E 's/^\[all\] //')
    alert "COOP engine · epoch run failed at $(date -u +%H:%M) UTC

${failed:-see epoch.log}

Run: ${summary:-no summary line}
Resumable state is kept; the next hourly run retries. Log: $LOG"
  fi
  # A pot Jupiter cannot convert is not a failure, but nobody is paid (a silent kept pot is the failure mode to avoid).
  # Say so whenever the pot is more than dust: 1,000 tokens at 6 decimals.
  kept=$(grep -E "has no route for [0-9]+ " "$run" | awk '{ for (i = 1; i <= NF; i++) if ($i == "for") { if ($(i + 1) + 0 >= 1000000000) print; break } }' | sed -E 's/^ +//' | cut -c1-300 | head -n 8)
  if [ -n "$kept" ]; then
    alert "COOP engine · tax swept but NOT paid at $(date -u +%H:%M) UTC: Jupiter has no route, even through SOL

$kept"
  fi
  # The operator pays every epoch's fees and the rent of new token accounts. Low: one alert per 12 hours. Critical: every run.
  low=$(grep -E "^\[operator\] .*LOW BALANCE" "$run" | tail -n 1 | cut -c1-300)
  if [ -n "$low" ]; then
    now=$(date +%s); last=$(cat "$LOW_STAMP" 2>/dev/null || echo 0)
    if echo "$low" | grep -q "CRITICAL" || [ $((now - last)) -ge 43200 ]; then
      alert "COOP engine · the operator wallet is running low at $(date -u +%H:%M) UTC

${low#\[operator\] }"
      [ "${ALERT_DRY:-0}" = "1" ] || echo "$now" > "$LOW_STAMP"
    fi
  fi
}

case "${1:-}" in
  --test-alert) alert "COOP engine: alerts are wired (test message from run-epochs.sh on $(hostname))"; exit 0 ;;
  --dry) npx tsx src/cli.ts epoch --all; exit $? ;;
  --selftest)
    T=$(mktemp)
    printf '%s\n' "[TOKENA] FAILED: swap not landing after 3 attempts (last 5W9H…); the epoch resumes on the next run" \
      "  creator: Jupiter has no route for 49570797400455 TOKENA → DSZSng…; kept for the next epoch" \
      "  reflections: Jupiter has no route for 38754 TOKENB → So1111…; kept for the next epoch" \
      "  94800000000000 TOKENC → So1111… is too small to swap (worth 1200000 lamports, under the 2000000 a swap needs); kept for the next epoch" \
      "[operator] 9dZcuWdTRjStMFNpQGDsSUZvTBkhrGZXxFvNMkjbpYKv holds 0.0312 SOL LOW BALANCE (under 0.05 SOL): top it up" \
      "[all] 2026-09-29T10:05:00.000Z ran 3, failed 1, tokens 12" > "$T"
    ALERT_DRY=1; LOW_STAMP=$(mktemp -u); checks "$T" 1; rm -f "$T"; exit 0 ;;
esac

RUN=$(mktemp)
npx tsx src/cli.ts epoch --all --execute > "$RUN" 2>&1
rc=$?
cat "$RUN" >> "$LOG"
checks "$RUN" "$rc"
rm -f "$RUN"
exit $rc
