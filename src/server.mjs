// TasteMenu web server: serves the app and streams the agent's progress (Server-Sent Events).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runAgent } from "./agent.mjs";

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
  const s = { history: [], plan: null, busy: false, updated: now };
  sessions.set(nid, s);
  return { id: nid, s };
}

async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 20000) throw new Error("Request too large");
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
      onEvent: (e) => {
        const line = progressLine(e);
        if (line) send("progress", { text: line, tool: e.name });
        if (e.type === "evidence" && e.evidence?.trace) send("trace", { trace: e.evidence.trace, city: e.evidence.city, neighbourhood: e.evidence.neighbourhood, cuisine: e.evidence.cuisine?.tag ?? null });
        if (e.type === "plan") send("plan", e.plan);
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
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true });
    if (req.method === "GET") return await serveStatic(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error("[server]", e);
    if (!res.headersSent) json(res, 500, { error: "Server error" });
  }
}).listen(PORT, () => console.log(`TasteMenu running on http://localhost:${PORT}`));
