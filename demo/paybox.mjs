// Shared setup for the demo helpers. Point PAYBOX_CLI_DIR at a folder with
// @paybox-sh/sdk installed and a logged-in PayBox CLI config, and set
// BLINKBOX_WALLET to your PayBox Solana address.
import { pathToFileURL } from "node:url";

const CLI_DIR = process.env.PAYBOX_CLI_DIR;
if (!CLI_DIR) throw new Error("Set PAYBOX_CLI_DIR to your PayBox CLI folder.");
process.env.PAYBOX_CONFIG_DIR ??= `${CLI_DIR}/config`;

const { PayboxClient } = await import(pathToFileURL(`${CLI_DIR}/node_modules/@paybox-sh/sdk/dist/index.js`).href);

export const paybox = PayboxClient.fromConfig();
export const WALLET = process.env.BLINKBOX_WALLET;
if (!WALLET) throw new Error("Set BLINKBOX_WALLET to your PayBox Solana address.");

/** Finds the installed Blinkbox plugin through PayBox discovery, as an agent would. */
export async function blinkboxId() {
  const page = await paybox.discoverPlugins({ query: "Blinkbox", status: "enabled" });
  const plugin = page.plugins.find((p) => p.name === "Blinkbox");
  if (!plugin) throw new Error("Blinkbox is not enabled in this PayBox account.");
  return plugin.id;
}
