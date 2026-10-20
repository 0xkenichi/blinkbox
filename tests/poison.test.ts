// Poisoning detection against the real attack on Base, Oct 20, 2026 (tests/fixtures).
// Usage: npx tsx tests/poison.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPoisoning, hasDisguisedCharacters, isStablecoinImpostor, type Transfer } from "../src/poison.js";

type Fixture = {
  wallet: string; knownRecipient: string;
  txs: { label: string; hash: string; sender: string; logs: { token: string; from: string; to: string; value: string }[] }[];
  tokens: Record<string, { symbol: string; name: string }>;
};
const fx: Fixture = JSON.parse(readFileSync(new URL("./fixtures/base-poisoning-2026-10-20.json", import.meta.url), "utf8"));
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FAKE = "0xbf949b6fb17874391b318a12bcaecd4921b23656";
const FAKE_TOKEN = "0xeb37c874ff1fbbe442f017e91db2136c13c643d4";

// The wallet's view: only transfers it appears in, like the bot's getLogs queries return.
const transfersOf = (labels: string[]): Transfer[] =>
  fx.txs.filter((t) => labels.includes(t.label)).flatMap((t) => t.logs
    .filter((l) => l.from === fx.wallet || l.to === fx.wallet)
    .map((l) => ({ token: l.token, from: l.from, to: l.to, value: BigInt(l.value), txHash: t.hash, txSender: t.sender })));
const ctx = (known: string[]) => ({ kind: "evm" as const, wallet: fx.wallet, known, official: [USDC], tokenInfo: (t: string) => fx.tokens[t] });

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS  ${name}`); };

test("the attack touches the wallet twice (0 USDC + fake ÚSDС)", () => assert.equal(transfersOf(["attack"]).length, 2));

test("flags the planted address once, with all three reasons", () => {
  const f = findPoisoning(transfersOf(["attack"]), ctx([fx.knownRecipient]));
  assert.equal(f.length, 1);
  assert.equal(f[0]!.address, FAKE);
  assert.deepEqual([...f[0]!.reasons].sort(), ["fake-token", "lookalike", "zero-value"]);
  assert.equal(f[0]!.original, fx.knownRecipient);
  assert.equal(f[0]!.fakeToken, fx.tokens[FAKE_TOKEN]!.symbol);
  assert.equal(f[0]!.txHash, "0x74d253da74809a7aff0dccd57fc54199e2890cbc455e029fa6b36582043bca2e");
});

test("still flags it with no known recipients (zero-value + fake token)", () => {
  const f = findPoisoning(transfersOf(["attack"]), ctx([]));
  assert.equal(f.length, 1);
  assert.deepEqual([...f[0]!.reasons].sort(), ["fake-token", "zero-value"]);
  assert.equal(f[0]!.original, undefined);
});

test("the wallet's own send and the Paycrest delivery are clean", () => {
  assert.deepEqual(findPoisoning(transfersOf(["own-send", "paycrest-delivery"]), ctx([fx.knownRecipient])), []);
});

test("all three together: only the attack is flagged", () => {
  const f = findPoisoning(transfersOf(["paycrest-delivery", "own-send", "attack"]), ctx([fx.knownRecipient]));
  assert.deepEqual(f.map((x) => x.address), [FAKE]);
});

test("a transfer the wallet signed is never flagged, even zero-value", () => {
  const own = { token: USDC, from: fx.wallet, to: FAKE, value: 0n, txHash: "0x1", txSender: fx.wallet };
  assert.deepEqual(findPoisoning([own], ctx([fx.knownRecipient])), []);
});

test("incoming dust from a lookalike of a known recipient is flagged", () => {
  const dust = { token: USDC, from: FAKE, to: fx.wallet, value: 1n, txHash: "0x2", txSender: "0x3959e49639d3b1bd9d1746a7971155e94fecf1f6" };
  const f = findPoisoning([dust], ctx([fx.knownRecipient]));
  assert.equal(f.length, 1);
  assert.deepEqual(f[0]!.reasons, ["lookalike"]);
});

test("incoming money from a stranger is not flagged", () => {
  const pay = { token: USDC, from: "0x76ecfa7f45d4976be582b6a7997f9cf384bd7698", to: fx.wallet, value: 5_000_000n, txHash: "0x3", txSender: "0x76ecfa7f45d4976be582b6a7997f9cf384bd7698" };
  assert.deepEqual(findPoisoning([pay], ctx([fx.knownRecipient])), []);
});

test("Solana: dust from a lookalike of your own wallet is flagged", () => {
  const W = "Fui8MkwA8vr37Lpojbn56M2TSYtLhoq6NJA9NraPAhd9";
  const fake = `Fui8${"X".repeat(W.length - 9)}PAhd9`;
  const f = findPoisoning([{ token: "native", from: fake, to: W, value: 1n, txHash: "sig", txSender: fake }], { kind: "solana", wallet: W, known: [], official: [], tokenInfo: () => undefined });
  assert.equal(f[0]?.address, fake);
  assert.equal(f[0]?.original, W);
});

test("spots the disguised ÚSDС token, not the real USDC", () => {
  assert.equal(isStablecoinImpostor(FAKE_TOKEN, fx.tokens[FAKE_TOKEN], [USDC]), true);
  assert.equal(isStablecoinImpostor(USDC, fx.tokens[USDC], [USDC]), false);
  assert.equal(hasDisguisedCharacters(fx.tokens[FAKE_TOKEN]!.symbol), true);
  assert.equal(hasDisguisedCharacters("ÚSDС"), true, "composed and decomposed accents both count");
  assert.equal(hasDisguisedCharacters("USDC"), false);
  assert.equal(isStablecoinImpostor("0xabc", { symbol: "USDC", name: "USD Coin" }, [USDC]), true, "plain USDC from the wrong contract");
  assert.equal(isStablecoinImpostor("0xabc", { symbol: "DEGEN", name: "Degen" }, [USDC]), false);
});

console.log(`all ${passed} passed`);
