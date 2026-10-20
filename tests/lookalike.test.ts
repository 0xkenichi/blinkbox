// Address-poisoning detection, including the real attack seen on Base on Oct 20, 2026.
// Usage: npx tsx tests/lookalike.test.ts
import assert from "node:assert/strict";
import { lookalikeOf, markDifference } from "../src/lookalike.js";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS  ${name}`); };

const REAL = "0xbf9428a7c9d7e79c6a49dbc7e55f6483c34c3656"; // the address actually paid
const FAKE = "0xbf949b6fb17874391b318a12bcaecd4921b23656"; // the scammer's lookalike

test("catches the real Base poisoning address", () => assert.equal(lookalikeOf(FAKE, [REAL], "evm"), REAL));
test("ignores case and checksums on EVM", () => assert.equal(lookalikeOf(FAKE.toUpperCase().replace("0X", "0x"), [REAL], "evm"), REAL));
test("the same address is not a lookalike", () => assert.equal(lookalikeOf(REAL.toUpperCase().replace("0X", "0x"), [REAL], "evm"), undefined));
test("an unrelated address passes", () => assert.equal(lookalikeOf("0x76ecfa7f45d4976be582b6a7997f9cf384bd7698", [REAL], "evm"), undefined));
test("a shared start alone passes", () => assert.equal(lookalikeOf("0xbf9400000000000000000000000000000000beef", [REAL], "evm"), undefined));
test("a long shared start plus end is caught", () => assert.equal(lookalikeOf("0xbf9428a700000000000000000000000000000056", [REAL], "evm"), REAL));

const SOL = "Fui8MkwA8vr37Lpojbn56M2TSYtLhoq6NJA9NraPAhd9";
test("catches a Solana lookalike", () => assert.equal(lookalikeOf(`Fui8${"X".repeat(SOL.length - 9)}PAhd9`, [SOL], "solana"), SOL));
test("Solana is case-sensitive", () => assert.equal(lookalikeOf("fUI8MkwA8vr37Lpojbn56M2TSYtLhoq6NJA9NraPaHD9", [SOL], "solana"), undefined));
test("random Solana wallets pass", () => assert.equal(lookalikeOf("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", [SOL], "solana"), undefined));

test("highlights the differing middle", () => assert.equal(markDifference(FAKE, REAL, "evm"), "0xbf94<b><u>9b6fb17874391b318a12bcaecd4921b2</u></b>3656"));

console.log(`all ${passed} passed`);
