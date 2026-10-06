// Quick check: connect to qloo mcp, list the tools and run one Bengaluru query.
import { callQloo, closeQloo, listTools } from "./qloo.mjs";

try {
  const tools = await listTools();
  console.log(`qloo mcp tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
  const caps = await callQloo("capabilities", {}, { cache: false });
  console.log("credential ready:", Boolean(caps.adapter?.ready ?? caps.ready ?? caps.status));
  const tags = await callQloo("find_tags", { query: "udupi restaurant", limit: 5 });
  console.log("find_tags:", tags.status, (tags.results ?? []).map((r) => `${r.name} (${r.id})`).join(" | "));
} finally {
  await closeQloo();
}
