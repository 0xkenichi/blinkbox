// Sends SOL with Blinkbox's transfer blink through PayBox: the plugin prepares
// the transaction, PayBox asks for approval, the paired key signs, and the
// script waits for on-chain confirmation.
// Usage: node demo/send.mjs <recipient> <amountSol>
import { WALLET, blinkboxId, paybox } from "./paybox.mjs";

const [to = WALLET, amount = "0.0001"] = process.argv.slice(2);
const id = await blinkboxId();

console.log(`→ Blinkbox: send ${amount} SOL to ${to === WALLET ? "my own wallet" : to}`);
console.log("→ If PayBox asks, approve in the PayBox app with your passkey.\n");

const run = await paybox.runPlugin(
  {
    pluginId: id,
    toolId: "prepare_blink_transaction",
    input: { url: "https://solana-sbl.dial.to/api/v0/transfer/SOL", inputs: { to, amount }, sender: WALLET },
  },
  { waitForApproval: true, timeoutMs: 280_000 },
);

const status = run.response?.status;
const hash = run.response?.output?.value?.tx_hash;
if (run.outcome === "terminal" && status === "success" && hash) {
  console.log("✓ Confirmed on Solana mainnet");
  console.log(`  https://solscan.io/tx/${hash}`);
} else {
  // Never resend automatically: check this request first.
  console.log(`✗ Not confirmed: outcome=${run.outcome} status=${status ?? "?"} reason=${run.reason ?? run.response?.reason ?? "?"}`);
  console.log(`  request ${run.requestId ?? "none"}. Check it before trying again.`);
  process.exitCode = 1;
}
