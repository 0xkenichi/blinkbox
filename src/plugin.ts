import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  BlinkError, beginCall, checkInputs, fetchAction, fetchDataTable, fillTemplate, normalizeBlinkUrl, postAction, postChain,
  resolveHref, templateNames, trustFor, type ActionMetadata, type LinkedAction, type TrustState,
} from "./blinks.js";
import { CATEGORIES, findBlinks } from "./catalog.js";
import { proposeSolana, solanaOutputSchema } from "./paybox.js";
import { guardInstructions, guardRefusal } from "./guard.js";
import { isPublicKey, parseTransaction, payboxIncompatibility, summarize } from "./solana.js";

const PROTOCOL_VERSION = "2026-07-28";
// Dialect Markets API key. Unset: Dialect's public demo key. "brokered": send no
// header, because PayBox injects a real key configured as a brokered secret.
const DIALECT_CLIENT_KEY = process.env.DIALECT_CLIENT_KEY === "brokered" ? null : process.env.DIALECT_CLIENT_KEY || "pk_demo";

// Address checks run inside the tools (see badAddress) so that a bad value
// returns a schema-valid error result rather than a protocol-level rejection.
const solanaAddress = z.string().max(128);

function badAddress(fields: Record<string, string | undefined>) {
  const wrong = Object.entries(fields).filter(([, v]) => v !== undefined && !isPublicKey(v)).map(([k]) => k);
  return wrong.length ? fail(`${wrong.join(" and ")} must be a base58 Solana public key (the wallet's address).`) : null;
}
const inputValue = z.union([z.string().max(512), z.array(z.string().max(512)).max(16)]);

const listingSchema = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  provider: z.string(),
  token: z.string().optional(),
  apy_percent: z.number().optional(),
  borrow_apy_percent: z.number().optional(),
  tvl_usd: z.number().optional(),
  odds: z.object({
    yes_ask: z.number().nullable(), no_ask: z.number().nullable(),
    yes_bid: z.number().nullable(), no_bid: z.number().nullable(),
    volume: z.number().nullable(), closes_at: z.string().nullable(),
  }).optional(),
  blinks: z.array(z.object({ action: z.string(), url: z.string() })),
  url_template: z.string().optional(),
  executable: z.boolean(),
  note: z.string().optional(),
});

const trustSchema = z.enum(["trusted", "dialect", "unverified", "malicious"]);

const blinkSchema = z.object({
  url: z.string(),
  provider_host: z.string(),
  trust: trustSchema,
  kind: z.enum(["action", "completed"]),
  title: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  disabled: z.boolean(),
  error: z.string().optional(),
  actions: z.array(z.object({
    index: z.number(),
    label: z.string(),
    type: z.string(),
    executable: z.boolean(),
    href: z.string(),
    inputs: z.array(z.object({
      name: z.string(),
      label: z.string().optional(),
      type: z.string(),
      required: z.boolean(),
      min: z.union([z.number(), z.string()]).optional(),
      max: z.union([z.number(), z.string()]).optional(),
      pattern: z.string().optional(),
      options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    })),
    note: z.string().optional(),
  })),
  stats: z.array(z.object({ title: z.string(), value: z.string() })),
  next_step: z.string(),
});
type BlinkView = z.infer<typeof blinkSchema>;

// PayBox requires every result, errors included, to match the declared output
// schema. Each tool therefore returns either its payload or `{ error }`.
const errorField = z.string().max(4000).optional().describe("Present only when the call failed: why, in plain language.");
const blinkOutputSchema = z.object({ blink: blinkSchema.optional(), error: errorField }).strict();
const PROPOSAL = "io.paybox/transactionProposal";
const prepareOutputSchema = z.object({ [PROPOSAL]: solanaOutputSchema.shape[PROPOSAL].optional(), error: errorField }).strict();

const TRUST_TEXT: Record<TrustState, string> = {
  trusted: "Registered as trusted in the Dialect blink registry.",
  dialect: "Hosted by Dialect's Standard Blinks Library.",
  unverified: "Not in the Dialect blink registry. Treat it as unverified.",
  malicious: "Flagged MALICIOUS in the Dialect blink registry. Do not use it.",
};

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }], structuredContent: { error: message } };
}

function errorText(error: unknown) {
  return error instanceof BlinkError ? error.message : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** The buttons a blink offers. A blink without linked actions has one implicit button: itself. */
function linkedActions(meta: ActionMetadata, url: string): (LinkedAction & { resolved: string })[] {
  const actions = meta.links?.actions?.length
    ? meta.links.actions
    : [{ type: "transaction", href: url, label: meta.label }];
  return actions.map((a) => {
    let resolved: string;
    try {
      resolved = resolveHref(a.href, url);
    } catch {
      resolved = a.href;
    }
    return { ...a, resolved };
  });
}

function view(url: string, host: string, trust: TrustState, meta: ActionMetadata, stats: { title: string; value: string }[]): BlinkView {
  const actions = linkedActions(meta, url).map((a, index) => {
    const executable = a.type === "transaction" && !meta.disabled;
    const declared = a.parameters ?? [];
    const declaredNames = new Set(declared.map((p) => p.name));
    // Some providers use {placeholders} in the href without declaring them.
    const implicit = templateNames(a.resolved).filter((n) => !declaredNames.has(n)).map((name) => ({ name, required: true }));
    return {
      index,
      label: a.label,
      type: a.type,
      executable,
      href: a.resolved,
      inputs: [...declared, ...implicit].map((p) => ({
        name: p.name,
        ...("label" in p && p.label ? { label: p.label } : {}),
        type: ("type" in p && p.type) || "text",
        required: !!p.required,
        ...("min" in p && p.min !== undefined ? { min: p.min } : {}),
        ...("max" in p && p.max !== undefined ? { max: p.max } : {}),
        ...("pattern" in p && p.pattern ? { pattern: p.pattern } : {}),
        ...("options" in p && p.options?.length ? { options: p.options.map((o) => ({ label: o.label, value: o.value })) } : {}),
      })),
      ...(executable ? {} : {
        note: meta.disabled ? "This blink is currently disabled by its provider."
          : a.type === "message" ? "Message-signing actions are not supported through PayBox plugins."
          : a.type === "external-link" ? "Opens an external website; nothing to sign."
          : "This step does not produce a transaction.",
      }),
    };
  });
  const runnable = actions.filter((a) => a.executable);
  const kind = meta.type === "completed" ? "completed" as const : "action" as const;
  return {
    url, provider_host: host, trust, kind,
    title: meta.title, description: meta.description,
    ...(meta.icon ? { icon: meta.icon } : {}),
    disabled: !!meta.disabled,
    ...(meta.error?.message ? { error: meta.error.message } : {}),
    actions, stats,
    next_step: kind === "completed" ? "This blink flow is complete."
      : trust === "malicious" ? "Stop: this blink is flagged malicious."
      : runnable.length ? `To run it, call prepare_blink_transaction with this url, an action_index (${runnable.map((a) => `${a.index} = "${a.label}"`).join(", ")}), any required inputs, and the user's Solana wallet address as sender.`
      : "Nothing here can be executed through PayBox.",
  };
}

function viewText(v: BlinkView) {
  const lines = [
    `${v.title} (${v.provider_host})`,
    v.description,
    `Trust: ${TRUST_TEXT[v.trust]}`,
    ...v.stats.map((s) => `${s.title}: ${s.value}`),
    ...(v.error ? [`Provider notice: ${v.error}`] : []),
    "Actions:",
    ...v.actions.map((a) => `  [${a.index}] ${a.label}${a.inputs.length ? ` (inputs: ${a.inputs.map((i) => i.name + (i.required ? "*" : "")).join(", ")})` : ""}${a.executable ? "" : ` — ${a.note}`}`),
    v.next_step,
  ];
  return lines.filter(Boolean).join("\n");
}

function createServer() {
  const server = new McpServer(
    { name: "blinkbox", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "find_blinks",
    {
      title: "Find blinks",
      description:
        "Discover Solana blinks (Solana Actions) an agent can run through PayBox: live yield, lending and loop markets with APY and TVL from Dialect's Markets API, " +
        "plus swap (Jupiter), staking (Jito, Raydium) and token transfer blinks. Category 'prediction' returns live Kalshi prediction-market odds via DFlow for pricing (read-only). " +
        "Pass a returned blink url to inspect_blink.",
      inputSchema: z.object({
        category: z.enum(CATEGORIES).default("all").describe("Kind of blink to find. 'all' covers every executable category."),
        query: z.string().max(100).optional().describe("Words to match, e.g. a token symbol (USDC), a provider (Kamino), or a topic (Senate)."),
        limit: z.number().int().min(1).max(25).default(10),
      }).strict(),
      outputSchema: z.object({
        results: z.array(listingSchema),
        total_matches: z.number(),
        notes: z.array(z.string()),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ category, query, limit }) => {
      beginCall();
      const found = await findBlinks({ category, query, limit, clientKey: DIALECT_CLIENT_KEY });
      const lines = found.results.map((r) => {
        const extra = r.odds
          ? ` — YES ${r.odds.yes_ask ?? "?"} / NO ${r.odds.no_ask ?? "?"}, volume ${r.odds.volume ?? "?"}`
          : `${r.apy_percent !== undefined ? ` — ${r.apy_percent}% APY` : ""}${r.tvl_usd !== undefined ? `, TVL $${Math.round(r.tvl_usd).toLocaleString("en-US")}` : ""}`;
        return `• ${r.title}${extra}${r.blinks.length ? `\n    ${r.blinks.map((b) => `${b.action}: ${b.url}`).join("\n    ")}` : ""}`;
      });
      const text = [`${found.total_matches} match(es); showing ${found.results.length}.`, ...lines, ...found.notes].join("\n");
      return { content: [{ type: "text", text }], structuredContent: found };
    },
  );

  server.registerTool(
    "inspect_blink",
    {
      title: "Inspect blink",
      description:
        "Read a Solana blink before acting on it. Accepts dial.to links, solana-action: links, blink: links, Dialect proxy links, jup.ag swap links, or a raw Action API URL. " +
        "Returns its title, registry trust status, the buttons (actions) it offers with their required inputs, and live stats such as APY or balances when an account is given. Read-only.",
      inputSchema: z.object({
        url: z.string().min(8).max(2048).describe("The blink link or Action API URL."),
        account: solanaAddress.optional().describe("Optional Solana wallet address, to include the user's balances or position in stats."),
      }).strict(),
      outputSchema: blinkOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, account }) => {
      beginCall();
      const invalid = badAddress({ account });
      if (invalid) return invalid;
      try {
        const actionUrl = normalizeBlinkUrl(url);
        const [trust, meta, stats] = await Promise.allSettled([trustFor(actionUrl), fetchAction(actionUrl), fetchDataTable(actionUrl, account)]);
        // A registry verdict of "malicious" matters more than whether the blink loaded.
        if (trust.status === "fulfilled" && trust.value.state === "malicious") {
          return fail(`Warning: ${trust.value.host} is flagged MALICIOUS in the Dialect blink registry. Do not interact with this blink.`);
        }
        if (trust.status === "rejected") throw trust.reason;
        if (meta.status === "rejected") throw meta.reason;
        const v = view(actionUrl, trust.value.host, trust.value.state, meta.value, stats.status === "fulfilled" ? stats.value : []);
        return { content: [{ type: "text", text: viewText(v) }], structuredContent: { blink: v } };
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "prepare_blink_transaction",
    {
      title: "Prepare blink transaction",
      description:
        "Run one action of a Solana blink for the user's wallet and hand the resulting unsigned transaction to PayBox. " +
        "Blinkbox checks the provider against the Dialect registry, validates inputs, fetches the transaction, verifies it is unsigned with the user's wallet as the only signer and fee payer, " +
        "and decodes the programs and transfers it touches. Blinkbox Guard refuses transactions that grant token approvals, change token or stake authorities, reassign the wallet, or close accounts to someone else (the ways drainers steal). PayBox then simulates it and asks the user to approve. Nothing is signed or sent by this tool.",
      inputSchema: z.object({
        url: z.string().min(8).max(2048).describe("The blink link, or an action href returned by inspect_blink or continue_blink."),
        sender: solanaAddress.describe("Public address of the user's PayBox Solana wallet that will sign and pay fees."),
        action_index: z.number().int().min(0).max(31).optional().describe("Which action (button) to run, from inspect_blink. Omit when url is already an action href or the blink has a single action."),
        inputs: z.record(z.string().max(64), inputValue).optional().describe("Values for the action's inputs, keyed by input name, e.g. {\"amount\": \"0.5\"}."),
        allow_unverified: z.boolean().optional().describe("Set true only when the user explicitly accepts a blink that is not in the Dialect registry."),
      }).strict(),
      outputSchema: prepareOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, sender, action_index, inputs = {}, allow_unverified }) => {
      beginCall();
      const invalid = badAddress({ sender });
      if (invalid) return invalid;
      try {
        const blinkUrl = normalizeBlinkUrl(url);
        // Check the registry while the blink loads; recheck only if the action lives elsewhere.
        const blinkTrust = trustFor(blinkUrl);
        blinkTrust.catch(() => {});
        let meta: ActionMetadata | null = null;
        try {
          meta = await fetchAction(blinkUrl);
        } catch (error) {
          // An action href (e.g. from a chained step) may only accept POST.
          if (action_index !== undefined) throw error;
        }

        let target = blinkUrl;
        let label = meta?.label ?? "action";
        if (meta) {
          if (meta.disabled) return fail(`This blink is disabled by its provider${meta.error?.message ? `: ${meta.error.message}` : "."}`);
          const actions = linkedActions(meta, blinkUrl);
          // Dialect adds a `_bin` tracking parameter to hrefs; ignore it when matching.
          const bare = (u: string) => {
            const parsed = new URL(u);
            parsed.searchParams.delete("_bin");
            return parsed.toString();
          };
          const same = (a: string) => bare(a) === bare(blinkUrl);
          const chosen = action_index !== undefined ? actions[action_index]
            : actions.length === 1 ? actions[0]
            : actions.find((a) => same(a.resolved));
          if (!chosen) {
            return fail(`Choose an action_index: ${actions.map((a, i) => `${i} = "${a.label}"`).join(", ")}. Use inspect_blink to see each action's inputs.`);
          }
          if (chosen.type !== "transaction") return fail(`Action "${chosen.label}" is a ${chosen.type} action, which does not produce a transaction PayBox can run.`);
          const problems = checkInputs(chosen.parameters ?? [], inputs, templateNames(chosen.resolved));
          if (problems.length) return fail(`Inputs need fixing for "${chosen.label}":\n- ${problems.join("\n- ")}`);
          target = fillTemplate(chosen.resolved, inputs);
          label = chosen.label;
        } else {
          target = fillTemplate(blinkUrl, inputs);
        }

        const trust = new URL(target).hostname === new URL(blinkUrl).hostname ? await blinkTrust : await trustFor(target);
        if (trust.state === "malicious") return fail(`Refused: ${trust.host} is flagged malicious in the Dialect blink registry.`);
        if (trust.state === "unverified" && !allow_unverified) {
          return fail(`${trust.host} is not in the Dialect blink registry. Ask the user whether they trust it; if they do, call again with allow_unverified: true.`);
        }

        const response = await postAction(target, sender, inputs);
        if (!response.transaction) {
          const next = response.links?.next;
          return fail([
            `The blink returned no transaction${response.type ? ` (type: ${response.type})` : ""}.`,
            response.message ? `Provider message: ${response.message}` : "",
            response.externalLink ? `It points to: ${response.externalLink}` : "",
            next?.type === "post" ? `It continues at ${resolveHref(next.href, target)} — call continue_blink with that href.` : "",
          ].filter(Boolean).join("\n"));
        }

        const raw = Buffer.from(response.transaction, "base64");
        const tx = parseTransaction(raw);
        const incompatible = payboxIncompatibility(tx, sender);
        if (incompatible) return fail(`This blink's transaction cannot run through PayBox. ${incompatible}`);
        const findings = guardInstructions(tx);
        const refused = guardRefusal(findings);
        if (refused) return fail(refused);
        const warnings = findings.filter((f) => f.level === "warn").map((f) => f.message);
        const summary = summarize(tx);

        const next = response.links?.next;
        const nextInfo = next?.type === "post"
          ? { type: "post", href: resolveHref(next.href, target), how: "After PayBox reports success, call continue_blink with this href, the sender, and the confirmed transaction signature." }
          : next?.type === "inline"
            ? { type: "inline", title: next.action.title, actions: linkedActions(next.action, target).map((a) => ({ label: a.label, href: a.resolved })), how: "After PayBox reports success, run the next step with prepare_blink_transaction using one of these hrefs as url." }
            : null;

        const proposal = proposeSolana({ transactionBase64: raw.toString("base64") });
        const sol = Number(summary.solOutLamports) / 1e9;
        const readable = [
          `Prepared "${label}" from ${meta?.title ?? trust.host} (${trust.host}). ${TRUST_TEXT[trust.state]}`,
          `Transaction: ${summary.version}, ${summary.bytes} bytes, ${summary.instructionCount} instructions; your wallet ${sender} is the only signer and pays fees.`,
          `Programs: ${summary.programs.map((p) => p.name ?? `unrecognized ${p.id}`).join(", ")}${summary.lookupTables ? ` (+${summary.lookupTables} address lookup table${summary.lookupTables > 1 ? "s" : ""})` : ""}.`,
          sol > 0 ? `Direct SOL transfers out of your wallet: ${sol} SOL.` : "",
          summary.priorityFeeLamports ? `Priority fee: up to ${Number(summary.priorityFeeLamports) / 1e9} SOL.` : "",
          response.message ? `Provider message: ${response.message}` : "",
          warnings.length ? `Blinkbox Guard warnings, tell the user before they approve: ${warnings.join(" ")}` : "Blinkbox Guard: no approvals, authority changes, wallet reassignments or foreign account closes.",
          "This summary was decoded by Blinkbox from the provider's bytes; PayBox simulates the same transaction and shows its own preview before the user approves.",
          nextInfo ? `This blink has a next step: ${JSON.stringify(nextInfo)}` : "",
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text", text: readable }, proposal.content[0]!], structuredContent: proposal.structuredContent };
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "continue_blink",
    {
      title: "Continue blink",
      description:
        "Fetch the next step of a multi-step (chained) blink after PayBox has confirmed the previous transaction. " +
        "Pass the next-step href that prepare_blink_transaction reported, the sender, and the confirmed transaction signature. Read-only.",
      inputSchema: z.object({
        href: z.string().min(8).max(2048).describe("The next-step href from prepare_blink_transaction."),
        sender: solanaAddress,
        signature: z.string().max(128).optional().describe("Base58 signature of the confirmed transaction from the previous step."),
      }).strict(),
      outputSchema: blinkOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ href, sender, signature }) => {
      beginCall();
      const invalid = badAddress({ sender });
      if (invalid) return invalid;
      if (signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) {
        return fail("signature must be the base58 signature of the confirmed transaction from the previous step.");
      }
      try {
        const actionUrl = normalizeBlinkUrl(href);
        const [trust, meta] = await Promise.all([trustFor(actionUrl), postChain(actionUrl, sender, signature)]);
        const v = view(actionUrl, trust.host, trust.state, meta, []);
        return { content: [{ type: "text", text: viewText(v) }], structuredContent: { blink: v } };
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
