// Evidence engine: turns "a <cuisine> restaurant in <area>" into Qloo-backed taste evidence.
// Every item keeps the Qloo numbers (affinity, popularity) and the call that produced it,
// so the Taste Plan can show where each claim came from.
import { callQloo } from "./qloo.mjs";

const ok = (env) => ["ok", "partial", "degraded"].includes(env.status);
const list = (env) => (Array.isArray(env.results) ? env.results : []);

function item(r) {
  return {
    id: r.entity_id ?? r.id,
    name: r.name,
    affinity: typeof r.affinity === "number" ? Number(r.affinity.toFixed(3)) : null,
    popularity: typeof r.popularity === "number" ? Number(r.popularity.toFixed(3)) : null,
    address: r.properties?.address ?? null,
    tags: (r.tags ?? []).slice(0, 6).map((t) => t.name ?? t).filter(Boolean),
    why: r.explainability ?? null,
  };
}

function step(label, tool, args, env) {
  return { label, tool, args, status: env.status, summary: env.summary ?? null, cached: Boolean(env.cached) };
}

// Pick the best restaurant tag for the cuisine words, preferring cuisine/genre tags.
async function resolveCuisineTag(cuisine, trace) {
  const args = { query: `${cuisine} restaurant`, limit: 8 };
  const env = await callQloo("find_tags", args);
  trace.push(step("Find the cuisine tag", "find_tags", args, env));
  const tags = list(env).map((t) => ({ id: t.id ?? t.tag_id, name: t.name }));
  const score = (t) => (/^urn:tag:genre:place:restaurant:/.test(t.id) ? 3 : /^urn:tag:category:place:/.test(t.id) ? 2 : /^urn:tag:cuisine:/.test(t.id) ? 1 : 0);
  const exact = tags.find((t) => /^urn:tag:cuisine:/.test(t.id) && t.name?.toLowerCase() === String(cuisine).toLowerCase());
  if (exact) return { chosen: exact, candidates: tags };
  const ranked = tags.filter((t) => score(t) > 0).sort((a, b) => score(b) - score(a));
  return { chosen: ranked[0] ?? null, candidates: tags };
}

// Qloo resolves cities reliably but often returns nothing for a neighbourhood
// ("Jayanagar, Bengaluru"), so the city is used for the Qloo calls and the
// neighbourhood is kept for the owner-facing text.
function splitArea(area) {
  const parts = String(area).split(",").map((p) => p.trim()).filter(Boolean);
  return { neighbourhood: parts.length > 1 ? parts[0] : null, city: parts[parts.length - 1] ?? area };
}


// --- What's rising with this crowd ---------------------------------------------------

// Qloo trends returns a popularity time series per entity. The envelope shape is read
// defensively: every object with a date and a number is a point, grouped by entity.
function seriesOf(env, names) {
  const groups = new Map();
  const walk = (node, owner) => {
    if (Array.isArray(node)) return node.forEach((x) => walk(x, owner));
    if (!node || typeof node !== "object") return;
    const id = node.entity_id ?? node.id ?? owner;
    const date = node.date ?? node.day ?? node.timestamp ?? node.period ?? node.start_date;
    const value = [node.popularity, node.value, node.score, node.population_percentile, node.rank_delta].find((v) => typeof v === "number");
    if (date && value != null && id) {
      const g = groups.get(id) ?? { id, name: names.get(id) ?? node.name ?? null, points: [] };
      g.points.push({ date: String(date).slice(0, 10), value });
      groups.set(id, g);
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v, id);
  };
  walk(env.results ?? env, null);
  return [...groups.values()].filter((g) => g.points.length >= 6);
}

// Change in average popularity over the last 14 days against the weeks before.
function momentum(points) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-14), before = sorted.slice(0, -14);
  if (!before.length) return null;
  const avg = (xs) => xs.reduce((a, p) => a + p.value, 0) / xs.length;
  const b = avg(before), r = avg(recent);
  return b > 0 ? (r - b) / b : null;
}

async function crowdTrends({ movies, tvShows, artists }, trace) {
  const end = new Date(Date.now() - 2 * 864e5), start = new Date(end.getTime() - 56 * 864e5);
  const day = (d) => d.toISOString().slice(0, 10);
  const rising = [];
  for (const [type, label, xs] of [["movie", "Film", movies], ["tv_show", "Show", tvShows], ["artist", "Artist", artists]]) {
    const top = (xs ?? []).slice(0, 5).filter((x) => x.id);
    if (!top.length) continue;
    const names = new Map(top.map((x) => [x.id, x.name]));
    const args = { entities: top.map((x) => x.id), entity_type: type, start_date: day(start), end_date: day(end) };
    const env = await callQloo("trends", args);
    trace.push(step(`What's rising with this crowd: ${label.toLowerCase()}s`, "trends", args, env));
    if (!ok(env)) continue;
    const series = seriesOf(env, names);
    if (!series.length) console.log("[trends] unreadable envelope", JSON.stringify(env).slice(0, 1200));
    for (const g of series) {
      const change = momentum(g.points);
      const x = top.find((t) => t.id === g.id);
      if (change != null && x) rising.push({ name: x.name, type: label, affinity: x.affinity, change: Number(change.toFixed(3)) });
    }
  }
  return rising.filter((x) => x.change >= 0.05).sort((a, b) => b.change - a.change).slice(0, 5);
}

export async function gatherEvidence({ area, cuisine, limit = 8 }) {
  const trace = [];
  const { neighbourhood, city } = splitArea(area);
  const cuisineTag = await resolveCuisineTag(cuisine, trace);
  if (!cuisineTag.chosen) {
    return { status: "needs_input", question: `I couldn't match "${cuisine}" to a restaurant type. Which is closest?`, candidates: cuisineTag.candidates, trace };
  }

  // 1. Restaurants like this one in the area: the peer set the audience is read from.
  const peerArgs = { target_type: "place", signal_location: city, filter_location: city, include_tags: [cuisineTag.chosen.id], limit: 10 };
  const peerEnv = await callQloo("recommend", peerArgs);
  trace.push(step("Similar restaurants nearby", "recommend", peerArgs, peerEnv));
  if (!ok(peerEnv) || list(peerEnv).length === 0) {
    return { status: peerEnv.status === "needs_input" ? "needs_input" : "empty", question: peerEnv.summary ?? `No ${cuisineTag.chosen.name} places found in ${city}.`, cuisine: { input: cuisine, tag: cuisineTag.chosen }, trace };
  }
  const peers = list(peerEnv).map(item);
  const signals = peers.slice(0, 5).map((p) => p.id).filter(Boolean);

  // 2. What the people who love those places also love (cross-domain affinity).
  const target = async (label, target_type, extra = {}) => {
    const args = { target_type, signals, signal_location: city, limit, ...extra };
    const env = await callQloo("recommend", args);
    trace.push(step(label, "recommend", args, env));
    return ok(env) ? list(env).map(item) : [];
  };
  const [artists, movies, tvShows, brands] = await Promise.all([
    target("Music this audience loves", "artist"),
    target("Films this audience loves", "movie"),
    target("Shows this audience loves", "tv_show"),
    target("Brands this audience loves", "brand"),
  ]);

  // 3. Partner places: non-restaurant spots nearby with an overlapping audience.
  const partnerTag = await callQloo("find_tags", { query: "dessert shop", limit: 3 });
  const partnerTagId = list(partnerTag).map((t) => t.id ?? t.tag_id).find((id) => /^urn:tag:/.test(id));
  const partners = partnerTagId
    ? await target("Nearby partner places with the same audience", "place", { filter_location: city, include_tags: [partnerTagId] })
    : [];

  // 4. What the peer restaurants are known for (dishes, vibe, amenities).
  const tagArgs = { entities: signals, entity_type: "place", limit: 20 };
  const tagEnv = await callQloo("entity_tags", tagArgs);
  trace.push(step("What similar places are known for", "entity_tags", tagArgs, tagEnv));
  const knownFor = ok(tagEnv) ? list(tagEnv).map((t) => ({ name: t.name, id: t.id ?? t.tag_id, count: t.count ?? t.frequency ?? null })) : [];

  // 5. Who the audience is (aggregate demographics of the top peer).
  const demoArgs = { entity: signals[0], entity_type: "place" };
  const demoEnv = await callQloo("audience_demographics", demoArgs);
  trace.push(step("Who the audience is", "audience_demographics", demoArgs, demoEnv));

  return {
    status: "ok",
    area,
    neighbourhood,
    city,
    cuisine: { input: cuisine, tag: cuisineTag.chosen, alternatives: cuisineTag.candidates.slice(0, 5) },
    peers,
    audience: { artists, movies, tvShows, brands, demographics: ok(demoEnv) ? demoEnv.results ?? null : null },
    trending: await crowdTrends({ movies, tvShows, artists }, trace).catch((e) => { console.error("[trends]", e.message); return []; }),
    knownFor,
    partners,
    trace,
  };
}
