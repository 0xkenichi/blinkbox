// Solana Actions ("blinks") client. Every request goes through Dialect's
// public blink proxy, so the hosted plugin needs only a few fixed network hosts
// while still reaching any registered action API.

export const PROXY = "https://api.dial.to/v1/blink";
const REGISTRY = "https://actions-registry.dial.to/all";

// PayBox gives each hosted call 10 seconds including sandbox startup. Requests
// share one deadline so a slow provider gets whatever time is left.
const CALL_BUDGET_MS = 8_500;
const MAX_REQUEST_MS = 6_000;
let deadline = Date.now() + CALL_BUDGET_MS;

/** Starts the time budget for one tool call. */
export function beginCall() {
  deadline = Date.now() + CALL_BUDGET_MS;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class BlinkError extends Error {}

async function request(url: string, init: { method?: "GET" | "POST"; body?: Json; headers?: Record<string, string> } = {}) {
  const timeout = Math.min(MAX_REQUEST_MS, deadline - Date.now());
  if (timeout < 250) throw new BlinkError("Ran out of time before contacting the blink provider; try again.");
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new BlinkError(`${new URL(url).hostname} ${reason}.`);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON bodies are reported below.
  }
  return { status: response.status, ok: response.ok, body };
}

export async function getJson(url: string, headers?: Record<string, string>) {
  return request(url, { headers });
}

function errorMessage(body: unknown): string | null {
  const message = rawErrorMessage(body);
  return message ? message.trim().replace(/[.\s]+$/, "") : null;
}

function rawErrorMessage(body: unknown): string | null {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") return b.message;
    if (b.error && typeof b.error === "object" && typeof (b.error as Record<string, unknown>).message === "string") {
      return (b.error as Record<string, string>).message!;
    }
    if (typeof b.error === "string") return b.error;
  }
  return null;
}

const ACTION_PREFIXES = ["blink:", "solana-action:"];

/**
 * Turns any blink form people share into the underlying Action API URL:
 * `solana-action:` / `blink:` links, dial.to (or other interstitial) links with
 * an `action=` parameter, Dialect proxy links, and plain Action API URLs.
 */
export function normalizeBlinkUrl(input: string): string {
  let text = input.trim();
  for (let i = 0; i < 4; i++) {
    const prefix = ACTION_PREFIXES.find((p) => text.toLowerCase().startsWith(p));
    if (prefix) {
      text = text.slice(prefix.length);
      if (/^https%3A/i.test(text)) text = decodeURIComponent(text);
      continue;
    }
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new BlinkError("That is not a valid blink URL.");
    }
    const action = url.searchParams.get("action");
    if (action && ACTION_PREFIXES.some((p) => action.toLowerCase().startsWith(p))) {
      text = action;
      continue;
    }
    if (url.hostname === "api.dial.to" && url.pathname.startsWith("/v1/blink") && url.searchParams.get("apiUrl")) {
      text = url.searchParams.get("apiUrl")!;
      continue;
    }
    const jupiter = url.hostname === "jup.ag" && url.pathname.match(/^\/swap\/([^/]+)$/);
    if (jupiter) {
      text = `https://jupiter.dial.to/api/v0/swap/${jupiter[1]}`;
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
      throw new BlinkError("Blink Action URLs must use HTTPS on port 443 without credentials.");
    }
    url.hash = "";
    return url.toString();
  }
  throw new BlinkError("That blink link is nested too deeply.");
}

/** Resolves an href from an action response back to its underlying Action API URL. */
export function resolveHref(href: string, base: string): string {
  return normalizeBlinkUrl(new URL(href, base).toString());
}

export function proxied(actionUrl: string, path = ""): string {
  return `${PROXY}${path}?apiUrl=${encodeURIComponent(actionUrl)}`;
}

export type TrustState = "trusted" | "dialect" | "unverified" | "malicious";

/** Looks up an action host in the Dialect blink registry. */
export async function trustFor(actionUrl: string): Promise<{ host: string; state: TrustState }> {
  const host = new URL(actionUrl).hostname.toLowerCase();
  const { ok, body } = await request(REGISTRY);
  const actions = ok && body && typeof body === "object" ? (body as { actions?: unknown }).actions : undefined;
  if (!Array.isArray(actions)) throw new BlinkError("The Dialect blink registry is unavailable, so the blink's safety could not be checked.");
  const entry = actions.find((a) => a && typeof a === "object" && (a as { host?: unknown }).host === host) as { state?: string } | undefined;
  if (entry?.state === "malicious") return { host, state: "malicious" };
  if (entry?.state === "trusted") return { host, state: "trusted" };
  if (host === "dial.to" || host.endsWith(".dial.to")) return { host, state: "dialect" };
  return { host, state: "unverified" };
}

export interface ActionParameter {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  pattern?: string;
  patternDescription?: string;
  min?: number | string;
  max?: number | string;
  options?: { label: string; value: string; selected?: boolean }[];
}

export interface LinkedAction {
  type: string;
  href: string;
  label: string;
  parameters?: ActionParameter[];
}

export interface ActionMetadata {
  type?: string;
  title: string;
  description: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  error?: { message: string };
  links?: { actions?: LinkedAction[] };
}

function asAction(body: unknown): ActionMetadata | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string" || typeof b.label !== "string") return null;
  return b as unknown as ActionMetadata;
}

export async function fetchAction(actionUrl: string): Promise<ActionMetadata> {
  const started = Date.now();
  let { ok, status, body } = await request(proxied(actionUrl));
  // The proxy occasionally fails an upstream fetch; one quick retry fits the 10s budget.
  if (status === 502 && Date.now() - started < 2_500) ({ ok, status, body } = await request(proxied(actionUrl)));
  const action = asAction(body);
  if (!ok || !action) {
    throw new BlinkError(`The blink did not return action details (${errorMessage(body) ?? `HTTP ${status}`}).`);
  }
  return action;
}

export interface PostResult {
  type?: string;
  transaction?: string;
  message?: string;
  externalLink?: string;
  links?: { next?: { type: "post"; href: string } | { type: "inline"; action: ActionMetadata } };
}

export async function postAction(actionUrl: string, account: string, data: Record<string, string | string[]>): Promise<PostResult> {
  // `type` is optional in the spec, but some providers reject requests without it.
  const body: Json = Object.keys(data).length ? { type: "transaction", account, data } : { type: "transaction", account };
  const started = Date.now();
  let { ok, status, body: response } = await request(proxied(actionUrl), { method: "POST", body });
  // A proxy 502 means the provider was never reached, so retrying cannot duplicate anything.
  if (status === 502 && errorMessage(response) === "Failed to fetch the URL" && Date.now() - started < 2_500) {
    ({ ok, status, body: response } = await request(proxied(actionUrl), { method: "POST", body }));
  }
  if (!ok || !response || typeof response !== "object") {
    const reason = errorMessage(response);
    if (!reason && status >= 500) {
      throw new BlinkError(`The blink's provider is failing right now (HTTP ${status}). Nothing was prepared; try again later or use another route from find_blinks.`);
    }
    throw new BlinkError(`The blink refused the request: ${reason ?? `HTTP ${status}`}.`);
  }
  return response as PostResult;
}

export async function postChain(actionUrl: string, account: string, signature?: string, state?: string): Promise<ActionMetadata> {
  const body: Json = { account, ...(signature ? { signature } : {}), ...(state ? { state } : {}) };
  const { ok, status, body: response } = await request(proxied(actionUrl, "/chain"), { method: "POST", body });
  const action = asAction(response);
  if (!ok || !action) throw new BlinkError(`The blink did not return a next step: ${errorMessage(response) ?? `HTTP ${status}`}.`);
  return action;
}

export async function fetchDataTable(actionUrl: string, account?: string) {
  const url = `${PROXY}-data-table?apiUrl=${encodeURIComponent(actionUrl)}${account ? `&account=${account}` : ""}`;
  try {
    // Stats are a nice-to-have: give up early rather than hold the call open.
    const { ok, body } = await Promise.race([
      request(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow")), 3_500).unref()),
    ]);
    const rows = ok && body && typeof body === "object" ? (body as { rows?: unknown }).rows : undefined;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is { title: string; value: string } => !!r && typeof r.title === "string" && typeof r.value === "string")
      .slice(0, 12)
      .map((r) => ({ title: r.title, value: r.value }));
  } catch {
    return []; // Data tables are optional context, never a reason to fail.
  }
}

const TEMPLATE = /\{([A-Za-z0-9_.-]+)\}|%7B([A-Za-z0-9_.-]+)%7D/gi;

export function templateNames(href: string): string[] {
  return [...new Set([...href.matchAll(TEMPLATE)].map((m) => m[1] ?? m[2]!))];
}

/**
 * Validates user inputs against an action's declared parameters. Placeholders
 * in the href that the provider did not declare are treated as required text.
 * Returns problems, if any.
 */
export function checkInputs(declared: ActionParameter[], inputs: Record<string, string | string[]>, placeholders: string[]): string[] {
  const problems: string[] = [];
  const names = new Set(declared.map((p) => p.name));
  // A value that fills a URL placeholder is always needed, whatever the provider declared.
  const parameters = [
    ...declared.map((p) => (placeholders.includes(p.name) ? { ...p, required: true } : p)),
    ...placeholders.filter((n) => !names.has(n)).map((name) => ({ name, required: true })),
  ];
  const known = new Set(parameters.map((p) => p.name));
  for (const name of Object.keys(inputs)) if (!known.has(name)) problems.push(`Unknown input "${name}". Expected: ${[...known].join(", ") || "none"}.`);
  for (const p of parameters as ActionParameter[]) {
    const value = inputs[p.name];
    const label = p.label ? `${p.name} (${p.label})` : p.name;
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      if (p.required) problems.push(`Missing required input ${label}.`);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && p.type !== "checkbox") problems.push(`Input ${label} takes a single value.`);
    if (p.options?.length) {
      const allowed = new Set(p.options.map((o) => o.value));
      for (const v of values) if (!allowed.has(v)) problems.push(`Input ${label} must be one of: ${[...allowed].join(", ")}.`);
      continue;
    }
    for (const v of values) {
      if (v.length > 512) problems.push(`Input ${label} is too long.`);
      if (p.type === "number") {
        const n = Number(v);
        if (!/^-?\d+(\.\d+)?$/.test(v) || !Number.isFinite(n)) problems.push(`Input ${label} must be a number.`);
        else {
          if (typeof p.min === "number" && n < p.min) problems.push(`Input ${label} must be at least ${p.min}.`);
          if (typeof p.max === "number" && n > p.max) problems.push(`Input ${label} must be at most ${p.max}.`);
        }
      }
      if (p.pattern && v.length <= 512) {
        let re: RegExp | null = null;
        try {
          re = new RegExp(`^(?:${p.pattern})$`);
        } catch {
          // An invalid provider pattern is not the user's problem.
        }
        if (re && !re.test(v)) problems.push(`Input ${label} is invalid${p.patternDescription ? `: ${p.patternDescription}` : "."}`);
      }
    }
  }
  return problems;
}

/** Fills `{name}` placeholders in an Action href with URL-encoded inputs. */
export function fillTemplate(href: string, inputs: Record<string, string | string[]>): string {
  const filled = href.replace(TEMPLATE, (_match, a: string | undefined, b: string | undefined) => {
    const value = inputs[(a ?? b)!];
    return encodeURIComponent(Array.isArray(value) ? value.join(",") : value ?? "");
  });
  return normalizeBlinkUrl(filled);
}
