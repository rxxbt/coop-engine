#!/usr/bin/env bash
# One-time wiring of COOP's own Telegram bot. Steps for the operator:
#   1. Create the bot with @BotFather (or reuse one) and put its token in telegram.env (in the engine folder) as
#      TELEGRAM_BOT_TOKEN=...   (chmod 600; the token never leaves the server)
#   2. Open the bot in Telegram and send it /start (so it can message you)
#   3. Run: bash scripts/telegram-setup.sh
# The script finds your chat id from the bot's updates, writes TELEGRAM_CHAT_ID into the same file, and sends a test message.
set -u
ENV_FILE="${TELEGRAM_ENV:-./telegram.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (create it with TELEGRAM_BOT_TOKEN=...)"; exit 1; }
set -a; . "$ENV_FILE"; set +a
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || { echo "TELEGRAM_BOT_TOKEN is empty in $ENV_FILE"; exit 1; }
python3 - "$ENV_FILE" <<'PYSETUP'
import os, sys, json, urllib.request, re
env_file = sys.argv[1]; token = os.environ["TELEGRAM_BOT_TOKEN"]
def call(method, body=None):
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=json.dumps(body).encode() if body else None, headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=20))
me = call("getMe"); print("bot:", "@" + me["result"]["username"])
chat = os.environ.get("TELEGRAM_CHAT_ID") or ""
if not chat:
    ups = call("getUpdates").get("result", [])
    chats = [u["message"]["chat"] for u in ups if "message" in u and u["message"]["chat"]["type"] == "private"]
    if not chats:
        print("no private message seen yet: open the bot in Telegram, send /start, then run this again"); sys.exit(1)
    c = chats[-1]; chat = str(c["id"]); print("chat id found for", c.get("username") or c.get("first_name"))
    txt = open(env_file).read()
    txt = re.sub(r"^TELEGRAM_CHAT_ID=.*$", "", txt, flags=re.M).rstrip("\n") + f"\nTELEGRAM_CHAT_ID={chat}\n"
    open(env_file, "w").write(txt); os.chmod(env_file, 0o600); print("TELEGRAM_CHAT_ID written to", env_file)
call("sendMessage", {"chat_id": chat, "text": "COOP engine: alerts and new-pair notes now arrive here."}); print("test message sent")
PYSETUP
