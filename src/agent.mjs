// TasteMenu agent: Gemini plans, calls Qloo (through our evidence engine and the raw
// Qloo MCP tools), and publishes a Taste Plan where every action cites Qloo evidence.
import { gatherEvidence } from "./evidence.mjs";
import { callQloo, listTools } from "./qloo.mjs";
import { analyzeSales, compareCompetitor, rankIdeas, sampleSales } from "./sales.mjs";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS = [
  { url: GEMINI_URL, key: () => process.env.GEMINI_API_KEY, model: process.env.TASTEMENU_MODEL || "gemini-3.8-flash" },
  { url: GEMINI_URL, key: () => process.env.GEMINI_API_KEY, model: "gemini-3-flash-preview" },
  { url: OPENROUTER_URL, key: () => process.env.OPENROUTER_API_KEY, model: process.env.TASTEMENU_FALLBACK_MODEL || "openrouter/free" },
];
const MAX_STEPS = 12;

export const SYSTEM_PROMPT = `You are TasteMenu, a taste strategist for independent restaurants, built first for India but working in any city.
The owner tells you about their restaurant. You find out what the people who love restaurants like theirs also love (music, films, shows, brands, nearby places) using Qloo's cultural-intelligence data, and turn that into a short, practical Taste Plan.

How you work:
1. If you do not know the restaurant's city and cuisine/style, ask one short question. Neighbourhood is optional.
2. Call gather_taste_evidence(area, cuisine) once you know them. If it returns needs_input, show the candidates and ask the owner to pick. Never guess silently.
3. Call publish_taste_plan with exactly four cards: menu (a dish, combo or special), music (what to play), event (a themed night or promotion), partners (local places or brands for a cross-promotion).
4. Straight after that, call publish_action_kit: for each of the four cards, the ready-to-use material the owner needs to actually do it this week.
5. Later questions:
   - "Check my menu / my sales": call analyze_sales, then explain in a few bullets which dishes to double down on, reposition or rethink, and which new dish idea fits the crowd best. Say clearly when it ran on the built-in sample month.
   - "What if I add X?" or "X or Y?": call rank_ideas with the owner's ideas (add one or two sensible alternatives if only one was given), then recommend one and say why.
   - "How am I different from <restaurant>?": call compare_competitor, then give two or three differences taken only from its tag lists, and one positioning idea that follows from them.
   - Use the raw qloo_* tools only when they add something specific (for example qloo_describe for one entity).

Rules:
- Every card must be grounded in Qloo results you actually received. Cite them in evidence[] with the exact name, type and affinity number. Never invent entities or numbers.
- Qloo results describe aggregate taste affinities of an audience, not facts about individual customers. Phrase them that way ("people who love places like yours over-index on ...").
- Make the actions concrete, cheap and doable this month by a small restaurant in that city. Mention prices in rupees only if the owner gave them.
- If a Qloo signal looks off for the context (for example an unexpected music genre), say so honestly in the card's caveat instead of hiding it.
- Action kit language: write every piece in simple English, and the WhatsApp message also in the main local language of the city, in its own script (India: Bengaluru Kannada, Chennai Tamil, Hyderabad Telugu, Mumbai/Pune Marathi, Kolkata Bengali, Kochi Malayalam, Ahmedabad Gujarati, other Indian cities Hindi. Outside India: the city's main language, or if that is English, its most common second language, e.g. Spanish for US cities). Keep messages short and warm, like a real owner would send. No made-up discounts or prices: use placeholders like [price] instead.
- When a tool returns no data (no Qloo signal, not found, empty comparison), say so plainly. Never fill the gap from general knowledge: do not describe a competitor, a dish or an audience that Qloo did not return.
- Sales tiers and crowd fit are relative within the menu. Never claim Qloo knows this restaurant's own customers.
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

const KIT_TOOL = {
  type: "function",
  function: {
    name: "publish_action_kit",
    description: "Publish the ready-to-use material for each plan card, so the owner can act on it today.",
    parameters: {
      type: "object",
      properties: {
        local_language: { type: "string", description: "The local language used for whatsapp_local, e.g. Kannada." },
        items: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["menu", "music", "event", "partners"] },
              whatsapp: { type: "string", description: "WhatsApp broadcast to regular customers, English, under 60 words." },
              whatsapp_local: { type: "string", description: "The same message in the local language, in its own script." },
              instagram: { type: "string", description: "Instagram caption with 4-6 hashtags." },
              board: { type: "string", description: "Text for the specials board or menu card, under 20 words." },
              staff: { type: "string", description: "Two-line briefing for counter staff and waiters." },
              outreach: { type: "string", description: "Partners card only: a short message to send to the partner business." },
              checklist: { type: "array", items: { type: "string" }, description: "Three to five steps to do this week." },
            },
            required: ["kind", "whatsapp", "whatsapp_local", "instagram", "board", "staff", "checklist"],
          },
        },
      },
      required: ["local_language", "items"],
    },
  },
};

const SALES_TOOL = {
  type: "function",
  function: {
    name: "analyze_sales",
    description: "Sales x Taste: match the restaurant's item sales to Qloo dish tags and score each dish's crowd fit for this audience. Uses the owner's uploaded sales if any, otherwise a built-in sample month. Needs gather_taste_evidence first.",
    parameters: { type: "object", properties: {} },
  },
};

const IDEAS_TOOL = {
  type: "function",
  function: {
    name: "rank_ideas",
    description: "What-if: score 2-6 ideas (dishes, formats or experiences such as 'biryani', 'breakfast', 'live music') for this restaurant's audience in one comparable run. Needs gather_taste_evidence first.",
    parameters: {
      type: "object",
      properties: { options: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } } },
      required: ["options"],
    },
  },
};

const COMPARE_TOOL = {
  type: "function",
  function: {
    name: "compare_competitor",
    description: "Competitor lens: compare a named competitor restaurant in the same city with places like the owner's, by Qloo taste tags (offerings, occasions, flavours, vibe): what only one side has and what both share. Needs gather_taste_evidence first.",
    parameters: {
      type: "object",
      properties: { competitor: { type: "string", description: "The competitor's name as people know it." } },
      required: ["competitor"],
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
  toolCache = [EVIDENCE_TOOL, SALES_TOOL, IDEAS_TOOL, COMPARE_TOOL, ...raw, PLAN_TOOL, KIT_TOOL];
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

// Every number on the owner's board must come from a Qloo response. Evidence items are
// matched by name to what Qloo returned in this session; a matching item gets Qloo's own
// affinity, an unmatched number is dropped, and each item records whether it was verified.
export function verifyPlan(plan, ctx) {
  const known = new Map();
  const add = (x) => { if (x?.name) known.set(x.name.toLowerCase(), typeof x.affinity === "number" ? x.affinity : null); };
  const ev = ctx.evidence;
  if (ev) {
    [ev.peers, ev.partners, ev.audience?.artists, ev.audience?.movies, ev.audience?.tvShows, ev.audience?.brands].forEach((xs) => (xs ?? []).forEach(add));
    (ev.knownFor ?? []).forEach((t) => known.has(t.name?.toLowerCase()) || known.set(t.name?.toLowerCase(), null));
  }
  for (const r of ctx.qlooSeen ?? []) add(r);
  for (const card of plan.cards ?? []) {
    card.evidence = (card.evidence ?? []).map((e) => {
      const key = String(e.name ?? "").toLowerCase();
      if (!known.has(key)) { const { affinity, ...rest } = e; return { ...rest, verified: false }; }
      const real = known.get(key);
      const { affinity, ...rest } = e;
      return real == null ? { ...rest, verified: true } : { ...rest, affinity: Number(real.toFixed(3)), verified: true };
    });
  }
  return plan;
}

const NEEDS_EVIDENCE = { status: "needs_evidence", message: "Run gather_taste_evidence for this restaurant first." };

async function runTool(name, args, onEvent, ctx) {
  onEvent?.({ type: "tool", name, args });
  if (name === "gather_taste_evidence") {
    const ev = await gatherEvidence(args);
    if (ev.status === "ok") ctx.evidence = ev;
    onEvent?.({ type: "evidence", evidence: ev });
    return compactEvidence(ev);
  }
  if (name === "analyze_sales") {
    if (!ctx.evidence) return NEEDS_EVIDENCE;
    const sample = !ctx.sales;
    const result = { ...(await analyzeSales(ctx.sales ?? (await sampleSales()), ctx.evidence)), sample, source: sample ? "built-in sample month" : ctx.salesName ?? "owner's upload" };
    onEvent?.({ type: "sales", sales: result });
    return result;
  }
  if (name === "rank_ideas") {
    if (!ctx.evidence) return NEEDS_EVIDENCE;
    const result = await rankIdeas(args.options ?? [], ctx.evidence);
    onEvent?.({ type: "ideas", ideas: result });
    return result;
  }
  if (name === "compare_competitor") {
    if (!ctx.evidence) return NEEDS_EVIDENCE;
    const result = await compareCompetitor(String(args.competitor ?? ""), ctx.evidence);
    onEvent?.({ type: "compare", compare: result });
    return result;
  }
  if (RAW_TOOLS.includes(name)) {
    const env = await callQloo(name, args);
    const results = Array.isArray(env.results) ? env.results.slice(0, 8).map((r) => ({ name: r.name, id: r.entity_id ?? r.id, affinity: r.affinity, popularity: r.popularity })) : env.results;
    if (Array.isArray(results)) (ctx.qlooSeen ??= []).push(...results);
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
    body: JSON.stringify({
      model: m.model, messages: clean(messages), tools: toolList, tool_choice: "auto", temperature: 0.4,
      // Gemini thinks before every step; "low" keeps tool-calling quality while cutting most of the wait.
      ...(m.url === GEMINI_URL && process.env.TASTEMENU_REASONING !== "default" ? { reasoning_effort: process.env.TASTEMENU_REASONING || "low" } : {}),
    }),
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
export async function runAgent(history, { onEvent, ctx = {} } = {}) {
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
            plan = verifyPlan(args, ctx);
            onEvent?.({ type: "plan", plan });
            result = { status: "published", next: "Now call publish_action_kit." };
          } else if (call.function.name === "publish_action_kit") {
            ctx.kit = args;
            onEvent?.({ type: "kit", kit: args });
            result = { status: "published" };
          } else {
            try { result = await runTool(call.function.name, args, onEvent, ctx); } catch (e) { result = { status: "error", error: String(e.message ?? e) }; }
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

// The "without Qloo" baseline: the same model, same request, no tools and no data. Shown
// next to the Qloo-grounded plan so the difference cultural data makes is visible.
export async function genericPlan(request) {
  const m = MODELS.find((x) => x.key());
  if (!m) return null;
  const r = await fetch(m.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${m.key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: m.model,
      temperature: 0.4,
      ...(m.url === GEMINI_URL ? { reasoning_effort: "low" } : {}),
      messages: [
        { role: "system", content: 'You are a helpful assistant. Reply with JSON only: {"cards":[{"kind":"menu|music|event|partners","title":"...","action":"one sentence"}]} with exactly four cards, one of each kind.' },
        { role: "user", content: `Give me a marketing plan for this month for my restaurant: ${request}` },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) return null;
  const text = (await r.json()).choices?.[0]?.message?.content ?? "";
  try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { return null; }
}
