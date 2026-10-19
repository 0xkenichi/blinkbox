// Naira on/off-ramp through Paycrest (https://docs.paycrest.io), behind one interface so the
// bot doesn't care which provider is underneath. Blinkbox never holds funds:
// - Buy: Paycrest gives a one-time bank account; the user transfers naira; USDC is sent
//   straight to their PayBox wallet on Solana.
// - Cash out: Paycrest gives a one-time Solana deposit address; the user signs a USDC transfer
//   to it with PayBox (Guard checks it); Paycrest pays naira to their bank or OPay account.
//
// Rates, the institution list and account-name lookup are public. Creating orders needs a
// sender API key (PAYCREST_API_KEY). Without one the provider runs in test mode: everything is
// real except orders, which are simulated in memory and never move money.

export interface Bank { code: string; name: string }
export interface Payout { bankCode: string; bankName: string; accountNumber: string; accountName: string }
// On-ramp KYC Paycrest requires per order. Passed straight through, never stored by Blinkbox.
export interface BuyerKyc { fullName: string; birthDate: string; bvn: string }

export interface Quote {
  id: string;
  side: "buy" | "sell";
  ngn: number; // naira paid (buy) or received (sell)
  usdc: number; // USDC received (buy) or sent (sell)
  rate: number; // naira per USDC, provider fees included
  providerIds: string[];
  expiresAt: number;
  ngnExact?: boolean; // pay-a-bank-account: the recipient gets exactly `ngn`
  network: RampNetwork; // where the USDC lives
}

// Paycrest network ids Blinkbox can deliver to or take USDC from.
export type RampNetwork = "solana" | "base";

export type BuyStatus = "awaiting_payment" | "paid" | "delivered" | "expired" | "failed";
export interface BuyOrder {
  id: string;
  quote: Quote;
  status: BuyStatus;
  payTo: { bankName: string; accountNumber: string; accountName: string; amountNgn: number; validUntil?: string };
  wallet: string;
  signature?: string;
  detail?: string;
}

export type SellStatus = "awaiting_deposit" | "received" | "paid_out" | "expired" | "failed";
export interface SellOrder {
  id: string;
  quote: Quote;
  status: SellStatus;
  depositAddress: string; // where the user's signed USDC transfer goes
  amountToTransfer: number; // USDC including Paycrest's fees
  memo?: string;
  payout: Payout;
  detail?: string;
}

export interface RampProvider {
  name: string;
  test: boolean;
  needsKyc: boolean;
  limits: { buyMinNgn: number; buyMaxNgn: number; sellMinUsdc: number; sellMaxUsdc: number };
  banks(): Promise<Bank[]>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<string>;
  quote(side: "buy", ngn: number, network?: RampNetwork): Promise<Quote>;
  quote(side: "sell", usdc: number, network?: RampNetwork): Promise<Quote>;
  // Quote for paying someone an exact naira amount.
  quoteForNgn(ngn: number, network?: RampNetwork): Promise<Quote>;
  createBuy(quote: Quote, wallet: string, userRef: string, extra: { kyc?: BuyerKyc; refundAccount?: Payout }): Promise<BuyOrder>;
  buyStatus(order: BuyOrder): Promise<BuyOrder>;
  createSell(quote: Quote, payout: Payout, refundAddress: string, userRef: string): Promise<SellOrder>;
  sellStatus(order: SellOrder): Promise<SellOrder>;
  // Test mode only: pretend the bank side happened.
  simulate?(id: string): Promise<void>;
}

const API = "https://api.paycrest.io";

async function call(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.key ? { "API-Key": init.key } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* gateway errors are HTML */ }
  if (!res.ok || data?.status === "error") {
    const detail = typeof data?.data === "object" && data?.data?.message ? `: ${data.data.message}` : "";
    throw new Error(`${data?.message ?? `Paycrest HTTP ${res.status}`}${detail}`);
  }
  return data?.data;
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const round2 = (n: number) => Math.floor(n * 100) / 100;

function sellStatusOf(s: string): SellStatus {
  if (s === "initiated") return "awaiting_deposit";
  if (["validated", "settling", "settled"].includes(s)) return "paid_out";
  if (s === "expired") return "expired";
  if (["cancelled", "refunding", "refunded"].includes(s)) return "failed";
  return "received"; // deposited, pending, fulfilling, fulfilled
}
function buyStatusOf(s: string): BuyStatus {
  if (s === "initiated") return "awaiting_payment";
  if (["validated", "settling", "settled"].includes(s)) return "delivered";
  if (s === "expired") return "expired";
  if (["cancelled", "refunding", "refunded"].includes(s)) return "failed";
  return "paid"; // pending, fulfilling, fulfilled
}

export class PaycrestRamp implements RampProvider {
  name = "Paycrest";
  test: boolean;
  needsKyc = true;
  limits = { buyMinNgn: 2_000, buyMaxNgn: 5_000_000, sellMinUsdc: 1, sellMaxUsdc: 5_000 };
  private bankCache: { at: number; list: Bank[] } | null = null;
  private simulated = new Map<string, { status: "done" }>();

  constructor(private key?: string) {
    this.test = !key;
  }

  async banks(): Promise<Bank[]> {
    if (this.bankCache && Date.now() - this.bankCache.at < 6 * 3600_000) return this.bankCache.list;
    const list = ((await call("/v1/institutions/NGN")) as { name: string; code: string }[]).map((b) => ({ code: b.code, name: b.name }));
    this.bankCache = { at: Date.now(), list };
    return list;
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    if (!/^\d{10}$/.test(accountNumber)) throw new Error("Nigerian account numbers (NUBAN) are exactly 10 digits. For OPay, Moniepoint or PalmPay that's usually your phone number without the first 0.");
    let name: string;
    try {
      name = String(await call("/v2/verify-account", { method: "POST", body: { institution: bankCode, accountIdentifier: accountNumber } }));
    } catch (e) {
      throw new Error(`Couldn't confirm that account (${(e as Error).message}). Check the number and bank, then try again.`);
    }
    if (!name || name === "OK") throw new Error("The bank didn't return a name for that account. Check the number and try again.");
    return name;
  }

  quote(side: "buy", ngn: number, network?: RampNetwork): Promise<Quote>;
  quote(side: "sell", usdc: number, network?: RampNetwork): Promise<Quote>;
  async quote(side: "buy" | "sell", amount: number, network: RampNetwork = "solana"): Promise<Quote> {
    // Rates are quoted per crypto notional; for a naira buy, estimate the USDC first, then re-quote.
    const rateFor = async (usdc: number) => {
      const d = await call(`/v2/rates/${network}/USDC/${Math.max(1, Math.round(usdc * 100) / 100)}/NGN?side=${side}`);
      const leg = d?.[side];
      const rate = Number(leg?.rate);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Paycrest has no ${side === "buy" ? "naira → USDC" : "USDC → naira"} quote right now. Try again shortly.`);
      return { rate, providerIds: (leg.providerIds ?? []) as string[] };
    };
    let usdc = amount;
    if (side === "buy") usdc = amount / (await rateFor(10)).rate;
    const { rate, providerIds } = await rateFor(usdc);
    return side === "buy"
      ? { id: uid("Q"), side, ngn: amount, usdc: round2(amount / rate), rate, providerIds, expiresAt: Date.now() + 10 * 60_000, network }
      : { id: uid("Q"), side, ngn: Math.floor(amount * rate), usdc: amount, rate, providerIds, expiresAt: Date.now() + 10 * 60_000, network };
  }

  async quoteForNgn(ngn: number, network: RampNetwork = "solana"): Promise<Quote> {
    const est = await this.quote("sell", Math.max(1, ngn / 1500), network);
    const q = await this.quote("sell", Math.max(1, Math.ceil((ngn / est.rate) * 100) / 100), network);
    return { ...q, ngn, usdc: Math.ceil((ngn / q.rate) * 1e6) / 1e6, ngnExact: true };
  }

  async createBuy(quote: Quote, wallet: string, userRef: string, extra: { kyc?: BuyerKyc; refundAccount?: Payout }): Promise<BuyOrder> {
    if (this.test) {
      const o: BuyOrder = { id: uid("BUY"), quote, status: "awaiting_payment", wallet, payTo: { bankName: "Test Bank (not real)", accountNumber: "0000000000", accountName: "PAYCREST TEST", amountNgn: quote.ngn } };
      return o;
    }
    if (!extra.kyc || !extra.refundAccount) throw new Error("Buying needs your ID details and a refund account.");
    const d = await call("/v2/sender/orders", {
      method: "POST", key: this.key,
      body: {
        amount: String(quote.ngn), amountIn: "fiat", rate: String(quote.rate), reference: `tg-${userRef}-${quote.id}`,
        source: {
          type: "fiat", currency: "NGN",
          refundAccount: { institution: extra.refundAccount.bankCode, accountIdentifier: extra.refundAccount.accountNumber, accountName: extra.refundAccount.accountName },
          kyc: { entityType: "person", personDetails: { fullName: extra.kyc.fullName, birthDate: extra.kyc.birthDate, idDocument: { type: "BVN", number: extra.kyc.bvn, issuerCountry: "NG" } } },
        },
        destination: { type: "crypto", currency: "USDC", recipient: { address: wallet, network: quote.network }, ...(quote.providerIds[0] ? { providerIds: [quote.providerIds[0]] } : {}) },
      },
    });
    const a = d.providerAccount ?? {};
    return {
      id: d.id, quote, status: buyStatusOf(d.status), wallet,
      payTo: { bankName: a.institution, accountNumber: a.accountIdentifier, accountName: a.accountName, amountNgn: Number(a.amountToTransfer ?? quote.ngn), validUntil: a.validUntil },
    };
  }

  async buyStatus(o: BuyOrder): Promise<BuyOrder> {
    if (this.test) return { ...o, status: this.simulated.has(o.id) ? "delivered" : "awaiting_payment" };
    const d = await call(`/v2/sender/orders/${o.id}`, { key: this.key });
    return { ...o, status: buyStatusOf(d.status), signature: d.txHash ?? o.signature, detail: d.refundReason ?? d.statusDetail };
  }

  async createSell(quote: Quote, payout: Payout, refundAddress: string, userRef: string): Promise<SellOrder> {
    if (this.test) {
      return { id: uid("SELL"), quote, status: "awaiting_deposit", depositAddress: "", amountToTransfer: quote.usdc, payout };
    }
    const body = (exactFiat: boolean) => ({
        amount: exactFiat ? String(quote.ngn) : String(quote.usdc), ...(exactFiat ? { amountIn: "fiat" } : {}),
        rate: String(quote.rate), reference: `tg-${userRef}-${quote.id}`,
        source: { type: "crypto", currency: "USDC", network: quote.network, refundAddress },
        destination: {
          type: "fiat", currency: "NGN",
          ...(quote.providerIds.length ? { providerIds: quote.providerIds.slice(0, 3) } : {}),
          recipient: { institution: payout.bankCode, accountIdentifier: payout.accountNumber, accountName: payout.accountName, memo: quote.ngnExact ? "Blinkbox payment" : "Blinkbox cash-out" },
        },
    });
    // Exact-naira payouts ask Paycrest to size the USDC; fall back to a crypto amount if refused.
    let d: any;
    try {
      d = await call("/v2/sender/orders", { method: "POST", key: this.key, body: body(!!quote.ngnExact) });
    } catch (e) {
      if (!quote.ngnExact || !/amount/i.test((e as Error).message)) throw e;
      d = await call("/v2/sender/orders", { method: "POST", key: this.key, body: body(false) });
    }
    const a = d.providerAccount ?? {};
    return {
      id: d.id, quote, status: sellStatusOf(d.status), payout,
      depositAddress: a.receiveAddress, amountToTransfer: Number(a.amountToTransfer ?? quote.usdc), memo: a.memo || undefined,
    };
  }

  async sellStatus(o: SellOrder): Promise<SellOrder> {
    if (this.test) return { ...o, status: this.simulated.has(o.id) ? "paid_out" : "awaiting_deposit" };
    const d = await call(`/v2/sender/orders/${o.id}`, { key: this.key });
    return { ...o, status: sellStatusOf(d.status), detail: d.refundReason ?? d.statusDetail };
  }

  async simulate(orderId: string) {
    if (this.test) this.simulated.set(orderId, { status: "done" });
  }
}

export function rampProvider(env: Record<string, string | undefined>): RampProvider {
  return new PaycrestRamp(env.PAYCREST_API_KEY || undefined);
}

export const naira = (n: number) => `₦${Math.round(n).toLocaleString("en-US")}`;
export const maskAccount = (n: string) => `****${n.slice(-4)}`;

// "20k", "20,000", "₦20000" → 20000
export function parseNaira(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[₦,\s]|ngn|naira/g, "");
  const m = t.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Most Nigerians use one of these; the rest are reachable by search.
export const POPULAR_BANKS = ["OPay", "Moniepoint", "PalmPay", "Kuda", "Guaranty Trust", "Access Bank", "Zenith", "First Bank", "United Bank for Africa", "Wema", "Fidelity", "Stanbic"];
