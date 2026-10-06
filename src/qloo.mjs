// Qloo bridge: starts the official `qloo mcp` server (stdio) once and calls its tools.
// The Qloo key never leaves the server: it comes from the harness config or QLOO_API_KEY.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = path.resolve(".cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let clientPromise = null;
let queue = Promise.resolve();
const MIN_GAP_MS = 400;

// Serialises Qloo calls with a small gap between them.
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS)));
  return run;
}

async function connect() {
  const transport = new StdioClientTransport({ command: "qloo", args: ["mcp"], env: process.env });
  const client = new Client({ name: "tastemenu", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    clientPromise = null;
    throw error.code === "ENOENT"
      ? new Error("Cannot start `qloo`. Install it with: npm install --global @qloo/qloo-harness")
      : error;
  }
  return client;
}

export function qlooClient() {
  clientPromise ??= connect();
  return clientPromise;
}

export async function listTools() {
  const client = await qlooClient();
  const { tools } = await client.listTools();
  return tools;
}

function cacheKey(tool, args) {
  return createHash("sha256").update(JSON.stringify([tool, args])).digest("hex").slice(0, 32);
}

async function readCache(key) {
  try {
    const raw = JSON.parse(await readFile(path.join(CACHE_DIR, `${key}.json`), "utf8"));
    if (Date.now() - raw.at < CACHE_TTL_MS) return raw.envelope;
  } catch {}
  return null;
}

async function writeCache(key, envelope) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), envelope }));
}

// Calls one Qloo tool and returns the normalised envelope:
// { status: ok | empty | needs_input | partial | degraded | error, summary, results, error, ... }
// Only ok/partial/degraded results are cached, so retries after an error hit Qloo again.
export async function callQloo(tool, args, { cache = true } = {}) {
  const name = tool.startsWith("qloo_") ? tool : `qloo_${tool}`;
  const key = cacheKey(name, args);
  if (cache) {
    const hit = await readCache(key);
    if (hit) return { ...hit, cached: true };
  }
  const client = await qlooClient();
  let envelope;
  // Qloo answers 429 when calls come too fast. Calls run one at a time (queue) and a
  // rate-limited or retryable error is retried with backoff, as the Qloo kit asks.
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await enqueue(() => client.callTool({ name, arguments: args }));
    const raw = result.structuredContent ?? {};
    envelope = raw.status === undefined
      ? { ...raw, status: "error", error: { code: "UNKNOWN", ...raw.error } }
      : raw;
    const rateLimited = /429|too many requests/i.test(`${envelope.summary ?? ""} ${envelope.error?.code ?? ""}`);
    if (envelope.status !== "error" || !(rateLimited || envelope.error?.retryable)) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  if (cache && ["ok", "partial", "degraded"].includes(envelope.status)) await writeCache(key, envelope);
  return envelope;
}

export async function closeQloo() {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  await client?.close();
}
