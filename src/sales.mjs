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

async function matchTag(name, pattern = DISH_TAG) {
  const env = await callQloo("find_tags", { query: name, limit: 8 });
  if (!ok(env)) return null;
  const tags = list(env).map((t) => ({ id: t.id ?? t.tag_id, name: t.name })).filter((t) => pattern.test(t.id ?? ""));
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w));
  // Prefer a tag that shares a word with the name ("Neer Dosa" → a dosa tag), dishes first.
  const named = tags.filter((t) => words.some((w) => t.name?.toLowerCase().includes(w)));
  return named.find((t) => /specialty_dish/.test(t.id)) ?? named[0] ?? null;
}
const dishTag = (name) => matchTag(name, DISH_TAG);

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
    const tag = await dishTag(it.name);
    const fit = tag ? await crowdFit(tag.id, signals, city) : null;
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
  const menuText = items.map((x) => x.name.toLowerCase()).join(" | ");
  const missing = (evidence.knownFor ?? [])
    .filter((t) => DISH_TAG.test(t.id ?? "") && t.name && !menuText.includes(t.name.toLowerCase().split(" ")[0]))
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
    const tag = await matchTag(option, IDEA_TAG);
    const fit = tag ? await crowdFit(tag.id, signals, evidence.city) : null;
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

// How the crowd of a named competitor differs from this restaurant's crowd
// (its peer places), across films, music and brands.
export async function compareCompetitor(competitor, evidence) {
  if (!evidence?.peers?.length) return { status: "needs_evidence" };
  const desc = await callQloo("describe", { entity: `${competitor}, ${evidence.city}`, type: "place" });
  const found = ok(desc) ? (Array.isArray(desc.results) ? desc.results[0] : desc.results) : null;
  const theirs = found?.entity_id ?? found?.id;
  if (!theirs) return { status: "not_found", question: `I couldn't find "${competitor}" in ${evidence.city} on Qloo. Could you give the exact name?` };
  const ours = evidence.peers.slice(0, 5).map((p) => p.id).filter((id) => id && id !== theirs);
  const pick = (r) => {
    const o = { name: r.name };
    for (const [k, v] of Object.entries(r)) if (typeof v === "number") o[k] = Number(v.toFixed(3));
    return o;
  };
  const sides = {};
  for (const target_type of ["movie", "artist", "brand"]) {
    const env = await callQloo("compare_audiences", { group_a: ours, group_b: [theirs], target_type, limit: 8 });
    sides[target_type] = ok(env) ? { summary: env.summary ?? null, results: list(env).slice(0, 8).map(pick) } : { status: env.status, summary: env.summary ?? null };
  }
  return {
    status: "ok",
    competitor: { name: found.name, address: found.properties?.address ?? null },
    group_a: "places like the owner's restaurant",
    group_b: found.name,
    comparisons: sides,
  };
}
