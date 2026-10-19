# Blinkbox demo video plan

Target length: 75–90 seconds. Required: the plugin working end to end, posted to X.
Deadline: Saturday Oct 17, 8pm EDT.

## What fits a 0.0016 SOL wallet

| Shot | Costs | Status |
|---|---|---|
| Find live yields | free | verified through PayBox |
| Inspect a blink with live APY and your balances | free | verified through PayBox |
| Live Kalshi prediction odds | free | verified through PayBox |
| Refuse a malicious blink | free | verified locally |
| **Real transaction: send SOL with the transfer blink, approve with passkey** | ~0.000005 SOL fee + amount | **verified on mainnet** ([tx](https://solscan.io/tx/5omKn6N6pzYebrPdtb2E2NwEwGtVnAq48TtBCw1gbRMAzhotW12oqNZMGFifkrn5pp9xk3CuRETmkzrbRkBjWhQJ)) |
| Swap or deposit (e.g. SOL→USDC, Kamino) | needs ~0.003 SOL+ for token-account rent | narrate as "same flow", don't execute |

Keep at least **0.00065 SOL** in the wallet (Solana's rent minimum). With 0.00162 SOL
you can send up to about 0.0009 SOL total across all takes. Each retake of the
transaction shot costs the amount you send plus ~0.000005 SOL. Send to
yourself (amount comes back, only the fee is spent) or tip a small amount to the
friend who funded you. That makes a nicer story, but the amount is gone.

## Where to record: here, in Claude Code

Claude.ai can't add custom connectors on your org account, so Claude Code is
the agent. It calls Blinkbox through your real PayBox account with
`node demo/agent.mjs <tool> '<json>'`: PayBox discovers the plugin, runs it in
its sandbox, and returns the result. The one transaction runs through
`node demo/send.mjs`, which **you** start. It prepares the transfer with Blinkbox,
PayBox asks for approval, and the paired key signs.

Dry run on the submitted version (`3773a6d0…`), all through PayBox: every shot
passes. The transaction shot was rehearsed on this version and confirmed on
mainnet on the first try
([tx](https://solscan.io/tx/Wxf2fwCqpd31K1N3wZGfeh2DiGjFkFVjqkns9j6t1RJ2Hdx2RdrqKaL35yXaPA26hUvJVEboNDcfgR3LSp7F8s2)).
If it ever prints "Not confirmed", tell Claude and check the request before retrying.

## Shot list

Record with **Cmd+Shift+5 → Record selected portion** around the Claude window.
Keep the PayBox app or tab ready in case it asks for a passkey. Type each prompt
to Claude; it runs the matching command.

**1. Hook (0:00–0:07).** Say:
> "Blinks turned any link into a Solana transaction. Blinkbox lets your AI agent
> use them, safely, through PayBox."

**2. Discover yield (0:07–0:22).** Type:
> Use Blinkbox through PayBox to find the best USDC yield on Solana.

(`find_blinks {"category":"yield","query":"usdc"}`). Say: "Live markets, each
one a blink the agent can run."

**3. Inspect (0:22–0:32).** Type:
> Inspect the Jito staking blink for my wallet.

(`inspect_blink` with your address). Shows: trusted in Dialect's registry, 4.71% APY,
your 0.00162 SOL. Say: "Before acting, it checks the provider and shows my position."

**4. Real transaction (0:32–0:55).** Type:
> Send 0.0001 SOL to my own wallet with a transfer blink. Give me the command to run.

Click **Run** on the `node demo/send.mjs` command Claude gives you. Approve in
PayBox if asked. Show the "✓ Confirmed on Solana mainnet" line, then open the
Solscan link. Say: "Blinkbox never touches keys. PayBox checks it, I approve, it's on-chain."

**5. Safety (0:55–1:05).** Type:
> Inspect this blink: https://dial.to/?action=solana-action:https://actions.radius.art/api/action

Shows "flagged MALICIOUS … Do not interact". Say: "Flagged blinks are refused."

**6. Predictions (1:05–1:15).** Type:
> What are the odds for the U.S. Senate in 2026?

(`find_blinks {"category":"prediction","query":"senate"}`). Say: "Live Kalshi odds too."

**7. Close (1:15–1:25).** Say:
> "Blinkbox: four tools, every registered Solana blink, zero per-protocol
> integrations, and a passkey on every move."

## Before you hit record

- [x] One rehearsal of shot 4 succeeded
- [ ] Notifications off (Focus mode), unrelated windows closed
- [ ] PayBox app or tab ready for a passkey prompt
- [ ] Wallet still has ≥ 0.0008 SOL

## X post

> I built Blinkbox for PayBox: your AI agent can find, inspect and run any
> Solana blink (yields, staking, payments) with a passkey on every
> transaction. Registry-checked, never touches your keys. Live on mainnet 👇
> #MoonPayHackathons

Attach the video. Tag MoonPay's and PayBox's official X accounts (check the
exact handles on their sites). Then add the post link wherever the
submission asks for it.
