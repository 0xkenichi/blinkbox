// Live check: LI.FI's Solana → Arc route builds a transaction PayBox can sign and Guard lets through,
// and Base's trending list has security data to filter on. Builds only, never signs or sends.
// Usage: npx tsx tests/bridge-route.test.ts
import assert from "node:assert/strict";
import { guardInstructions } from "../src/guard.js";
import { parseTransaction, payboxIncompatibility, summarize } from "../src/solana.js";

const SOL_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // a large public wallet, so routes can quote
const EVM_WALLET = "0x76ecfa7f45d4976be582b6a7997f9cf384bd7698";
const q = new URLSearchParams({ fromChain: "1151111081099710", toChain: "5042", fromToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", toToken: "0x3600000000000000000000000000000000000000", fromAmount: "1000000", fromAddress: SOL_WALLET, toAddress: EVM_WALLET, integrator: "blinkbox" });
const quote: any = await (await fetch(`https://li.quest/v1/quote?${q}`)).json();
assert.ok(quote.transactionRequest?.data, `no Solana route: ${JSON.stringify(quote).slice(0, 200)}`);
const raw = Buffer.from(quote.transactionRequest.data, "base64");
const tx = parseTransaction(raw);
assert.equal(payboxIncompatibility(tx, SOL_WALLET), null, "PayBox can sign it");
const findings = guardInstructions(tx);
assert.ok(!findings.some((f) => f.level === "block"), `Guard blocks it: ${JSON.stringify(findings)}`);
console.log(`ok: Solana → Arc via ${quote.tool}, ${raw.length} bytes, programs: ${summarize(tx).programs.map((p) => p.name ?? p.id).join(", ")}; guard notes: ${findings.length}`);

const pools: any = await (await fetch("https://api.geckoterminal.com/api/v2/networks/base/trending_pools?duration=24h&page=1", { headers: { accept: "application/json" } })).json();
const addrs = [...new Set(pools.data.map((p: any) => String(p.relationships.base_token.data.id).replace(/^base_/, "").toLowerCase()))].slice(0, 20) as string[];
const covered: string[] = [];
for (const a of addrs.slice(0, 8)) {
  const sec: any = await (await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${a}`)).json();
  if (sec.result?.[a]) covered.push(a);
}
assert.ok(covered.length >= 4, `security data for ${covered.length}/8`);
console.log(`ok: ${addrs.length} trending Base tokens, security data for ${covered.length} of the first 8`);
