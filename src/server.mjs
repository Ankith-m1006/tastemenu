// TasteMenu web server: serves the app and streams the agent's progress (Server-Sent Events).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { compactEvidence, runAgent } from "./agent.mjs";
import { analyzeSales, parseSales, sampleSales } from "./sales.mjs";
import { gatherEvidence } from "./evidence.mjs";

try { process.loadEnvFile(".env"); } catch {}

const PORT = Number(process.env.PORT || 4200);
const PUBLIC = path.resolve("public");
const sessions = new Map(); // id -> { history, plan, busy, updated }
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MESSAGE = 1200;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function session(id) {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.updated > SESSION_TTL_MS) sessions.delete(k);
  if (id && sessions.has(id)) return { id, s: sessions.get(id) };
  const nid = randomUUID();
  const s = { history: [], plan: null, busy: false, updated: now, ctx: {} };
  sessions.set(nid, s);
  return { id: nid, s };
}

async function body(req, max = 20000) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > max) throw new Error("Request too large");
  }
  return JSON.parse(data || "{}");
}

// Turns raw agent events into short, owner-friendly progress lines.
function progressLine(e) {
  if (e.type !== "tool") return null;
  const a = e.args ?? {};
  switch (e.name) {
    case "gather_taste_evidence": return `Reading the taste of people who love ${a.cuisine} places in ${a.area}…`;
    case "qloo_recommend": return `Asking Qloo for ${a.target_type ?? "more"} recommendations…`;
    case "qloo_rank": return "Comparing your options for this audience…";
    case "qloo_describe": return `Looking up ${a.entity ?? "an entity"}…`;
    case "qloo_find_tags": return `Matching "${a.query ?? ""}" to Qloo tags…`;
    case "analyze_sales": return "Matching every dish on your menu to what your crowd loves…";
    case "rank_ideas": return `Scoring ${(a.options ?? []).length} ideas for your crowd…`;
    case "compare_competitor": return `Comparing your crowd with the crowd at ${a.competitor ?? "that restaurant"}…`;
    case "publish_action_kit": return "Writing your messages and posts…";
    default: return `Running ${e.name}…`;
  }
}

async function chat(req, res) {
  const input = await body(req);
  const message = String(input.message ?? "").trim().slice(0, MAX_MESSAGE);
  if (!message) return json(res, 400, { error: "Message is empty." });
  const { id, s } = session(input.sessionId);
  if (s.busy) return json(res, 409, { error: "Still working on your last message." });
  s.busy = true;
  s.updated = Date.now();

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("session", { sessionId: id });
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);

  try {
    s.history.push({ role: "user", content: message });
    const out = await runAgent(s.history, {
      ctx: s.ctx,
      onEvent: (e) => {
        const line = progressLine(e);
        if (line) send("progress", { text: line, tool: e.name });
        if (e.type === "evidence" && e.evidence?.trace) {
          send("trace", { trace: e.evidence.trace, city: e.evidence.city, neighbourhood: e.evidence.neighbourhood, cuisine: e.evidence.cuisine?.tag ?? null });
          if (e.evidence.status === "ok") send("evidence", compactEvidence(e.evidence));
        }
        if (e.type === "plan") send("plan", e.plan);
        if (e.type === "kit") send("kit", e.kit);
        if (e.type === "sales") send("sales", e.sales);
        if (e.type === "ideas") send("ideas", e.ideas);
        if (e.type === "compare") send("compare", e.compare);
        if (e.type === "retry") send("progress", { text: "The AI was busy, switching to a backup model…" });
      },
    });
    s.history = out.messages.filter((m) => m.role !== "system");
    if (out.plan) s.plan = out.plan;
    send("reply", { text: out.reply, model: out.model });
  } catch (e) {
    send("error", { message: "Something went wrong talking to the AI or Qloo. Please try again in a moment." });
    console.error("[chat]", e);
  } finally {
    clearInterval(ping);
    s.busy = false;
    res.end();
  }
}

// Sales upload: parsed and kept in the session's memory only (never written to disk).
async function uploadSales(req, res) {
  const input = await body(req, 600000);
  const { id, s } = session(input.sessionId);
  try {
    const items = parseSales(String(input.csv ?? ""));
    s.ctx.sales = items;
    s.ctx.salesName = String(input.name ?? "your sales file").slice(0, 80);
    const top = [...items].sort((a, b) => (b.amount || b.qty) - (a.amount || a.qty)).slice(0, 3).map((x) => x.name);
    json(res, 200, { sessionId: id, items: items.length, top });
  } catch (e) {
    json(res, 400, { sessionId: id, error: e.message });
  }
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") return await chat(req, res);
    if (req.method === "POST" && req.url === "/api/sales") return await uploadSales(req, res);
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && req.url === "/api/warm") return json(res, 200, { warmed: await prewarm() });
    if (req.method === "GET") return await serveStatic(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error("[server]", e);
    if (!res.headersSent) json(res, 500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(`TasteMenu running on http://localhost:${PORT}`);
  if (process.env.PREWARM !== "0") prewarm();
});

// Fills the Qloo cache for the sample restaurants on the start page (and the sample sales
// check), so the first person to try them doesn't wait for a cold run. Repeats every 12 h,
// inside the 24 h cache lifetime.
const SAMPLES = [
  { area: "Jayanagar, Bengaluru", cuisine: "Udupi", sales: true },
  { area: "Indiranagar, Bengaluru", cuisine: "cafe" },
  { area: "Koramangala, Bengaluru", cuisine: "biryani" },
];
let warming = null;
function prewarm() {
  warming ??= warmAll().finally(() => { warming = null; });
  return warming;
}
async function warmAll() {
  const report = [];
  for (const x of SAMPLES) {
    const t0 = Date.now();
    try {
      const ev = await gatherEvidence(x);
      if (x.sales && ev.status === "ok") await analyzeSales(await sampleSales(), ev);
      report.push({ ...x, status: ev.status, ms: Date.now() - t0 });
    } catch (e) {
      report.push({ ...x, status: "error", error: e.message });
    }
  }
  console.log("[prewarm]", JSON.stringify(report));
  return report;
}
