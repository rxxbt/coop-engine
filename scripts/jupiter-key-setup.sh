#!/usr/bin/env bash
# One-time: install a Jupiter API key on the server. Steps for the operator:
#   1. Create a key at https://developers.jup.ag/portal (the free plan allows 1 request per second; without a key Jupiter allows 0.5)
#   2. Run, in the engine folder: bash scripts/jupiter-key-setup.sh
# The script asks for the key without echoing it, checks it against Jupiter, writes JUP_API_KEY into .env (the hourly run) and into
# api.service.env (the API service), restarts the API. The key never leaves the server.
set -u
cd "$(dirname "$0")/.."
read -r -s -p "Jupiter API key: " KEY; echo
[ -n "$KEY" ] || { echo "nothing entered"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $KEY" "https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112")
[ "$code" = "200" ] || { echo "Jupiter answered $code to a test request with this key; nothing written"; exit 1; }
for f in .env api.service.env; do
  [ -f "$f" ] || continue
  KEY="$KEY" python3 - "$f" <<'PY'
import os, re, sys
f, key = sys.argv[1], os.environ["KEY"]
txt = open(f).read()
txt = re.sub(r"^JUP_API_KEY=.*$\n?", "", txt, flags=re.M).rstrip("\n") + f"\nJUP_API_KEY={key}\n"
open(f, "w").write(txt)
PY
  chmod 600 "$f"; echo "JUP_API_KEY written to $f"
done
systemctl restart coop-api 2>/dev/null && echo "coop-api restarted" || echo "restart the API by hand: systemctl restart coop-api"
echo "Done. The hourly run uses the key from its next start: api.jup.ag at 1 request per second (set JUP_RPS for a paid plan)."
