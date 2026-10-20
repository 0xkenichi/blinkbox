// Spots address poisoning in a wallet's transfer history, so the user hears about it
// before they ever copy the planted address. Pure logic: the bot fetches the transfers.
//
// What poisoners plant (seen for real on Base, Oct 20, 2026):
//  - a zero-value transfer "from" the wallet to a lookalike address, which any contract can
//    emit for tokens like USDC without the wallet signing anything;
//  - a fake token ("ÚSDС") "sent" from the wallet to the same lookalike, mirroring a real amount;
//  - dust sent to the wallet from an address that imitates someone it pays.

import { lookalikeOf, type AddressKind } from "./lookalike.js";

export type Transfer = {
  token: string; // token contract or mint ("native" for SOL/ETH)
  from: string;
  to: string;
  value: bigint;
  txHash: string;
  txSender?: string; // who signed the transaction, when known
};

export type TokenInfo = { symbol?: string; name?: string };
export type PoisonReason = "zero-value" | "fake-token" | "lookalike";
export type PoisonFinding = { address: string; reasons: PoisonReason[]; original?: string; txHash: string; fakeToken?: string };

// Characters that render like Latin letters in token names. NFKD + stripping marks handles
// accents (Ú → U); this table handles other scripts (Cyrillic С → C).
const CONFUSABLES: Record<string, string> = {
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I", "К": "K", "М": "M", "О": "O", "Р": "P", "Ѕ": "S", "Т": "T", "Х": "X", "У": "Y",
  "а": "a", "с": "c", "е": "e", "о": "o", "р": "p", "ѕ": "s", "х": "x", "у": "y", "і": "i", "ԁ": "d", "ս": "u", "Ս": "U",
  "Α": "A", "Β": "B", "Ε": "E", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X", "Υ": "Y", "υ": "u", "ο": "o",
  "Ꭰ": "D", "Ꮪ": "S", "Ꮯ": "C", "ꓴ": "U", "ꓢ": "S", "ꓓ": "D", "ꓚ": "C", "＄": "S", "$": "S",
};
const skeleton = (s: string) =>
  [...s.normalize("NFKD").replace(/[̀-ͯ]/g, "")].map((c) => CONFUSABLES[c] ?? c).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");

const STABLES = new Set(["USDC", "USDT", "USDCOIN", "TETHERUSD", "USDG", "DAI", "EURC", "PYUSD"]);

/** A token whose name or symbol reads as a well-known stablecoin but that isn't one of the official contracts. */
export function isStablecoinImpostor(token: string, info: TokenInfo | undefined, official: string[]): boolean {
  if (official.some((o) => o.toLowerCase() === token.toLowerCase())) return false;
  return [info?.symbol, info?.name].some((s) => !!s && STABLES.has(skeleton(s)));
}

/** True when a token label uses look-alike characters instead of plain ASCII (e.g. "ÚSDС"). */
export const hasDisguisedCharacters = (s: string) => /[^\x20-\x7e]/.test(s) && STABLES.has(skeleton(s));

export type ScanContext = {
  kind: AddressKind;
  wallet: string;
  known: string[]; // addresses the user has really paid
  official: string[]; // genuine token contracts on this chain
  tokenInfo: (token: string) => TokenInfo | undefined;
};

/** Finds planted addresses in a batch of transfers touching `wallet`. One finding per planted address. */
export function findPoisoning(transfers: Transfer[], ctx: ScanContext): PoisonFinding[] {
  const eq = (a?: string, b?: string) => !!a && !!b && (ctx.kind === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const isKnown = (a: string) => eq(a, ctx.wallet) || ctx.known.some((k) => eq(k, a));
  const byAddress = new Map<string, PoisonFinding>();
  const add = (address: string, reason: PoisonReason, t: Transfer, fakeToken?: string) => {
    if (isKnown(address)) return;
    const key = ctx.kind === "evm" ? address.toLowerCase() : address;
    const f = byAddress.get(key) ?? { address, reasons: [], txHash: t.txHash, original: lookalikeOf(address, [...ctx.known, ctx.wallet], ctx.kind) };
    if (!f.reasons.includes(reason)) f.reasons.push(reason);
    if (fakeToken && !f.fakeToken) f.fakeToken = fakeToken;
    byAddress.set(key, f);
  };

  for (const t of transfers) {
    const outgoing = eq(t.from, ctx.wallet), incoming = eq(t.to, ctx.wallet);
    if (outgoing) {
      // The wallet "sent" this but didn't sign the transaction: someone else made it appear.
      const unsigned = t.txSender !== undefined && !eq(t.txSender, ctx.wallet);
      if (!unsigned) continue;
      const info = ctx.tokenInfo(t.token);
      if (t.value === 0n) add(t.to, "zero-value", t);
      if (isStablecoinImpostor(t.token, info, ctx.official)) add(t.to, "fake-token", t, info?.symbol ?? info?.name);
      if (lookalikeOf(t.to, ctx.known, ctx.kind)) add(t.to, "lookalike", t);
    } else if (incoming) {
      // Dust from an address dressed up as someone the user pays (or as the user's own wallet).
      if (lookalikeOf(t.from, [...ctx.known, ctx.wallet], ctx.kind)) add(t.from, "lookalike", t);
    }
  }
  return [...byAddress.values()];
}
