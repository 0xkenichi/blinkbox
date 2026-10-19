// Minimal, dependency-free Solana transaction reader. It only decodes what
// Blinkbox needs to check a blink's transaction against PayBox's rules and to
// describe it to the agent. PayBox still simulates and previews the bytes itself.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const value = ALPHABET_MAP.get(text[i]!);
    if (value === undefined) throw new Error("Invalid base58 character.");
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/** True when `text` is a canonical base58 encoding of a 32-byte public key. */
export function isPublicKey(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  try {
    const bytes = base58Decode(text);
    return bytes.length === 32 && base58Encode(bytes) === text;
  } catch {
    return false;
  }
}

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining() {
    return this.bytes.length - this.offset;
  }
  u8(): number {
    if (this.remaining < 1) throw new Error("Transaction ended unexpectedly.");
    return this.bytes[this.offset++]!;
  }
  take(length: number): Uint8Array {
    if (length < 0 || this.remaining < length) throw new Error("Transaction ended unexpectedly.");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  shortVec(): number {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const byte = this.u8();
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
    throw new Error("Invalid compact-u16 length.");
  }
}

export interface Instruction {
  programId: string;
  accounts: number[];
  data: Uint8Array;
}

export interface ParsedTransaction {
  bytes: number;
  version: "legacy" | 0;
  signatureCount: number;
  nonEmptySignatures: number;
  requiredSignatures: number;
  feePayer: string;
  staticKeys: string[];
  instructions: Instruction[];
  lookupTables: number;
}

export function parseTransaction(raw: Uint8Array): ParsedTransaction {
  const r = new Reader(raw);
  const signatureCount = r.shortVec();
  let nonEmptySignatures = 0;
  for (let i = 0; i < signatureCount; i++) {
    if (r.take(64).some((b) => b !== 0)) nonEmptySignatures++;
  }

  const prefix = r.u8();
  let version: "legacy" | 0 = "legacy";
  let requiredSignatures = prefix;
  if (prefix & 0x80) {
    if ((prefix & 0x7f) !== 0) throw new Error(`Unsupported transaction version ${prefix & 0x7f}.`);
    version = 0;
    requiredSignatures = r.u8();
  }
  r.u8(); // read-only signed accounts
  r.u8(); // read-only unsigned accounts

  const staticKeys = Array.from({ length: r.shortVec() }, () => base58Encode(r.take(32)));
  r.take(32); // recent blockhash; PayBox replaces it before simulation

  const instructions: Instruction[] = Array.from({ length: r.shortVec() }, () => {
    const programIndex = r.u8();
    const accounts = Array.from(r.take(r.shortVec()));
    const data = r.take(r.shortVec());
    const programId = staticKeys[programIndex];
    if (!programId) throw new Error("Instruction references a program outside the static account keys.");
    return { programId, accounts, data };
  });

  let lookupTables = 0;
  if (version === 0) {
    lookupTables = r.shortVec();
    for (let i = 0; i < lookupTables; i++) {
      r.take(32);
      r.take(r.shortVec());
      r.take(r.shortVec());
    }
  }
  if (r.remaining !== 0) throw new Error("Transaction has trailing bytes.");
  if (!staticKeys[0]) throw new Error("Transaction has no fee payer.");

  return {
    bytes: raw.length,
    version,
    signatureCount,
    nonEmptySignatures,
    requiredSignatures,
    feePayer: staticKeys[0],
    staticKeys,
    instructions,
    lookupTables,
  };
}

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

export const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM]: "System Program",
  [TOKEN]: "SPL Token",
  [TOKEN_2022]: "SPL Token-2022",
  [COMPUTE_BUDGET]: "Compute Budget",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  Stake11111111111111111111111111111111111111: "Stake Program",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9: "Jupiter Lend",
  noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV: "Noop (event logging)",
  FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q: "Lulo",
  SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: "SPL Stake Pool",
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: "Kamino Lending",
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: "marginfi v2",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: "Drift v2",
};

function u32(data: Uint8Array, at: number) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
}
function u64(data: Uint8Array, at: number) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);
}

export interface PaymentHint {
  kind: "sol" | "token";
  from: string;
  to: string;
  amount: string; // atomic units (lamports, or token base units)
  mint?: string;
  decimals?: number;
}

export interface TransactionSummary {
  version: "legacy" | "v0";
  bytes: number;
  feePayer: string;
  instructionCount: number;
  lookupTables: number;
  programs: { id: string; name: string | null }[];
  unrecognizedPrograms: number;
  solOutLamports: string;
  transfers: PaymentHint[];
  priorityFeeLamports: string | null;
}

/** Describes what the transaction does, decoding only well-known instructions. */
export function summarize(tx: ParsedTransaction): TransactionSummary {
  const key = (i: number | undefined) => (i === undefined ? "?" : tx.staticKeys[i] ?? `lookup#${i - tx.staticKeys.length}`);
  const programs = new Map<string, string | null>();
  const transfers: PaymentHint[] = [];
  let solOut = 0n;
  let unitPrice: bigint | null = null;
  let unitLimit: number | null = null;

  for (const ix of tx.instructions) {
    programs.set(ix.programId, KNOWN_PROGRAMS[ix.programId] ?? null);
    const d = ix.data;
    if (ix.programId === SYSTEM && d.length >= 12 && u32(d, 0) === 2) {
      const lamports = u64(d, 4);
      const from = key(ix.accounts[0]);
      transfers.push({ kind: "sol", from, to: key(ix.accounts[1]), amount: lamports.toString() });
      if (from === tx.feePayer) solOut += lamports;
    } else if ((ix.programId === TOKEN || ix.programId === TOKEN_2022) && d.length >= 9 && d[0] === 3) {
      transfers.push({ kind: "token", from: key(ix.accounts[0]), to: key(ix.accounts[1]), amount: u64(d, 1).toString() });
    } else if ((ix.programId === TOKEN || ix.programId === TOKEN_2022) && d.length >= 10 && d[0] === 12) {
      transfers.push({
        kind: "token", from: key(ix.accounts[0]), to: key(ix.accounts[2]), mint: key(ix.accounts[1]),
        amount: u64(d, 1).toString(), decimals: d[9]!,
      });
    } else if (ix.programId === COMPUTE_BUDGET && d.length >= 9 && d[0] === 3) {
      unitPrice = u64(d, 1);
    } else if (ix.programId === COMPUTE_BUDGET && d.length >= 5 && d[0] === 2) {
      unitLimit = u32(d, 1);
    }
  }

  const priorityFee = unitPrice !== null ? (unitPrice * BigInt(unitLimit ?? 200_000 * tx.instructions.length)) / 1_000_000n : null;
  const list = [...programs].map(([id, name]) => ({ id, name }));
  return {
    version: tx.version === 0 ? "v0" : "legacy",
    bytes: tx.bytes,
    feePayer: tx.feePayer,
    instructionCount: tx.instructions.length,
    lookupTables: tx.lookupTables,
    programs: list,
    unrecognizedPrograms: list.filter((p) => p.name === null).length,
    solOutLamports: solOut.toString(),
    transfers,
    priorityFeeLamports: priorityFee === null ? null : priorityFee.toString(),
  };
}

/**
 * Checks the PayBox Solana proposal contract: legacy/v0, at most 1,232 bytes,
 * exactly one required signer who is the fee payer and the expected sender, an
 * empty signature slot, and no durable nonce. Returns a reason string on failure.
 */
export function payboxIncompatibility(tx: ParsedTransaction, sender: string): string | null {
  if (tx.bytes > 1232) return `The transaction is ${tx.bytes} bytes; PayBox accepts at most 1,232.`;
  if (tx.requiredSignatures !== 1 || tx.signatureCount !== 1) {
    return `The transaction needs ${tx.requiredSignatures} signers. PayBox only executes transactions signed by your wallet alone, so this blink (often an NFT mint or a co-signed action) cannot run through PayBox yet.`;
  }
  if (tx.nonEmptySignatures > 0) return "The blink returned a pre-signed transaction. PayBox rejects pre-signed payloads.";
  if (tx.feePayer !== sender) return `The blink set fee payer ${tx.feePayer}, not your wallet ${sender}.`;
  const first = tx.instructions[0];
  if (first && first.programId === SYSTEM && first.data.length >= 4 && u32(first.data, 0) === 4) {
    return "The transaction uses a durable nonce, which PayBox does not accept.";
  }
  return null;
}
