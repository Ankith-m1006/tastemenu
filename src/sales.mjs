// Sales × Taste: combines the restaurant's own item sales with Qloo's view of its crowd.
// Each dish is matched to a Qloo dish/cuisine tag, and "crowd fit" is how strongly the
// restaurant's audience over-indexes on places known for that dish in the same city.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { callQloo } from "./qloo.mjs";

const ok = (env) => ["ok", "partial", "degraded"].includes(env.status);
const list = (env) => (Array.isArray(env.results) ? env.results : []);

// --- CSV ---------------------------------------------------------------------------

function parseCsvRows(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[₹,\s]|Rs\.?|INR/gi, ""));
  return Number.isFinite(n) ? n : null;
};

// Accepts most POS item-wise sales exports: finds the item, category, quantity and amount
// columns by name, skips total rows, and adds up repeated items (e.g. one row per day).
export function parseSales(text) {
  const rows = parseCsvRows(String(text || "").replace(/^﻿/, ""));
  if (rows.length < 2) throw new Error("The file has no data rows.");
  const headerIndex = rows.findIndex((r) => r.some((h) => /item|dish|product|menu/i.test(h)));
  if (headerIndex < 0) throw new Error("Couldn't find an item/dish column.");
  const header = rows[headerIndex].map((h) => String(h).trim().toLowerCase());
  const find = (re, not) => header.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const col = {
    name: find(/item ?name|dish|product|^item$|menu item|name/, /categ|group|code/),
    category: find(/categ|group|section/),
    qty: find(/qty|quantity|sold|count|units/),
    amount: find(/net|amount|revenue|sales|total|value/, /qty|quantity|tax|discount/),
  };
  if (col.name < 0 || (col.qty < 0 && col.amount < 0)) throw new Error("Need an item column and a quantity or amount column.");
  const byName = new Map();
  for (const r of rows.slice(headerIndex + 1)) {
    const name = String(r[col.name] ?? "").trim();
    if (!name || /^(grand )?total|sub ?total/i.test(name)) continue;
    const prev = byName.get(name.toLowerCase()) ?? { name, category: col.category >= 0 ? String(r[col.category] ?? "").trim() : "", qty: 0, amount: 0 };
    prev.qty += col.qty >= 0 ? num(r[col.qty]) ?? 0 : 0;
    prev.amount += col.amount >= 0 ? num(r[col.amount]) ?? 0 : 0;
    byName.set(name.toLowerCase(), prev);
  }
  const items = [...byName.values()].filter((x) => x.qty > 0 || x.amount > 0);
  if (!items.length) throw new Error("No items with sales found.");
  return items;
}

export async function sampleSales() {
  return parseSales(await readFile(path.resolve("data/sample-sales.csv"), "utf8"));
}

// --- Qloo matching -----------------------------------------------------------------

const DISH_TAG = /^urn:tag:(specialty_dish|cuisine|genre:place:restaurant|category:place)/;

// What-if ideas can also be about the experience (live music, outdoor seating, kid-friendly).
const IDEA_TAG = /^urn:tag:(specialty_dish|cuisine|genre:place|category:place|amenity|good_for|setting|offerings|decor)/;
const STOP = new Set(["and", "the", "with", "for", "add", "menu", "special", "counter", "night", "weekend", "meal", "meals"]);

// Candidate Qloo tags for a dish or idea, best first: tags sharing a word with the name
// ("Neer Dosa" → a dosa tag), dishes before cuisines and place types.
async function matchTags(name, pattern) {
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const query = words.join(" ") || name;
  const env = await callQloo("find_tags", { query, limit: 8 });
  if (!ok(env)) return [];
  const tags = list(env).map((t) => ({ id: t.id ?? t.tag_id, name: t.name })).filter((t) => pattern.test(t.id ?? ""));
  const named = tags.filter((t) => words.some((w) => t.name?.toLowerCase().includes(w)));
  return [...named.filter((t) => /specialty_dish/.test(t.id)), ...named.filter((t) => !/specialty_dish/.test(t.id))].slice(0, 3);
}

// Tries the candidate tags in order until Qloo has places for one of them in this city,
// so a thin dish tag ("Biryani") falls back to a broader one ("Biryani restaurant").
async function fitFor(name, pattern, signals, city) {
  const tags = await matchTags(name, pattern);
  for (const tag of tags) {
    const fit = await crowdFit(tag.id, signals, city);
    if (fit) return { tag, fit };
  }
  return { tag: tags[0] ?? null, fit: null };
}

async function crowdFit(tagId, signals, city) {
  const env = await callQloo("recommend", { target_type: "place", signals, signal_location: city, filter_location: city, include_tags: [tagId], limit: 3 });
  if (!ok(env)) return null;
  const xs = list(env).map((r) => r.affinity).filter((a) => typeof a === "number");
  return xs.length ? { score: xs.reduce((a, b) => a + b, 0) / xs.length, examples: list(env).slice(0, 2).map((r) => r.name) } : null;
}

// --- Analysis ----------------------------------------------------------------------

export async function analyzeSales(items, evidence, { maxItems = 14 } = {}) {
  if (!evidence?.peers?.length) return { status: "needs_evidence" };
  const signals = evidence.peers.slice(0, 5).map((p) => p.id).filter(Boolean);
  const city = evidence.city;
  const total = items.reduce((a, x) => a + (x.amount || 0), 0) || 1;
  const sorted = [...items].sort((a, b) => (b.amount || b.qty) - (a.amount || a.qty));
  // Look at the best sellers and the weakest few: that's where decisions are.
  const picked = [...sorted.slice(0, maxItems - 5), ...sorted.slice(-5)].filter((x, i, a) => a.indexOf(x) === i);

  const rows = [];
  for (const it of picked) {
    const { tag, fit } = await fitFor(it.name, DISH_TAG, signals, city);
    rows.push({ ...it, share: it.amount / total, rank: sorted.indexOf(it) + 1, tag, fit });
  }

  // Tiers are relative within this menu: top/bottom third by sales and by crowd fit.
  const n = sorted.length;
  const fits = rows.filter((r) => r.fit).map((r) => r.fit.score).sort((a, b) => a - b);
  const q = (p) => fits[Math.min(fits.length - 1, Math.floor(p * fits.length))];
  const hiFit = fits.length ? q(0.6) : 1, loFit = fits.length ? q(0.3) : 0;
  for (const r of rows) {
    const sales = r.rank <= Math.ceil(n / 3) ? "strong" : r.rank > Math.floor((2 * n) / 3) ? "weak" : "steady";
    const crowd = !r.fit ? "unknown" : r.fit.score >= hiFit ? "high" : r.fit.score <= loFit ? "low" : "medium";
    r.sales = sales;
    r.crowd = crowd;
    r.verdict =
      crowd === "unknown" ? "No Qloo signal"
      : sales === "strong" && crowd !== "low" ? "Double down"
      : sales !== "strong" && crowd === "high" ? "Reposition"
      : sales === "strong" && crowd === "low" ? "Core staple"
      : sales === "weak" && crowd === "low" ? "Rethink"
      : "Keep";
  }

  // Dishes/cuisines the crowd's favourite places are known for, that the menu lacks.
  // Diet labels and the restaurant's own cuisine describe what it already is, so they are skipped.
  const menuText = items.map((x) => `${x.name} ${x.category ?? ""}`.toLowerCase()).join(" | ");
  const own = `${evidence.cuisine?.tag?.name ?? ""} ${evidence.cuisine?.input ?? ""}`.toLowerCase();
  const GENERIC = /vegetarian|^indian$|restaurant or cafe|^restaurant$|^cafe$|fast food|family/i;
  const missing = (evidence.knownFor ?? [])
    .filter((t) => DISH_TAG.test(t.id ?? "") && t.name && !GENERIC.test(t.name))
    .filter((t) => {
      const first = t.name.toLowerCase().replace(/ restaurant$/, "").split(" ")[0];
      return !menuText.includes(first) && !own.includes(first);
    })
    .slice(0, 6);
  const ideas = [];
  for (const t of missing) {
    const fit = await crowdFit(t.id, signals, city);
    if (fit) ideas.push({ name: t.name, tag: t.id, fit: Number(fit.score.toFixed(3)), examples: fit.examples });
  }
  ideas.sort((a, b) => b.fit - a.fit);

  return {
    status: "ok",
    city,
    items_total: items.length,
    revenue_total: total,
    rows: rows.map((r) => ({
      item: r.name, category: r.category, qty: r.qty, revenue: r.amount, share: Number(r.share.toFixed(4)), sales_rank: r.rank,
      qloo_tag: r.tag?.name ?? null, crowd_fit: r.fit ? Number(r.fit.score.toFixed(3)) : null, fit_examples: r.fit?.examples ?? [],
      sales: r.sales, crowd: r.crowd, verdict: r.verdict,
    })),
    new_ideas: ideas.slice(0, 4),
    method: "Crowd fit = average Qloo affinity of the top places in the city known for that dish/cuisine tag, using the restaurant's peer places as taste signals. Tiers are relative within this menu.",
  };
}

// --- What-if ---------------------------------------------------------------------------

// Scores the owner's ideas ("weekend biryani counter", "live music night") for this crowd,
// all in one comparable run: same peer signals, same city, one tag per idea.
export async function rankIdeas(options, evidence) {
  if (!evidence?.peers?.length) return { status: "needs_evidence" };
  const signals = evidence.peers.slice(0, 5).map((p) => p.id).filter(Boolean);
  const out = [];
  for (const option of options.slice(0, 6)) {
    const { tag, fit } = await fitFor(option, IDEA_TAG, signals, evidence.city);
    out.push({ option, qloo_tag: tag?.name ?? null, crowd_fit: fit ? Number(fit.score.toFixed(3)) : null, examples: fit?.examples ?? [] });
  }
  out.sort((a, b) => (b.crowd_fit ?? -1) - (a.crowd_fit ?? -1));
  return {
    status: "ok",
    city: evidence.city,
    ranking: out,
    method: "Crowd fit = average Qloo affinity, for this restaurant's audience, of the top places in the city known for the idea's tag. Only compare scores within this list.",
  };
}

// --- Competitor lens ------------------------------------------------------------------

// How a named competitor differs from places like this restaurant, using Qloo's audience
// comparison: it returns the taste tags of each group (a = places like yours, b = the
// competitor) and the tags they share. Tags on one side only are the real differences.
export async function compareCompetitor(competitor, evidence) {
  if (!evidence?.peers?.length) return { status: "needs_evidence" };
  const desc = await callQloo("describe", { entity: `${competitor}, ${evidence.city}`, type: "place" });
  const found = ok(desc) ? (Array.isArray(desc.results) ? desc.results[0] : desc.results) : null;
  const theirs = found?.entity_id ?? found?.id;
  if (!theirs) return { status: "not_found", question: `I couldn't find "${competitor}" in ${evidence.city} on Qloo. Could you give the exact name?` };
  const ours = evidence.peers.slice(0, 5).map((p) => p.id).filter((id) => id && id !== theirs);
  const env = await callQloo("compare_audiences", { group_a: ours, group_b: [theirs], limit: 20 });
  const r = env.results && !Array.isArray(env.results) ? env.results : {};
  const names = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((t) => t.name).filter(Boolean))];
  const a = names(r.a), b = names(r.b), shared = names(r.tags);
  const aSet = new Set(a.map((x) => x.toLowerCase())), bSet = new Set(b.map((x) => x.toLowerCase()));
  if (!ok(env) || (!a.length && !b.length)) return { status: "empty", question: `Qloo has no comparison data for ${found.name} yet.` };
  return {
    status: "ok",
    competitor: { name: found.name, address: found.properties?.address ?? null },
    only_places_like_yours: a.filter((x) => !bSet.has(x.toLowerCase())).slice(0, 8),
    only_competitor: b.filter((x) => !aSet.has(x.toLowerCase())).slice(0, 8),
    shared: shared.slice(0, 8),
    method: "Qloo compare_audiences over taste tags: group A = the top places like the owner's restaurant, group B = the competitor. Tags are traits of the places and their audiences (offerings, occasions, flavours, vibe).",
  };
}
