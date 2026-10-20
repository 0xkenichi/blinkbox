# Running the Telegram bot

This is how I run [@BlinkboxPaybot](https://t.me/BlinkboxPaybot): one small Linux VM, one systemd service, no database. It's fine on a 1 GB free-tier box.

## What you need

- Node.js 24
- A bot token from [@BotFather](https://t.me/BotFather)
- Optional: a [Paycrest](https://app.paycrest.io) sender API key for real naira orders

## Layout on the server

```
~/blinkbox/              the app
  dist/bot.mjs           built bot (npm run build)
  worker.mjs             PayBox signing worker, spawned per request
  node_modules/          @paybox-sh/sdk and the paybox CLI
~/.blinkbox-bot/         data (chmod 700)
  .env                   secrets, see telegram/.env.example (chmod 600)
  directory.json         linked @handles → chat ids
  stats/events.jsonl     anonymous usage events (salted user hashes, counts and dollar amounts only)
  users/<chat id>/       one folder per user (chmod 700)
    config.json          that user's PayBox CLI session and paired signing key
    guard.json           their limits and recent spend
    payout.json          their saved cash-out account
    recipients.json      bank accounts they've paid before
```

Each user links their own PayBox account with `/connect`: a device login, then pairing a signing key that PayBox controls. Blinkbox never sees a wallet private key. Every signature goes through PayBox under that user's approval rules, and they can revoke Blinkbox in the PayBox app under **Agents**.

## Deploy

On your machine:

```bash
cd telegram
npm install
npm run build
scp dist/bot.mjs  you@server:~/blinkbox/dist/bot.mjs
scp worker.mjs package.json package-lock.json  you@server:~/blinkbox/
```

On the server, the first time:

```bash
cd ~/blinkbox && npm ci --omit=dev
mkdir -p ~/.blinkbox-bot && chmod 700 ~/.blinkbox-bot
cp .env.example ~/.blinkbox-bot/.env && chmod 600 ~/.blinkbox-bot/.env   # then fill it in
sudo cp blinkbox-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now blinkbox-bot
journalctl -u blinkbox-bot -f
```

After that, a deploy is just the `scp` of `dist/bot.mjs` plus `sudo systemctl restart blinkbox-bot`.

## Knowing who uses it

Set `OWNER_CHAT_ID` to your own Telegram chat id. Then `/stats` shows connected wallets, active users, and transactions by type and dollar volume, and the bot pings you when someone new connects or makes their first transaction. Anyone else who sends `/stats` just gets the menu. Users are logged as salted hashes, never names, addresses or bank details, and your own activity isn't counted.

## Small-VM tips

Things I learned the hard way on a 1 GB box:

- Cap Node's heap (`--max-old-space-size=256`, already in the unit file) and add swap.
- Turn off background services you don't need (package cache timers, metrics agents).
- Turn on the persistent journal so you can see why it died after a reboot.
- `kernel.panic=10` plus `hung_task_panic=1` means a frozen VM reboots itself instead of waiting for you.

## Test mode

With no `PAYCREST_API_KEY`, naira buy, cash-out and pay-a-bank all run against Paycrest's real public endpoints (live rates, all 174 institutions, real account-name lookup) but create test orders only. Every message in that mode carries a test banner, so nobody mistakes it for a real payment.
