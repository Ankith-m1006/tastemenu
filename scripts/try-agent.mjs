import { runAgent } from "../src/agent.mjs";
import { closeQloo } from "../src/qloo.mjs";
import { writeFile } from "node:fs/promises";
process.loadEnvFile(".env");
try {
  const t0 = Date.now();
  const out = await runAgent([{ role: "user", content: "I run a small pure-veg Udupi-style restaurant in Jayanagar, Bengaluru. Mostly office crowd at lunch and families on weekends. Help me plan this month." }], {
    onEvent: (e) => { if (e.type === "tool") console.log("  tool:", e.name, JSON.stringify(e.args).slice(0, 120)); if (e.type === "plan") console.log("  PLAN published"); },
  });
  console.log("model:", out.model, "| seconds:", Math.round((Date.now() - t0) / 1000));
  console.log("reply:", (out.reply || "").slice(0, 600));
  if (out.plan) { await writeFile(".cache/sample-plan.json", JSON.stringify(out.plan, null, 1)); console.log("headline:", out.plan.headline); for (const c of out.plan.cards) console.log(`- [${c.kind}] ${c.title}: ${c.action}\n    why: ${c.why}\n    evidence: ${(c.evidence||[]).map(e=>`${e.name} (${e.type} ${e.affinity ?? ""})`).join("; ")}${c.caveat ? "\n    caveat: " + c.caveat : ""}`); }
} finally { await closeQloo(); }
