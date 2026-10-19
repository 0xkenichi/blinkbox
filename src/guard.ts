// Blinkbox Guard: instruction-level checks that catch wallet drainers before
// anything is signed. A blink can pass the registry check and still hand over
// control of your tokens or wallet; these are the instructions that do that.
import type { ParsedTransaction } from "./solana.js";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const STAKE = "Stake11111111111111111111111111111111111111";
const U64_MAX = 0xffffffffffffffffn;

export interface GuardFinding {
  level: "block" | "warn";
  code: string;
  message: string;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u32 = (d: Uint8Array, at: number) => view(d).getUint32(at, true);
const u64 = (d: Uint8Array, at: number) => view(d).getBigUint64(at, true);

/** Scans every top-level instruction for ways a transaction can give away control of the signer's assets. */
export function guardInstructions(tx: ParsedTransaction): GuardFinding[] {
  const me = tx.feePayer;
  // Accounts loaded from lookup tables can't be resolved offline; treat them as "not you".
  const key = (i: number | undefined) => (i === undefined ? undefined : tx.staticKeys[i]);
  const isMe = (i: number | undefined) => key(i) === me;
  const findings: GuardFinding[] = [];
  const add = (level: GuardFinding["level"], code: string, message: string) => {
    if (!findings.some((f) => f.code === code)) findings.push({ level, code, message });
  };
  const solRecipients = new Set<string>();

  for (const ix of tx.instructions) {
    const d = ix.data;
    const a = ix.accounts;
    if (ix.programId === SYSTEM && d.length >= 4) {
      const op = u32(d, 0);
      if ((op === 1 || op === 8) && isMe(a[0])) {
        add("block", "wallet-takeover", `It ${op === 1 ? "reassigns your wallet to another program" : "reallocates your wallet account"}, which would hand control of your wallet away.`);
      }
      if (op === 2 && isMe(a[0])) {
        const to = key(a[1]) ?? "a lookup-table address";
        if (to !== me) solRecipients.add(to);
      }
    } else if ((ix.programId === TOKEN || ix.programId === TOKEN_2022) && d.length >= 1) {
      const op = d[0];
      if ((op === 4 && isMe(a[2])) || (op === 13 && isMe(a[3]))) {
        const amount = d.length >= 9 ? u64(d, 1) : 0n;
        const delegate = key(op === 4 ? a[1] : a[2]) ?? "an unknown address";
        add("block", "token-approval", `It gives ${delegate} permission to spend ${amount === U64_MAX ? "an UNLIMITED amount of" : "up to " + amount.toString() + " base units of"} your tokens, even after this transaction.`);
      } else if (op === 6 && isMe(a[1])) {
        const kinds = ["minting", "freezing", "ownership", "closing"];
        add("block", "authority-change", `It transfers ${kinds[d[1] ?? 2] ?? "control"} rights over one of your token accounts to someone else.`);
      } else if (op === 9 && isMe(a[2]) && !isMe(a[1])) {
        add("block", "close-to-other", `It closes one of your token accounts and sends the leftover balance to ${key(a[1]) ?? "an unknown address"}.`);
      } else if ((op === 8 || op === 15) && isMe(a[2])) {
        add("warn", "burn", "It burns (permanently destroys) some of your tokens.");
      }
    } else if (ix.programId === STAKE && d.length >= 36 && u32(d, 0) === 1 && isMe(a[2])) {
      add("block", "stake-authority", "It hands the authority over one of your stake accounts to another address.");
    }
  }

  if (solRecipients.size > 1) add("warn", "many-recipients", `It sends SOL from your wallet to ${solRecipients.size} different addresses.`);
  const unknown = tx.instructions.filter((ix) => !(ix.programId in KNOWN)).length;
  if (unknown && tx.instructions.length === unknown) add("warn", "all-unknown", "Every instruction runs a program Blinkbox doesn't recognize.");
  return findings;
}

// Kept local so this file has no runtime import cycle with solana.ts.
const KNOWN: Record<string, true> = Object.fromEntries([
  SYSTEM, TOKEN, TOKEN_2022, STAKE,
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
].map((k) => [k, true]));

/** One line for people: what Guard refused, or null when nothing is blocked. */
export function guardRefusal(findings: GuardFinding[]): string | null {
  const blocks = findings.filter((f) => f.level === "block");
  if (!blocks.length) return null;
  return `Blinkbox Guard refused this transaction. ${blocks.map((f) => f.message).join(" ")} Legitimate swaps, transfers and deposits never need this, which is how wallet drainers work.`;
}
