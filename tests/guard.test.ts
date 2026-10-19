// Offline checks for Blinkbox Guard using hand-built transactions.
// Usage: npx tsx tests/guard.test.ts
import { guardInstructions, guardRefusal } from "../src/guard.js";
import { base58Decode, parseTransaction } from "../src/solana.js";

const ME = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const MINT = new Uint8Array(32).fill(11);
const ACCT = new Uint8Array(32).fill(13);
const SYSTEM = base58Decode("11111111111111111111111111111111");
const TOKEN = base58Decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const JUP = base58Decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ODD = new Uint8Array(32).fill(21);

type Ix = { program: Uint8Array; accounts: Uint8Array[]; data: number[] };
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));

// Legacy message, one empty signature slot, ME as fee payer.
function tx(ixs: Ix[]) {
  const keys: Uint8Array[] = [ME];
  const idx = (k: Uint8Array) => {
    let i = keys.findIndex((x) => x.every((b, j) => b === k[j]));
    if (i < 0) i = keys.push(k) - 1;
    return i;
  };
  const compiled = ixs.map((ix) => ({ p: idx(ix.program), a: ix.accounts.map(idx), d: ix.data }));
  const bytes = [1, ...new Array(64).fill(0), 1, 0, 0, keys.length, ...keys.flatMap((k) => [...k]), ...new Array(32).fill(1), compiled.length];
  for (const c of compiled) bytes.push(c.p, c.a.length, ...c.a, c.d.length, ...c.d);
  return parseTransaction(Uint8Array.from(bytes));
}

const transfer = (to: Uint8Array, lamports: bigint): Ix => ({ program: SYSTEM, accounts: [ME, to], data: [...u32(2), ...u64(lamports)] });
const cases: [string, Ix[], string | null][] = [
  ["plain SOL transfer passes", [transfer(OTHER, 1000n)], null],
  ["unlimited token approval is blocked", [{ program: TOKEN, accounts: [ACCT, OTHER, ME], data: [4, ...u64(0xffffffffffffffffn)] }], "token-approval"],
  ["approve-checked is blocked", [{ program: TOKEN, accounts: [ACCT, MINT, OTHER, ME], data: [13, ...u64(5n), 6] }], "token-approval"],
  ["token owner change is blocked", [{ program: TOKEN, accounts: [ACCT, ME], data: [6, 2, 1, ...OTHER] }], "authority-change"],
  ["wallet reassign is blocked", [{ program: SYSTEM, accounts: [ME], data: [...u32(1), ...OTHER] }], "wallet-takeover"],
  ["close to someone else is blocked", [{ program: TOKEN, accounts: [ACCT, OTHER, ME], data: [9] }], "close-to-other"],
  ["close back to me passes", [{ program: TOKEN, accounts: [ACCT, ME, ME], data: [9] }], null],
  ["Jupiter swap passes", [transfer(ACCT, 5000n), { program: JUP, accounts: [ME, ACCT], data: [1, 2, 3] }], null],
  ["spray to many wallets warns", [transfer(OTHER, 1n), transfer(MINT, 1n), transfer(ACCT, 1n)], "many-recipients"],
  ["only unknown programs warns", [{ program: ODD, accounts: [ME], data: [0] }], "all-unknown"],
];

let failed = 0;
for (const [name, ixs, expect] of cases) {
  const findings = guardInstructions(tx(ixs));
  const blocked = guardRefusal(findings) !== null;
  const ok = expect === null ? !blocked && !findings.length : findings.some((f) => f.code === expect);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(findings)}`}`);
}
console.log(failed ? `${failed} failed` : `all ${cases.length} passed`);
process.exit(failed ? 1 : 0);
