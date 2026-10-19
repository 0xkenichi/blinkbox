// Calls one Blinkbox tool through PayBox and prints what the agent sees.
// Usage: node demo/agent.mjs <tool> '<json input>'
import { blinkboxId, paybox } from "./paybox.mjs";

const [tool, json = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("Usage: node demo/agent.mjs <tool> '<json input>'");
  process.exit(2);
}

const id = await blinkboxId();
console.log(`→ PayBox · Blinkbox · ${tool}\n`);
const result = await paybox.usePlugin({ pluginId: id, toolId: tool, input: JSON.parse(json) });
for (const block of result.content ?? []) if (block.type === "text") console.log(block.text);
if (result.isError) process.exitCode = 1;
