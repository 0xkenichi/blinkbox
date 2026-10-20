// Address poisoning: scammers generate an address that starts and ends like one you've paid,
// then plant fake transfers to it in your history so you copy the wrong one next time.
// People check the first and last few characters, so that's exactly what the fakes match.

export type AddressKind = "solana" | "evm";

// EVM addresses are case-insensitive hex; Solana base58 is case-sensitive.
const norm = (a: string, kind: AddressKind) => (kind === "evm" ? a.trim().toLowerCase().replace(/^0x/, "") : a.trim());

function sharedEnds(a: string, b: string): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/**
 * Returns the known address that `candidate` imitates, if any: same start and end, different middle.
 * Three characters at each end (or eight in total) is roughly a 1-in-17-million coincidence for hex
 * and far rarer for base58, while real poisoning addresses match four or more at each end.
 */
export function lookalikeOf(candidate: string, known: string[], kind: AddressKind): string | undefined {
  const c = norm(candidate, kind);
  for (const k of known) {
    const n = norm(k, kind);
    if (!n || n === c || n.length !== c.length) continue;
    const { prefix, suffix } = sharedEnds(c, n);
    if ((prefix >= 3 && suffix >= 3) || prefix + suffix >= 8) return k;
  }
  return undefined;
}

/** Shows where two addresses differ: the matching ends plain, the differing middle in bold (HTML). */
export function markDifference(candidate: string, original: string, kind: AddressKind): string {
  const pre = kind === "evm" && candidate.toLowerCase().startsWith("0x") ? 2 : 0;
  const { prefix, suffix } = sharedEnds(norm(candidate, kind), norm(original, kind));
  const start = pre + prefix, end = candidate.length - suffix;
  return `${candidate.slice(0, start)}<b><u>${candidate.slice(start, end)}</u></b>${candidate.slice(end)}`;
}
