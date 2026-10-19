# The Blinkbox PayBox plugin

Every Solana blink, executable by your agent.

Blinkbox is a PayBox plugin that lets an AI agent discover, inspect, and run
**Solana Actions (blinks)** with the user's PayBox wallet. The agent finds a
blink, reads what it does, fills its inputs, and gets back an unsigned
transaction. PayBox then simulates it, shows the user a preview, and asks for a
passkey approval before anything is signed.

One plugin covers all four hackathon tracks:

| Track | What the agent can do |
|---|---|
| Consumer finance | Find the best live USDC/SOL yield (Kamino, Jupiter Lend, Lulo, MarginFi, DeFiTuna, Carrot, Drift), deposit, withdraw, liquid-stake for JitoSOL, swap on Jupiter |
| Merchant tools | Pay any address in SOL or SPL tokens; run any registered checkout or payment blink from a link |
| Creative | Run any of the 1,000+ registered blinks people share on X and websites (tips, donations, mints that need only your signature) |
| Predictions | Pull live Kalshi prediction-market odds (via DFlow) to price and forecast events (read-only for now) |

## Tools

| Tool | Read-only | What it does |
|---|---|---|
| `find_blinks` | yes | Live yield, lending, and loop markets with APY and TVL from Dialect's Markets API, plus swap, stake, and transfer blinks. `category: "prediction"` returns live odds. |
| `inspect_blink` | yes | Accepts any blink form: `dial.to/?action=…`, `solana-action:`, `blink:`, Dialect proxy links, `jup.ag/swap/…`, or a raw Action URL. Returns title, registry trust status, the actions it offers and their inputs, and live stats such as APY and the user's balances. |
| `prepare_blink_transaction` | no (returns a proposal) | Runs one action for the user's wallet and returns an `io.paybox/transactionProposal` (Solana). Before proposing, it checks the provider against the Dialect registry, validates inputs, and verifies the transaction is unsigned with the user's wallet as the only signer and fee payer. It also decodes the programs and SOL transfers involved. |
| `continue_blink` | yes | Follows multi-step (chained) blinks after PayBox confirms the previous transaction. |

### Safety model

- **Guard.** Before proposing, Blinkbox decodes every instruction and refuses
  drainer patterns: token approvals by your wallet (unlimited ones flagged),
  authority changes, account reassignment, and closing token accounts to
  someone else. Burns and multi-recipient SOL transfers come with a warning.
- **Registry gate.** Hosts flagged malicious in the Dialect registry are always
  refused. Hosts not in the registry need `allow_unverified: true`, which the
  agent may only pass after the user says yes.
- **PayBox contract enforced locally.** Blinkbox rejects anything PayBox would:
  more than one signer, pre-signed payloads, a fee payer other than the user,
  durable nonces, and transactions over 1,232 bytes. Each rejection comes with
  a plain-English reason.
- **No keys, no secrets, no state.** The plugin never sees a private key. It only
  receives the user's public address. Every call is stateless.
- **Honest summaries.** The decoded summary is labeled as Blinkbox's own reading.
  PayBox's simulation and preview remain the source of truth.

## Developer portal setup

1. Upload `dist/plugin.mjs`. Upload only that file.
2. **Network hosts** (add exactly these three):
   - `api.dial.to`: Dialect's blink proxy, used for every action GET/POST
   - `actions-registry.dial.to`: the trust registry
   - `markets.dial.to`: live markets for `find_blinks`
3. **Variables & Secrets**: nothing is required. By default `find_blinks`
   uses Dialect's public demo key (`pk_demo`). If you get a real Dialect key:
   - Add a **Secret**: host `markets.dial.to`, header `x-dialect-client-key`,
     value = your key.
   - Add an **Environment variable** `DIALECT_CLIENT_KEY` = `brokered`, so the
     plugin stops sending its own header.
4. Run the checks, then **Test → Load tools**. Paste these one at a time and
   replace `YOUR_SOLANA_ADDRESS` with your PayBox Solana wallet's public address:

```json
{"category": "yield", "query": "usdc", "limit": 5}
```
(`find_blinks`)

```json
{"url": "https://jito.dial.to/stake", "account": "YOUR_SOLANA_ADDRESS"}
```
(`inspect_blink`)

```json
{"url": "https://jupiter.dial.to/api/v0/swap/SOL-USDC", "action_index": 3, "inputs": {"amount": "0.01"}, "sender": "YOUR_SOLANA_ADDRESS"}
```
(`prepare_blink_transaction`. Then click **Validate transaction** with the same wallet.)

5. Submit it for review.
6. In the PayBox app, open **Plugins → Unofficial plugins** and enable Blinkbox.
   Then connect Claude.ai (or any MCP host) to PayBox and try the demo below.

## Demo video

See [demo-recording.md](demo-recording.md) for the shot list, exact prompts, budget notes, and the X
post. The first real transaction (a 0.0001 SOL transfer prepared by Blinkbox and
approved through PayBox) is on mainnet:
[5omKn6N6…kBjWhQJ](https://solscan.io/tx/5omKn6N6pzYebrPdtb2E2NwEwGtVnAq48TtBCw1gbRMAzhotW12oqNZMGFifkrn5pp9xk3CuRETmkzrbRkBjWhQJ).

## Local development

Node.js 24 (reference 24.21.0) and pnpm 11.11.0.

```bash
pnpm install --frozen-lockfile
pnpm test               # typecheck, reproducible build, PayBox conformance
node tests/e2e.mjs      # live checks of every tool against real blinks
npx tsx tests/guard.test.ts  # Guard unit tests
```

`tests/e2e.mjs` builds real transactions for a large public wallet so that
providers can quote. It only decodes them: nothing is signed or sent.

## Known limits

- Blinks that need extra signers (many NFT mints) or that return pre-signed
  transactions can't run through PayBox yet. Blinkbox explains why instead of
  proposing them.
- Message-signing actions are not supported by PayBox plugins.
- Prediction markets are read-only: DFlow's trade API needs a partner key.
- Provider uptime varies. For example, Jito's own stake endpoint was returning
  500s during testing, so the stake template routes SOL → JitoSOL through
  Jupiter instead.
