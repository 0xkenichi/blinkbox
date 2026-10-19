// One PayBox operation for one user, run in its own process so each Telegram
// user's PayBox login (PAYBOX_CONFIG_DIR) stays isolated. Prints one JSON line.
// Usage: PAYBOX_CONFIG_DIR=<dir> node worker.mjs wallet
//        PAYBOX_CONFIG_DIR=<dir> node worker.mjs sign '{"credentialId":"…","address":"…","transactionBase64":"…"}'
//        PAYBOX_CONFIG_DIR=<dir> node worker.mjs signEvm '{"credentialId":"…","transaction":{to,data,value,chainId,gas,maxFeePerGas,maxPriorityFeePerGas,nonce}}'
import { PayboxClient } from "@paybox-sh/sdk";

const [op, json = "{}"] = process.argv.slice(2);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  const paybox = PayboxClient.fromConfig();
  if (op === "wallet") {
    const { credentials } = await paybox.listCredentials();
    const all = credentials.map((c) => c.credential ?? c).filter((c) => c.credential_type === "wallet" && c.metadata?.address);
    const pick = (chain) => all.filter((w) => (w.metadata?.chains ?? []).includes(chain)).map((w) => ({ credentialId: w.id, name: w.name, address: w.metadata.address }));
    out({ ok: true, wallets: pick("solana"), evm: pick("evm") });
  } else if (op === "sign") {
    const { credentialId, address, transactionBase64 } = JSON.parse(json);
    const response = await paybox.requestWalletSign(
      { credentialId, intent: { op: "solanaTransaction", address, transactionBase64 } },
      { waitForApproval: { timeoutMs: 150_000 } },
    );
    out({ ok: true, response });
  } else if (op === "signEvm") {
    const { credentialId, transaction } = JSON.parse(json);
    const response = await paybox.requestWalletSign(
      { credentialId, intent: { op: "transaction", transaction } },
      { waitForApproval: { timeoutMs: 150_000 } },
    );
    out({ ok: true, response });
  } else {
    out({ ok: false, error: `unknown op ${op}` });
  }
} catch (error) {
  out({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
