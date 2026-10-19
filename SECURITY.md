# Security

Blinkbox moves real money, so I take reports seriously.

## Reporting a problem

Please **don't open a public issue** for anything security-related. Use GitHub's private advisory form instead: **Security → Report a vulnerability** on this repo. I'll reply within 72 hours.

Useful things to include: what you found, how to reproduce it, and what an attacker could do with it. If funds are at risk right now, say so in the first line.

## What's in scope

- Anything that gets a transaction signed that the user didn't confirm in chat
- Ways around Guard: limits, drainer checks, duplicate protection, recipient checks
- Leaking another user's data (chat id, saved bank accounts, linked handles)
- Making the naira flows pay the wrong account or the wrong amount
- The plugin proposing a transaction PayBox's contract would reject, or hiding what it does

Out of scope: PayBox, Paycrest, Dialect, Jupiter and Circle themselves (report to them), and attacks that need the user's phone or Telegram account.

## How Blinkbox protects users

- **No private keys.** Blinkbox builds unsigned transactions. PayBox signs under the user's own approval rules and passkey, and users can revoke Blinkbox in PayBox at any time.
- **Confirm before sign.** Nothing is sent to PayBox until the user taps Confirm on a plain-language preview.
- **Guard on every transaction.** It simulates the transaction, enforces spending limits, blocks drainer instructions, catches double payments, and checks recipients and links against the Dialect registry.
- **Minimal data.** Per-user files are mode 0600 inside 0700 folders. BVNs typed during a naira purchase go straight to Paycrest: they are never written to disk, and the message is deleted from the chat.
- **No secrets in this repo.** Tokens and API keys live in an `.env` file on the server only. See `telegram/.env.example` for the names.

## If you run your own copy

- Keep `~/.blinkbox-bot` at `chmod 700`. It holds every user's PayBox session.
- Never commit `.env`. The `.gitignore` here blocks it, but check before you push.
- Rotate your bot token and Paycrest key if you ever think they leaked.
