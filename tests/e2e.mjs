// Live end-to-end checks against the built bundle (dist/plugin.mjs).
// Each call runs in a fresh plugin process, the way PayBox runs hosted calls.
// Usage: node tests/e2e.mjs [sender-address]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const PROTOCOL = "2026-07-28";
// Default: a large public wallet, so providers can build realistic transactions.
// Nothing is signed or sent; the transactions are only decoded.
const SENDER = process.argv[2] ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const RECIPIENT = "5EUaVYpVwZ3tNjnbBNx4XG2H7b4oGQsE7GWQ5j6zSViS";
const BUNDLE = fileURLToPath(new URL("../dist/plugin.mjs", import.meta.url));

function call(method, params) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BUNDLE], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${method} exceeded 10s`)); }, 10_000);
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      child.kill();
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve({ ...msg.result, ms: Date.now() - started });
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "blinkbox-e2e", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    }) + "\n");
  });
}

const { tools } = await call("tools/list", {});
const ajv = new Ajv2020({ strict: false });
const validators = Object.fromEntries(tools.map((t) => [t.name, t.outputSchema ? ajv.compile(t.outputSchema) : null]));
const schemaBytes = tools.map((t) => `${t.name}=${JSON.stringify(t.inputSchema).length + JSON.stringify(t.outputSchema ?? {}).length}B`);
console.log(`tools: ${tools.map((t) => t.name).join(", ")}  (schema sizes: ${schemaBytes.join(" ")})\n`);

function decode(b64) {
  const b = Buffer.from(b64, "base64");
  const sigs = b[0];
  const empty = b.subarray(1, 1 + 64 * sigs).every((x) => x === 0);
  const m = 1 + 64 * sigs;
  const v0 = (b[m] & 0x80) !== 0;
  return { bytes: b.length, sigs, empty, version: v0 ? "v0" : "legacy", required: v0 ? b[m + 1] : b[m] };
}

let failures = 0;
async function check(name, tool, args, expect) {
  // Pace calls like a real agent; bursts trip upstream rate limits (e.g. Jupiter token metadata).
  await new Promise((r) => setTimeout(r, 1_500));
  try {
    const r = await call("tools/call", { name: tool, arguments: args });
    const text = r.content?.map((c) => c.text).join("\n") ?? "";
    let schemaOk = true;
    // PayBox rejects any result (errors included) that lacks schema-valid structured output.
    if (validators[tool]) schemaOk = r.structuredContent !== undefined && validators[tool](r.structuredContent);
    const proposal = r.structuredContent?.["io.paybox/transactionProposal"];
    const decoded = proposal ? decode(proposal.transaction.transactionBase64) : null;
    const ok = schemaOk && expect({ r, text, proposal, decoded });
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (${r.ms}ms)${r.isError ? " [isError]" : ""}${schemaOk ? "" : " SCHEMA: " + (r.structuredContent === undefined ? "structuredContent missing" : ajv.errorsText(validators[tool].errors))}`);
    if (decoded) console.log(`     proposal: ${JSON.stringify(decoded)} expires ${proposal.expiresAt}`);
    console.log("     " + text.slice(0, 900).replaceAll("\n", "\n     ") + "\n");
    return r;
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.message}\n`);
  }
}

const okProposal = ({ r, proposal, decoded }) => !r.isError && proposal?.kind === "solana" && decoded.sigs === 1 && decoded.required === 1 && decoded.empty && decoded.bytes <= 1232;

await check("find yield USDC", "find_blinks", { category: "yield", query: "usdc", limit: 5 }, ({ r }) => !r.isError && r.structuredContent.results.length > 0);
await check("find lending kamino", "find_blinks", { category: "lending", query: "kamino sol", limit: 3 }, ({ r }) => !r.isError && r.structuredContent.results.length > 0);
await check("find predictions senate", "find_blinks", { category: "prediction", query: "senate", limit: 4 }, ({ r }) => !r.isError && r.structuredContent.results.every((x) => x.odds));
await check("find all stake", "find_blinks", { category: "stake" }, ({ r }) => !r.isError && r.structuredContent.results.some((x) => x.id === "jito.stake"));
await check("inspect jito with account", "inspect_blink", { url: "https://jito.dial.to/stake", account: SENDER }, ({ r }) => !r.isError && r.structuredContent.blink.stats.length > 0);
await check("inspect solana-action link", "inspect_blink", { url: "solana-action:https://solana-sbl.dial.to/api/v0/transfer/USDC" }, ({ r }) => !r.isError && r.structuredContent.blink.actions[0].inputs.length === 2);
await check("inspect jup.ag link", "inspect_blink", { url: "https://jup.ag/swap/SOL-JUP" }, ({ r }) => !r.isError);
await check("prepare swap 0.1 SOL->USDC", "prepare_blink_transaction", { url: "https://jupiter.dial.to/api/v0/swap/SOL-USDC", action_index: 0, sender: SENDER }, okProposal);
await check("prepare swap custom amount", "prepare_blink_transaction", { url: "https://dial.to/?action=solana-action:https://jupiter.dial.to/api/v0/swap/SOL-DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", action_index: 3, inputs: { amount: "0.02" }, sender: SENDER }, okProposal);
await check("prepare JitoSOL stake via Jupiter", "prepare_blink_transaction", { url: "https://jupiter.dial.to/api/v0/swap/SOL-J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", action_index: 0, sender: SENDER }, okProposal);
await check("prepare SOL transfer", "prepare_blink_transaction", { url: "https://solana-sbl.dial.to/api/v0/transfer/SOL", sender: SENDER, inputs: { to: RECIPIENT, amount: "0.001" } }, okProposal);
await check("prepare Jupiter Earn 5 USDC", "prepare_blink_transaction", { url: "blink:https://jupiter.dial.to/api/v0/lend/earn/USDC/deposit", action_index: 3, inputs: { amount: "5" }, sender: SENDER }, okProposal);
await check("prepare Lulo 5 USDC", "prepare_blink_transaction", { url: "https://lulo.dial.to/api/v0/deposit/USDC/protected", action_index: 3, inputs: { amount: "5" }, sender: SENDER }, okProposal);
const KAMINO = "blink:https://kamino.dial.to/api/v0/lending/reserve/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59/deposit";
await check("inspect Kamino market blink", "inspect_blink", { url: KAMINO, account: SENDER }, ({ r }) => !r.isError);
await check("prepare Kamino 5 USDC (chained)", "prepare_blink_transaction", { url: KAMINO, action_index: 3, inputs: { amount: "5" }, sender: SENDER }, (x) => okProposal(x) && /next step/.test(x.text));
await check("malicious host refused", "prepare_blink_transaction", { url: "https://actions.radius.art/api/action", sender: SENDER }, ({ r, text }) => r.isError && /malicious/.test(text));
await check("malicious host flagged on inspect", "inspect_blink", { url: "https://dial.to/?action=solana-action:https://actions.radius.art/api/action" }, ({ r, text }) => r.isError && /MALICIOUS/.test(text));
await check("provider outage is explained", "prepare_blink_transaction", { url: "https://jito.dial.to/stake", action_index: 3, inputs: { amount: "0.1" }, sender: SENDER }, ({ r, text }) => r.isError && /provider is failing|refused/.test(text));
await check("missing input is reported", "prepare_blink_transaction", { url: "https://solana-sbl.dial.to/api/v0/transfer/SOL", sender: SENDER, inputs: { amount: "0.001" } }, ({ r, text }) => r.isError && /to/.test(text));
await check("ambiguous action is reported", "prepare_blink_transaction", { url: "https://jupiter.dial.to/api/v0/swap/SOL-USDC", sender: SENDER }, ({ r, text }) => r.isError && /action_index/.test(text));
await check("bad sender rejected", "prepare_blink_transaction", { url: "https://jito.dial.to/stake", action_index: 0, sender: "not-a-key" }, ({ r }) => r.isError);

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
