# Blinkbox

Send money, bridge it, earn on it, cash it out to your bank. Solana plus every EVM chain PayBox supports, all from Telegram, all signed by your own wallet.

**Try it:** [t.me/BlinkboxPaybot](https://t.me/BlinkboxPaybot) · **Site:** [blinkbox-ten.vercel.app](https://blinkbox-ten.vercel.app) · **Built by:** [@0xKenichi](https://x.com/0xKenichi)

---

I built Blinkbox for the MoonPay PayBox hackathon. I started with one question: why does using crypto still feel like filing paperwork?

Solana blinks already turn any link into a transaction. PayBox already gives anyone a wallet they control with a passkey. What was missing was the part in the middle: something that reads the link, checks it isn't a drainer, shows you in plain words what's about to leave your wallet, and only then asks you to sign. Plus, for people like me in Nigeria, a way to get naira in and out without a P2P desk.

So Blinkbox is two things:

1. **A PayBox plugin.** It lets any AI agent find, inspect and run Solana blinks with your PayBox wallet.
2. **A Telegram bot**, [@BlinkboxPaybot](https://t.me/BlinkboxPaybot). It does the same thing with buttons, for people who don't want an AI agent at all.

You need Telegram and a PayBox account. That's it.

## What it does

| | |
|---|---|
| **Send** | SOL and USDC on Solana. USDC on **Base**, **Arc**, Ethereum, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and HyperEVM, plus USDG on Robinhood Chain. Pay an address or just an `@username` (Telegram or X). |
| **Bridge** | Move USDC between any two of those 11 chains, e.g. Base → Arc or Base → Solana, routed by [LI.FI](https://li.fi) (Across, Relay, CCTP). You see what lands and the all-in fee before you sign. |
| **USDC-only life** | On **Arc**, gas is paid in USDC. Hold one token, pay for everything with it, fees included. |
| **Naira in / out** | Buy USDC with a normal bank transfer. Cash out to any of 174 Nigerian banks and wallets (OPay, Moniepoint, PalmPay…), usually in under two minutes. Powered by [Paycrest](https://paycrest.io). |
| **Pay a bank account** | Send USDC; naira lands in someone else's bank account. The bank confirms the account name before you pay. |
| **Earn** | Live USDC/SOL yields from Kamino, Jupiter Lend, Lulo, MarginFi, Drift and more. Deposit and withdraw in two taps. |
| **Swap** | Jupiter routes, e.g. `/swap 0.01 SOL USDC`. |
| **Hot tokens** | Trending tokens on **Solana** and **Base**, but only the ones that pass: no mint or freeze authority, real liquidity, no whale concentration, no wash trading, a sane price impact. On Base it also checks for honeypots, buy/sell tax and blacklist functions ([GoPlus](https://gopluslabs.io)), and you can buy with USDC or ETH and sell back to USDC. |
| **Predictions** | Live odds on real-world events. Betting with USDC turns on with a Jupiter key. |
| **Any blink** | Paste a `dial.to`, `solana-action:` or Actions link. Blinkbox checks it against the Dialect registry before you run it. |
| **Top up** | Card or bank through MoonPay inside PayBox, or naira through Paycrest. |

## It works on mainnet

These ran with real money, signed by PayBox, from the bot:

- **₦2,000 → 1.46 USDC**, naira bought by bank transfer: [3koZcPbJ…zgLZx](https://solscan.io/tx/3koZcPbJQQUmViGVrtZmxdN4jjZAgszd6AvtD476HRDErNmp4WKqfM14Qjgz3pNu5UuhvwnktCNo3yqi833zgLZx)
- **1.65 USDC → ₦2,230**, paid to a Moniepoint account in about 90 seconds: [4hVkUnkq…DnCY5x](https://solscan.io/tx/4hVkUnkqFNuw7JmsWGX5RcyqeTY7k7ozCJooicQdC9gPxrm2Yi7PdnzXJ6voTDNdRVanNZ2iaRb76ypoVPDnCY5x)
- **A blink run through Guard**, from the live Telegram demo: [2DLCTYWh…K124G](https://solscan.io/tx/2DLCTYWhk1tZye3KWBCgqV3DsTMz2fV6xbEtMukEa9BXpCG7eoYUiLn6JUvhaa4zMwMgMh5JNCEo6zkvmdhK124G)
- **The first plugin transaction**, prepared by Blinkbox and approved in PayBox: [5omKn6N6…kBjWhQJ](https://solscan.io/tx/5omKn6N6pzYebrPdtb2E2NwEwGtVnAq48TtBCw1gbRMAzhotW12oqNZMGFifkrn5pp9xk3CuRETmkzrbRkBjWhQJ)

## How it works

```
 you ── Telegram ──▶ Blinkbox bot ──▶ blink / Jupiter / Paycrest / RPC
                          │              (builds an unsigned transaction)
                          ▼
                       Guard  ── simulate, check limits, block drainers
                          │
                          ▼
                 preview in chat ── you tap Confirm
                          │
                          ▼
                PayBox signs (your passkey, your rules) ──▶ chain
```

The important part: **Blinkbox never holds your keys.** It builds a transaction and asks PayBox to sign it. PayBox applies your own approval settings, and for anything that needs it, asks for your passkey. You can revoke Blinkbox any time in the PayBox app under **Agents**.

## Guard

Every transaction goes through Guard before you see a Confirm button.

- **Simulates first.** You see what actually leaves your wallet, not what the link claims.
- **Blocks drainer patterns.** Token approvals (especially unlimited ones), authority changes, account reassignments, and closing your token accounts to someone else.
- **Spending limits.** $25 per transaction and $100 a day by default; change them with `/guard`.
- **Catches double payments.** The same transfer twice within 10 minutes needs an explicit "yes, again".
- **Catches lookalike addresses.** Scammers plant fake transfers to an address that starts and ends like one you've paid (address poisoning). Guard remembers who you've paid and blocks any new address that matches the ends but not the middle, on Solana and every EVM chain, and shows you exactly where they differ.
- **Checks recipients.** Refuses token-mint and program addresses (money sent there is gone) and flags addresses that have never been used.
- **Checks links.** Hosts flagged malicious in the Dialect registry are refused outright.
- **Pins EVM routes.** Swaps and bridges must go to LI.FI's own contract on that chain, approvals are for the exact amount (never unlimited), and a swap that would lose more than 5% to price impact is refused.

## Repo layout

```
src/        PayBox plugin: blink parsing, Dialect registry, Guard, Solana decoding
telegram/   the Telegram bot (bot.ts), the PayBox signing worker, the Paycrest ramp
site/       landing page (static, deployed on Vercel)
tests/      Guard unit tests and live end-to-end checks
scripts/    build, schema and PayBox conformance checks
demo/       scripts and pages used to record the demo films
docs/       plugin setup, self-hosting the bot, demo notes
```

## Run it yourself

You need Node.js 24 and pnpm 11.

**The plugin**

```bash
pnpm install --frozen-lockfile
pnpm test            # typecheck, reproducible build, PayBox conformance
node tests/e2e.mjs   # live checks against real blinks (builds transactions, never sends)
```

Then follow [docs/paybox-plugin.md](docs/paybox-plugin.md) to upload `dist/plugin.mjs` to the PayBox developer portal.

**The Telegram bot**

```bash
cd telegram
npm install
cp .env.example ~/.blinkbox-bot/.env   # add your BotFather token
npm run build && npm start
```

Without a Paycrest key the naira flows run in test mode: real rates, real bank list, real account-name lookup, no real orders. Full server setup is in [docs/telegram-bot.md](docs/telegram-bot.md).

## Honest limits

- Blinks that need a second signer (many NFT mints) or come pre-signed can't go through PayBox yet. Blinkbox tells you why instead of trying.
- Paycrest supports Solana and Base for naira, not Arc yet. To get USDC onto Arc, withdraw from an exchange that supports Arc or bridge with Circle's CCTP.
- EVM chains other than Arc need a little of their gas token (ETH, POL, BNB, AVAX, HYPE). Arc takes its fees in USDC, so USDC alone is enough there.
- Bridges and EVM swaps are built, Guard-checked and simulated against mainnet, but I haven't pushed a live one through PayBox yet. Solana sends, swaps and the naira flows have real mainnet receipts above.
- Photo-to-pay (snap someone's bank details, pay them) and voice notes ("send 5 USDC to @tunde") are built and switch on with a Groq API key. Both only fill in the form: you still see the preview and tap Confirm.

## Security

Found something? Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

All rights reserved. The code is public so you can read and verify it, not reuse it. Want to build on it? Ask me on X. Details in [LICENSE](LICENSE).
