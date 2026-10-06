// TasteMenu agent: Gemini plans, calls Qloo (through our evidence engine and the raw
// Qloo MCP tools), and publishes a Taste Plan where every action cites Qloo evidence.
import { gatherEvidence } from "./evidence.mjs";
import { callQloo, listTools } from "./qloo.mjs";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS = [
  { url: GEMINI_URL, key: () => process.env.GEMINI_API_KEY, model: process.env.TASTEMENU_MODEL || "gemini-3.8-flash" },
  { url: GEMINI_URL, key: () => process.env.GEMINI_API_KEY, model: "gemini-3-flash-preview" },
  { url: OPENROUTER_URL, key: () => process.env.OPENROUTER_API_KEY, model: process.env.TASTEMENU_FALLBACK_MODEL || "openrouter/free" },
];
const MAX_STEPS = 10;

export const SYSTEM_PROMPT = `You are TasteMenu, a taste strategist for independent restaurants in India.
The owner tells you about their restaurant. You find out what the people who love restaurants like theirs also love (music, films, shows, brands, nearby places) using Qloo's cultural-intelligence data, and turn that into a short, practical Taste Plan.

How you work:
1. If you do not know the restaurant's city and cuisine/style, ask one short question. Neighbourhood is optional.
2. Call gather_taste_evidence(area, cuisine) once you know them. If it returns needs_input, show the candidates and ask the owner to pick. Never guess silently.
3. Use the extra qloo_* tools only when they add something specific (for example a what-if comparison with qloo_rank, or qloo_describe for one entity).
4. Then call publish_taste_plan with exactly four cards: menu (a dish, combo or special), music (what to play), event (a themed night or promotion), partners (local places or brands for a cross-promotion).

Rules:
- Every card must be grounded in Qloo results you actually received. Cite them in evidence[] with the exact name, type and affinity number. Never invent entities or numbers.
- Qloo results describe aggregate taste affinities of an audience, not facts about individual customers. Phrase them that way ("people who love places like yours over-index on ...").
- Make the actions concrete, cheap and doable this month by a small restaurant in that city. Mention prices in rupees only if the owner gave them.
- If a Qloo signal looks off for the context (for example an unexpected music genre), say so honestly in the card's caveat instead of hiding it.
- Chat replies are plain text for a phone screen: no headings, no tables, no markdown symbols except **bold** and "- " bullets.
- After publish_taste_plan, reply with one or two short sentences only (for example what to try first). Never repeat the plan in the chat: the board already shows it.
- For follow-up or what-if questions, answer in at most five short sentences or bullets, grounded in Qloo results, and say clearly if Qloo has no signal for it.`;

const PLAN_TOOL = {
  type: "function",
  function: {
    name: "publish_taste_plan",
    description: "Publish the Taste Plan to the owner's board. Call once evidence is gathered.",
    parameters: {
      type: "object",
      properties: {
        headline: { type: "string", description: "One sentence summary of who the audience is." },
        cards: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["menu", "music", "event", "partners"] },
              title: { type: "string" },
              action: { type: "string", description: "What to do, concretely." },
              why: { type: "string", description: "Why this audience will like it, in plain words." },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    affinity: { type: "number" },
                  },
                  required: ["name", "type"],
                },
              },
              caveat: { type: "string" },
            },
            required: ["kind", "title", "action", "why", "evidence"],
          },
        },
      },
      required: ["headline", "cards"],
    },
  },
};

const EVIDENCE_TOOL = {
  type: "function",
  function: {
    name: "gather_taste_evidence",
    description: "Run the Qloo taste analysis for a kind of restaurant in a city: similar places, and the films, shows, music, brands and partner places their audience over-indexes on, plus aggregate demographics.",
    parameters: {
      type: "object",
      properties: {
        area: { type: "string", description: "City, optionally with neighbourhood first, e.g. 'Jayanagar, Bengaluru'." },
        cuisine: { type: "string", description: "Cuisine or style, e.g. 'Udupi', 'South Indian', 'cafe', 'biryani'." },
      },
      required: ["area", "cuisine"],
    },
  },
};

// The raw Qloo MCP tools the agent may also use (what-if questions, details).
const RAW_TOOLS = ["qloo_rank", "qloo_recommend", "qloo_describe", "qloo_find_tags"];

let toolCache = null;
async function tools() {
  if (toolCache) return toolCache;
  const mcp = await listTools();
  const raw = mcp
    .filter((t) => RAW_TOOLS.includes(t.name))
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description?.slice(0, 900), parameters: t.inputSchema } }));
  toolCache = [EVIDENCE_TOOL, ...raw, PLAN_TOOL];
  return toolCache;
}

// Keeps tool results small enough for the model while preserving the numbers it must cite.
export function compactEvidence(ev) {
  if (ev.status !== "ok") return ev;
  const top = (xs, n = 6) => (xs ?? []).slice(0, n).map((x) => ({ name: x.name, affinity: x.affinity }));
  const demo = ev.audience.demographics?.[0]?.query ?? null;
  return {
    status: "ok",
    area: ev.area,
    city: ev.city,
    neighbourhood: ev.neighbourhood,
    cuisine_tag: ev.cuisine.tag,
    similar_places: top(ev.peers, 8),
    known_for: (ev.knownFor ?? []).slice(0, 15).map((t) => t.name),
    audience: {
      films: top(ev.audience.movies),
      shows: top(ev.audience.tvShows),
      music_artists: top(ev.audience.artists),
      brands: top(ev.audience.brands),
      demographics_over_index: demo,
    },
    partner_places: top(ev.partners),
    note: "Affinity is 0-1 (higher = this audience over-indexes more). Demographics are relative over/under-index, not shares.",
  };
}

async function runTool(name, args, onEvent) {
  onEvent?.({ type: "tool", name, args });
  if (name === "gather_taste_evidence") {
    const ev = await gatherEvidence(args);
    onEvent?.({ type: "evidence", evidence: ev });
    return compactEvidence(ev);
  }
  if (RAW_TOOLS.includes(name)) {
    const env = await callQloo(name, args);
    const results = Array.isArray(env.results) ? env.results.slice(0, 8).map((r) => ({ name: r.name, id: r.entity_id ?? r.id, affinity: r.affinity, popularity: r.popularity })) : env.results;
    return { status: env.status, summary: env.summary, results };
  }
  return { error: `Unknown tool ${name}` };
}

// Providers differ on message details: Gemini rejects null content, and fields such as
// reasoning traces must not leak between providers. Gemini's thought signatures
// (extra_content) are kept so multi-step tool calls stay valid.
function clean(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? "" };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.extra_content) out.extra_content = m.extra_content;
    return out;
  });
}

async function callModel(m, messages, toolList) {
  const r = await fetch(m.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${m.key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: m.model, messages: clean(messages), tools: toolList, tool_choice: "auto", temperature: 0.4 }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`${m.model} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    err.retryable = r.status === 429 || r.status >= 500;
    throw err;
  }
  return j.choices[0].message;
}

// Tries the pinned model first (with retries for busy/overloaded errors). A conversation
// stays on one model once it has made tool calls, because Gemini's thought signatures
// cannot be produced by a different provider.
async function chat(messages, toolList, state) {
  const usable = MODELS.map((m, i) => ({ ...m, i })).filter((m) => m.key());
  if (!usable.length) throw new Error("No model key configured (GEMINI_API_KEY or OPENROUTER_API_KEY).");
  const candidates = state.pinned != null ? usable.filter((m) => m.i === state.pinned) : usable.filter((m) => !state.excluded?.has(m.i));
  let lastError;
  for (const m of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const message = await callModel(m, messages, toolList);
        state.pinned ??= m.i;
        return { message, model: m.model };
      } catch (e) {
        lastError = e;
        console.error(`[model] ${m.model} attempt ${attempt + 1} failed: ${String(e.message).slice(0, 200)}`);
        if (!e.retryable) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

// Runs the agent until it replies to the owner. Returns the new messages and any plan published.
// If the model a turn started on keeps failing (for example Gemini "high demand" 503s), the
// whole turn is restarted on the next model. Qloo results are cached, so the restart is quick.
export async function runAgent(history, { onEvent } = {}) {
  const toolList = await tools();
  const start = history[0]?.role === "system" ? [...history] : [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const excluded = new Set();
  let lastError;
  for (let round = 0; round < MODELS.length; round++) {
    const messages = [...start];
    let plan = null;
    const state = { pinned: null, excluded };
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        const { message, model } = await chat(messages, toolList, state);
        messages.push(message);
        const calls = message.tool_calls ?? [];
        if (!calls.length) return { messages, reply: message.content ?? "", plan, model };
        for (const call of calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
          let result;
          if (call.function.name === "publish_taste_plan") {
            plan = args;
            onEvent?.({ type: "plan", plan });
            result = { status: "published" };
          } else {
            try { result = await runTool(call.function.name, args, onEvent); } catch (e) { result = { status: "error", error: String(e.message ?? e) }; }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
        }
      }
      return { messages, reply: "I ran out of steps. Could you rephrase?", plan, model: null };
    } catch (e) {
      lastError = e;
      if (state.pinned == null) throw e;
      excluded.add(state.pinned);
      console.error(`[agent] restarting the turn without ${MODELS[state.pinned].model}`);
      onEvent?.({ type: "retry" });
    }
  }
  throw lastError;
}
