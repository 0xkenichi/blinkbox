// Blink discovery: live markets from Dialect's Markets API plus a small set of
// protocol blinks from the Standard Blinks Library that need no market lookup.

import { getJson, normalizeBlinkUrl } from "./blinks.js";

const MARKETS = "https://markets.dial.to/api/v0/markets";

export const CATEGORIES = ["all", "yield", "lending", "loop", "swap", "stake", "transfer", "prediction"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Listing {
  id: string;
  category: Exclude<Category, "all">;
  title: string;
  provider: string;
  token?: string;
  apy_percent?: number;
  borrow_apy_percent?: number;
  tvl_usd?: number;
  odds?: { yes_ask: number | null; no_ask: number | null; yes_bid: number | null; no_bid: number | null; volume: number | null; closes_at: string | null };
  blinks: { action: string; url: string }[];
  url_template?: string;
  executable: boolean;
  note?: string;
}

const TEMPLATES: Listing[] = [
  {
    id: "jupiter.swap", category: "swap", title: "Swap any token on Jupiter", provider: "Jupiter",
    blinks: [{ action: "swap", url: "https://jupiter.dial.to/api/v0/swap/SOL-USDC" }],
    url_template: "https://jupiter.dial.to/api/v0/swap/{FROM}-{TO}",
    executable: true,
    note: "Replace {FROM} and {TO} with major token symbols (SOL, USDC, JUP) or, for anything else, mint addresses. The amount input is in units of FROM.",
  },
  {
    id: "jito.stake", category: "stake", title: "Liquid-stake SOL for JitoSOL", provider: "Jito", token: "JitoSOL",
    blinks: [
      { action: "stake (via Jupiter)", url: "https://jupiter.dial.to/api/v0/swap/SOL-J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" },
      { action: "stats", url: "https://jito.dial.to/stake" },
    ],
    executable: true,
    note: "The Jupiter route buys JitoSOL at the pool rate. Inspect the jito.dial.to blink for live APY and your balances.",
  },
  {
    id: "jupiter.earn", category: "yield", title: "Deposit into Jupiter Lend Earn", provider: "Jupiter", token: "USDC",
    blinks: [
      { action: "deposit", url: "https://jupiter.dial.to/api/v0/lend/earn/USDC/deposit" },
      { action: "withdraw", url: "https://jupiter.dial.to/api/v0/lend/earn/USDC/withdraw" },
    ],
    url_template: "https://jupiter.dial.to/api/v0/lend/earn/{TOKEN}/deposit",
    executable: true,
  },
  {
    id: "raydium.ray-stake", category: "stake", title: "Stake RAY in Raydium", provider: "Raydium", token: "RAY",
    blinks: [
      { action: "stake", url: "https://raydium.dial.to/api/v0/farm/RAY/stake" },
      { action: "unstake", url: "https://raydium.dial.to/api/v0/farm/RAY/unstake" },
    ],
    executable: true,
  },
  {
    id: "solana.transfer", category: "transfer", title: "Send SOL or any SPL token", provider: "Solana",
    blinks: [
      { action: "send SOL", url: "https://solana-sbl.dial.to/api/v0/transfer/SOL" },
      { action: "send USDC", url: "https://solana-sbl.dial.to/api/v0/transfer/USDC" },
    ],
    url_template: "https://solana-sbl.dial.to/api/v0/transfer/{TOKEN}",
    executable: true,
    note: "Inputs: `to` (recipient address) and `amount` (in whole tokens).",
  },
];

type Market = Record<string, unknown> & {
  id: string;
  type: string;
  title?: string;
  productName?: string;
  provider?: { name?: string };
  token?: { symbol?: string; address?: string };
  depositApy?: number;
  borrowApy?: number;
  totalDepositUsd?: number;
  actions?: Record<string, { blinkUrl?: string }>;
  yesAsk?: number; noAsk?: number; yesBid?: number; noBid?: number; volume?: number; closeTime?: number;
  status?: string;
};

function num(v: unknown) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined;
}

function toListing(m: Market): Listing | null {
  const provider = m.provider?.name ?? "Unknown";
  if (m.type === "prediction") {
    return {
      id: m.id, category: "prediction", title: m.title ?? m.id, provider,
      odds: {
        yes_ask: num(m.yesAsk) ?? null, no_ask: num(m.noAsk) ?? null,
        yes_bid: num(m.yesBid) ?? null, no_bid: num(m.noBid) ?? null,
        volume: num(m.volume) ?? null,
        closes_at: typeof m.closeTime === "number" ? new Date(m.closeTime * 1000).toISOString() : null,
      },
      blinks: [], executable: false,
      note: "Live odds for pricing and forecasting (prices are per $1 payout). Trading is not available through blinks yet.",
    };
  }
  if (!["yield", "lending", "loop"].includes(m.type)) return null;
  const blinks = Object.entries(m.actions ?? {})
    .flatMap(([action, v]) => {
      if (!v?.blinkUrl) return [];
      try {
        return [{ action, url: normalizeBlinkUrl(v.blinkUrl) }];
      } catch {
        return [];
      }
    });
  if (!blinks.length) return null;
  const symbol = m.token?.symbol;
  return {
    id: m.id, category: m.type as Listing["category"],
    title: [provider, m.productName, symbol].filter(Boolean).join(" "), provider, token: symbol,
    apy_percent: num(m.depositApy), borrow_apy_percent: num(m.borrowApy), tvl_usd: num(m.totalDepositUsd),
    blinks, executable: true,
  };
}

function matches(l: Listing, words: string[]) {
  const hay = `${l.title} ${l.provider} ${l.token ?? ""} ${l.category} ${l.note ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export async function findBlinks(input: { category: Category; query?: string; limit: number; clientKey: string | null }) {
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const marketTypes = input.category === "all" ? ["yield", "lending", "loop"] : ["yield", "lending", "loop", "prediction"].filter((t) => t === input.category);
  const notes: string[] = [];
  let live: Listing[] = [];

  if (marketTypes.length) {
    const url = `${MARKETS}?type=${marketTypes.join(",")}&limit=200`;
    try {
      const { ok, status, body } = await getJson(url, input.clientKey ? { "x-dialect-client-key": input.clientKey } : {});
      const markets = ok && body && typeof body === "object" ? (body as { markets?: unknown }).markets : undefined;
      if (Array.isArray(markets)) {
        // The API lists some markets once per purchase token; keep one of each.
        const seen = new Set<string>();
        for (const m of markets) {
          if (!m || typeof m !== "object" || typeof (m as Market).id !== "string") continue;
          const listing = toListing(m as Market);
          const key = listing && `${listing.title}|${listing.odds?.yes_ask ?? listing.apy_percent}`;
          if (listing && !seen.has(key!)) {
            seen.add(key!);
            live.push(listing);
          }
        }
      } else {
        notes.push(`Live markets were unavailable (HTTP ${status}).`);
      }
    } catch (error) {
      notes.push(`Live markets were unavailable: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }

  const templates = TEMPLATES.filter((t) => input.category === "all" || t.category === input.category);
  let results = [...live, ...templates].filter((l) => matches(l, words));
  // Highest yield first for earning products; templates keep their order.
  results.sort((a, b) => (b.apy_percent ?? -1) - (a.apy_percent ?? -1));
  if (input.category === "prediction") results.sort((a, b) => (b.odds?.volume ?? 0) - (a.odds?.volume ?? 0));
  const total = results.length;
  results = results.slice(0, input.limit);

  if (!total && words.length) notes.push(`Nothing matched "${input.query}". Try a token symbol (USDC, SOL), a provider (Kamino, Jito), or a broader category.`);
  return { results, total_matches: total, notes };
}
