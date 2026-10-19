// Checks the Paycrest ramp in test mode (no API key) against Paycrest's live public endpoints.
// Usage: npx tsx telegram/ramp.test.ts
import assert from "node:assert/strict";
import { parseNaira, PaycrestRamp, POPULAR_BANKS } from "./ramp.js";

assert.equal(parseNaira("20k"), 20_000);
assert.equal(parseNaira("₦20,000"), 20_000);
assert.equal(parseNaira("1.5m"), 1_500_000);
assert.equal(parseNaira("twenty"), null);

const r = new PaycrestRamp();
assert.equal(r.test, true, "no key means test mode");

const banks = await r.banks();
assert.ok(banks.length > 100, `expected 100+ institutions, got ${banks.length}`);
const opay = banks.find((b) => b.name === "OPay");
assert.ok(opay, "OPay is supported");
const popular = POPULAR_BANKS.filter((n) => banks.some((b) => b.name.toLowerCase().includes(n.toLowerCase())));
assert.ok(popular.length >= 10, `popular banks found: ${popular.join(", ")}`);

const sell = await r.quote("sell", 10);
const buy = await r.quote("buy", 20_000);
assert.ok(sell.rate > 500 && sell.rate < 5_000, `sell rate ${sell.rate}`);
assert.ok(buy.usdc > 5 && buy.usdc < 40, `buy usdc ${buy.usdc}`);
assert.ok(buy.rate >= sell.rate, "buying costs at least what selling pays");
await assert.rejects(r.resolveAccount(opay!.code, "123"), /10 digits/);

const b = await r.createBuy(buy, "wallet", "1", {});
assert.equal((await r.buyStatus(b)).status, "awaiting_payment");
await r.simulate(b.id);
assert.equal((await r.buyStatus(b)).status, "delivered");
const s = await r.createSell(sell, { bankCode: opay!.code, bankName: "OPay", accountNumber: "0123456789", accountName: "X" }, "wallet", "1");
await r.simulate(s.id);
assert.equal((await r.sellStatus(s)).status, "paid_out");

console.log(`ok: ${banks.length} institutions (OPay ${opay!.code}); sell 10 USDC → ₦${sell.ngn} @ ${sell.rate}; buy ₦20,000 → ${buy.usdc} USDC @ ${buy.rate}`);
